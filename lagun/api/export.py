"""Streaming export: INSERT SQL, DELETE SQL, CSV."""
import csv
import io
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, escape_value

router = APIRouter(tags=["export"])


class ExportRequest(BaseModel):
    database: str
    table: Optional[str] = None
    sql: Optional[str] = None        # custom SELECT; overrides table
    format: str = "insert"           # "insert" | "delete" | "delete+insert" | "csv"
    batch_size: int = 500
    pk_values: Optional[list] = None  # list of dicts: [{pk_col: val, ...}, ...]
    # CSV-specific options (ignored for other formats)
    csv_delimiter: str = ","
    csv_quotechar: str = '"'
    csv_escapechar: str = '"'
    csv_lineterminator: str = "\r\n"
    csv_encoding: str = "utf-8"      # "utf-8" | "utf-8-sig" | "ascii"


@router.post("/sessions/{session_id}/export")
async def export_data(session_id: str, req: ExportRequest):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    pool = await get_pool(session_id)

    if req.sql:
        # Only allow SELECT statements for security
        stripped = req.sql.strip().rstrip(";").strip()
        if not re.match(r'^\s*SELECT\b', stripped, re.IGNORECASE):
            raise HTTPException(400, "Only SELECT statements are allowed for export")
        select_sql = req.sql
    elif req.table:
        select_sql = f"SELECT * FROM {quote_ident(req.database)}.{quote_ident(req.table)}"
        if req.pk_values:
            conditions = []
            for pk_dict in req.pk_values:
                parts = [f"{quote_ident(col)} = {escape_value(val)}" for col, val in pk_dict.items()]
                conditions.append(f"({' AND '.join(parts)})")
            select_sql += f" WHERE {' OR '.join(conditions)}"
    else:
        raise HTTPException(400, "Provide either 'table' or 'sql'")

    async def _generate_insert():
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                cols_sql = ", ".join(quote_ident(c) for c in cols)
                tbl = req.table or "exported_data"
                tbl_q = quote_ident(tbl)

                yield f"-- Lagun export: {req.database}.{tbl}\n"
                yield f"-- Format: INSERT\n\n"

                batch = []
                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    for row in rows:
                        vals = ", ".join(escape_value(v) for v in row)
                        batch.append(f"({vals})")
                    yield (
                        f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n"
                        + ",\n".join(batch)
                        + ";\n"
                    )
                    batch = []

    async def _generate_delete():
        # Need PK columns from information_schema
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND CONSTRAINT_NAME='PRIMARY'
                       ORDER BY ORDINAL_POSITION""",
                    (req.database, req.table),
                )
                pk_rows = await cur.fetchall()
                pk_cols = [r[0] for r in pk_rows]
                if not pk_cols:
                    raise HTTPException(400, "Table has no primary key — cannot generate DELETE export")

                tbl_q = f"{quote_ident(req.database)}.{quote_ident(req.table or 'tbl')}"
                await cur.execute(select_sql)

                yield f"-- Lagun export: {req.database}.{req.table}\n-- Format: DELETE\n\n"

                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    cols = [d[0] for d in cur.description]
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        where = " AND ".join(
                            f"{quote_ident(pk)} = {escape_value(row_dict[pk])}"
                            for pk in pk_cols
                        )
                        yield f"DELETE FROM {tbl_q} WHERE {where};\n"

    async def _generate_delete_insert():
        # Need PK columns from information_schema
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND CONSTRAINT_NAME='PRIMARY'
                       ORDER BY ORDINAL_POSITION""",
                    (req.database, req.table),
                )
                pk_rows = await cur.fetchall()
                pk_cols = [r[0] for r in pk_rows]
                if not pk_cols:
                    raise HTTPException(400, "Table has no primary key — cannot generate DELETE+INSERT export")

                tbl_q = f"{quote_ident(req.database)}.{quote_ident(req.table or 'tbl')}"
                await cur.execute(select_sql)

                cols = None
                cols_sql = None
                yield f"-- Lagun export: {req.database}.{req.table}\n-- Format: DELETE+INSERT\n\n"

                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    if cols is None:
                        cols = [d[0] for d in cur.description]
                        cols_sql = ", ".join(quote_ident(c) for c in cols)
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        where = " AND ".join(
                            f"{quote_ident(pk)} = {escape_value(row_dict[pk])}"
                            for pk in pk_cols
                        )
                        vals = ", ".join(escape_value(v) for v in row)
                        yield f"DELETE FROM {tbl_q} WHERE {where};\n"
                        yield f"INSERT INTO {tbl_q} ({cols_sql}) VALUES ({vals});\n"

    async def _generate_csv():
        writer_kwargs: dict = dict(
            delimiter=req.csv_delimiter,
            lineterminator=req.csv_lineterminator,
        )
        escapechar = req.csv_escapechar or None  # empty string → no escape char
        if req.csv_quotechar:
            writer_kwargs["quoting"] = csv.QUOTE_ALL
            writer_kwargs["quotechar"] = req.csv_quotechar
            if escapechar and escapechar != req.csv_quotechar:
                writer_kwargs["escapechar"] = escapechar
        else:
            writer_kwargs["quoting"] = csv.QUOTE_NONE
            writer_kwargs["escapechar"] = escapechar or "\\"

        encoding = req.csv_encoding
        # Determine byte encoding and error handling
        if encoding == "ascii":
            byte_enc, enc_errors = "ascii", "replace"
        else:
            byte_enc, enc_errors = "utf-8", "strict"

        def to_bytes(text: str) -> bytes:
            return text.encode(byte_enc, errors=enc_errors)

        def clean_row(row: tuple) -> list:
            # None → empty string so NULL doesn't export as the string "None"
            return ["" if v is None else v for v in row]

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]

                # Emit BOM bytes for utf-8-sig
                if encoding == "utf-8-sig":
                    yield b"\xef\xbb\xbf"

                buf = io.StringIO()
                writer = csv.writer(buf, **writer_kwargs)
                writer.writerow(cols)
                yield to_bytes(buf.getvalue())

                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    buf = io.StringIO()
                    writer = csv.writer(buf, **writer_kwargs)
                    writer.writerows(clean_row(row) for row in rows)
                    yield to_bytes(buf.getvalue())

    if req.format == "insert":
        gen = _generate_insert()
        media = "text/plain"
        filename = f"{req.database}_{req.table}_insert.sql"
    elif req.format == "delete":
        gen = _generate_delete()
        media = "text/plain"
        filename = f"{req.database}_{req.table}_delete.sql"
    elif req.format == "delete+insert":
        gen = _generate_delete_insert()
        media = "text/plain"
        filename = f"{req.database}_{req.table}_delete_insert.sql"
    elif req.format == "csv":
        gen = _generate_csv()
        enc = req.csv_encoding.replace("-sig", "")
        media = f"text/csv; charset={enc}"
        filename = f"{req.database}_{req.table or 'query'}.csv"
    else:
        raise HTTPException(400, f"Unknown format: {req.format!r}")

    return StreamingResponse(
        gen,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
