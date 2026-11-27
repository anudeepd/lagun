import datetime
import decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import lagun.api.query as query_api
from lagun.db.row_key import RowKey
from lagun.models.query import ScriptQueryRequest


def test_validate_script_statements_covers_size_and_shape_errors(monkeypatch):
    empty = query_api._validate_script_statements([])
    assert empty.error is not None
    assert empty.error.code == "EMPTY_SCRIPT"

    monkeypatch.setattr(query_api, "_BULK_MAX_STATEMENTS", 1)
    too_many = query_api._validate_script_statements(
        ["INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)"]
    )
    assert too_many.error is not None
    assert too_many.error.code == "TOO_MANY_STATEMENTS"

    monkeypatch.setattr(query_api, "_BULK_MAX_STATEMENTS", 100)
    monkeypatch.setattr(query_api, "_BULK_MAX_STATEMENT_BYTES", 1)
    too_large = query_api._validate_script_statements(["INSERT INTO t VALUES (1)"])
    assert too_large.error is not None
    assert too_large.error.code == "STATEMENT_TOO_LARGE"

    monkeypatch.setattr(query_api, "_BULK_MAX_STATEMENT_BYTES", 100_000)
    unsupported = query_api._validate_script_statements(["SELECT 1"])
    assert unsupported.error is not None
    assert unsupported.error.code == "UNSUPPORTED_STATEMENT"

    monkeypatch.setattr(query_api, "target_table", lambda _statement: None)
    unparsed = query_api._validate_script_statements(["INSERT INTO t VALUES (1)"])
    assert unparsed.error is not None
    assert unparsed.error.code == "UNSUPPORTED_STATEMENT"

    monkeypatch.undo()
    missing_where = query_api._validate_script_statements(
        ["UPDATE users SET name = 'x'"]
    )
    assert missing_where.error is not None
    assert missing_where.error.code == "MISSING_WHERE"

    valid = query_api._validate_script_statements(
        ["INSERT INTO users VALUES (1)", "DELETE FROM users WHERE id = 1"]
    )
    assert valid.ok is True
    assert valid.operation_counts == {"INSERT": 1, "UPDATE": 0, "DELETE": 1}


def test_script_request_and_sequential_parser_errors(monkeypatch):
    both = query_api._statements_from_request(
        ScriptQueryRequest(execution_id="x", sql="SELECT 1", statements=["SELECT 1"])
    )
    assert both[0] is None and both[1].code == "INVALID_REQUEST"

    monkeypatch.setattr(query_api, "_BULK_MAX_BODY_BYTES", 1)
    too_large = query_api._statements_from_request(
        ScriptQueryRequest(execution_id="x", sql="SELECT 1")
    )
    assert too_large[1].code == "BODY_TOO_LARGE"
    sequential_large = query_api._sequential_statements_from_sql("SELECT 1")
    assert sequential_large[0] is None

    monkeypatch.setattr(query_api, "_BULK_MAX_BODY_BYTES", 1_000_000)
    parse = query_api._statements_from_request(
        ScriptQueryRequest(execution_id="x", sql="SELECT 'unterminated")
    )
    assert parse[1].code == "PARSE_ERROR"
    assert query_api._sequential_statements_from_sql("SELECT 'unterminated")[1]
    assert query_api._sequential_statements_from_sql("  ;  ")[1] == (
        "No SQL statements were found."
    )

    monkeypatch.setattr(query_api, "_BULK_MAX_STATEMENTS", 1)
    assert (
        "statement limit"
        in query_api._sequential_statements_from_sql("SELECT 1; SELECT 2;")[1]
    )
    assert query_api._sequential_statements_from_sql("SELECT 1;") == (
        ["SELECT 1"],
        None,
    )
    listed = query_api._statements_from_request(
        ScriptQueryRequest(execution_id="x", statements=[" SELECT 1 ", "", "  "])
    )
    assert listed == (["SELECT 1"], None)


def test_echo_and_serialization_helpers():
    assert query_api._echo_statements(["a", "b"], 4).endswith(
        "2 more statement(s) omitted"
    )
    assert query_api._echo_statements(["a"], 1) == "a"
    assert query_api._serialize(2**60) == str(2**60)
    assert query_api._serialize(datetime.timedelta(seconds=1)) == "00:00:01"
    assert query_api._serialize(datetime.date(2026, 1, 2)) == "2026-01-02"
    assert query_api._serialize(decimal.Decimal("1.25")) == "1.25"
    assert query_api._serialize(b"\x00\xff") == "0x00ff"
    assert query_api._serialize("plain") == "plain"


def test_row_key_validation_errors():
    key = RowKey(columns=("id",), kind="primary")
    with pytest.raises(query_api._RowKeyError, match="must include"):
        query_api._check_row_key(key, {"other": 1})
    with pytest.raises(query_api._RowKeyError, match="NULL"):
        query_api._check_row_key(key, {"id": None})
    with pytest.raises(query_api._RowKeyError, match="required"):
        query_api._check_row_key(None, {})
    assert query_api._check_row_key(key, {"id": 1}) is True
    assert query_api._check_row_key(None, {"name": "x"}) is False


@pytest.mark.asyncio
async def test_rollback_and_discard_helpers(monkeypatch):
    class Broken:
        async def rollback(self):
            raise RuntimeError("no")

    await query_api._rollback_quietly(Broken())

    class Conn:
        closed = False

        def close(self):
            self.closed = True

    conn = Conn()
    query_api._discard_lease_connection(conn)
    assert conn.closed is True


@pytest.mark.asyncio
async def test_query_execution_tracking_edges(monkeypatch):
    query_api._active_query_executions.clear()
    query_api._cancelled_query_executions.clear()
    key = await query_api._begin_query_execution("s", "e", "alice")
    with pytest.raises(HTTPException, match="already active"):
        await query_api._begin_query_execution("s", "e", "alice")

    query_api._cancelled_query_executions.add(key)
    assert await query_api._register_query_thread("s", key, 42, "alice") is True
    query_api._cancelled_query_executions.discard(key)
    assert await query_api._register_query_thread("s", key, 43, "alice") is False
    await query_api._finish_query_execution("s", key, 42)
    await query_api._finish_query_execution("s", key, 43)
    await query_api._finish_query_execution("s", None, None)


@pytest.mark.asyncio
async def test_scope_enforcement_edges(monkeypatch):
    scoped = SimpleNamespace(
        managed=True, selected_databases=["app"], managed_selected_databases=["app"]
    )
    with pytest.raises(HTTPException):
        query_api._require_statement_scope(scoped, "SELECT * FROM other.t", "app")
    with pytest.raises(HTTPException):
        query_api._require_statement_scope(scoped, "UPDATE t SET x=1", None)
    query_api._require_statement_scope(
        scoped, "SELECT * FROM information_schema.t", "app"
    )
    query_api._require_statement_scope(
        SimpleNamespace(
            managed=False, selected_databases=[], managed_selected_databases=[]
        ),
        "SELECT * FROM other.t",
        None,
    )
