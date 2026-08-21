"""Schema browser API endpoints."""

import logging
import time

from fastapi import APIRouter, BackgroundTasks, HTTPException
from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, SYSTEM_DBS
from lagun.models.schema import ColumnInfo, IndexInfo, TableInfo

router = APIRouter(tags=["schema"])

logger = logging.getLogger(__name__)

_ANALYZE_SIZE_LIMIT_BYTES = 1 << 30  # 1 GiB
_ANALYZE_THROTTLE_SECONDS = 60.0
_last_analyze: dict[tuple[str, str], float] = {}


def invalidate_analyze_cache(session_id: str | None = None) -> None:
    """Clear ANALYZE throttle entries. Pass session_id to clear one session; None to clear all."""
    if session_id is None:
        _last_analyze.clear()
    else:
        keys_to_remove = [k for k in _last_analyze if k[0] == session_id]
        for k in keys_to_remove:
            del _last_analyze[k]


async def _get_pool_or_404(session_id: str):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return await get_pool(session_id)


async def _analyze_tables_background(
    session_id: str, db: str, targets: list[tuple[str, int]]
) -> None:
    """Run ANALYZE TABLE for small tables in the background.

    Errors are logged, never raised. Tables at or above the size limit keep
    whatever stats InnoDB has cached; only small tables get a stats refresh.
    """
    try:
        qualified = []
        for name, data_length in targets:
            if data_length >= _ANALYZE_SIZE_LIMIT_BYTES:
                continue
            try:
                qualified.append(f"{quote_ident(db)}.{quote_ident(name)}")
            except ValueError:
                continue
        if not qualified:
            return
        pool = await get_pool(session_id)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(f"ANALYZE TABLE {', '.join(qualified)}")
    except Exception:
        logger.warning(
            "background ANALYZE TABLE failed for database %r; using cached stats",
            db,
            exc_info=True,
        )


@router.get("/sessions/{session_id}/databases")
async def list_databases(session_id: str) -> list[str]:
    pool = await _get_pool_or_404(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SHOW DATABASES")
            rows = await cur.fetchall()
    return [r[0] for r in rows if r[0].lower() not in SYSTEM_DBS]


@router.get("/sessions/{session_id}/databases/{db}/tables")
async def list_tables(
    session_id: str, db: str, background_tasks: BackgroundTasks
) -> list[TableInfo]:
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.selected_databases and db not in s.selected_databases:
        raise HTTPException(
            403,
            f"Database '{db}' is not in this connection's allowed databases.",
        )
    pool = await get_pool(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # information_schema.TABLES.TABLE_ROWS is a sampling-based InnoDB
            # estimate that lags behind reality. ANALYZE TABLE forces a stats
            # refresh so the schema view doesn't report a stale row count.
            # (COUNT(*) would be exact but too slow on large tables.)
            # The ANALYZE is scheduled as a background task below, so this
            # response returns immediately even for huge tables.
            await cur.execute(
                """SELECT TABLE_NAME, TABLE_TYPE, ENGINE,
                          TABLE_ROWS, DATA_LENGTH, TABLE_COMMENT
                   FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA = %s
                   ORDER BY TABLE_NAME""",
                (db,),
            )
            rows = await cur.fetchall()
    tables = [
        TableInfo(
            name=r[0],
            table_type=r[1],
            engine=r[2],
            row_count=r[3],
            data_length=r[4],
            comment=r[5] or "",
        )
        for r in rows
    ]
    key = (session_id, db)
    now = time.monotonic()
    if now - _last_analyze.get(key, float("-inf")) >= _ANALYZE_THROTTLE_SECONDS:
        _last_analyze[key] = now
        # Non-data tables (e.g. views) report NULL DATA_LENGTH; skip them.
        targets = [(r[0], r[4]) for r in rows if r[4] is not None]
        background_tasks.add_task(_analyze_tables_background, session_id, db, targets)
    return tables


@router.get("/sessions/{session_id}/databases/{db}/tables/{table}/columns")
async def list_columns(session_id: str, db: str, table: str) -> list[ColumnInfo]:
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.selected_databases and db not in s.selected_databases:
        raise HTTPException(
            403, f"Database '{db}' is not in this connection's allowed databases."
        )
    pool = await get_pool(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
                          IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY,
                          EXTRA, COLUMN_COMMENT
                   FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                   ORDER BY ORDINAL_POSITION""",
                (db, table),
            )
            rows = await cur.fetchall()
    return [
        ColumnInfo(
            name=r[0],
            data_type=r[1],
            column_type=r[2],
            is_nullable=(r[3] == "YES"),
            column_default=r[4],
            is_primary_key=(r[5] == "PRI"),
            is_auto_increment=("auto_increment" in (r[6] or "").lower()),
            extra=r[6] or "",
            comment=r[7] or "",
        )
        for r in rows
    ]


@router.get("/sessions/{session_id}/databases/{db}/tables/{table}/indexes")
async def list_indexes(session_id: str, db: str, table: str) -> list[IndexInfo]:
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.selected_databases and db not in s.selected_databases:
        raise HTTPException(
            403, f"Database '{db}' is not in this connection's allowed databases."
        )
    pool = await get_pool(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
                   FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                   ORDER BY INDEX_NAME, SEQ_IN_INDEX""",
                (db, table),
            )
            rows = await cur.fetchall()

    # Group by index name
    index_map: dict[str, dict] = {}
    for name, col, non_unique, idx_type in rows:
        if name not in index_map:
            index_map[name] = {
                "name": name,
                "columns": [],
                "is_unique": non_unique == 0,
                "index_type": idx_type,
            }
        index_map[name]["columns"].append(col)

    return [IndexInfo(**v) for v in index_map.values()]


@router.get("/sessions/{session_id}/databases/{db}/functions")
async def list_functions(session_id: str, db: str) -> list[str]:
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.selected_databases and db not in s.selected_databases:
        raise HTTPException(
            403, f"Database '{db}' is not in this connection's allowed databases."
        )
    pool = await get_pool(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT ROUTINE_NAME
                   FROM information_schema.ROUTINES
                   WHERE ROUTINE_SCHEMA = %s AND ROUTINE_TYPE = 'FUNCTION'
                   ORDER BY ROUTINE_NAME""",
                (db,),
            )
            rows = await cur.fetchall()
    return [r[0] for r in rows]


@router.get("/sessions/{session_id}/databases/{db}/tables/{table}/create_sql")
async def get_create_sql(session_id: str, db: str, table: str) -> dict:
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.selected_databases and db not in s.selected_databases:
        raise HTTPException(
            403, f"Database '{db}' is not in this connection's allowed databases."
        )
    pool = await get_pool(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"SHOW CREATE TABLE {quote_ident(db)}.{quote_ident(table)}"
            )
            row = await cur.fetchone()
    return {"create_sql": row[1] if row else ""}
