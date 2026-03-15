"""Table and index management endpoints."""
from fastapi import APIRouter, HTTPException

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import (
    quote_ident, validate_engine, validate_charset, validate_collation,
    validate_index_type, validate_col_type, escape_string_literal,
)
from lagun.models.schema import CreateTableRequest, CreateIndexRequest, SetPrimaryKeyRequest, AddColumnRequest, ModifyColumnRequest

router = APIRouter(tags=["table_ops"])


async def _pool(session_id: str):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return await get_pool(session_id)


@router.post("/sessions/{session_id}/databases/{db}/tables", status_code=201)
async def create_table(session_id: str, db: str, req: CreateTableRequest):
    pool = await _pool(session_id)
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
        default = f" DEFAULT '{escape_string_literal(col.default)}'" if col.default is not None else ""
        comment = f" COMMENT '{escape_string_literal(col.comment)}'" if col.comment else ""
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


@router.delete("/sessions/{session_id}/databases/{db}/tables/{table}")
async def drop_table(session_id: str, db: str, table: str):
    pool = await _pool(session_id)
    sql = f"DROP TABLE {quote_ident(db)}.{quote_ident(table)}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}


@router.post("/sessions/{session_id}/databases/{db}/tables/{table}/truncate")
async def truncate_table(session_id: str, db: str, table: str):
    pool = await _pool(session_id)
    sql = f"TRUNCATE TABLE {quote_ident(db)}.{quote_ident(table)}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}


@router.post("/sessions/{session_id}/databases/{db}/tables/{table}/indexes", status_code=201)
async def create_index(session_id: str, db: str, table: str, req: CreateIndexRequest):
    pool = await _pool(session_id)
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


@router.delete("/sessions/{session_id}/databases/{db}/tables/{table}/indexes/{index_name}")
async def drop_index(session_id: str, db: str, table: str, index_name: str):
    pool = await _pool(session_id)
    sql = f"DROP INDEX {quote_ident(index_name)} ON {quote_ident(db)}.{quote_ident(table)}"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}


@router.post("/sessions/{session_id}/databases/{db}/tables/{table}/primary-key", status_code=201)
async def set_primary_key(session_id: str, db: str, table: str, req: SetPrimaryKeyRequest):
    if not req.columns:
        raise HTTPException(400, "At least one column is required for primary key")
    pool = await _pool(session_id)
    db_q = quote_ident(db)
    tbl_q = quote_ident(table)
    cols = ", ".join(quote_ident(c) for c in req.columns)

    # Try combined DROP + ADD first (when table already has a PK),
    # fall back to just ADD if no existing PK.
    sql_combined = f"ALTER TABLE {db_q}.{tbl_q} DROP PRIMARY KEY, ADD PRIMARY KEY ({cols})"
    sql_add_only = f"ALTER TABLE {db_q}.{tbl_q} ADD PRIMARY KEY ({cols})"

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(sql_combined)
                sql = sql_combined
            except Exception as exc:
                # MySQL error 1091: "Can't DROP 'PRIMARY'; check that column/key exists"
                err_msg = str(exc)
                if "1091" in err_msg or "DROP" in err_msg.upper():
                    await cur.execute(sql_add_only)
                    sql = sql_add_only
                else:
                    raise

    return {"ok": True, "sql": sql}


@router.delete("/sessions/{session_id}/databases/{db}/tables/{table}/primary-key")
async def drop_primary_key(session_id: str, db: str, table: str):
    pool = await _pool(session_id)
    sql = f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} DROP PRIMARY KEY"
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}



@router.post("/sessions/{session_id}/databases/{db}/tables/{table}/columns", status_code=201)
async def add_column(session_id: str, db: str, table: str, req: AddColumnRequest):
    pool = await _pool(session_id)
    col_q = quote_ident(req.name)
    col_type = validate_col_type(req.type)
    nullable = "" if req.nullable else " NOT NULL"
    default = f" DEFAULT '{escape_string_literal(req.default)}'" if req.default is not None else ""
    comment = f" COMMENT '{escape_string_literal(req.comment)}'" if req.comment else ""
    sql = (
        f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} "
        f"ADD COLUMN {col_q} {col_type}{nullable}{default}{comment}"
    )
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True, "sql": sql}


@router.put("/sessions/{session_id}/databases/{db}/tables/{table}/columns/{column}")
async def modify_column(session_id: str, db: str, table: str, column: str, req: ModifyColumnRequest):
    pool = await _pool(session_id)
    new_name = req.name or column
    col_type = validate_col_type(req.type)
    nullable = "" if req.nullable is False else " NULL"
    default = f" DEFAULT '{escape_string_literal(req.default)}'" if req.default is not None else ""
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


@router.delete("/sessions/{session_id}/databases/{db}/tables/{table}/columns/{column}")
async def drop_column(session_id: str, db: str, table: str, column: str):
    pool = await _pool(session_id)
    sql = (
        f"ALTER TABLE {quote_ident(db)}.{quote_ident(table)} "
        f"DROP COLUMN {quote_ident(column)}"
    )
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(sql)
    return {"ok": True}
