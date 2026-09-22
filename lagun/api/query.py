"""Query execution, cell editing, row insert/delete."""

import asyncio
import datetime
import decimal
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Iterable

from fastapi import APIRouter, HTTPException, Request

from lagun.auth import request_username
from lagun.db.pool import DatabaseCapacityError, DatabaseConnectionError, get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, escape_value, format_mysql_time
from lagun.api.scope import effective_scope, require_db_scope
from lagun.api.sql_analysis import (
    add_row_limit,
    statement_kind,
    strip_comments_and_literals,
    target_table,
)
from lagun.api.sql_script import SqlScriptError, split_sql_script
from lagun.models.query import (
    QueryRequest,
    QueryResult,
    QueryTimings,
    ScriptQueryRequest,
    ScriptQueryResult,
    ScriptQueryValidationResult,
    ScriptQueryError,
    CellUpdateRequest,
    CellUpdateResult,
    RowUpdateRequest,
    RowUpdateResult,
    RowInsertRequest,
    RowInsertResult,
    RowDeleteRequest,
    RowDeleteResult,
    QueryKillResult,
)

router = APIRouter(tags=["query"])


@dataclass
class _ActiveQuery:
    thread_id: int | None
    owner_username: str | None
    execution_id: str | None = None
    started_at: str = ""
    started_epoch: float = 0
    database: str | None = None
    tab_id: str | None = None
    sql: str = ""


# Maps session_id to MySQL thread IDs and their LDAP owners. A None owner is the
# existing single-user mode, where session-wide cancellation remains available.
_active_queries: dict[str, dict[int, str | None]] = {}
# Maps one request-specific execution to its thread and LDAP owner. A None
# thread means the request is registered but has not acquired a connection yet.
_active_query_executions: dict[tuple[str, str], _ActiveQuery] = {}
_cancelled_query_executions: set[tuple[str, str]] = set()
_active_queries_lock = asyncio.Lock()
_active_script_queries: dict[str, dict[str, int | None]] = {}
_active_script_queries_lock = asyncio.Lock()
_active_script_details: dict[tuple[str, str], dict[str, Any]] = {}
_JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_BULK_MAX_STATEMENTS = int(os.getenv("LAGUN_BULK_MAX_STATEMENTS", "3000"))
_BULK_MAX_BODY_BYTES = int(os.getenv("LAGUN_BULK_MAX_BODY_BYTES", str(2 * 1024 * 1024)))
_BULK_MAX_STATEMENT_BYTES = int(
    os.getenv("LAGUN_BULK_MAX_STATEMENT_BYTES", str(64 * 1024))
)
_BULK_LOCK_WAIT_TIMEOUT_SECONDS = int(
    os.getenv("LAGUN_BULK_LOCK_WAIT_TIMEOUT_SECONDS", "5")
)
_BULK_MAX_RUNTIME_SECONDS = int(os.getenv("LAGUN_BULK_MAX_RUNTIME_SECONDS", "120"))
_QUERY_MAX_RUNTIME_SECONDS = float(os.getenv("LAGUN_QUERY_MAX_RUNTIME_SECONDS", "30"))
# Hard ceiling on rows returned by a single query, independent of the session's
# own query_limit. A caller can ask for at most this many rows, so a result set
# can never be sized by the request alone.
_QUERY_MAX_RESULT_ROWS = int(os.getenv("LAGUN_QUERY_MAX_RESULT_ROWS", "100000"))
_BULK_PREVIEW_CHARS = 160
# How many rendered DELETE statements a bulk row-delete echoes back. The response
# is a convenience for the query log, not a record, so it is capped rather than
# grown with the request.
_ROW_DELETE_MAX_ECHO = 50
_NONTRANSACTIONAL_ENGINES = {
    "MYISAM",
    "MEMORY",
    "CSV",
    "ARCHIVE",
    "BLACKHOLE",
    "FEDERATED",
}


async def _get_pool_or_404(session_id: str):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return await get_pool(session_id), s


def _script_error(code: str, problem: str, cause: str, fix: str) -> ScriptQueryError:
    return ScriptQueryError(
        code=code,
        problem=problem,
        cause=cause,
        fix=fix,
        docs_url=f"/docs/bulk-execution#{code.lower().replace('_', '-')}",
    )


def _preview_statement(statement: str) -> str:
    return re.sub(r"\s+", " ", statement).strip()[:_BULK_PREVIEW_CHARS]


def _is_lock_wait_timeout(exc: BaseException) -> bool:
    errno = getattr(exc, "args", [None])[0] if getattr(exc, "args", None) else None
    return errno == 1205 or "lock wait timeout" in str(exc).lower()


def _validate_script_statements(statements: list[str]) -> ScriptQueryValidationResult:
    if not statements:
        return ScriptQueryValidationResult(
            ok=False,
            statement_count=0,
            operation_counts={},
            error=_script_error(
                "EMPTY_SCRIPT",
                "No SQL statements were found.",
                "The submitted script is empty.",
                "Add INSERT, UPDATE, or DELETE statements.",
            ),
        )
    if len(statements) > _BULK_MAX_STATEMENTS:
        return ScriptQueryValidationResult(
            ok=False,
            statement_count=len(statements),
            operation_counts={},
            error=_script_error(
                "TOO_MANY_STATEMENTS",
                f"Large write script is over the {_BULK_MAX_STATEMENTS} statement limit.",
                f"The script contains {len(statements)} statements.",
                "Split the script into smaller batches.",
            ),
        )

    counts: dict[str, int] = {"INSERT": 0, "UPDATE": 0, "DELETE": 0}
    for idx, statement in enumerate(statements):
        if len(statement.encode("utf-8")) > _BULK_MAX_STATEMENT_BYTES:
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error(
                    "STATEMENT_TOO_LARGE",
                    "A statement is too large for large write script execution.",
                    f"Statement {idx + 1} exceeds the per-statement byte limit.",
                    "Split or shrink this statement.",
                ),
            )
        normalized = strip_comments_and_literals(statement)
        upper = normalized.upper()
        kind = statement_kind(statement)
        if kind not in counts:
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error(
                    "UNSUPPORTED_STATEMENT",
                    "Large write scripts only accept INSERT, UPDATE, and DELETE.",
                    f"Statement {idx + 1} starts with {kind or 'unknown SQL'}.",
                    "Run mixed scripts with the normal query path or remove unsupported statements.",
                ),
            )
        if kind == "INSERT" and not re.search(r"\bVALUES\b", upper):
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error(
                    "UNSUPPORTED_INSERT",
                    "Large write scripts only accept INSERT ... VALUES.",
                    f"Statement {idx + 1} is not an INSERT ... VALUES form.",
                    "Rewrite it as INSERT ... VALUES or run it normally.",
                ),
            )
        if "/*!" in statement or re.search(
            r"\bON\s+DUPLICATE\s+KEY\b|\b(WITH|SELECT|CALL|USE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|LOAD|LOCK|UNLOCK|START|BEGIN|COMMIT|ROLLBACK)\b",
            upper,
        ):
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error(
                    "UNSUPPORTED_STATEMENT",
                    "This write form is not eligible for large write script execution.",
                    f"Statement {idx + 1} uses SQL outside the supported write grammar.",
                    "Use simple INSERT VALUES, UPDATE ... WHERE, or DELETE ... WHERE statements.",
                ),
            )
        if target_table(statement) is None:
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error(
                    "UNSUPPORTED_STATEMENT",
                    "Large write scripts only accept simple single-table writes.",
                    f"Statement {idx + 1} target table could not be parsed unambiguously.",
                    "Use simple INSERT INTO table, UPDATE table SET, or DELETE FROM table WHERE forms.",
                ),
            )
        if kind in {"UPDATE", "DELETE"} and not re.search(r"\bWHERE\b", upper):
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error(
                    "MISSING_WHERE",
                    f"{kind} statements need WHERE in large write scripts.",
                    f"Statement {idx + 1} has no detectable WHERE clause.",
                    "Add a WHERE clause or run the statement manually.",
                ),
            )
        counts[kind] += 1

    return ScriptQueryValidationResult(
        ok=True, statement_count=len(statements), operation_counts=counts
    )


def _statements_from_request(
    req: ScriptQueryRequest,
) -> tuple[list[str] | None, ScriptQueryError | None]:
    has_sql = bool(req.sql and req.sql.strip())
    has_statements = bool(req.statements)
    if has_sql == has_statements:
        return None, _script_error(
            "INVALID_REQUEST",
            "Provide exactly one script input.",
            "The request must include either sql or statements.",
            "Send pasted SQL in the sql field.",
        )
    if has_sql:
        raw = req.sql or ""
        if len(raw.encode("utf-8")) > _BULK_MAX_BODY_BYTES:
            return None, _script_error(
                "BODY_TOO_LARGE",
                "Large write script is too large.",
                "The submitted SQL body exceeds the server byte limit.",
                "Split the script into smaller batches.",
            )
        try:
            return split_sql_script(raw), None
        except SqlScriptError as error:
            return None, _script_error(
                "PARSE_ERROR",
                "The SQL script could not be parsed.",
                str(error),
                "Fix the quoted string, comment, delimiter, or statement size and retry.",
            )
    return [s.strip() for s in req.statements or [] if s.strip()], None


async def _check_transactional_targets(
    cur, statements: list[str]
) -> tuple[int, str, ScriptQueryError] | None:
    await cur.execute("SELECT DATABASE()")
    row = await cur.fetchone()
    current_database = row[0] if row else None

    seen_engines: dict[tuple[str, str], str] = {}
    for idx, statement in enumerate(statements):
        target = target_table(statement)
        if target is None:
            continue
        database, table = target
        if database is None and not current_database:
            return (
                idx,
                _preview_statement(statement),
                _script_error(
                    "NO_DATABASE_SELECTED",
                    "Large write scripts need a selected database.",
                    "Unqualified table names cannot be checked without a current database.",
                    "Select a database or qualify each table as database.table.",
                ),
            )
        database = database or current_database
        cache_key = (database, table)
        if cache_key in seen_engines:
            engine = seen_engines[cache_key]
        else:
            await cur.execute(
                "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s",
                (database, table),
            )
            row = await cur.fetchone()
            if not row or row[0] is None:
                seen_engines[cache_key] = ""
                continue
            engine = str(row[0]).upper()
            seen_engines[cache_key] = engine
        if engine in _NONTRANSACTIONAL_ENGINES:
            return (
                idx,
                _preview_statement(statement),
                _script_error(
                    "NONTRANSACTIONAL_TABLE",
                    "Large write scripts cannot guarantee rollback for this table.",
                    f"Statement {idx + 1} targets {database}.{table}, which uses the non-transactional {engine.lower()} engine.",
                    "Convert the table to InnoDB or run this script manually after accepting that rollback is not guaranteed.",
                ),
            )
    return None


def _script_scope_error(
    statements: list[str], scope: frozenset[str] | None, current_database: str | None
) -> tuple[int, str, ScriptQueryError] | None:
    """First statement that targets a schema outside the connection's scope.

    The bulk path is a write path like any other, so it gets the same scope rule
    as the single-statement endpoints — including for schema-qualified
    statements, which is why the target is resolved per statement rather than
    trusting the request's ``database``.
    """
    if scope is None:
        return None
    for idx, statement in enumerate(statements):
        target = target_table(statement)
        if target is None:
            continue
        database, _ = target
        resolved = database or current_database
        if resolved and resolved not in scope:
            return (
                idx,
                _preview_statement(statement),
                _script_error(
                    "OUT_OF_SCOPE_DATABASE",
                    "Large write script targets a database this connection cannot use.",
                    f"Statement {idx + 1} targets {resolved}, which is outside this "
                    "connection's allowed databases.",
                    "Remove the statement, or ask an administrator to extend this "
                    "connection's allowed databases.",
                ),
            )
    return None


class _QueryCancelled(Exception):
    pass


def _elapsed_ms(started: float) -> float:
    return round((time.monotonic() - started) * 1000, 2)


async def _begin_query_execution(
    session_id: str,
    execution_id: str | None,
    owner_username: str | None,
    *,
    database: str | None = None,
    tab_id: str | None = None,
    sql: str = "",
) -> tuple[str, str]:
    tracking_id = execution_id or f"auto-{uuid.uuid4().hex}"
    key = (session_id, tracking_id)
    async with _active_queries_lock:
        if key in _active_query_executions:
            raise HTTPException(409, "Query execution ID is already active")
        _active_query_executions[key] = _ActiveQuery(
            thread_id=None,
            owner_username=owner_username,
            execution_id=execution_id,
            started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            started_epoch=time.time(),
            tab_id=tab_id,
            sql=sql,
        )
        _cancelled_query_executions.discard(key)
    return key


async def _register_query_thread(
    session_id: str,
    execution_key: tuple[str, str] | None,
    thread_id: int,
    owner_username: str | None,
) -> bool:
    async with _active_queries_lock:
        _active_queries.setdefault(session_id, {})[thread_id] = owner_username
        if execution_key is not None:
            active = _active_query_executions.get(execution_key)
            if active is not None:
                active.thread_id = thread_id
                active.owner_username = owner_username
            return execution_key in _cancelled_query_executions
    return False


async def _is_query_cancelled(
    execution_key: tuple[str, str] | None,
) -> bool:
    if execution_key is None:
        return False
    async with _active_queries_lock:
        return execution_key in _cancelled_query_executions


async def _finish_query_execution(
    session_id: str,
    execution_key: tuple[str, str] | None,
    thread_id: int | None,
) -> None:
    async with _active_queries_lock:
        if thread_id is not None:
            queries = _active_queries.get(session_id)

            if queries is not None:
                queries.pop(thread_id, None)
                if not queries:
                    del _active_queries[session_id]
        if execution_key is not None:
            _active_query_executions.pop(execution_key, None)
            _cancelled_query_executions.discard(execution_key)


async def list_active_queries() -> list[dict[str, Any]]:
    """Return live normal and bulk executions for the admin workspace view."""
    async with _active_queries_lock:
        normal = [
            {
                "session_id": session_id,
                "execution_id": active.execution_id or key[1],
                "username": active.owner_username or "local",
                "database": active.database,
                "tab_id": active.tab_id,
                "sql": active.sql,
                "started_at": active.started_at,
                "elapsed_ms": round(
                    max(0, time.time() - active.started_epoch) * 1000, 2
                ),
                "state": "running" if active.thread_id is not None else "queued",
                "kind": "query",
            }
            for (session_id, key), active in _active_query_executions.items()
        ]
    async with _active_script_queries_lock:
        scripts = [
            {
                "session_id": session_id,
                "execution_id": execution_id,
                "username": details.get("username") or "local",
                "database": details.get("database"),
                "tab_id": details.get("tab_id"),
                "sql": details.get("sql", ""),
                "started_at": details.get("started_at", ""),
                "elapsed_ms": round(
                    max(0, time.time() - details.get("started_epoch", time.time()))
                    * 1000,
                    2,
                ),
                "state": "running" if thread_id is not None else "queued",
                "kind": "bulk",
            }
            for session_id, executions in _active_script_queries.items()
            for execution_id, thread_id in executions.items()
            for details in [_active_script_details.get((session_id, execution_id), {})]
        ]
    rows = normal + scripts
    for row in rows:
        session = await get_session(row["session_id"])
        if session:
            row.update(
                {
                    "session_name": session.name,
                    "host": session.host,
                    "port": session.port,
                }
            )
    return rows


async def _kill_query_threads(session_id: str, thread_ids: list[int]) -> None:
    if not thread_ids:
        return
    pool, _ = await _get_pool_or_404(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            for thread_id in thread_ids:
                await cur.execute(f"KILL QUERY {thread_id}")


def _query_timings(
    started: float,
    *,
    pool_wait_ms: float,
    setup_ms: float,
    execute_ms: float,
    fetch_ms: float,
    value_serialize_ms: float,
) -> QueryTimings:
    return QueryTimings(
        pool_wait_ms=pool_wait_ms,
        setup_ms=setup_ms,
        execute_ms=execute_ms,
        fetch_ms=fetch_ms,
        value_serialize_ms=value_serialize_ms,
        total_ms=_elapsed_ms(started),
    )


@router.post("/sessions/{session_id}/query", response_model=QueryResult)
async def execute_query(session_id: str, req: QueryRequest, request: Request):
    started = time.monotonic()
    owner_username = request_username(request)
    execution_key = await _begin_query_execution(
        session_id,
        req.execution_id,
        owner_username,
        database=req.database,
        tab_id=req.tab_id,
        sql=req.sql,
    )
    thread_id: int | None = None
    pool_wait_ms = 0.0
    setup_ms = 0.0
    execute_ms = 0.0
    fetch_ms = 0.0
    value_serialize_ms = 0.0
    deadline_error = (
        f"Query exceeded the {_QUERY_MAX_RUNTIME_SECONDS:g}-second execution limit"
    )
    try:
        if await _is_query_cancelled(execution_key):
            raise _QueryCancelled
        pool, session = await _get_pool_or_404(session_id)
        effective_db = req.database or session.default_db
        # Scope enforcement resolves req.database and then session.default_db, so
        # omitting the database cannot bypass the check, and a managed connection
        # is bounded by the administrator's ceiling (see lagun/api/scope.py).
        #
        # Known limitation: this guards the connection's current database only.
        # Free-form SQL naming another schema (``SELECT * FROM other_db.tbl``) is
        # not scanned — parsing is fragile and bypassable via dynamic SQL and
        # prepared statements. The deeper gate remains the MySQL user's grants.
        require_db_scope(session, effective_db)
        sql = req.sql.strip().rstrip(";").strip()
        limit = min(req.limit or session.query_limit, _QUERY_MAX_RESULT_ROWS)

        # Every row-returning statement gets a LIMIT unless it already has a
        # top-level one. A prefix regex is not enough: `WITH ... SELECT` and
        # `/* hint */ SELECT` both return rows but match neither `^SELECT` nor a
        # naive LIMIT search, so they used to run unbounded. add_row_limit also
        # knows where a LIMIT may legally go (`SELECT ... FOR UPDATE`), and
        # returns None when the grammar has no room for one.
        limited = add_row_limit(sql, limit)
        if limited is not None:
            sql = limited

        pool_wait_started = time.monotonic()
        async with pool.acquire() as conn:
            pool_wait_ms = _elapsed_ms(pool_wait_started)
            try:
                async with asyncio.timeout(max(0.1, _QUERY_MAX_RUNTIME_SECONDS)):
                    async with conn.cursor() as cur:
                        setup_started = time.monotonic()
                        await cur.execute("SELECT CONNECTION_ID()")
                        row = await cur.fetchone()
                        thread_id = row[0]
                        cancelled = await _register_query_thread(
                            session_id,
                            execution_key,
                            thread_id,
                            owner_username,
                        )
                        if cancelled:
                            raise _QueryCancelled
                        if effective_db:
                            await cur.execute(f"USE {quote_ident(effective_db)}")
                        if await _is_query_cancelled(execution_key):
                            raise _QueryCancelled
                        setup_ms = _elapsed_ms(setup_started)

                        execute_started = time.monotonic()
                        await cur.execute(sql)
                        execute_ms = _elapsed_ms(execute_started)
                        if await _is_query_cancelled(execution_key):
                            raise _QueryCancelled
                        if cur.description:
                            columns = [d[0] for d in cur.description]
                            fetch_started = time.monotonic()
                            raw_rows = await cur.fetchall()
                            fetch_ms = _elapsed_ms(fetch_started)
                            serialize_started = time.monotonic()
                            # Serialize straight out of the driver's rows: an
                            # intermediate `[list(r) for r in ...]` copy would
                            # double peak memory for large result sets.
                            rows = [
                                [_serialize(value) for value in row] for row in raw_rows
                            ]
                            value_serialize_ms = _elapsed_ms(serialize_started)
                            timings = _query_timings(
                                started,
                                pool_wait_ms=pool_wait_ms,
                                setup_ms=setup_ms,
                                execute_ms=execute_ms,
                                fetch_ms=fetch_ms,
                                value_serialize_ms=value_serialize_ms,
                            )
                            return QueryResult(
                                columns=columns,
                                rows=rows,
                                row_count=len(rows),
                                exec_time_ms=timings.total_ms,
                                execution_id=req.execution_id,
                                timings=timings,
                            )
                        timings = _query_timings(
                            started,
                            pool_wait_ms=pool_wait_ms,
                            setup_ms=setup_ms,
                            execute_ms=execute_ms,
                            fetch_ms=fetch_ms,
                            value_serialize_ms=value_serialize_ms,
                        )
                        return QueryResult(
                            columns=[],
                            rows=[],
                            row_count=cur.rowcount,
                            exec_time_ms=timings.total_ms,
                            affected_rows=cur.rowcount,
                            insert_id=cur.lastrowid,
                            execution_id=req.execution_id,
                            timings=timings,
                        )
            except TimeoutError as error:
                conn.close()
                raise TimeoutError(deadline_error) from error
    except HTTPException:
        raise
    except (DatabaseCapacityError, DatabaseConnectionError):
        raise
    except _QueryCancelled:
        error = "Query cancelled"
    except Exception as exc:
        error = str(exc)
    finally:
        await _finish_query_execution(session_id, execution_key, thread_id)

    timings = _query_timings(
        started,
        pool_wait_ms=pool_wait_ms,
        setup_ms=setup_ms,
        execute_ms=execute_ms,
        fetch_ms=fetch_ms,
        value_serialize_ms=value_serialize_ms,
    )
    return QueryResult(
        columns=[],
        rows=[],
        row_count=0,
        exec_time_ms=timings.total_ms,
        error=error,
        execution_id=req.execution_id,
        timings=timings,
    )


@router.delete(
    "/sessions/{session_id}/query",
    response_model=QueryKillResult,
    response_model_exclude_unset=True,
)
async def kill_query(session_id: str, request: Request):
    owner_username = request_username(request)
    async with _active_queries_lock:
        execution_keys = [
            key
            for key, active_query in _active_query_executions.items()
            if key[0] == session_id
            and (
                owner_username is None or active_query.owner_username == owner_username
            )
        ]
        thread_ids = [
            thread_id
            for thread_id, query_owner in _active_queries.get(session_id, {}).items()
            if owner_username is None or query_owner == owner_username
        ]
        for key in execution_keys:
            _cancelled_query_executions.add(key)
    if not thread_ids and not execution_keys:
        return {"ok": False, "error": "No active query"}
    try:
        await _kill_query_threads(session_id, thread_ids)
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.delete(
    "/sessions/{session_id}/query/{execution_id}",
    response_model=QueryKillResult,
    response_model_exclude_unset=True,
)
async def kill_query_execution(
    session_id: str,
    execution_id: str,
    request: Request,
):
    key = (session_id, execution_id)
    owner_username = request_username(request)
    async with _active_queries_lock:
        active_query = _active_query_executions.get(key)
        if active_query is None or (
            owner_username is not None and active_query.owner_username != owner_username
        ):
            return {"ok": True}
        _cancelled_query_executions.add(key)
        thread_id = active_query.thread_id
    try:
        if thread_id is not None:
            await _kill_query_threads(session_id, [thread_id])
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post(
    "/sessions/{session_id}/query/script/validate",
    response_model=ScriptQueryValidationResult,
)
async def validate_script_query(session_id: str, req: ScriptQueryRequest):
    pool, session = await _get_pool_or_404(session_id)
    current_database = req.database or session.default_db
    require_db_scope(session, current_database)
    statements, err = _statements_from_request(req)
    if err:
        return ScriptQueryValidationResult(
            ok=False, statement_count=0, operation_counts={}, error=err
        )
    validation = _validate_script_statements(statements or [])
    if not validation.ok:
        return validation
    scope_error = _script_scope_error(
        statements or [], effective_scope(session), current_database
    )
    if scope_error:
        idx, preview, error = scope_error
        return ScriptQueryValidationResult(
            ok=False,
            statement_count=len(statements or []),
            operation_counts=validation.operation_counts,
            rejected_statement_index=idx,
            rejected_statement_preview=preview,
            error=error,
        )
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if req.database:
                await cur.execute(f"USE {quote_ident(req.database)}")
            target_error = await _check_transactional_targets(cur, statements or [])
            if target_error:
                idx, preview, error = target_error
                return ScriptQueryValidationResult(
                    ok=False,
                    statement_count=len(statements or []),
                    operation_counts=validation.operation_counts,
                    rejected_statement_index=idx,
                    rejected_statement_preview=preview,
                    error=error,
                )
    return validation


@router.post("/sessions/{session_id}/query/script", response_model=ScriptQueryResult)
async def execute_script_query(
    session_id: str, req: ScriptQueryRequest, request: Request
):
    pool, session = await _get_pool_or_404(session_id)
    current_database = req.database or session.default_db
    require_db_scope(session, current_database)
    t0 = time.monotonic()

    statements, err = _statements_from_request(req)
    if err:
        return ScriptQueryResult(
            ok=False,
            execution_id=req.execution_id,
            statements_executed=0,
            affected_rows=0,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            rolled_back=False,
            error=err,
        )

    validation = _validate_script_statements(statements or [])
    if not validation.ok:
        return ScriptQueryResult(
            ok=False,
            execution_id=req.execution_id,
            statements_executed=0,
            affected_rows=0,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            failed_statement_index=validation.rejected_statement_index,
            failed_statement_preview=validation.rejected_statement_preview,
            rolled_back=False,
            error=validation.error,
        )

    scope_error = _script_scope_error(
        statements or [], effective_scope(session), current_database
    )
    if scope_error:
        idx, preview, error = scope_error
        return ScriptQueryResult(
            ok=False,
            execution_id=req.execution_id,
            statements_executed=0,
            affected_rows=0,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            failed_statement_index=idx,
            failed_statement_preview=preview,
            rolled_back=False,
            error=error,
        )

    async with _active_script_queries_lock:
        if session_id in _active_script_queries and _active_script_queries[session_id]:
            return ScriptQueryResult(
                ok=False,
                execution_id=req.execution_id,
                statements_executed=0,
                affected_rows=0,
                exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
                error=_script_error(
                    "BULK_ALREADY_RUNNING",
                    "A large write script is already active for this session.",
                    "Only one large write script may run per session.",
                    "Wait for the active run to finish or cancel it.",
                ),
            )
        _active_script_queries.setdefault(session_id, {})[req.execution_id] = None
        _active_script_details[(session_id, req.execution_id)] = {
            "username": request_username(request),
            "database": req.database,
            "tab_id": req.tab_id,
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "started_epoch": time.time(),
            "sql": req.sql or "; ".join(req.statements or []),
        }

    thread_id = None
    statements_executed = 0
    affected_rows = 0
    failed_idx: int | None = None
    failed_preview: str | None = None
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT CONNECTION_ID()")
                row = await cur.fetchone()
                thread_id = row[0]
                async with _active_script_queries_lock:
                    _active_script_queries.setdefault(session_id, {})[
                        req.execution_id
                    ] = thread_id
                try:
                    if req.database:
                        await cur.execute(f"USE {quote_ident(req.database)}")
                    target_error = await _check_transactional_targets(
                        cur, statements or []
                    )
                    if target_error:
                        failed_idx, failed_preview, error = target_error
                        return ScriptQueryResult(
                            ok=False,
                            execution_id=req.execution_id,
                            statements_executed=0,
                            affected_rows=0,
                            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
                            failed_statement_index=failed_idx,
                            failed_statement_preview=failed_preview,
                            rolled_back=False,
                            error=error,
                        )
                    await cur.execute("SELECT @@innodb_lock_wait_timeout")
                    original_timeout = (await cur.fetchone())[0]
                    await cur.execute(
                        f"SET SESSION innodb_lock_wait_timeout={_BULK_LOCK_WAIT_TIMEOUT_SECONDS}"
                    )
                    await cur.execute("START TRANSACTION")
                    try:
                        for idx, statement in enumerate(statements or []):
                            if time.monotonic() - t0 > _BULK_MAX_RUNTIME_SECONDS:
                                failed_idx = idx
                                failed_preview = _preview_statement(statement)
                                raise TimeoutError(
                                    "Large write script exceeded max runtime"
                                )
                            await cur.execute(statement)
                            statements_executed += 1
                            if cur.rowcount and cur.rowcount > 0:
                                affected_rows += cur.rowcount
                        await cur.execute("COMMIT")
                    except BaseException:
                        try:
                            await cur.execute("ROLLBACK")
                        except Exception:
                            try:
                                await conn.close()
                            except Exception:
                                pass
                        raise
                    finally:
                        try:
                            await cur.execute(
                                f"SET SESSION innodb_lock_wait_timeout={original_timeout}"
                            )
                        except Exception:
                            pass
                finally:
                    async with _active_script_queries_lock:
                        active = _active_script_queries.get(session_id)
                        if active:
                            active.pop(req.execution_id, None)
                            if not active:
                                del _active_script_queries[session_id]
                        _active_script_details.pop((session_id, req.execution_id), None)

        return ScriptQueryResult(
            ok=True,
            execution_id=req.execution_id,
            statements_executed=statements_executed,
            affected_rows=affected_rows,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            rolled_back=False,
        )
    except Exception as exc:
        if failed_idx is None:
            failed_idx = statements_executed
            if statements and 0 <= failed_idx < len(statements):
                failed_preview = _preview_statement(statements[failed_idx])
        if isinstance(exc, TimeoutError):
            code = "MAX_RUNTIME_EXCEEDED"
            problem = "Large write script exceeded the max runtime and was rolled back."
            fix = "Split the script into smaller batches or raise LAGUN_BULK_MAX_RUNTIME_SECONDS."
        elif _is_lock_wait_timeout(exc):
            code = "LOCK_WAIT_TIMEOUT"
            problem = "Large write script could not finish because a row was locked."
            fix = "Try again later, reduce the script, or run during a quieter window."
        else:
            code = "SCRIPT_EXECUTION_FAILED"
            problem = "Large write script failed and was rolled back."
            fix = "Fix the failing statement and run the script again."
        return ScriptQueryResult(
            ok=False,
            execution_id=req.execution_id,
            statements_executed=statements_executed,
            affected_rows=affected_rows,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            failed_statement_index=failed_idx,
            failed_statement_preview=failed_preview,
            rolled_back=statements_executed > 0,
            error=_script_error(
                code,
                problem,
                f"Statement {(failed_idx or 0) + 1} failed: {exc}",
                fix,
            ),
        )
    finally:
        async with _active_script_queries_lock:
            active = _active_script_queries.get(session_id)
            if active:
                active.pop(req.execution_id, None)
                if not active:
                    del _active_script_queries[session_id]
            _active_script_details.pop((session_id, req.execution_id), None)


@router.delete(
    "/sessions/{session_id}/query/script/{execution_id}",
    response_model=QueryKillResult,
    response_model_exclude_unset=True,
)
async def kill_script_query(session_id: str, execution_id: str, request: Request):
    username = request_username(request)
    async with _active_script_queries_lock:
        details = _active_script_details.get((session_id, execution_id)) or {}
        owner = details.get("username")
        # Same rule as normal query cancellation: only the owner may cancel a
        # run, and a non-owner gets the same answer as for a nonexistent one so
        # execution ids cannot be probed.
        if owner is not None and username is not None and owner != username:
            return {"ok": False, "error": "No active large write script"}
        thread_id = _active_script_queries.get(session_id, {}).get(execution_id)
        if thread_id is None and execution_id in _active_script_queries.get(
            session_id, {}
        ):
            return {"ok": False, "error": "Large write script is starting"}
        if not thread_id:
            return {"ok": False, "error": "No active large write script"}
    try:
        pool, _ = await _get_pool_or_404(session_id)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(f"KILL QUERY {thread_id}")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _echo_statements(statements: list[str], total: int) -> str:
    """Join echoed SQL, noting how many statements were left out."""
    joined = ";\n".join(statements)
    omitted = max(0, total - len(statements))
    if omitted:
        return f"{joined}\n-- … {omitted} more statement(s) omitted"
    return joined


# MySQL types whose driver values arrive as bytes and must be written back as
# bytes, never as the hex text the grid displays.
_BINARY_DATA_TYPES = frozenset(
    {
        "binary",
        "varbinary",
        "blob",
        "tinyblob",
        "mediumblob",
        "longblob",
        "bit",
        "geometry",
        "point",
        "linestring",
        "polygon",
        "multipoint",
        "multilinestring",
        "multipolygon",
        "geometrycollection",
    }
)


def _serialize(v: Any) -> Any:
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > _JS_MAX_SAFE_INTEGER:
        return str(v)
    if isinstance(v, datetime.timedelta):
        # str(timedelta) is "1 day, 1:00:00", which is not a TIME literal and
        # cannot be replayed or written back.
        return format_mysql_time(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return str(v)
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, bytes):
        # Marked as hex so the value is unambiguously binary and can be decoded
        # again on the way back in (see _coerce_binary_columns).
        return "0x" + v.hex()
    return v


async def _column_data_types(
    cur, database: str, table: str, columns: Iterable[str]
) -> dict[str, str]:
    """DATA_TYPE per column, so a write can send bytes to a binary column."""
    names = [name for name in dict.fromkeys(columns) if name]
    if not names:
        return {}
    placeholders = ", ".join(["%s"] * len(names))
    await cur.execute(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS "
        f"WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND COLUMN_NAME IN ({placeholders})",
        (database, table, *names),
    )
    return {row[0]: str(row[1]).lower() for row in await cur.fetchall()}


def _coerce_binary_value(value: Any, data_type: str | None) -> Any:
    """Decode the grid's ``0x…`` text back into bytes for a binary column."""
    if data_type not in _BINARY_DATA_TYPES or not isinstance(value, str):
        return value
    body = value[2:] if value[:2].lower() == "0x" else value
    try:
        return bytes.fromhex(body)
    except ValueError:
        return value


def _coerce_binary_map(
    values: dict[str, Any], data_types: dict[str, str]
) -> dict[str, Any]:
    return {
        key: _coerce_binary_value(value, data_types.get(key))
        for key, value in values.items()
    }


def _build_pk_where(pk: dict[str, Any]) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    values: list[Any] = []
    for k, v in pk.items():
        if v is None:
            clauses.append(f"{quote_ident(k)} IS NULL")
        else:
            clauses.append(f"{quote_ident(k)} = %s")
            values.append(v)
    return " AND ".join(clauses), values


def _display_sql(sql: str, params: list[Any]) -> str:
    parts = sql.split("%s")
    display_parts: list[str] = []
    for i, part in enumerate(parts):
        display_parts.append(part)
        if i < len(params):
            display_parts.append(_display_value(params[i]))
    return "".join(display_parts)


def _display_value(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float, decimal.Decimal)) and not isinstance(value, bool):
        return str(value)
    return escape_value(str(value))


@router.post("/sessions/{session_id}/cell-update", response_model=CellUpdateResult)
async def cell_update(session_id: str, req: CellUpdateRequest):
    pool, session = await _get_pool_or_404(session_id)
    require_db_scope(session, req.database)
    display_sql = ""

    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        col_q = quote_ident(req.column)

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                data_types = await _column_data_types(
                    cur, req.database, req.table, [req.column, *req.primary_key]
                )
                pk_clauses, pk_values = _build_pk_where(
                    _coerce_binary_map(req.primary_key, data_types)
                )
                new_value = _coerce_binary_value(
                    req.new_value, data_types.get(req.column)
                )

                sql = f"UPDATE {db_q}.{tbl_q} SET {col_q} = %s WHERE {pk_clauses}"
                params = [new_value] + pk_values
                display_sql = _display_sql(sql, params)

                # Single-row writes had no deadline at all; a stuck statement
                # held a pooled connection for as long as the server allowed.
                async with asyncio.timeout(max(0.1, _QUERY_MAX_RUNTIME_SECONDS)):
                    await cur.execute(sql, params)
                    affected = cur.rowcount

        return CellUpdateResult(
            ok=True, affected_rows=affected, sql_executed=display_sql
        )
    except Exception as exc:
        return CellUpdateResult(
            ok=False, affected_rows=0, sql_executed=display_sql, error=str(exc)
        )


@router.post("/sessions/{session_id}/row-update", response_model=RowUpdateResult)
async def row_update(session_id: str, req: RowUpdateRequest):
    pool, session = await _get_pool_or_404(session_id)
    require_db_scope(session, req.database)
    display_sql = ""
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                data_types = await _column_data_types(
                    cur, req.database, req.table, [*req.updates, *req.primary_key]
                )
                updates = _coerce_binary_map(req.updates, data_types)
                pk_clauses, pk_values = _build_pk_where(
                    _coerce_binary_map(req.primary_key, data_types)
                )
                set_clauses = ", ".join(f"{quote_ident(col)} = %s" for col in updates)
                sql = f"UPDATE {db_q}.{tbl_q} SET {set_clauses} WHERE {pk_clauses}"
                params = list(updates.values()) + pk_values
                display_sql = _display_sql(sql, params)

                async with asyncio.timeout(max(0.1, _QUERY_MAX_RUNTIME_SECONDS)):
                    await cur.execute(sql, params)
                    affected = cur.rowcount

        return RowUpdateResult(
            ok=True, affected_rows=affected, sql_executed=display_sql
        )
    except Exception as exc:
        return RowUpdateResult(
            ok=False, affected_rows=0, sql_executed=display_sql, error=str(exc)
        )


@router.post("/sessions/{session_id}/row-insert", response_model=RowInsertResult)
async def row_insert(session_id: str, req: RowInsertRequest):
    pool, session = await _get_pool_or_404(session_id)
    require_db_scope(session, req.database)
    display_sql = ""
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                data_types = await _column_data_types(
                    cur, req.database, req.table, req.values
                )
                values = _coerce_binary_map(req.values, data_types)
                if values:
                    cols = ", ".join(quote_ident(c) for c in values)
                    placeholders = ", ".join("%s" for _ in values)
                    sql = f"INSERT INTO {db_q}.{tbl_q} ({cols}) VALUES ({placeholders})"
                else:
                    sql = f"INSERT INTO {db_q}.{tbl_q} () VALUES ()"
                params = list(values.values())
                display_sql = _display_sql(sql, params)
                async with asyncio.timeout(max(0.1, _QUERY_MAX_RUNTIME_SECONDS)):
                    await cur.execute(sql, params)
                return RowInsertResult(
                    ok=True,
                    insert_id=cur.lastrowid,
                    affected_rows=cur.rowcount,
                    sql_executed=display_sql,
                )
    except Exception as exc:
        return RowInsertResult(ok=False, sql_executed=display_sql, error=str(exc))


@router.delete("/sessions/{session_id}/rows", response_model=RowDeleteResult)
async def row_delete(session_id: str, req: RowDeleteRequest):
    pool, session = await _get_pool_or_404(session_id)
    require_db_scope(session, req.database)
    display_sqls: list[str] = []
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        total_affected = 0
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SET autocommit=0")
                await cur.execute("SELECT @@autocommit")
                autocommit_row = await cur.fetchone()
                if autocommit_row and autocommit_row[0]:
                    raise RuntimeError(
                        "Failed to disable autocommit for transactional delete"
                    )
                data_types = await _column_data_types(
                    cur,
                    req.database,
                    req.table,
                    [key for pk in req.primary_keys for key in pk],
                )
                try:
                    # The whole batch shares one transaction, so it also shares
                    # one deadline: a huge key list must not hold a pooled
                    # connection and row locks indefinitely.
                    async with asyncio.timeout(max(0.1, _QUERY_MAX_RUNTIME_SECONDS)):
                        for pk in req.primary_keys:
                            pk_clauses, pk_values = _build_pk_where(
                                _coerce_binary_map(pk, data_types)
                            )
                            sql = f"DELETE FROM {db_q}.{tbl_q} WHERE {pk_clauses}"
                            if len(display_sqls) < _ROW_DELETE_MAX_ECHO:
                                display_sqls.append(_display_sql(sql, pk_values))
                            await cur.execute(sql, pk_values)
                            total_affected += cur.rowcount
                    await cur.execute("COMMIT")
                except Exception:
                    await cur.execute("ROLLBACK")
                    raise
                finally:
                    await cur.execute("SET autocommit=1")
        return RowDeleteResult(
            ok=True,
            affected_rows=total_affected,
            sql_executed=_echo_statements(display_sqls, len(req.primary_keys)),
        )
    except Exception as exc:
        return RowDeleteResult(
            ok=False,
            affected_rows=0,
            sql_executed=_echo_statements(display_sqls, len(req.primary_keys)),
            error=(
                f"Delete exceeded the {_QUERY_MAX_RUNTIME_SECONDS:g}-second limit "
                "and was rolled back."
                if isinstance(exc, TimeoutError)
                else str(exc)
            ),
        )
