"""Query execution, cell editing, row insert/delete."""
import datetime
import decimal
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident
from lagun.models.query import (
    QueryRequest, QueryResult,
    CellUpdateRequest, CellUpdateResult,
    RowInsertRequest, RowInsertResult,
    RowDeleteRequest, RowDeleteResult,
)

router = APIRouter(tags=["query"])


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
    has_limit = re.search(r'\bLIMIT\b', sql, re.IGNORECASE)
    if is_select and not has_limit:
        sql = f"{sql} LIMIT {limit}"

    t0 = time.monotonic()
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
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
    except Exception as exc:
        return QueryResult(
            columns=[], rows=[], row_count=0,
            exec_time_ms=round((time.monotonic() - t0) * 1000, 2),
            error=str(exc),
        )


def _serialize(v: Any) -> Any:
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return str(v)
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, bytes):
        return v.hex()
    return v


@router.post("/sessions/{session_id}/cell-update", response_model=CellUpdateResult)
async def cell_update(session_id: str, req: CellUpdateRequest):
    pool, _ = await _get_pool_or_404(session_id)

    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        col_q = quote_ident(req.column)

        pk_clauses = " AND ".join(
            f"{quote_ident(k)} = %s" for k in req.primary_key
        )
        pk_values = list(req.primary_key.values())

        sql = f"UPDATE {db_q}.{tbl_q} SET {col_q} = %s WHERE {pk_clauses}"
        params = [req.new_value] + pk_values

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                affected = cur.rowcount

        # Build display SQL safely
        parts = sql.split("%s")
        display_parts = []
        for i, part in enumerate(parts):
            display_parts.append(part)
            if i < len(params):
                p = params[i]
                display_parts.append("NULL" if p is None else repr(p))
        display_sql = "".join(display_parts)
        return CellUpdateResult(ok=True, affected_rows=affected, sql_executed=display_sql)
    except Exception as exc:
        return CellUpdateResult(ok=False, affected_rows=0, sql_executed="", error=str(exc))


@router.post("/sessions/{session_id}/row-insert", response_model=RowInsertResult)
async def row_insert(session_id: str, req: RowInsertRequest):
    pool, _ = await _get_pool_or_404(session_id)
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        cols = ", ".join(quote_ident(c) for c in req.values)
        placeholders = ", ".join("%s" for _ in req.values)
        sql = f"INSERT INTO {db_q}.{tbl_q} ({cols}) VALUES ({placeholders})"
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, list(req.values.values()))
                return RowInsertResult(ok=True, insert_id=cur.lastrowid)
    except Exception as exc:
        return RowInsertResult(ok=False, error=str(exc))


@router.delete("/sessions/{session_id}/rows", response_model=RowDeleteResult)
async def row_delete(session_id: str, req: RowDeleteRequest):
    pool, _ = await _get_pool_or_404(session_id)
    try:
        db_q = quote_ident(req.database)
        tbl_q = quote_ident(req.table)
        total_affected = 0
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SET autocommit=0")
                try:
                    for pk in req.primary_keys:
                        pk_clauses = " AND ".join(f"{quote_ident(k)} = %s" for k in pk)
                        sql = f"DELETE FROM {db_q}.{tbl_q} WHERE {pk_clauses}"
                        await cur.execute(sql, list(pk.values()))
                        total_affected += cur.rowcount
                    await cur.execute("COMMIT")
                except Exception:
                    await cur.execute("ROLLBACK")
                    raise
                finally:
                    await cur.execute("SET autocommit=1")
        return RowDeleteResult(ok=True, affected_rows=total_affected)
    except Exception as exc:
        return RowDeleteResult(ok=False, affected_rows=0, error=str(exc))
