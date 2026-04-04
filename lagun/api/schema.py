"""Schema browser API endpoints."""
from fastapi import APIRouter, HTTPException
from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, SYSTEM_DBS
from lagun.models.schema import ColumnInfo, IndexInfo, TableInfo

router = APIRouter(tags=["schema"])


async def _get_pool_or_404(session_id: str):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return await get_pool(session_id)


@router.get("/sessions/{session_id}/databases")
async def list_databases(session_id: str) -> list[str]:
    pool = await _get_pool_or_404(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SHOW DATABASES")
            rows = await cur.fetchall()
    return [r[0] for r in rows if r[0].lower() not in SYSTEM_DBS]


@router.get("/sessions/{session_id}/databases/{db}/tables")
async def list_tables(session_id: str, db: str) -> list[TableInfo]:
    pool = await _get_pool_or_404(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT TABLE_NAME, TABLE_TYPE, ENGINE,
                          TABLE_ROWS, DATA_LENGTH, TABLE_COMMENT
                   FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA = %s
                   ORDER BY TABLE_NAME""",
                (db,),
            )
            rows = await cur.fetchall()
    return [
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


@router.get("/sessions/{session_id}/databases/{db}/tables/{table}/columns")
async def list_columns(session_id: str, db: str, table: str) -> list[ColumnInfo]:
    pool = await _get_pool_or_404(session_id)
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
    pool = await _get_pool_or_404(session_id)
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
    pool = await _get_pool_or_404(session_id)
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
    pool = await _get_pool_or_404(session_id)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"SHOW CREATE TABLE {quote_ident(db)}.{quote_ident(table)}")
            row = await cur.fetchone()
    return {"create_sql": row[1] if row else ""}
