"""Table and index management endpoints."""

import time

from fastapi import APIRouter, HTTPException, Query

from lagun.api.scope import require_db_scope
from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import (
    quote_ident,
    validate_engine,
    validate_charset,
    validate_collation,
    validate_index_type,
    validate_col_type,
    escape_string_literal,
    format_default_clause,
)
from lagun.models.schema import (
    AddColumnRequest,
    AnalyzeTableResult,
    CreateIndexRequest,
    CreateTableRequest,
    ModifyColumnRequest,
    SetPrimaryKeyRequest,
    TableDdlResult,
    TableOperationResult,
)

router = APIRouter(tags=["table_ops"])

# Automatic stats refresh (force=False) runs at most once per table per window.
_ANALYZE_THROTTLE_SECONDS = 600.0
# Skip the automatic path for very large tables; an explicit force=True still runs.
_ANALYZE_SIZE_LIMIT_BYTES = 1 << 30  # 1 GiB
_last_analyze: dict[tuple[str, str, str], float] = {}


def invalidate_analyze_cache(session_id: str | None = None) -> None:
    """Drop ANALYZE throttle entries. Pass session_id to clear one session; None to clear all."""
    if session_id is None:
        _last_analyze.clear()
        return
    for key in [k for k in _last_analyze if k[0] == session_id]:
        del _last_analyze[key]


async def _pool(session_id: str, db: str | None = None):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    require_db_scope(s, db)
    return await get_pool(session_id)


@router.post(
    "/sessions/{session_id}/databases/{db}/tables",
    response_model=TableDdlResult,
    status_code=201,
    summary="Create a table",
)
async def create_table(session_id: str, db: str, req: CreateTableRequest):
    pool = await _pool(session_id, db)
    db_q = quote_ident(db)
    tbl_q = quote_ident(req.name)

    # Build column definitions
    col_defs = []
    pk_cols = []
    for col in req.columns:
        name_q = quote_ident(col.name)
        col_type = validate_col_type(col.type)
        nullable = "" if col.nullable else " NOT NULL"
        auto_inc = " AUTO_INCREMENT" if col.auto_increment else ""
        default = format_default_clause(col.default)
        comment = (
            f" COMMENT '{escape_string_literal(col.comment)}'" if col.comment else ""
        )
        col_defs.append(f"  {name_q} {col_type}{nullable}{auto_inc}{default}{comment}")
        if col.primary_key:
            pk_cols.append(name_q)

    if pk_cols:
        col_defs.append(f"  PRIMARY KEY ({', '.join(pk_cols)})")

    col_sql = ",\n".join(col_defs)
    engine = validate_engine(req.engine)
    charset = validate_charset(req.charset)
    collation = validate_collation(req.collation)
    sql = (
        f"CREATE TABLE {db_q}.{tbl_q} (\n{col_sql}\n) "
        f"ENGINE={engine} "
        f"DEFAULT CHARSET={charset} "
        f"COLLATE={collation}"
    )

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}


@router.delete(
    "/sessions/{session_id}/databases/{db}/tables/{table}",
    response_model=TableOperationResult,
    summary="Drop a table",
)
async def drop_table(session_id: str, db: str, table: str):
    pool = await _pool(session_id, db)
    sql = f"DROP TABLE {quote_ident(db)}.{quote_ident(table)}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}


@router.post(
    "/sessions/{session_id}/databases/{db}/tables/{table}/analyze",
    response_model=AnalyzeTableResult,
    summary="Refresh one table's statistics",
)
async def analyze_table(
    session_id: str, db: str, table: str, force: bool = Query(False)
) -> dict:
    """Refresh InnoDB statistics for one table.

    information_schema.TABLES.TABLE_ROWS is a sampling-based estimate; ANALYZE
    TABLE recomputes it. Only the table in front of the user is ever analyzed —
    a schema-wide ANALYZE would run for every table a listing happens to touch.

    Callers pass force=False for the automatic refresh that happens when a table
    view opens; that path is throttled and skips very large tables. force=True
    is the explicit user request and always runs.
    """
    pool = await _pool(session_id, db)
    qualified = f"{quote_ident(db)}.{quote_ident(table)}"
    key = (session_id, db, table)
    now = time.monotonic()

    if (
        not force
        and now - _last_analyze.get(key, float("-inf")) < _ANALYZE_THROTTLE_SECONDS
    ):
        analyzed = False
    else:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT DATA_LENGTH FROM information_schema.TABLES
                       WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s""",
                    (db, table),
                )
                row = await cur.fetchone()
                data_length = row[0] if row else None
                if (
                    not force
                    and data_length is not None
                    and data_length >= _ANALYZE_SIZE_LIMIT_BYTES
                ):
                    analyzed = False
                else:
                    await cur.execute(f"ANALYZE TABLE {qualified}")
                    await cur.fetchall()  # ANALYZE returns a status row set
                    _last_analyze[key] = now
                    analyzed = True

    stats = await _table_stats(pool, db, table)
    return {"ok": True, "analyzed": analyzed, **stats}


async def _table_stats(pool, db: str, table: str) -> dict:
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT TABLE_ROWS, DATA_LENGTH FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s""",
                (db, table),
            )
            row = await cur.fetchone()
    return {
        "row_count": row[0] if row else None,
        "data_length": row[1] if row else None,
    }


@router.post(
    "/sessions/{session_id}/databases/{db}/tables/{table}/truncate",
    response_model=TableOperationResult,
    summary="Truncate a table",
)
async def truncate_table(session_id: str, db: str, table: str):
    pool = await _pool(session_id, db)
    sql = f"TRUNCATE TABLE {quote_ident(db)}.{quote_ident(table)}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}


@router.post(
    "/sessions/{session_id}/databases/{db}/tables/{table}/indexes",
    response_model=TableDdlResult,
    status_code=201,
    summary="Create an index",
)
async def create_index(session_id: str, db: str, table: str, req: CreateIndexRequest):
    pool = await _pool(session_id, db)
    unique = "UNIQUE " if req.unique else ""
    cols = ", ".join(quote_ident(c) for c in req.columns)
    idx_q = quote_ident(req.name)
    tbl_q = f"{quote_ident(db)}.{quote_ident(table)}"
    idx_type = validate_index_type(req.index_type)
    sql = f"CREATE {unique}INDEX {idx_q} ON {tbl_q} ({cols}) USING {idx_type}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}


@router.delete(
    "/sessions/{session_id}/databases/{db}/tables/{table}/indexes/{index_name}",
    response_model=TableOperationResult,
    summary="Drop an index",
)
async def drop_index(session_id: str, db: str, table: str, index_name: str):
    pool = await _pool(session_id, db)
    sql = f"DROP INDEX {quote_ident(index_name)} ON {quote_ident(db)}.{quote_ident(table)}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}


@router.post(
    "/sessions/{session_id}/databases/{db}/tables/{table}/primary-key",
    response_model=TableDdlResult,
    status_code=201,
    summary="Set the primary key",
)
async def set_primary_key(
    session_id: str, db: str, table: str, req: SetPrimaryKeyRequest
):
    if not req.columns:
        raise HTTPException(400, "At least one column is required for primary key")
    pool = await _pool(session_id, db)
    db_q = quote_ident(db)
    tbl_q = quote_ident(table)
    cols = ", ".join(quote_ident(c) for c in req.columns)

    # Try combined DROP + ADD first (when table already has a PK),
    # fall back to just ADD if no existing PK.
    sql_combined = (
        f"ALTER TABLE {db_q}.{tbl_q} DROP PRIMARY KEY, ADD PRIMARY KEY ({cols})"
    )
    sql_add_only = f"ALTER TABLE {db_q}.{tbl_q} ADD PRIMARY KEY ({cols})"

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(sql_combined)
                sql = sql_combined
            except Exception as exc:
                err_msg = str(exc)
                if "1091" in err_msg or "can't drop 'primary'" in err_msg.lower():
                    await cur.execute(sql_add_only)
                    sql = sql_add_only
                else:
                    raise

    return {"ok": True, "sql": sql}


@router.delete(
    "/sessions/{session_id}/databases/{db}/tables/{table}/primary-key",
    response_model=TableDdlResult,
    summary="Drop the primary key",
)
async def drop_primary_key(session_id: str, db: str, table: str):
    pool = await _pool(session_id, db)
    sql = f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} DROP PRIMARY KEY"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}


@router.post(
    "/sessions/{session_id}/databases/{db}/tables/{table}/columns",
    response_model=TableDdlResult,
    status_code=201,
    summary="Add a column",
)
async def add_column(session_id: str, db: str, table: str, req: AddColumnRequest):
    pool = await _pool(session_id, db)
    col_q = quote_ident(req.name)
    col_type = validate_col_type(req.type)
    nullable = "" if req.nullable else " NOT NULL"
    default = format_default_clause(req.default, literal=req.default_is_literal)
    comment = f" COMMENT '{escape_string_literal(req.comment)}'" if req.comment else ""
    sql = (
        f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} "
        f"ADD COLUMN {col_q} {col_type}{nullable}{default}{comment}"
    )
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}


@router.put(
    "/sessions/{session_id}/databases/{db}/tables/{table}/columns/{column}",
    response_model=TableDdlResult,
    summary="Modify a column",
)
async def modify_column(
    session_id: str, db: str, table: str, column: str, req: ModifyColumnRequest
):
    pool = await _pool(session_id, db)
    new_name = req.name or column
    col_type = validate_col_type(req.type)
    if req.nullable is True:
        nullable = " NULL"
    elif req.nullable is False:
        nullable = " NOT NULL"
    else:
        nullable = ""
    default = format_default_clause(req.default, literal=req.default_is_literal)
    comment = f" COMMENT '{escape_string_literal(req.comment)}'" if req.comment else ""

    if req.name and req.name != column:
        action = (
            f"CHANGE COLUMN {quote_ident(column)} {quote_ident(new_name)} "
            f"{col_type}{nullable}{default}{comment}"
        )
    else:
        action = (
            f"MODIFY COLUMN {quote_ident(column)} "
            f"{col_type}{nullable}{default}{comment}"
        )

    sql = f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} {action}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}


@router.delete(
    "/sessions/{session_id}/databases/{db}/tables/{table}/columns/{column}",
    response_model=TableOperationResult,
    summary="Drop a column",
)
async def drop_column(session_id: str, db: str, table: str, column: str):
    pool = await _pool(session_id, db)
    sql = (
        f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} "
        f"DROP COLUMN {quote_ident(column)}"
    )
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}
