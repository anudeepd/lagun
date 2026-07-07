"""Query execution, cell editing, row insert/delete."""
import datetime
import decimal
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, escape_string_literal
from lagun.models.query import (
    QueryRequest, QueryResult,
    CellUpdateRequest, CellUpdateResult,
    RowUpdateRequest, RowUpdateResult,
    RowInsertRequest, RowInsertResult,
    RowDeleteRequest, RowDeleteResult,
)

router = APIRouter(tags=["query"])

# Maps session_id → set of MySQL thread_ids of currently running queries
_active_queries: dict[str, set[int]] = {}
_JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991


async def _get_pool_or_404(session_id: str):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return await get_pool(session_id), s


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
