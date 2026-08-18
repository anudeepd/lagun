"""Streaming export: INSERT SQL, DELETE SQL, CSV."""

from __future__ import annotations

import csv
import io
import logging
import re
from typing import Literal, Optional

import aiomysql
from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import escape_value, quote_ident
from lagun.api.sql_script import SqlScriptError, split_sql_script

log = logging.getLogger(__name__)
router = APIRouter(tags=["export"])

_BLOCKED_SQL = re.compile(
    r"\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE\s*\(|SLEEP\s*\(|BENCHMARK\s*\()\b",
    re.IGNORECASE,
)
_SAFE_FILENAME = re.compile(r"[^\w.\-]")
_EXPORT_FETCH_ROWS = 100
_EXPORT_STREAM_CHARS = 256 * 1024


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


async def _resolve_ai_columns(pool, database: str, table: str, cols: list[str]) -> set[str]:
    """Return set of column names that are auto_increment. Raises on lookup failure.

    Cost: one extra information_schema round-trip per export call. Acceptable
    because exports are user-initiated (not per-keystroke), the metadata
    lookup is cheap, and the result is small. The round-trip is gated by
    ``exclude_auto_increment`` and an empty ``req.table`` so query-tab
    exports (which have no fixed table) skip it entirely.
    """
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                placeholders = ",".join(["%s"] * len(cols))
                await cur.execute(
                    f"""SELECT COLUMN_NAME FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                       AND EXTRA LIKE '%%auto_increment%%'
                       AND COLUMN_NAME IN ({placeholders})""",
                    (database, table, *cols),
                )
                return {row[0] for row in await cur.fetchall()}
    except Exception:
        log.warning(
            "Failed to resolve auto-increment columns for %s.%s; export aborted",
            database, table, exc_info=True,
        )
        raise


async def _apply_ai_filter(pool, req, cols: list[str]) -> list[str]:
    """Drop auto_increment columns from ``cols`` when the export opts in.

    No-op when ``req.exclude_auto_increment`` is False or ``req.table`` is
    empty (query-tab export has no fixed table to query metadata for).
    """
    if not req.exclude_auto_increment or not req.table:
        return cols
    ai_cols = await _resolve_ai_columns(pool, req.database, req.table, cols)
    return [c for c in cols if c not in ai_cols]


class ExportRequest(BaseModel):
    database: str
    table: Optional[str] = None
    sql: Optional[str] = None
    format: Literal["insert", "delete", "delete+insert", "csv"] = "insert"
    batch_size: int = Field(default=500, ge=1, le=10_000)
    insert_mode: Literal["batch", "single"] = "single"
    include_schema: bool = False
    exclude_auto_increment: bool = False
    pk_values: Optional[list[dict[str, object]]] = None
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
    def valid_request(self) -> "ExportRequest":
        if self.csv_quotechar and self.csv_delimiter == self.csv_quotechar:
            raise ValueError("csv_delimiter and csv_quotechar must differ")
        if self.csv_escapechar and self.csv_escapechar == self.csv_delimiter:
            raise ValueError("csv_escapechar and csv_delimiter must differ")
        if self.sql and self.format in {"delete", "delete+insert"}:
            raise ValueError("DELETE exports require a table")
        if self.pk_values is not None:
            if not self.table:
                raise ValueError("pk_values require a table")
            if not self.pk_values or any(not item for item in self.pk_values):
                raise ValueError("pk_values must contain non-empty key objects")
            if len(self.pk_values) > 10_000:
                raise ValueError("pk_values cannot contain more than 10,000 rows")
            if sum(len(item) for item in self.pk_values) > 50_000:
                raise ValueError("pk_values contains too many key columns")
            for item in self.pk_values:
                for column in item:
                    quote_ident(column)
        quote_ident(self.database)
        if self.table:
            quote_ident(self.table)
        return self


@router.post("/sessions/{session_id}/export")
async def export_data(session_id: str, req: ExportRequest):
    return await _export_response(session_id, req)


@router.post("/sessions/{session_id}/export/download")
async def download_export(session_id: str, config: str = Form(...)):
    try:
        req = ExportRequest.model_validate_json(config)
    except ValidationError as error:
        raise HTTPException(422, detail=error.errors(include_context=False)) from error
    return await _export_response(session_id, req)


async def _export_response(session_id: str, req: ExportRequest):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if req.sql and req.table:
        raise HTTPException(400, "Provide either 'table' or 'sql', not both")

    if req.sql:
        try:
            statements = split_sql_script(req.sql)
        except SqlScriptError as error:
            raise HTTPException(400, f"Invalid export query: {error}") from error
        if len(statements) != 1:
            raise HTTPException(400, "Export query must contain one SELECT statement")
        stripped = statements[0].strip()
        if not re.match(r"^SELECT\b", stripped, re.IGNORECASE):
            raise HTTPException(400, "Only SELECT statements are allowed for export")
        if _BLOCKED_SQL.search(stripped):
            raise HTTPException(400, "SQL contains disallowed functions")
        select_sql = stripped
    elif req.table:
        select_sql = (
            f"SELECT * FROM {quote_ident(req.database)}.{quote_ident(req.table or '')}"
        )
        if req.pk_values is not None:
            conditions = []
            for pk_dict in req.pk_values:
                parts = [_where_value(col, val) for col, val in pk_dict.items()]
                conditions.append(f"({' AND '.join(parts)})")
            select_sql += f" WHERE {' OR '.join(conditions)}"
    else:
        raise HTTPException(400, "Provide either 'table' or 'sql'")

    pool = await get_pool(session_id)
    fetch_size = min(req.batch_size, _EXPORT_FETCH_ROWS)

    async def _generate_insert():
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                cols_filtered = await _apply_ai_filter(pool, req, cols)
                cols_sql = ", ".join(quote_ident(c) for c in cols_filtered)
                tbl = req.table or "exported_data"
                tbl_q = _target_table_sql(req.database, tbl, req.include_schema)
                tbl_label = _target_table_label(req.database, tbl, req.include_schema)

                yield f"-- Lagun export: {tbl_label}\n"
                yield f"-- Format: INSERT ({req.insert_mode})\n\n"
                buf = io.StringIO()
                if req.insert_mode == "single":
                    while True:
                        rows = await cur.fetchmany(fetch_size)
                        if not rows:
                            break
                        for row in rows:
                            row_dict = dict(zip(cols, row))
                            vals = ", ".join(escape_value(row_dict[c]) for c in cols_filtered)
                            buf.write(
                                f"INSERT INTO {tbl_q} ({cols_sql}) VALUES ({vals});\n"
                            )
                            if buf.tell() >= _EXPORT_STREAM_CHARS:
                                yield buf.getvalue()
                                buf.seek(0)
                                buf.truncate(0)
                else:
                    rows_in_statement = 0
                    while True:
                        rows = await cur.fetchmany(fetch_size)
                        if not rows:
                            break
                        for row in rows:
                            if rows_in_statement == 0:
                                buf.write(f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n")
                            else:
                                buf.write(",\n")
                            row_dict = dict(zip(cols, row))
                            vals = ", ".join(escape_value(row_dict[c]) for c in cols_filtered)
                            buf.write(f"({vals})")
                            rows_in_statement += 1
                            if rows_in_statement == req.batch_size:
                                buf.write(";\n")
                                rows_in_statement = 0
                            if buf.tell() >= _EXPORT_STREAM_CHARS:
                                yield buf.getvalue()
                                buf.seek(0)
                                buf.truncate(0)
                    if rows_in_statement:
                        buf.write(";\n")
                if buf.tell():
                    yield buf.getvalue()

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
                buf = io.StringIO()
                while True:
                    rows = await cur.fetchmany(fetch_size)
                    if not rows:
                        break
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        where = " AND ".join(
                            _where_value(c, row_dict[c]) for c in where_cols
                        )
                        buf.write(f"DELETE FROM {tbl_q} WHERE {where};\n")
                        if buf.tell() >= _EXPORT_STREAM_CHARS:
                            yield buf.getvalue()
                            buf.seek(0)
                            buf.truncate(0)
                if buf.tell():
                    yield buf.getvalue()

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
                cols_filtered = await _apply_ai_filter(pool, req, cols)
                cols_sql = ", ".join(quote_ident(c) for c in cols_filtered)
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {_target_table_label(req.database, req.table or 'tbl', req.include_schema)}\n-- Format: DELETE+INSERT ({req.insert_mode})\n\n"
                if req.insert_mode == "single":
                    buf = io.StringIO()
                    while True:
                        rows = await cur.fetchmany(fetch_size)
                        if not rows:
                            break
                        for row in rows:
                            row_dict = dict(zip(cols, row))
                            where = " AND ".join(
                                _where_value(c, row_dict[c]) for c in where_cols
                            )
                            vals = ", ".join(escape_value(row_dict[c]) for c in cols_filtered)
                            buf.write(f"DELETE FROM {tbl_q} WHERE {where};\n")
                            buf.write(
                                f"INSERT INTO {tbl_q} ({cols_sql}) VALUES ({vals});\n"
                            )
                            if buf.tell() >= _EXPORT_STREAM_CHARS:
                                yield buf.getvalue()
                                buf.seek(0)
                                buf.truncate(0)
                    if buf.tell():
                        yield buf.getvalue()
                else:
                    while True:
                        rows = await cur.fetchmany(fetch_size)
                        if not rows:
                            break
                        buf = io.StringIO()
                        for row in rows:
                            row_dict = dict(zip(cols, row))
                            where = " AND ".join(
                                _where_value(c, row_dict[c]) for c in where_cols
                            )
                            buf.write(f"DELETE FROM {tbl_q} WHERE {where};\n")
                        buf.write(f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n")
                        for index, row in enumerate(rows):
                            row_dict = dict(zip(cols, row))
                            vals = ", ".join(escape_value(row_dict[c]) for c in cols_filtered)
                            buf.write((",\n" if index else "") + f"({vals})")
                        buf.write(";\n")
                        yield buf.getvalue()

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

        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await cur.execute(f"USE {quote_ident(req.database)}")
                await cur.execute(select_sql)
                cols = [d[0] for d in cur.description]
                cols_filtered = await _apply_ai_filter(pool, req, cols)
                if req.csv_encoding == "utf-8-sig":
                    yield b"\xef\xbb\xbf"

                buf = io.StringIO()
                writer = csv.writer(buf, **writer_kwargs)
                writer.writerow(cols_filtered)
                while True:
                    rows = await cur.fetchmany(fetch_size)
                    if not rows:
                        break
                    for row in rows:
                        row_dict = dict(zip(cols, row))
                        writer.writerow(
                            "" if row_dict[c] is None else row_dict[c]
                            for c in cols_filtered
                        )
                        if buf.tell() >= _EXPORT_STREAM_CHARS:
                            yield buf.getvalue().encode(byte_enc, errors=enc_errors)
                            buf.seek(0)
                            buf.truncate(0)
                if buf.tell():
                    yield buf.getvalue().encode(byte_enc, errors=enc_errors)

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
