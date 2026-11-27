import asyncio
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from lagun.api import query as query_api
from lagun.db.pool import DatabaseCapacityError
from lagun.models.query import (
    CellUpdateRequest,
    QueryRequest,
    RowDeleteRequest,
    RowInsertRequest,
    RowUpdateRequest,
    ScriptQueryRequest,
    SequentialScriptRequest,
)


def _request(username=None):
    request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})
    if username is not None:
        request.state.user = username
    return request


def _session(**overrides):
    values = {
        "managed": False,
        "selected_databases": [],
        "managed_selected_databases": [],
        "query_limit": 100,
        "default_db": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class Cursor:
    def __init__(
        self,
        *,
        description=None,
        one=(42,),
        rows=None,
        rowcount=1,
        on_execute=None,
    ):
        self.description = description
        self._one = one
        self._rows = [] if rows is None else rows
        self.rowcount = rowcount
        self.lastrowid = 1
        self.statements = []
        self.on_execute = on_execute

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def execute(self, sql, args=None):
        self.statements.append((sql, args))
        if self.on_execute is not None:
            await self.on_execute(sql, args)

    async def fetchone(self):
        return self._one

    async def fetchall(self):
        return self._rows

    async def fetchmany(self, _size):
        rows, self._rows = self._rows, []
        return rows

    async def nextset(self):
        return False


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.closed = False
        self.rolled_back = False
        self.committed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def cursor(self, _cursor_class=None):
        return self._cursor

    async def rollback(self):
        self.rolled_back = True

    async def begin(self):
        return None

    async def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


class Pool:
    def __init__(self, cursor=None):
        self.connection = Connection(cursor or Cursor())

    def acquire(self):
        return self.connection


async def test_transactional_target_checks_skip_reads_and_unknown_tables():
    class TxCursor:
        def __init__(self, current, engine):
            self.current = current
            self.engine = engine
            self.result = None

        async def execute(self, sql, _args=None):
            self.result = (
                self.current if sql.startswith("SELECT DATABASE()") else self.engine
            )

        async def fetchone(self):
            return self.result

    skip_reads = TxCursor(None, None)
    assert (
        await query_api._check_transactional_targets(skip_reads, ["SELECT 1"]) is None
    )

    no_database = TxCursor(None, None)
    error = await query_api._check_transactional_targets(
        no_database, ["INSERT INTO t VALUES (1)"]
    )
    assert error is not None
    assert error[2].code == "NO_DATABASE_SELECTED"

    unknown_table = TxCursor(("app",), None)
    assert (
        await query_api._check_transactional_targets(
            unknown_table, ["INSERT INTO t VALUES (1)"]
        )
        is None
    )


def test_scope_helpers_ignore_reads_and_unknown_unqualified_targets():
    assert (
        query_api._script_scope_error(
            ["SELECT 1", "UPDATE t SET x=1 WHERE id=1"], frozenset({"app"}), None
        )
        is None
    )
    assert (
        query_api._statement_names_its_own_schema("INSERT INTO t VALUES (1)") is False
    )
    assert query_api._statement_names_its_own_schema("CALL proc()") is False
    assert (
        query_api._statement_names_its_own_schema(
            "UPDATE app.users SET name='x' WHERE id=1"
        )
        is True
    )


def test_script_validation_rejects_select_insert_and_on_duplicate_forms():
    non_values = query_api._validate_script_statements(
        ["INSERT INTO users SELECT * FROM users"]
    )
    assert non_values.error is not None
    assert non_values.error.code == "UNSUPPORTED_INSERT"

    on_duplicate = query_api._validate_script_statements(
        ["INSERT INTO users VALUES (1) ON DUPLICATE KEY UPDATE id=1"]
    )
    assert on_duplicate.error is not None
    assert on_duplicate.error.code == "UNSUPPORTED_STATEMENT"


def test_database_ddl_with_a_known_schema_passes_statement_scope():
    session = _session(
        managed=True, selected_databases=["app"], managed_selected_databases=["app"]
    )
    query_api._require_statement_scope(session, "CREATE DATABASE app", "app")


async def test_query_thread_helpers_cover_missing_execution_keys():
    query_api._cancelled_query_executions.clear()
    assert await query_api._register_query_thread("s", None, 1, None) is False
    assert (
        await query_api._register_query_thread("s", ("s", "missing"), 1, None) is False
    )
    assert await query_api._is_query_cancelled(None) is False
    await query_api._finish_query_execution("s", None, 99)


async def test_active_query_listing_keeps_rows_for_deleted_sessions(monkeypatch):
    query_api._active_query_executions.clear()
    query_api._active_script_queries.clear()
    active = SimpleNamespace(
        execution_id="e",
        owner_username=None,
        database="app",
        tab_id="tab",
        sql="SELECT 1",
        started_at="now",
        started_epoch=0,
        thread_id=None,
    )
    query_api._active_query_executions[("missing", "e")] = active

    async def missing(_session_id):
        return None

    monkeypatch.setattr(query_api, "get_session", missing)
    rows = await query_api.list_active_queries()

    assert rows[0]["username"] == "local"
    assert "session_name" not in rows[0]
    query_api._active_query_executions.clear()


async def test_active_query_listing_adds_existing_session_details(monkeypatch):
    query_api._active_query_executions.clear()
    query_api._active_script_queries.clear()
    query_api._active_query_executions[("s", "e")] = SimpleNamespace(
        execution_id="e",
        owner_username=None,
        database="app",
        tab_id="tab",
        sql="SELECT 1",
        started_at="now",
        started_epoch=0,
        thread_id=None,
    )

    async def found(_session_id):
        return SimpleNamespace(name="Local", host="db", port=3306)

    monkeypatch.setattr(query_api, "get_session", found)
    rows = await query_api.list_active_queries()

    assert rows[0]["session_name"] == "Local"
    assert rows[0]["host"] == "db"
    query_api._active_query_executions.clear()


async def test_kill_helpers_report_empty_and_failed_cancellations(monkeypatch):
    await query_api._kill_query_threads("s", [])
    query_api._active_query_executions.clear()
    query_api._active_queries.clear()

    assert (await query_api.kill_query("s", _request()))["ok"] is False

    query_api._active_queries["s"] = {7: None}

    async def failed(_session_id, _thread_ids):
        raise RuntimeError("kill failed")

    monkeypatch.setattr(query_api, "_kill_query_threads", failed)
    response = await query_api.kill_query("s", _request())
    assert response == {"ok": False, "error": "kill failed"}

    query_api._active_query_executions[("s", "e")] = SimpleNamespace(
        owner_username=None, thread_id=None
    )
    assert await query_api.kill_query_execution("s", "e", _request()) == {"ok": True}
    query_api._active_query_executions[("s", "e")].thread_id = 7
    response = await query_api.kill_query_execution("s", "e", _request())
    assert response == {"ok": False, "error": "kill failed"}
    query_api._active_queries.clear()
    query_api._active_query_executions.clear()


@pytest.mark.asyncio
async def test_execute_query_reports_prestart_and_midstream_cancellation(monkeypatch):
    session = _session(default_db="app")
    pool = Pool()

    async def get_pool(_session_id):
        return pool, session

    async def restore(_conn):
        return False

    async def pre_cancelled(key):
        return key == ("s", "pre")

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_pool)
    monkeypatch.setattr(query_api, "restore_connection_state", restore)
    monkeypatch.setattr(query_api, "_is_query_cancelled", pre_cancelled)
    prestarted = await query_api.execute_query(
        "s", QueryRequest(sql="SELECT 1", execution_id="pre"), _request()
    )
    assert prestarted.error == "Query cancelled"

    async def already_cancelled(*_args):
        return True

    monkeypatch.setattr(query_api, "_register_query_thread", already_cancelled)
    after_connect = await query_api.execute_query(
        "s", QueryRequest(sql="SELECT 1", execution_id="connect"), _request()
    )
    assert after_connect.error == "Query cancelled"

    checks = [False, True]

    async def cancel_on_second(_key):
        return checks.pop(0)

    async def registered(*_args):
        return False

    monkeypatch.setattr(query_api, "_is_query_cancelled", cancel_on_second)
    monkeypatch.setattr(query_api, "_register_query_thread", registered)
    after_use = await query_api.execute_query(
        "s",
        QueryRequest(sql="SELECT 1", database="app", execution_id="use"),
        _request(),
    )
    assert after_use.error == "Query cancelled"

    checks = [False, False, True]
    after_execute = await query_api.execute_query(
        "s",
        QueryRequest(sql="SELECT 1", database="app", execution_id="execute"),
        _request(),
    )
    assert after_execute.error == "Query cancelled"


async def test_execute_query_reports_a_connection_reset_after_fetch(monkeypatch):
    session = _session(default_db="app")
    cursor = Cursor(description=(("n",),), rows=[(1,)])
    pool = Pool(cursor)

    async def get_pool(_session_id):
        return pool, session

    async def get_session(_session_id):
        return session

    states = [False, True]

    async def restore(_conn):
        return states.pop(0)

    async def registered(*_args):
        return False

    async def not_cancelled(_key):
        return False

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_pool)
    monkeypatch.setattr(query_api, "restore_connection_state", restore)
    monkeypatch.setattr(query_api, "_register_query_thread", registered)
    monkeypatch.setattr(query_api, "_is_query_cancelled", not_cancelled)
    result = await query_api.execute_query(
        "s",
        QueryRequest(sql="SELECT 1", database="app", execution_id="reset"),
        _request(),
    )

    assert result.error == query_api._CONNECTION_RESET_ERROR
    assert result.columns == []


async def test_execute_query_reports_reset_without_results_and_no_database(monkeypatch):
    session = _session(default_db=None)
    cursor = Cursor(description=None)
    pool = Pool(cursor)

    async def get_pool(_session_id):
        return pool, session

    states = [False, True]

    async def restore(_conn):
        return states.pop(0)

    async def registered(*_args):
        return False

    async def not_cancelled(_key):
        return False

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_pool)
    monkeypatch.setattr(query_api, "restore_connection_state", restore)
    monkeypatch.setattr(query_api, "_register_query_thread", registered)
    monkeypatch.setattr(query_api, "_is_query_cancelled", not_cancelled)
    result = await query_api.execute_query(
        "s", QueryRequest(sql="SET @x=1", execution_id="write-reset"), _request()
    )

    assert result.error == query_api._CONNECTION_RESET_ERROR
    assert not any(sql.startswith("USE ") for sql, _ in cursor.statements)


def _install_route_pool(monkeypatch, session=None, cursor=None):
    session = session or _session(default_db="app")
    pool = Pool(cursor or Cursor())

    async def get_pool(_session_id):
        return pool, session

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_pool)
    return pool, session


async def test_script_validation_reports_parse_scope_and_target_errors(monkeypatch):
    _install_route_pool(monkeypatch)
    both = await query_api.validate_script_query(
        "s",
        ScriptQueryRequest(
            execution_id="both", sql="SELECT 1", statements=["SELECT 1"]
        ),
    )
    assert both.error.code == "INVALID_REQUEST"

    scoped = _session(
        managed=True,
        selected_databases=["app"],
        managed_selected_databases=["app"],
    )
    _install_route_pool(monkeypatch, scoped)
    out_of_scope = await query_api.validate_script_query(
        "s",
        ScriptQueryRequest(
            execution_id="scope",
            database="app",
            statements=["UPDATE other.users SET name='x' WHERE id=1"],
        ),
    )
    assert out_of_scope.error.code == "OUT_OF_SCOPE_DATABASE"

    _install_route_pool(monkeypatch)
    error = query_api._script_error("TEST", "problem", "cause", "fix")

    async def target_error(_cur, _statements):
        return 0, "INSERT INTO app.users VALUES (1)", error

    monkeypatch.setattr(query_api, "_check_transactional_targets", target_error)
    target = await query_api.validate_script_query(
        "s",
        ScriptQueryRequest(
            execution_id="target",
            statements=["INSERT INTO app.users VALUES (1)"],
        ),
    )
    assert target.error.code == "TEST"

    async def no_target_error(_cur, _statements):
        return None

    monkeypatch.setattr(query_api, "_check_transactional_targets", no_target_error)
    valid = await query_api.validate_script_query(
        "s",
        ScriptQueryRequest(
            execution_id="valid",
            statements=["INSERT INTO app.users VALUES (1)"],
        ),
    )
    assert valid.ok is True


async def test_script_execution_reports_parse_validation_and_target_errors(
    monkeypatch,
):
    _install_route_pool(monkeypatch)
    query_api._active_script_queries.clear()
    query_api._active_script_details.clear()
    parse = await query_api.execute_script_query(
        "s",
        ScriptQueryRequest(
            execution_id="parse", sql="SELECT 1", statements=["SELECT 1"]
        ),
        _request(),
    )
    assert parse.error.code == "INVALID_REQUEST"

    validation = await query_api.execute_script_query(
        "s",
        ScriptQueryRequest(execution_id="validation", sql="SELECT 1"),
        _request(),
    )
    assert validation.error.code == "UNSUPPORTED_STATEMENT"

    error = query_api._script_error("TEST", "problem", "cause", "fix")

    async def target_error(_cur, _statements):
        return 0, "INSERT INTO app.users VALUES (1)", error

    monkeypatch.setattr(query_api, "_check_transactional_targets", target_error)
    target = await query_api.execute_script_query(
        "s",
        ScriptQueryRequest(
            execution_id="target",
            statements=["INSERT INTO app.users VALUES (1)"],
        ),
        _request(),
    )
    assert target.error.code == "TEST"
    assert "s" not in query_api._active_script_queries


async def test_sequential_script_reports_parse_scope_and_running_conflicts(monkeypatch):
    _install_route_pool(monkeypatch)
    query_api._active_script_queries.clear()
    parse = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(execution_id="parse", sql="  ;  "),
        _request(),
    )
    assert "No SQL statements" in parse.error

    scoped = _session(
        managed=True,
        selected_databases=["app"],
        managed_selected_databases=["app"],
    )
    _install_route_pool(monkeypatch, scoped)
    with pytest.raises(Exception, match="USE target cannot be verified"):
        await query_api.execute_sequential_script(
            "s",
            SequentialScriptRequest(execution_id="use", sql="USE"),
            _request(),
        )

    _install_route_pool(monkeypatch)
    query_api._active_script_queries["s"] = {"other": 1}
    conflict = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(execution_id="conflict", sql="SELECT 1"),
        _request(),
    )
    assert "already running" in conflict.error
    query_api._active_script_queries.clear()


async def test_sequential_script_accepts_unscoped_use(monkeypatch):
    _install_route_pool(monkeypatch)
    query_api._active_script_queries.clear()

    result = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(execution_id="unscoped-use", sql="USE"),
        _request(),
    )

    assert result.ok is True


async def test_sequential_script_allows_qualified_read_without_a_database(
    monkeypatch,
):
    _install_route_pool(monkeypatch)
    query_api._active_script_queries.clear()
    result = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(
            execution_id="qualified",
            sql="SELECT * FROM app.users",
        ),
        _request(),
    )

    assert result.ok is True
    assert result.statements_executed == 1


async def test_sequential_script_reports_deadline_and_cancellation(monkeypatch):
    _install_route_pool(monkeypatch)
    query_api._active_script_queries.clear()
    monkeypatch.setattr(query_api, "_BULK_MAX_RUNTIME_SECONDS", 0)
    expired = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(execution_id="deadline", sql="SELECT 1"),
        _request(),
    )
    assert "execution limit" in expired.error

    monkeypatch.setattr(query_api, "_BULK_MAX_RUNTIME_SECONDS", 30)
    query_api._active_script_queries.clear()
    session_id = "s"
    execution_id = "cancelled"

    async def cancel_after_first(sql, _args):
        if sql == "SET @x=1":
            query_api._active_script_details[(session_id, execution_id)][
                "cancelled"
            ] = True

    _install_route_pool(monkeypatch, cursor=Cursor(on_execute=cancel_after_first))
    cancelled = await query_api.execute_sequential_script(
        session_id,
        SequentialScriptRequest(execution_id=execution_id, sql="SET @x=1; SET @x=2;"),
        _request(),
    )
    assert cancelled.ok is False
    assert "cancelled" in cancelled.error.lower()


async def test_sequential_script_handles_restore_failures_and_capacity(monkeypatch):
    _install_route_pool(monkeypatch)
    query_api._active_script_queries.clear()

    async def cancelled_restore(_conn):
        raise asyncio.CancelledError

    monkeypatch.setattr(query_api, "restore_connection_state", cancelled_restore)
    with pytest.raises(asyncio.CancelledError):
        await query_api.execute_sequential_script(
            "s",
            SequentialScriptRequest(execution_id="cancelled-restore", sql="SELECT 1"),
            _request(),
        )

    async def failed_restore(_conn):
        raise RuntimeError("reset failed")

    monkeypatch.setattr(query_api, "restore_connection_state", failed_restore)
    ignored = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(execution_id="failed-restore", sql="SELECT 1"),
        _request(),
    )
    assert ignored.ok is True

    async def dirty_restore(_conn):
        return True

    monkeypatch.setattr(query_api, "restore_connection_state", dirty_restore)
    dirty = await query_api.execute_sequential_script(
        "s",
        SequentialScriptRequest(execution_id="dirty", sql="SELECT 1"),
        _request(),
    )
    assert dirty.ok is False
    assert "transaction open" in dirty.error

    class Saturated:
        def acquire(self):
            return self

        async def __aenter__(self):
            raise DatabaseCapacityError("busy")

        async def __aexit__(self, *_args):
            return False

    async def saturated(_session_id):
        return Saturated(), _session(default_db="app")

    monkeypatch.setattr(query_api, "_get_pool_or_404", saturated)
    with pytest.raises(DatabaseCapacityError, match="busy"):
        await query_api.execute_sequential_script(
            "s",
            SequentialScriptRequest(execution_id="capacity", sql="SELECT 1"),
            _request(),
        )


async def test_sequential_cancellation_during_restore_has_no_failed_statement(
    monkeypatch,
):
    session_id = "s"
    execution_id = "restore-cancel"

    async def mark_cancelled(sql, _args):
        if sql.startswith("SELECT 1"):
            query_api._active_script_details[(session_id, execution_id)][
                "cancelled"
            ] = True

    _install_route_pool(monkeypatch, cursor=Cursor(on_execute=mark_cancelled))

    async def cancelled_restore(_conn):
        raise asyncio.CancelledError

    monkeypatch.setattr(query_api, "restore_connection_state", cancelled_restore)
    result = await query_api.execute_sequential_script(
        session_id,
        SequentialScriptRequest(execution_id=execution_id, sql="SELECT 1"),
        _request(),
    )

    assert result.ok is False
    assert "cancelled" in result.error.lower()
    assert result.failed_statement_index is None


def test_script_cursor_exit_closes_a_live_connection():
    cursor = object.__new__(query_api._ScriptCursor)
    closed = []
    cursor._connection = SimpleNamespace(close=lambda: closed.append(True))

    async def close():
        return None

    cursor.close = close
    asyncio.run(cursor.__aexit__(ValueError, None, None))

    assert closed == [True]

    cursor._connection = None
    asyncio.run(cursor.__aexit__(None, None, None))


class BulkCursor(Cursor):
    def __init__(
        self,
        *,
        fail_statement=None,
        fail_commit=False,
        fail_rollback=False,
        fail_restore=False,
        lock_wait=False,
        rowcount=1,
    ):
        super().__init__(rowcount=rowcount)
        self.fail_statement = fail_statement
        self.fail_commit = fail_commit
        self.fail_rollback = fail_rollback
        self.fail_restore = fail_restore
        self.lock_wait = lock_wait

    async def execute(self, sql, args=None):
        self.statements.append((sql, args))
        if sql == "SELECT CONNECTION_ID()":
            self._one = (11,)
            return
        if sql == "SELECT @@innodb_lock_wait_timeout":
            self._one = (50,)
            return
        if self.fail_commit and sql == "COMMIT":
            raise TimeoutError
        if self.fail_rollback and sql == "ROLLBACK":
            raise RuntimeError("rollback failed")
        if self.fail_restore and sql == "SET SESSION innodb_lock_wait_timeout=50":
            raise RuntimeError("restore failed")
        if sql == self.fail_statement:
            if self.lock_wait:
                raise RuntimeError(1205, "lock wait timeout")
            raise TimeoutError


async def _run_bulk(cursor, monkeypatch, statements=None):
    _install_route_pool(monkeypatch, cursor=cursor)
    query_api._active_script_queries.clear()
    query_api._active_script_details.clear()

    async def no_target_error(_cur, _statements):
        return None

    monkeypatch.setattr(query_api, "_check_transactional_targets", no_target_error)
    request = ScriptQueryRequest(
        execution_id="bulk",
        statements=statements or ["UPDATE app.t SET a=1 WHERE id=1"],
    )
    return await query_api.execute_script_query("s", request, _request())


async def test_bulk_script_reports_statement_and_commit_timeouts(monkeypatch):
    statement = "UPDATE app.t SET a=1 WHERE id=1"
    timed_out = await _run_bulk(BulkCursor(fail_statement=statement), monkeypatch)
    assert timed_out.error.code == "MAX_RUNTIME_EXCEEDED"
    assert timed_out.rolled_back is False

    query_api._active_script_queries.clear()
    commit_timed_out = await _run_bulk(
        BulkCursor(fail_commit=True), monkeypatch, ["UPDATE app.t SET a=1 WHERE id=1"]
    )
    assert commit_timed_out.error.code == "MAX_RUNTIME_EXCEEDED"


async def test_bulk_script_reports_lock_waits_and_zero_row_updates(monkeypatch):
    statement = "UPDATE app.t SET a=1 WHERE id=1"
    locked = await _run_bulk(
        BulkCursor(fail_statement=statement, lock_wait=True), monkeypatch
    )
    assert locked.error.code == "LOCK_WAIT_TIMEOUT"

    query_api._active_script_queries.clear()
    zero_rows = await _run_bulk(
        BulkCursor(rowcount=0),
        monkeypatch,
        ["UPDATE app.t SET a=1 WHERE id=1", "UPDATE app.t SET a=2 WHERE id=2"],
    )
    assert zero_rows.ok is True
    assert zero_rows.statements_executed == 2


async def test_bulk_script_survives_rollback_and_timeout_restore_failures(
    monkeypatch,
):
    statement = "UPDATE app.t SET a=1 WHERE id=1"
    rolled_back = await _run_bulk(
        BulkCursor(fail_statement=statement, fail_rollback=True), monkeypatch
    )
    assert rolled_back.ok is False

    query_api._active_script_queries.clear()
    restored = await _run_bulk(
        BulkCursor(fail_statement=statement, fail_restore=True), monkeypatch
    )
    assert restored.ok is False


async def test_row_writes_cover_limits_and_timeout_branches(monkeypatch):
    _install_route_pool(monkeypatch)

    async def clean(_conn):
        return False

    monkeypatch.setattr(query_api, "restore_connection_state", clean)

    async def no_row_key(_cur, _database, _table):
        return None

    async def no_types(_cur, _database, _table, _columns):
        return {}

    monkeypatch.setattr(query_api, "select_row_key", no_row_key)
    monkeypatch.setattr(query_api, "_column_data_types", no_types)
    cell = await query_api.cell_update(
        "s",
        CellUpdateRequest(
            database="app",
            table="t",
            primary_key={"id": 1},
            column="name",
            new_value="x",
        ),
    )
    assert cell.ok is True
    assert "LIMIT 1" in cell.sql_executed

    unchanged = await query_api.row_update(
        "s",
        RowUpdateRequest(
            database="app",
            table="t",
            primary_key={"id": 1},
            updates={},
        ),
    )
    assert unchanged.ok is False
    assert unchanged.error == "No changes were supplied."

    class TimeoutCursor(Cursor):
        async def execute(self, sql, args=None):
            self.statements.append((sql, args))
            raise TimeoutError

    timeout_pool = Pool(TimeoutCursor())

    async def get_timeout_pool(_session_id):
        return timeout_pool, _session(default_db="app")

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_timeout_pool)
    row_timeout = await query_api.row_update(
        "s",
        RowUpdateRequest(
            database="app",
            table="t",
            primary_key={"id": 1},
            updates={"name": "x"},
        ),
    )
    assert row_timeout.ok is False
    assert timeout_pool.connection.closed is True

    timeout_pool = Pool(TimeoutCursor())
    insert_timeout = await query_api.row_insert(
        "s",
        RowInsertRequest(database="app", table="t", values={"name": "x"}),
    )
    assert insert_timeout.ok is False
    assert timeout_pool.connection.closed is True


async def test_row_delete_caps_echoes_and_reports_rollback_failures(monkeypatch):
    _install_route_pool(monkeypatch)

    async def clean(_conn):
        return False

    monkeypatch.setattr(query_api, "restore_connection_state", clean)

    async def no_row_key(_cur, _database, _table):
        return None

    async def no_types(_cur, _database, _table, _columns):
        return {}

    monkeypatch.setattr(query_api, "select_row_key", no_row_key)
    monkeypatch.setattr(query_api, "_column_data_types", no_types)
    capped = await query_api.row_delete(
        "s",
        RowDeleteRequest(
            database="app",
            table="t",
            primary_keys=[{"id": index} for index in range(51)],
        ),
    )
    assert capped.ok is True
    assert capped.sql_executed.endswith("1 more statement(s) omitted")

    class FailingCursor(Cursor):
        def __init__(self, error):
            super().__init__()
            self.error = error

        async def execute(self, sql, args=None):
            self.statements.append((sql, args))
            raise self.error

    failure_pool = Pool(FailingCursor(TimeoutError()))

    async def get_failure_pool(_session_id):
        return failure_pool, _session(default_db="app")

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_failure_pool)
    timed_out = await query_api.row_delete(
        "s",
        RowDeleteRequest(database="app", table="t", primary_keys=[{"id": 1}]),
    )
    assert timed_out.ok is False
    assert "exceeded" in timed_out.error
    assert failure_pool.connection.rolled_back is True

    generic_pool = Pool(FailingCursor(RuntimeError("delete failed")))

    async def get_generic_pool(_session_id):
        return generic_pool, _session(default_db="app")

    monkeypatch.setattr(query_api, "_get_pool_or_404", get_generic_pool)
    failed = await query_api.row_delete(
        "s",
        RowDeleteRequest(database="app", table="t", primary_keys=[{"id": 1}]),
    )
    assert failed.ok is False
    assert failed.error == "delete failed"


async def test_kill_script_reports_ownership_start_and_kill_errors(monkeypatch):
    query_api._active_script_queries.clear()
    query_api._active_script_details.clear()
    query_api._active_script_queries["s"] = {"e": 7}
    query_api._active_script_details[("s", "e")] = {
        "username": "bob",
        "task": None,
    }
    monkeypatch.setattr(query_api, "request_username", lambda _request: "alice")

    denied = await query_api.kill_script_query("s", "e", _request())
    assert denied == {"ok": False, "error": "No active large write script"}

    monkeypatch.setattr(query_api, "request_username", lambda _request: "bob")

    async def unavailable(_session_id):
        raise RuntimeError("pool gone")

    monkeypatch.setattr(query_api, "_get_pool_or_404", unavailable)
    failed = await query_api.kill_script_query("s", "e", _request())
    assert failed == {"ok": False, "error": "pool gone"}
    query_api._active_script_queries.clear()
    query_api._active_script_details.clear()

    query_api._active_script_queries["s"] = {"e": None}
    query_api._active_script_details[("s", "e")] = {"task": None}

    response = await query_api.kill_script_query("s", "e", _request())

    assert response == {"ok": False, "error": "Large write script is starting"}
    query_api._active_script_queries.clear()
    query_api._active_script_details.clear()
