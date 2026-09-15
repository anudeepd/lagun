"""Schema browser API endpoints."""

from fastapi import APIRouter, HTTPException, Query
from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, SYSTEM_DBS
from lagun.models.schema import ColumnInfo, IndexInfo, TableInfo

router = APIRouter(tags=["schema"])

_MAX_BATCH_SCHEMAS = 256


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


def _require_db_scope(session, db: str) -> None:
    if session.selected_databases and db not in session.selected_databases:
        raise HTTPException(
            403,
            f"Database '{db}' is not in this connection's allowed databases.",
        )


async def _fetch_tables(pool, schemas: list[str]) -> dict[str, list[TableInfo]]:
    """Table metadata for every requested schema, in one round trip."""
    placeholders = ", ".join(["%s"] * len(schemas))
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"""SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE,
                           TABLE_ROWS, DATA_LENGTH, TABLE_COMMENT
                    FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA IN ({placeholders})
                    ORDER BY TABLE_SCHEMA, TABLE_NAME""",
                tuple(schemas),
            )
            rows = await cur.fetchall()
    grouped: dict[str, list[TableInfo]] = {schema: [] for schema in schemas}
    for r in rows:
        grouped[r[0]].append(
            TableInfo(
                name=r[1],
                table_type=r[2],
                engine=r[3],
                row_count=r[4],
                data_length=r[5],
                comment=r[6] or "",
            )
        )
    return grouped


@router.get("/sessions/{session_id}/tables")
async def list_tables_for_databases(
    session_id: str,
    databases: list[str] = Query(..., min_length=1, max_length=_MAX_BATCH_SCHEMAS),
) -> dict[str, list[TableInfo]]:
    """Table metadata for several schemas at once, keyed by schema name.

    The schema browser searches every schema in scope; one request per schema
    turns a single keystroke into a request per database.
    """
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    requested = [db for db in dict.fromkeys(databases) if db]
    if not requested:
        raise HTTPException(422, "No databases requested")
    for db in requested:
        _require_db_scope(s, db)
    pool = await get_pool(session_id)
    return await _fetch_tables(pool, requested)


@router.get("/sessions/{session_id}/databases/{db}/tables")
async def list_tables(session_id: str, db: str) -> list[TableInfo]:
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    _require_db_scope(s, db)
    pool = await get_pool(session_id)
    grouped = await _fetch_tables(pool, [db])
    return grouped[db]


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
