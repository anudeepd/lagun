"""Streaming export: INSERT SQL, DELETE SQL, CSV."""
import csv
import io
import logging
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident, escape_value

log = logging.getLogger(__name__)
router = APIRouter(tags=["export"])

_BLOCKED_SQL = re.compile(
    r'\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE\s*\(|SLEEP\s*\()\b',
    re.IGNORECASE,
)
_SAFE_FILENAME = re.compile(r'[^\w.\-]')


def _safe_filename_part(s: str) -> str:
    return _SAFE_FILENAME.sub('_', s) if s else 'export'


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
    csv_escapechar: str = ""         # empty → use doubling mode (doublequote=True)
    csv_lineterminator: str = "\r\n"
    csv_encoding: str = "utf-8"      # "utf-8" | "utf-8-sig" | "ascii"

    @field_validator('csv_delimiter', 'csv_quotechar', 'csv_escapechar')
    @classmethod
    def single_char(cls, v: str) -> str:
        if len(v) > 1:
            raise ValueError('must be 0 or 1 characters')
        return v


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
        if _BLOCKED_SQL.search(stripped):
            raise HTTPException(400, "SQL contains disallowed functions")
        select_sql = req.sql
    elif req.table:
        select_sql = f"SELECT * FROM {quote_ident(req.database)}.{quote_ident(req.table)}"
        if req.pk_values:
            conditions = []
            for pk_dict in req.pk_values:
                if not pk_dict:
                    continue
                parts = [f"{quote_ident(col)} = {escape_value(val)}" for col, val in pk_dict.items()]
                conditions.append(f"({' AND '.join(parts)})")
            if conditions:
                select_sql += f" WHERE {' OR '.join(conditions)}"
    else:
        raise HTTPException(400, "Provide either 'table' or 'sql'")

    async def _generate_insert():
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
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
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(
                    """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND CONSTRAINT_NAME='PRIMARY'
                       ORDER BY ORDINAL_POSITION""",
                    (req.database, req.table),
                )
                pk_rows = await cur.fetchall()
                pk_cols = [r[0] for r in pk_rows]

                tbl_q = f"{quote_ident(req.database)}.{quote_ident(req.table or 'tbl')}"
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                # Fall back to all columns if no primary key (HeidiSQL approach)
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {req.database}.{req.table}\n-- Format: DELETE\n\n"

                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        where = " AND ".join(
                            f"{quote_ident(c)} = {escape_value(row_dict[c])}"
                            for c in where_cols
                        )
                        yield f"DELETE FROM {tbl_q} WHERE {where};\n"

    async def _generate_delete_insert():
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(
                    """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND CONSTRAINT_NAME='PRIMARY'
                       ORDER BY ORDINAL_POSITION""",
                    (req.database, req.table),
                )
                pk_rows = await cur.fetchall()
                pk_cols = [r[0] for r in pk_rows]

                tbl_q = f"{quote_ident(req.database)}.{quote_ident(req.table or 'tbl')}"
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                cols_sql = ", ".join(quote_ident(c) for c in cols)
                # Fall back to all columns if no primary key (HeidiSQL approach)
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {req.database}.{req.table}\n-- Format: DELETE+INSERT\n\n"

                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        where = " AND ".join(
                            f"{quote_ident(c)} = {escape_value(row_dict[c])}"
                            for c in where_cols
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
                # doublequote=True (default) ignores escapechar for quote-within-field
                # escaping; must be False so the csv module uses escapechar exclusively.
                writer_kwargs["doublequote"] = False
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
                await cur.execute(f"USE {quote_ident(req.database)}")
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

    db = _safe_filename_part(req.database)
    tbl = _safe_filename_part(req.table or 'query')

    if req.format == "insert":
        gen = _generate_insert()
        media = "text/plain"
        filename = f"{db}_{tbl}_insert.sql"
    elif req.format == "delete":
        gen = _generate_delete()
        media = "text/plain"
        filename = f"{db}_{tbl}_delete.sql"
    elif req.format == "delete+insert":
        gen = _generate_delete_insert()
        media = "text/plain"
        filename = f"{db}_{tbl}_delete_insert.sql"
    elif req.format == "csv":
        gen = _generate_csv()
        enc = req.csv_encoding.replace("-sig", "")
        media = f"text/csv; charset={enc}"
        filename = f"{db}_{tbl}.csv"
    else:
        raise HTTPException(400, f"Unknown format: {req.format!r}")

    return StreamingResponse(
        gen,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
