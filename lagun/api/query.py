"""Query execution, cell editing, row insert/delete."""
import asyncio
import datetime
import decimal
import os
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, escape_string_literal
from lagun.models.query import (
    QueryRequest, QueryResult,
    ScriptQueryRequest, ScriptQueryResult, ScriptQueryValidationResult, ScriptQueryError,
    CellUpdateRequest, CellUpdateResult,
    RowUpdateRequest, RowUpdateResult,
    RowInsertRequest, RowInsertResult,
    RowDeleteRequest, RowDeleteResult,
)

router = APIRouter(tags=["query"])

# Maps session_id → set of MySQL thread_ids of currently running queries
_active_queries: dict[str, set[int]] = {}
_active_script_queries: dict[str, dict[str, int | None]] = {}
_active_script_queries_lock = asyncio.Lock()
_JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_BULK_MAX_STATEMENTS = int(os.getenv("LAGUN_BULK_MAX_STATEMENTS", "3000"))
_BULK_MAX_BODY_BYTES = int(os.getenv("LAGUN_BULK_MAX_BODY_BYTES", str(2 * 1024 * 1024)))
_BULK_MAX_STATEMENT_BYTES = int(os.getenv("LAGUN_BULK_MAX_STATEMENT_BYTES", str(64 * 1024)))
_BULK_LOCK_WAIT_TIMEOUT_SECONDS = int(os.getenv("LAGUN_BULK_LOCK_WAIT_TIMEOUT_SECONDS", "5"))
_BULK_MAX_RUNTIME_SECONDS = int(os.getenv("LAGUN_BULK_MAX_RUNTIME_SECONDS", "120"))
_BULK_PREVIEW_CHARS = 160
_NONTRANSACTIONAL_ENGINES = {"MYISAM", "MEMORY", "CSV", "ARCHIVE", "BLACKHOLE", "FEDERATED"}
_SQL_IDENTIFIER_RE = r"(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)"
_SQL_TABLE_REF_RE = rf"(?P<first>{_SQL_IDENTIFIER_RE})(?:\s*\.\s*(?P<second>{_SQL_IDENTIFIER_RE}))?"


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


def _split_sql_script(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    in_single = in_double = in_backtick = False
    in_line_comment = in_block_comment = False
    i = 0
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if in_line_comment:
            current.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            current.append(ch)
            if ch == "*" and nxt == "/":
                current.append(nxt)
                i += 2
                in_block_comment = False
            else:
                i += 1
            continue
        if in_single:
            current.append(ch)
            if ch == "\\" and nxt == "'":
                current.append(nxt)
                i += 2
            elif ch == "'" and nxt == "'":
                current.append(nxt)
                i += 2
            elif ch == "'":
                in_single = False
                i += 1
            else:
                i += 1
            continue
        if in_double:
            current.append(ch)
            if ch == '"':
                in_double = False
            i += 1
            continue
        if in_backtick:
            current.append(ch)
            if ch == "`":
                in_backtick = False
            i += 1
            continue
        if ch == "-" and nxt == "-":
            current.extend([ch, nxt])
            in_line_comment = True
            i += 2
            continue
        if ch == "#":
            current.append(ch)
            in_line_comment = True
            i += 1
            continue
        if ch == "/" and nxt == "*":
            current.extend([ch, nxt])
            in_block_comment = True
            i += 2
            continue
        if ch == "'":
            in_single = True
            current.append(ch)
            i += 1
            continue
        if ch == '"':
            in_double = True
            current.append(ch)
            i += 1
            continue
        if ch == "`":
            in_backtick = True
            current.append(ch)
            i += 1
            continue
        if ch == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1

    statement = "".join(current).strip()
    if statement:
        statements.append(statement)
    return statements


def _strip_comments_and_literals(sql: str) -> str:
    result: list[str] = []
    i = 0
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if ch == "-" and nxt == "-":
            i += 2
            while i < len(sql) and sql[i] != "\n":
                i += 1
            result.append(" ")
        elif ch == "#":
            i += 1
            while i < len(sql) and sql[i] != "\n":
                i += 1
            result.append(" ")
        elif ch == "/" and nxt == "*":
            if i + 2 < len(sql) and sql[i + 2] == "!":
                result.append("/*! ")
            i += 2
            while i + 1 < len(sql) and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i += 2
            result.append(" ")
        elif ch == "'":
            i += 1
            while i < len(sql):
                if sql[i] == "\\" and i + 1 < len(sql) and sql[i + 1] == "'":
                    i += 2
                elif sql[i] == "'" and i + 1 < len(sql) and sql[i + 1] == "'":
                    i += 2
                elif sql[i] == "'":
                    i += 1
                    break
                else:
                    i += 1
            result.append("''")
        elif ch == '"':
            i += 1
            while i < len(sql):
                if sql[i] == '"' and i + 1 < len(sql) and sql[i + 1] == '"':
                    i += 2
                elif sql[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
            result.append('""')
        elif ch == "`":
            result.append("`")
            i += 1
            while i < len(sql) and sql[i] != "`":
                result.append("_")
                i += 1
            if i < len(sql):
                result.append("`")
                i += 1
        else:
            result.append(ch)
            i += 1
    return "".join(result)


def _statement_kind(statement: str) -> str | None:
    stripped = _strip_comments_and_literals(statement)
    m = re.search(r"\b([A-Za-z]+)\b", stripped)
    return m.group(1).upper() if m else None


def _unquote_sql_identifier(identifier: str) -> str:
    identifier = identifier.strip()
    if identifier.startswith("`") and identifier.endswith("`"):
        return identifier[1:-1].replace("``", "`")
    return identifier


def _target_table(statement: str) -> tuple[str | None, str] | None:
    prefix = r"^\s*(?:(?:--[^\n]*\n|#[^\n]*\n|/\*[^!][\s\S]*?\*/)\s*)*"
    ws_or_end = r"(?:\s|$)"
    patterns = [
        rf"{prefix}INSERT\s+(?:IGNORE\s+)?INTO\s+{_SQL_TABLE_REF_RE}{ws_or_end}",
        rf"{prefix}UPDATE\s+{_SQL_TABLE_REF_RE}\s+SET\b",
        rf"{prefix}DELETE\s+FROM\s+{_SQL_TABLE_REF_RE}\s+WHERE\b",
        rf"{prefix}DELETE\s+FROM\s+{_SQL_TABLE_REF_RE}{ws_or_end}",
    ]
    for pattern in patterns:
        m = re.search(pattern, statement, re.IGNORECASE)
        if not m:
            continue
        first = _unquote_sql_identifier(m.group("first"))
        second = m.group("second")
        if second:
            return first, _unquote_sql_identifier(second)
        return None, first
    return None


def _validate_script_statements(statements: list[str]) -> ScriptQueryValidationResult:
    if not statements:
        return ScriptQueryValidationResult(
            ok=False,
            statement_count=0,
            operation_counts={},
            error=_script_error("EMPTY_SCRIPT", "No SQL statements were found.", "The submitted script is empty.", "Add INSERT, UPDATE, or DELETE statements."),
        )
    if len(statements) > _BULK_MAX_STATEMENTS:
        return ScriptQueryValidationResult(
            ok=False,
            statement_count=len(statements),
            operation_counts={},
            error=_script_error("TOO_MANY_STATEMENTS", f"Large write script is over the {_BULK_MAX_STATEMENTS} statement limit.", f"The script contains {len(statements)} statements.", "Split the script into smaller batches."),
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
                error=_script_error("STATEMENT_TOO_LARGE", "A statement is too large for large write script execution.", f"Statement {idx + 1} exceeds the per-statement byte limit.", "Split or shrink this statement."),
            )
        normalized = _strip_comments_and_literals(statement)
        upper = normalized.upper()
        kind = _statement_kind(statement)
        if kind not in counts:
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error("UNSUPPORTED_STATEMENT", "Large write scripts only accept INSERT, UPDATE, and DELETE.", f"Statement {idx + 1} starts with {kind or 'unknown SQL'}.", "Run mixed scripts with the normal query path or remove unsupported statements."),
            )
        if kind == "INSERT" and not re.search(r"\bVALUES\b", upper):
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error("UNSUPPORTED_INSERT", "Large write scripts only accept INSERT ... VALUES.", f"Statement {idx + 1} is not an INSERT ... VALUES form.", "Rewrite it as INSERT ... VALUES or run it normally."),
            )
        if "/*!" in upper or re.search(r"\bON\s+DUPLICATE\s+KEY\b|\b(WITH|SELECT|CALL|USE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|LOAD|LOCK|UNLOCK|START|BEGIN|COMMIT|ROLLBACK)\b", upper):
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error("UNSUPPORTED_STATEMENT", "This write form is not eligible for large write script execution.", f"Statement {idx + 1} uses SQL outside the supported write grammar.", "Use simple INSERT VALUES, UPDATE ... WHERE, or DELETE ... WHERE statements."),
            )
        if _target_table(statement) is None:
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error("UNSUPPORTED_STATEMENT", "Large write scripts only accept simple single-table writes.", f"Statement {idx + 1} target table could not be parsed unambiguously.", "Use simple INSERT INTO table, UPDATE table SET, or DELETE FROM table WHERE forms."),
            )
        if kind in {"UPDATE", "DELETE"} and not re.search(r"\bWHERE\b", upper):
            return ScriptQueryValidationResult(
                ok=False,
                statement_count=len(statements),
                operation_counts=counts,
                rejected_statement_index=idx,
                rejected_statement_preview=_preview_statement(statement),
                error=_script_error("MISSING_WHERE", f"{kind} statements need WHERE in large write scripts.", f"Statement {idx + 1} has no detectable WHERE clause.", "Add a WHERE clause or run the statement manually."),
            )
        counts[kind] += 1

    return ScriptQueryValidationResult(ok=True, statement_count=len(statements), operation_counts=counts)


def _statements_from_request(req: ScriptQueryRequest) -> tuple[list[str] | None, ScriptQueryError | None]:
    has_sql = bool(req.sql and req.sql.strip())
    has_statements = bool(req.statements)
    if has_sql == has_statements:
        return None, _script_error("INVALID_REQUEST", "Provide exactly one script input.", "The request must include either sql or statements.", "Send pasted SQL in the sql field.")
    if has_sql:
        raw = req.sql or ""
        if len(raw.encode("utf-8")) > _BULK_MAX_BODY_BYTES:
            return None, _script_error("BODY_TOO_LARGE", "Large write script is too large.", "The submitted SQL body exceeds the server byte limit.", "Split the script into smaller batches.")
        return _split_sql_script(raw), None
    return [s.strip() for s in req.statements or [] if s.strip()], None


async def _check_transactional_targets(cur, statements: list[str]) -> tuple[int, str, ScriptQueryError] | None:
    await cur.execute("SELECT DATABASE()")
    row = await cur.fetchone()
    current_database = row[0] if row else None

    seen_engines: dict[tuple[str, str], str] = {}
    for idx, statement in enumerate(statements):
        target = _target_table(statement)
        if target is None:
            continue
        database, table = target
        if database is None and not current_database:
            return (
                idx,
                _preview_statement(statement),
                _script_error("NO_DATABASE_SELECTED", "Large write scripts need a selected database.", "Unqualified table names cannot be checked without a current database.", "Select a database or qualify each table as database.table."),
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


@router.post("/sessions/{session_id}/query", response_model=QueryResult)
async def execute_query(session_id: str, req: QueryRequest):
    pool, session = await _get_pool_or_404(session_id)

    sql = req.sql.strip().rstrip(';').strip()
    limit = req.limit or session.query_limit

    # Auto-append LIMIT for plain SELECT without existing LIMIT
    is_select = re.match(r'^\s*SELECT\b', sql, re.IGNORECASE)
    has_limit = re.search(r'\bLIMIT\b', _strip_quotes(sql), re.IGNORECASE)
    if is_select and not has_limit:
        sql = f"{sql} LIMIT {limit}"

    t0 = time.monotonic()
    thread_id = None
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                # Register connection thread_id so it can be killed if needed
                await cur.execute("SELECT CONNECTION_ID()")
                row = await cur.fetchone()
                thread_id = row[0]
                if session_id not in _active_queries:
                    _active_queries[session_id] = set()
                _active_queries[session_id].add(thread_id)
                try:
                    if req.database:
                        await cur.execute(f"USE {quote_ident(req.database)}")
                    await cur.execute(sql)
                    if cur.description:
                        columns = [d[0] for d in cur.description]
                        rows = [list(r) for r in (await cur.fetchall())]
                        # Serialize non-JSON-native types
                        rows = [[_serialize(v) for v in row] for row in rows]
                        return QueryResult(
                            columns=columns,
                            rows=rows,
                            row_count=len(rows),
                            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
                        )
                    else:
                        return QueryResult(
                            columns=[],
                            rows=[],
                            row_count=cur.rowcount,
                            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
                            affected_rows=cur.rowcount,
                            insert_id=cur.lastrowid,
                        )
                finally:
                    _active_queries[session_id].discard(thread_id)
                    if not _active_queries[session_id]:
                        del _active_queries[session_id]
    except Exception as exc:
        if thread_id is not None:
            queries = _active_queries.get(session_id)
            if queries:
                queries.discard(thread_id)
                if not queries:
                    del _active_queries[session_id]
        return QueryResult(
            columns=[], rows=[], row_count=0,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            error=str(exc),
        )


@router.delete("/sessions/{session_id}/query")
async def kill_query(session_id: str):
    thread_ids = _active_queries.get(session_id)
    if not thread_ids:
        return {"ok": False, "error": "No active query"}
    try:
        pool, _ = await _get_pool_or_404(session_id)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                for thread_id in list(thread_ids):
                    await cur.execute(f"KILL QUERY {thread_id}")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/sessions/{session_id}/query/script/validate", response_model=ScriptQueryValidationResult)
async def validate_script_query(session_id: str, req: ScriptQueryRequest):
    pool, _ = await _get_pool_or_404(session_id)
    statements, err = _statements_from_request(req)
    if err:
        return ScriptQueryValidationResult(ok=False, statement_count=0, operation_counts={}, error=err)
    validation = _validate_script_statements(statements or [])
    if not validation.ok:
        return validation
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
async def execute_script_query(session_id: str, req: ScriptQueryRequest):
    pool, _ = await _get_pool_or_404(session_id)
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

    async with _active_script_queries_lock:
        if session_id in _active_script_queries and _active_script_queries[session_id]:
            return ScriptQueryResult(
                ok=False,
                execution_id=req.execution_id,
                statements_executed=0,
                affected_rows=0,
                exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
                error=_script_error("BULK_ALREADY_RUNNING", "A large write script is already active for this session.", "Only one large write script may run per session.", "Wait for the active run to finish or cancel it."),
            )
        _active_script_queries.setdefault(session_id, {})[req.execution_id] = None

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
                    _active_script_queries.setdefault(session_id, {})[req.execution_id] = thread_id
                try:
                    if req.database:
                        await cur.execute(f"USE {quote_ident(req.database)}")
                    target_error = await _check_transactional_targets(cur, statements or [])
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
                    await cur.execute(f"SET SESSION innodb_lock_wait_timeout={_BULK_LOCK_WAIT_TIMEOUT_SECONDS}")
                    await cur.execute("START TRANSACTION")
                    try:
                        for idx, statement in enumerate(statements or []):
                            if time.monotonic() - t0 > _BULK_MAX_RUNTIME_SECONDS:
                                failed_idx = idx
                                failed_preview = _preview_statement(statement)
                                raise TimeoutError("Large write script exceeded max runtime")
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
                            await cur.execute(f"SET SESSION innodb_lock_wait_timeout={original_timeout}")
                        except Exception:
                            pass
                finally:
                    async with _active_script_queries_lock:
                        active = _active_script_queries.get(session_id)
                        if active:
                            active.pop(req.execution_id, None)
                            if not active:
                                del _active_script_queries[session_id]

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


@router.delete("/sessions/{session_id}/query/script/{execution_id}")
async def kill_script_query(session_id: str, execution_id: str):
    async with _active_script_queries_lock:
        thread_id = _active_script_queries.get(session_id, {}).get(execution_id)
        if thread_id is None and execution_id in _active_script_queries.get(session_id, {}):
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


def _strip_quotes(sql: str) -> str:
    """Remove quoted strings and backtick identifiers so keywords inside them are ignored."""
    result: list[str] = []
    i = 0
    while i < len(sql):
        ch = sql[i]
        if ch == "'":
            i += 1
            while i < len(sql):
                if sql[i] == "'" and i + 1 < len(sql) and sql[i + 1] == "'":
                    i += 2
                elif sql[i] == "'":
                    i += 1
                    break
                else:
                    i += 1
        elif ch == '"':
            i += 1
            while i < len(sql) and sql[i] != '"':
                i += 1
            i += 1
        elif ch == '`':
            i += 1
            while i < len(sql) and sql[i] != '`':
                i += 1
            i += 1
        else:
            result.append(ch)
            i += 1
    return ''.join(result)


def _serialize(v: Any) -> Any:
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) > _JS_MAX_SAFE_INTEGER:
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time, datetime.timedelta)):
        return str(v)
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, bytes):
        return v.hex()
    return v


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
    return f"'{escape_string_literal(str(value))}'"


@router.post("/sessions/{session_id}/cell-update", response_model=CellUpdateResult)
async def cell_update(session_id: str, req: CellUpdateRequest):
    pool, _ = await _get_pool_or_404(session_id)
    display_sql = ""

    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        col_q = quote_ident(req.column)

        pk_clauses, pk_values = _build_pk_where(req.primary_key)

        sql = f"UPDATE {db_q}.{tbl_q} SET {col_q} = %s WHERE {pk_clauses}"
        params = [req.new_value] + pk_values
        display_sql = _display_sql(sql, params)

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                affected = cur.rowcount

        return CellUpdateResult(ok=True, affected_rows=affected, sql_executed=display_sql)
    except Exception as exc:
        return CellUpdateResult(ok=False, affected_rows=0, sql_executed=display_sql, error=str(exc))


@router.post("/sessions/{session_id}/row-update", response_model=RowUpdateResult)
async def row_update(session_id: str, req: RowUpdateRequest):
    pool, _ = await _get_pool_or_404(session_id)
    display_sql = ""
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)

        set_clauses = ", ".join(f"{quote_ident(col)} = %s" for col in req.updates)
        pk_clauses, pk_values = _build_pk_where(req.primary_key)
        sql = f"UPDATE {db_q}.{tbl_q} SET {set_clauses} WHERE {pk_clauses}"
        params = list(req.updates.values()) + pk_values
        display_sql = _display_sql(sql, params)

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                affected = cur.rowcount

        return RowUpdateResult(ok=True, affected_rows=affected, sql_executed=display_sql)
    except Exception as exc:
        return RowUpdateResult(ok=False, affected_rows=0, sql_executed=display_sql, error=str(exc))


@router.post("/sessions/{session_id}/row-insert", response_model=RowInsertResult)
async def row_insert(session_id: str, req: RowInsertRequest):
    pool, _ = await _get_pool_or_404(session_id)
    display_sql = ""
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        cols = ", ".join(quote_ident(c) for c in req.values)
        placeholders = ", ".join("%s" for _ in req.values)
        sql = f"INSERT INTO {db_q}.{tbl_q} ({cols}) VALUES ({placeholders})"
        params = list(req.values.values())
        display_sql = _display_sql(sql, params)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
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
    pool, _ = await _get_pool_or_404(session_id)
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
                    raise RuntimeError("Failed to disable autocommit for transactional delete")
                try:
                    for pk in req.primary_keys:
                        pk_clauses, pk_values = _build_pk_where(pk)
                        sql = f"DELETE FROM {db_q}.{tbl_q} WHERE {pk_clauses}"
                        display_sqls.append(_display_sql(sql, pk_values))
                        await cur.execute(sql, pk_values)
                        total_affected += cur.rowcount
                    await cur.execute("COMMIT")
                except Exception:
                    await cur.execute("ROLLBACK")
                    raise
                finally:
                    await cur.execute("SET autocommit=1")
        return RowDeleteResult(ok=True, affected_rows=total_affected, sql_executed=";\n".join(display_sqls))
    except Exception as exc:
        return RowDeleteResult(ok=False, affected_rows=0, sql_executed=";\n".join(display_sqls), error=str(exc))
