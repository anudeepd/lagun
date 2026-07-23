"""Streaming export: INSERT SQL, DELETE SQL, CSV."""

from __future__ import annotations

import csv
import io
import logging
import re
from typing import Literal, Optional

import aiomysql
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import escape_value, quote_ident

log = logging.getLogger(__name__)
router = APIRouter(tags=["export"])

_BLOCKED_SQL = re.compile(
    r"\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE\s*\(|SLEEP\s*\(|BENCHMARK\s*\()\b",
    re.IGNORECASE,
)
_SAFE_FILENAME = re.compile(r"[^\w.\-]")


def _safe_filename_part(s: str) -> str:
    return _SAFE_FILENAME.sub("_", s) if s else "export"


def _target_table_sql(
    database: str, table_name: str, include_schema: bool = False
) -> str:
    tbl_q = quote_ident(table_name)
    if not include_schema:
        return tbl_q
    return f"{quote_ident(database)}.{tbl_q}"


def _target_table_label(
    database: str, table_name: str, include_schema: bool = False
) -> str:
    return f"{database}.{table_name}" if include_schema else table_name


def _where_value(column: str, value) -> str:
    if value is None:
        return f"{quote_ident(column)} IS NULL"
    return f"{quote_ident(column)} = {escape_value(value)}"


class ExportRequest(BaseModel):
    database: str
    table: Optional[str] = None
    sql: Optional[str] = None
    format: Literal["insert", "delete", "delete+insert", "csv"] = "insert"
    batch_size: int = Field(default=500, ge=1, le=10_000)
    insert_mode: Literal["batch", "single"] = "single"
    include_schema: bool = False
    pk_values: Optional[list] = None
    csv_delimiter: str = ","
    csv_quotechar: str = '"'
    csv_escapechar: str = ""
    csv_lineterminator: str = "\r\n"
    csv_encoding: Literal["utf-8", "utf-8-sig", "ascii"] = "utf-8"

    @field_validator("csv_delimiter", "csv_quotechar", "csv_escapechar")
    @classmethod
    def single_char(cls, v: str) -> str:
        if len(v) > 1:
            raise ValueError("must be 0 or 1 characters")
        return v

    @field_validator("csv_delimiter")
    @classmethod
    def delimiter_required(cls, v: str) -> str:
        if not v:
            raise ValueError("delimiter must not be empty")
        return v

    @field_validator("csv_lineterminator")
    @classmethod
    def valid_line_ending(cls, v: str) -> str:
        if v not in {"\r\n", "\n", "\r"}:
            raise ValueError("must be CRLF, LF, or CR")
        return v

    @model_validator(mode="after")
    def valid_csv_options(self) -> "ExportRequest":
        if self.csv_quotechar and self.csv_delimiter == self.csv_quotechar:
            raise ValueError("csv_delimiter and csv_quotechar must differ")
        if self.csv_escapechar and self.csv_escapechar == self.csv_delimiter:
            raise ValueError("csv_escapechar and csv_delimiter must differ")
        return self


@router.post("/sessions/{session_id}/export")
async def export_data(session_id: str, req: ExportRequest):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")

    if req.sql:
        stripped = req.sql.strip().rstrip(";").strip()
        if not re.match(r"^\s*SELECT\b", stripped, re.IGNORECASE):
            raise HTTPException(400, "Only SELECT statements are allowed for export")
        if _BLOCKED_SQL.search(stripped):
            raise HTTPException(400, "SQL contains disallowed functions")
        select_sql = req.sql
    elif req.table:
        select_sql = (
            f"SELECT * FROM {quote_ident(req.database)}.{quote_ident(req.table)}"
        )
        if req.pk_values:
            conditions = []
            for pk_dict in req.pk_values:
                if not pk_dict:
                    continue
                parts = [_where_value(col, val) for col, val in pk_dict.items()]
                conditions.append(f"({' AND '.join(parts)})")
            if conditions:
                select_sql += f" WHERE {' OR '.join(conditions)}"
    else:
        raise HTTPException(400, "Provide either 'table' or 'sql'")

    pool = await get_pool(session_id)

    async def _generate_insert():
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                cols_sql = ", ".join(quote_ident(c) for c in cols)
                tbl = req.table or "exported_data"
                tbl_q = _target_table_sql(req.database, tbl, req.include_schema)
                tbl_label = _target_table_label(req.database, tbl, req.include_schema)

                yield f"-- Lagun export: {tbl_label}\n"
                yield f"-- Format: INSERT ({req.insert_mode})\n\n"
                if req.insert_mode == "single":
                    while True:
                        rows = await cur.fetchmany(req.batch_size)
                        if not rows:
                            break
                        for row in rows:
                            vals = ", ".join(escape_value(v) for v in row)
                            yield f"INSERT INTO {tbl_q} ({cols_sql}) VALUES ({vals});\n"
                else:
                    while True:
                        rows = await cur.fetchmany(req.batch_size)
                        if not rows:
                            break
                        values = []
                        for row in rows:
                            vals = ", ".join(escape_value(v) for v in row)
                            values.append(f"({vals})")
                        yield (
                            f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n"
                            + ",\n".join(values)
                            + ";\n"
                        )

    async def _generate_delete():
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(
                    """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND CONSTRAINT_NAME='PRIMARY'
                       ORDER BY ORDINAL_POSITION""",
                    (req.database, req.table),
                )
                pk_cols = [row[0] for row in await cur.fetchall()]
                tbl_q = _target_table_sql(
                    req.database, req.table or "tbl", req.include_schema
                )
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {_target_table_label(req.database, req.table or 'tbl', req.include_schema)}\n-- Format: DELETE\n\n"
                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        where = " AND ".join(
                            _where_value(c, row_dict[c]) for c in where_cols
                        )
                        yield f"DELETE FROM {tbl_q} WHERE {where};\n"

    async def _generate_delete_insert():
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(
                    """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND CONSTRAINT_NAME='PRIMARY'
                       ORDER BY ORDINAL_POSITION""",
                    (req.database, req.table),
                )
                pk_cols = [row[0] for row in await cur.fetchall()]
                tbl_q = _target_table_sql(
                    req.database, req.table or "tbl", req.include_schema
                )
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                cols_sql = ", ".join(quote_ident(c) for c in cols)
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {_target_table_label(req.database, req.table or 'tbl', req.include_schema)}\n-- Format: DELETE+INSERT ({req.insert_mode})\n\n"
                if req.insert_mode == "single":
                    while True:
                        rows = await cur.fetchmany(req.batch_size)
                        if not rows:
                            break
                        for row in rows:
                            row_dict = dict(zip(cols, row))
                            where = " AND ".join(
                                _where_value(c, row_dict[c]) for c in where_cols
                            )
                            vals = ", ".join(escape_value(v) for v in row)
                            yield f"DELETE FROM {tbl_q} WHERE {where};\n"
                            yield f"INSERT INTO {tbl_q} ({cols_sql}) VALUES ({vals});\n"
                else:
                    while True:
                        rows = await cur.fetchmany(req.batch_size)
                        if not rows:
                            break
                        values = []
                        for row in rows:
                            row_dict = dict(zip(cols, row))
                            where = " AND ".join(
                                _where_value(c, row_dict[c]) for c in where_cols
                            )
                            vals = ", ".join(escape_value(v) for v in row)
                            yield f"DELETE FROM {tbl_q} WHERE {where};\n"
                            values.append(f"({vals})")
                        yield (
                            f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n"
                            + ",\n".join(values)
                            + ";\n"
                        )

    async def _generate_csv():
        writer_kwargs: dict = {
            "delimiter": req.csv_delimiter,
            "lineterminator": req.csv_lineterminator,
        }
        escapechar = req.csv_escapechar or None
        if req.csv_quotechar:
            writer_kwargs["quoting"] = csv.QUOTE_ALL
            writer_kwargs["quotechar"] = req.csv_quotechar
            if escapechar and escapechar != req.csv_quotechar:
                writer_kwargs["escapechar"] = escapechar
                writer_kwargs["doublequote"] = False
        else:
            writer_kwargs["quoting"] = csv.QUOTE_NONE
            writer_kwargs["escapechar"] = escapechar or "\\"

        if req.csv_encoding == "ascii":
            byte_enc, enc_errors = "ascii", "replace"
        else:
            byte_enc, enc_errors = "utf-8", "strict"

        def to_bytes(text: str) -> bytes:
            return text.encode(byte_enc, errors=enc_errors)

        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                if req.csv_encoding == "utf-8-sig":
                    yield b"\xef\xbb\xbf"

                buf = io.StringIO()
                csv.writer(buf, **writer_kwargs).writerow(cols)
                yield to_bytes(buf.getvalue())
                while True:
                    rows = await cur.fetchmany(req.batch_size)
                    if not rows:
                        break
                    buf = io.StringIO()
                    csv.writer(buf, **writer_kwargs).writerows(
                        (("" if value is None else value) for value in row)
                        for row in rows
                    )
                    yield to_bytes(buf.getvalue())

    db = _safe_filename_part(req.database)
    tbl = _safe_filename_part(req.table or "query")
    if req.format == "insert":
        gen, media, filename = (
            _generate_insert(),
            "text/plain",
            f"{db}_{tbl}_insert.sql",
        )
    elif req.format == "delete":
        gen, media, filename = (
            _generate_delete(),
            "text/plain",
            f"{db}_{tbl}_delete.sql",
        )
    elif req.format == "delete+insert":
        gen, media, filename = (
            _generate_delete_insert(),
            "text/plain",
            f"{db}_{tbl}_delete_insert.sql",
        )
    elif req.format == "csv":
        gen = _generate_csv()
        enc = req.csv_encoding.replace("-sig", "")
        media, filename = f"text/csv; charset={enc}", f"{db}_{tbl}.csv"
    else:
        raise HTTPException(400, f"Unknown format: {req.format!r}")

    return StreamingResponse(
        gen,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
