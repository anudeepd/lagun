"""Streaming export: INSERT SQL, DELETE SQL, CSV."""

from __future__ import annotations

import asyncio
import csv
import datetime
from contextlib import asynccontextmanager
import io
import logging
import os
import re
import time
from typing import Literal, Optional

import aiomysql
from fastapi import APIRouter, Form, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from starlette.types import Receive, Scope, Send

from lagun.api.query import _discard_lease_connection
from lagun.db.pool import get_pool
from lagun.api.scope import effective_scope, require_db_scope
from lagun.api.sql_analysis import (
    SCOPE_REFERENCE_EXEMPT_SCHEMAS,
    referenced_schemas,
)
from lagun.db.session_store import get_session
from lagun.db.utils import escape_value, format_mysql_time, quote_ident
from lagun.api.sql_script import SqlScriptError, split_sql_script

log = logging.getLogger(__name__)
router = APIRouter(tags=["export"])

# `/*! … */` bodies are executed by the server, so their contents are real SQL
# and must not be treated as a comment.
_EXECUTABLE_COMMENT = re.compile(r"/\*!")
# Ordinary comments are removed before keyword scanning, or `INTO/**/OUTFILE`
# slips past a pattern that expects whitespace between the two words. The `--`
# alternative repeats MySQL's lexer rule (the second dash needs whitespace or a
# control character after it) — reading `--(` as a comment let
# `SELECT 1--(1) INTO OUTFILE '/tmp/x'` through this refusal.
_COMMENT = re.compile(r"/\*.*?\*/|--(?=[\s\x00-\x1f])[^\n]*|#[^\n]*", re.DOTALL)
_SERVER_FILE_WRITE = re.compile(r"\bINTO\s+(?:OUTFILE|DUMPFILE)\b", re.IGNORECASE)
_DISALLOWED_FUNCTION = re.compile(
    r"\b(?:LOAD_FILE|SLEEP|BENCHMARK)\s*\(", re.IGNORECASE
)
_SAFE_FILENAME = re.compile(r"[^\w.\-]")
# Rows per `fetchmany`. Kept well below the request's 10,000-row ceiling so a
# batch is still a bounded unit of work, but large enough that a big export is
# not latency-bound on one await + deadline check per hundred rows.
_EXPORT_FETCH_ROWS = 1000
# Streaming a whole table had no deadline; the response body is produced after
# the handler returns, so the bound has to be enforced inside the generator.
_EXPORT_MAX_RUNTIME_SECONDS = float(
    os.getenv("LAGUN_EXPORT_MAX_RUNTIME_SECONDS", "300")
)
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_EXPORT_STREAM_CHARS = 256 * 1024
# Bulkhead for streaming exports: each stream holds a pooled connection plus an
# open server-side cursor for its whole download, so a trickling client can pin
# a lease indefinitely. Cap concurrent streams; excess requests fail fast with
# 503 instead of queueing behind stuck leases and starving interactive queries.
# Same pattern as the session-probe semaphore in lagun/api/sessions.py.
_EXPORT_MAX_CONCURRENCY = max(1, int(os.getenv("LAGUN_EXPORT_MAX_CONCURRENCY", "3")))
_EXPORT_QUEUE_TIMEOUT_SECONDS = max(
    0.1, float(os.getenv("LAGUN_EXPORT_QUEUE_TIMEOUT_SECONDS", "10"))
)
_export_semaphore = asyncio.Semaphore(_EXPORT_MAX_CONCURRENCY)


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


class _ExportTimeout(RuntimeError):
    """The export ran past its deadline."""


def _is_numeric_literal(value: str) -> bool:
    try:
        float(value)
    except ValueError:
        return False
    return True


def _csv_neutralize(value: str) -> str:
    """Prefix a formula-looking cell so a spreadsheet reads it as text.

    CSV injection guard (S-8): a cell starting with = + - @ TAB or CR is
    executable content in Excel/LibreOffice/Sheets. A leading - or + on a number
    is a sign rather than a formula, so numeric literals are left alone.
    """
    if not value or value[0] not in _CSV_FORMULA_PREFIXES:
        return value
    if _is_numeric_literal(value):
        return value
    return "'" + value


def _csv_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (bytes, bytearray, memoryview)):
        # str(bytes) is a Python repr ("b'\x00\xff'") that no importer can turn
        # back into the original bytes.
        return "0x" + bytes(value).hex()
    if isinstance(value, datetime.timedelta):
        # str(timedelta) is "1 day, 1:00:00", which is not a valid TIME literal.
        return format_mysql_time(value)
    return _csv_neutralize(str(value))


def _kept_indexes(cols: list[str], cols_filtered: list[str]) -> list[int]:
    """Positions of the surviving columns, so values never go through a name map."""
    dropped = set(cols) - set(cols_filtered)
    return [index for index, name in enumerate(cols) if name not in dropped]


def _where_clause(cols: list[str], row: tuple, where_cols: list[str]) -> str:
    """Build a WHERE clause, resolving each key column by position.

    A name lookup silently used the wrong column's value when a result set
    contained the same name twice (a self-join), which made the DELETE half of an
    export match nothing.
    """
    parts = []
    for name in where_cols:
        try:
            index = cols.index(name)
        except ValueError:
            continue
        parts.append(_where_value(name, row[index]))
    return " AND ".join(parts)


def _completion_marker(rows: int) -> str:
    """Final line of a streamed SQL export, so truncation is detectable.

    The status is already 200 by the time the first chunk is written, so a
    mid-stream failure cannot change it; a client that checks for this marker can
    tell a complete file from a truncated one.
    """
    return f"-- Lagun export complete: {rows} rows\n"


# Appended to a text/plain body when it raises after the headers went out. A
# failure at that point cannot become a 4xx, so the body is the only place it can
# be made visible; CSV has no comment syntax and cannot carry this.
_EXPORT_FAILURE_MARKER = "-- Lagun export FAILED: "


def _failure_marker(error: BaseException) -> str:
    """Final line of a text/plain export whose body failed mid-stream."""
    return f"{_EXPORT_FAILURE_MARKER}{error}\n"


async def _await_with_remaining_deadline(
    awaitable, deadline: float, timeout_error: Exception
):
    """Await a stalled database future without exceeding the export deadline.

    A plain ``await cur.execute(...)`` has no bound: a stalled server holds the
    pooled connection past the export's max runtime. The remaining budget
    (never below 0.1s, so an already-expired deadline still fails fast instead
    of raising ``TimeoutError(0)``) bounds each await while preserving the
    export's error taxonomy — an expiry always surfaces as ``_ExportTimeout``.
    """
    remaining = max(0.1, deadline - time.monotonic())
    try:
        async with asyncio.timeout(remaining):
            return await awaitable
    except TimeoutError as exc:
        raise timeout_error from exc


def _export_timeout(exported: int) -> _ExportTimeout:
    return _ExportTimeout(
        f"Export exceeded the {_EXPORT_MAX_RUNTIME_SECONDS:g}-second limit "
        f"after {exported} rows"
    )


async def _acquire_export_slot() -> None:
    """Hold one export-concurrency slot for the whole stream, or raise 503.

    Acquired after scope/validation (a 403/400 must never consume a slot) and
    returned by :class:`_ExportStreamResponse` once the response has finished
    (or the client disconnected), so at most ``_EXPORT_MAX_CONCURRENCY`` pooled
    leases can be pinned by downloads. Same 503 + Retry-After shape as the
    pool-capacity handler in lagun/main.py.
    """
    try:
        await asyncio.wait_for(
            _export_semaphore.acquire(), timeout=_EXPORT_QUEUE_TIMEOUT_SECONDS
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Server is busy exporting. Try again shortly.",
            headers={"Retry-After": "5"},
        ) from exc


class _ExportStreamResponse(StreamingResponse):
    """Streams an export body and returns its concurrency slot afterwards.

    Starlette sends ``http.response.start`` before it pulls the first body
    chunk, so a client that disconnects at that point never drives the body
    generator to completion: releasing the slot from the generator's ``finally``
    would leave it pinned until the interpreter finalises the generator. Doing
    it here makes the hand-back deterministic — including when the body raises
    before its first chunk.

    ``failure_marker`` is the prefix of the comment appended to a ``text/plain``
    body when it raises after the headers went out (a deadline expiry, a pool
    error, a nested-acquire failure). The status is already 200 by then and
    cannot become a 4xx, so the body is the only place the failure can be made
    visible. CSV passes ``None``: it has no comment syntax to carry a marker.
    """

    def __init__(self, *args, failure_marker: Optional[str] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._failure_marker = failure_marker

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        except Exception as error:
            if self._failure_marker is not None:
                # The socket may already be gone (the failure itself can be a
                # disconnect), and a failed send must not replace the original
                # exception, so it is swallowed here and the error re-raised.
                try:
                    await send(
                        {
                            "type": "http.response.body",
                            "body": _failure_marker(error).encode(self.charset),
                            "more_body": False,
                        }
                    )
                except Exception:
                    pass
            raise
        finally:
            _export_semaphore.release()


@asynccontextmanager
async def _export_lease(pool):
    """Lease a pooled connection, discarding it when the export times out.

    Once ``asyncio.timeout`` fires, the driver connection may still own the
    stuck statement; returning it to the pool would hand a busy, desynchronized
    connection to the next request. ``_discard_lease_connection`` closes it,
    and the pool's release discards it instead of recycling it.
    """
    async with pool.acquire() as conn:
        try:
            yield conn
        except _ExportTimeout:
            _discard_lease_connection(conn)
            raise


async def _next_batch(cur, fetch_size: int, deadline: float, exported: int):
    if time.monotonic() > deadline:
        raise _export_timeout(exported)
    return await _await_with_remaining_deadline(
        cur.fetchmany(fetch_size), deadline, _export_timeout(exported)
    )


def _where_value(column: str, value) -> str:
    if value is None:
        return f"{quote_ident(column)} IS NULL"
    return f"{quote_ident(column)} = {escape_value(value)}"


async def _resolve_ai_columns(
    pool, database: str, table: str, deadline: float, exported: int
) -> set[str]:
    """Return the set of auto_increment column names for a table.

    Resolved on its own short-lived lease BEFORE the streaming cursor opens.
    The cursor holds one pooled connection for the whole download, so resolving
    while it is open would need a SECOND lease from the same per-session pool —
    which never succeeds when ``LAGUN_DB_POOL_MAX_SIZE=1``. The table's own
    ordinal column list is enough here (the filter only runs for table exports,
    where the result set is the table's columns), so no SELECT result is needed.

    Cost: one extra information_schema round-trip per opted-in export call.
    Acceptable because exports are user-initiated (not per-keystroke), the
    metadata lookup is cheap, and the result is small. The lookup shares the
    export deadline so a stalled metadata query cannot hold a pooled connection
    past max runtime.
    """
    try:
        async with _export_lease(pool) as conn:
            async with conn.cursor() as cur:
                await _await_with_remaining_deadline(
                    cur.execute(
                        """SELECT COLUMN_NAME FROM information_schema.COLUMNS
                           WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                           AND EXTRA LIKE '%%auto_increment%%'
                           ORDER BY ORDINAL_POSITION""",
                        (database, table),
                    ),
                    deadline,
                    _export_timeout(exported),
                )
                rows = await _await_with_remaining_deadline(
                    cur.fetchall(), deadline, _export_timeout(exported)
                )
                return {row[0] for row in rows}
    except Exception:
        log.warning(
            "Failed to resolve auto-increment columns for %s.%s; export aborted",
            database,
            table,
            exc_info=True,
        )
        raise


async def _apply_ai_filter(pool, req, deadline: float, exported: int) -> set[str]:
    """Auto_increment columns to omit from the export, resolved up front.

    No-op (empty set) when ``req.exclude_auto_increment`` is False or
    ``req.table`` is empty (a query-tab export has no fixed table to query
    metadata for). A lookup failure aborts the export with the log line in
    :func:`_resolve_ai_columns` and re-raises: continuing would emit INSERT/CSV
    output that still contains the columns the user asked to drop.
    """
    if not req.exclude_auto_increment or not req.table:
        return set()
    return await _resolve_ai_columns(pool, req.database, req.table, deadline, exported)


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


# The body is a streamed file, not JSON: the schema documents that, since a
# JSON `response_model` cannot describe it.
_STREAM_RESPONSES = {
    200: {
        "description": (
            "The exported file. The body ends with `-- Lagun export complete: N rows` "
            "for the SQL formats, so a truncated stream is detectable; if the stream "
            "fails after the headers, a final `-- Lagun export FAILED: <message>` line "
            "is appended instead. CSV carries no marker."
        ),
        # A file stream, so the schema is a string body rather than a JSON model.
        "content": {
            "text/plain": {"schema": {"type": "string"}},
            "text/csv": {"schema": {"type": "string"}},
        },
    }
}


@router.post(
    "/sessions/{session_id}/export",
    response_class=StreamingResponse,
    responses=_STREAM_RESPONSES,
)
async def export_data(session_id: str, req: ExportRequest):
    return await _export_response(session_id, req)


@router.post(
    "/sessions/{session_id}/export/download",
    response_class=StreamingResponse,
    responses=_STREAM_RESPONSES,
)
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
    # Same rule as every other data path: refuse before opening a connection.
    # A raw export SELECT may qualify another schema, so every referenced
    # schema is checked too — not just the request's database. MySQL's own
    # catalogs stay readable; ``mysql`` (grants, credentials) does not.
    require_db_scope(s, req.database)
    if req.sql and effective_scope(s) is not None:
        for schema in referenced_schemas(req.sql):
            if schema.lower() in SCOPE_REFERENCE_EXEMPT_SCHEMAS:
                continue
            require_db_scope(s, schema)

    if req.sql:
        try:
            statements = split_sql_script(req.sql)
        except SqlScriptError as error:
            raise HTTPException(400, f"Invalid export query: {error}") from error
        if len(statements) != 1:
            raise HTTPException(400, "Export query must contain one SELECT statement")
        stripped = statements[0].strip()
        if _EXECUTABLE_COMMENT.search(stripped):
            raise HTTPException(
                400, "Export query must not contain an executable comment"
            )
        if not re.match(r"^SELECT\b", stripped, re.IGNORECASE):
            raise HTTPException(400, "Only SELECT statements are allowed for export")
        uncommented = _COMMENT.sub(" ", stripped)
        if _SERVER_FILE_WRITE.search(uncommented):
            raise HTTPException(
                400,
                "Export query must not write server-side files "
                "(INTO OUTFILE / INTO DUMPFILE)",
            )
        if _DISALLOWED_FUNCTION.search(uncommented):
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
        exported = 0
        deadline = time.monotonic() + _EXPORT_MAX_RUNTIME_SECONDS
        # Resolved before the streaming lease: the metadata lookup takes its own
        # pooled connection, and a second lease from the same per-session pool
        # never succeeds when LAGUN_DB_POOL_MAX_SIZE=1.
        ai_cols = await _apply_ai_filter(pool, req, deadline, exported)
        async with _export_lease(pool) as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await _await_with_remaining_deadline(
                    cur.execute(f"USE {quote_ident(req.database)}"),
                    deadline,
                    _export_timeout(exported),
                )
                await _await_with_remaining_deadline(
                    cur.execute(select_sql), deadline, _export_timeout(exported)
                )
                cols = [d[0] for d in cur.description]
                cols_filtered = [c for c in cols if c not in ai_cols]
                # Values are taken by position: two result columns can share a
                # name (a self-join) and a name-keyed dict kept only the last.
                keep = _kept_indexes(cols, cols_filtered)
                cols_sql = ", ".join(quote_ident(c) for c in cols_filtered)
                tbl = req.table or "exported_data"
                tbl_q = _target_table_sql(req.database, tbl, req.include_schema)
                tbl_label = _target_table_label(req.database, tbl, req.include_schema)

                yield f"-- Lagun export: {tbl_label}\n"
                yield f"-- Format: INSERT ({req.insert_mode})\n\n"
                buf = io.StringIO()
                if req.insert_mode == "single":
                    while True:
                        rows = await _next_batch(cur, fetch_size, deadline, exported)
                        if not rows:
                            break
                        exported += len(rows)
                        for row in rows:
                            vals = ", ".join(escape_value(row[i]) for i in keep)
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
                        rows = await _next_batch(cur, fetch_size, deadline, exported)
                        if not rows:
                            break
                        exported += len(rows)
                        for row in rows:
                            if rows_in_statement == 0:
                                buf.write(f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n")
                            else:
                                buf.write(",\n")
                            vals = ", ".join(escape_value(row[i]) for i in keep)
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
                yield _completion_marker(exported)

    async def _generate_delete():
        exported = 0
        deadline = time.monotonic() + _EXPORT_MAX_RUNTIME_SECONDS
        async with _export_lease(pool) as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await _await_with_remaining_deadline(
                    cur.execute(f"USE {quote_ident(req.database)}"),
                    deadline,
                    _export_timeout(exported),
                )
                await _await_with_remaining_deadline(
                    cur.execute(
                        """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                           WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                           AND CONSTRAINT_NAME='PRIMARY'
                           ORDER BY ORDINAL_POSITION""",
                        (req.database, req.table),
                    ),
                    deadline,
                    _export_timeout(exported),
                )
                pk_cols = [
                    row[0]
                    for row in await _await_with_remaining_deadline(
                        cur.fetchall(), deadline, _export_timeout(exported)
                    )
                ]
                tbl_q = _target_table_sql(
                    req.database, req.table or "tbl", req.include_schema
                )
                await _await_with_remaining_deadline(
                    cur.execute(select_sql), deadline, _export_timeout(exported)
                )
                cols = [d[0] for d in cur.description]
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {_target_table_label(req.database, req.table or 'tbl', req.include_schema)}\n-- Format: DELETE\n\n"
                buf = io.StringIO()
                while True:
                    rows = await _next_batch(cur, fetch_size, deadline, exported)
                    if not rows:
                        break
                    exported += len(rows)
                    for row in rows:
                        where = _where_clause(cols, row, where_cols)
                        buf.write(f"DELETE FROM {tbl_q} WHERE {where};\n")
                        if buf.tell() >= _EXPORT_STREAM_CHARS:
                            yield buf.getvalue()
                            buf.seek(0)
                            buf.truncate(0)
                if buf.tell():
                    yield buf.getvalue()
                yield _completion_marker(exported)

    async def _generate_delete_insert():
        exported = 0
        deadline = time.monotonic() + _EXPORT_MAX_RUNTIME_SECONDS
        # Resolved before the streaming lease: see _generate_insert.
        ai_cols = await _apply_ai_filter(pool, req, deadline, exported)
        async with _export_lease(pool) as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await _await_with_remaining_deadline(
                    cur.execute(f"USE {quote_ident(req.database)}"),
                    deadline,
                    _export_timeout(exported),
                )
                await _await_with_remaining_deadline(
                    cur.execute(
                        """SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
                           WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                           AND CONSTRAINT_NAME='PRIMARY'
                           ORDER BY ORDINAL_POSITION""",
                        (req.database, req.table),
                    ),
                    deadline,
                    _export_timeout(exported),
                )
                pk_cols = [
                    row[0]
                    for row in await _await_with_remaining_deadline(
                        cur.fetchall(), deadline, _export_timeout(exported)
                    )
                ]
                tbl_q = _target_table_sql(
                    req.database, req.table or "tbl", req.include_schema
                )
                await _await_with_remaining_deadline(
                    cur.execute(select_sql), deadline, _export_timeout(exported)
                )
                cols = [d[0] for d in cur.description]
                cols_filtered = [c for c in cols if c not in ai_cols]
                keep = _kept_indexes(cols, cols_filtered)
                cols_sql = ", ".join(quote_ident(c) for c in cols_filtered)
                where_cols = pk_cols if pk_cols else cols

                yield f"-- Lagun export: {_target_table_label(req.database, req.table or 'tbl', req.include_schema)}\n-- Format: DELETE+INSERT ({req.insert_mode})\n\n"
                if req.insert_mode == "single":
                    buf = io.StringIO()
                    while True:
                        rows = await _next_batch(cur, fetch_size, deadline, exported)
                        if not rows:
                            break
                        exported += len(rows)
                        for row in rows:
                            where = _where_clause(cols, row, where_cols)
                            vals = ", ".join(escape_value(row[i]) for i in keep)
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
                        rows = await _next_batch(cur, fetch_size, deadline, exported)
                        if not rows:
                            break
                        exported += len(rows)
                        buf = io.StringIO()
                        for row in rows:
                            where = _where_clause(cols, row, where_cols)
                            buf.write(f"DELETE FROM {tbl_q} WHERE {where};\n")
                        buf.write(f"INSERT INTO {tbl_q} ({cols_sql}) VALUES\n")
                        for index, row in enumerate(rows):
                            vals = ", ".join(escape_value(row[i]) for i in keep)
                            buf.write((",\n" if index else "") + f"({vals})")
                        buf.write(";\n")
                        yield buf.getvalue()
                yield _completion_marker(exported)

    async def _generate_csv():
        exported = 0
        deadline = time.monotonic() + _EXPORT_MAX_RUNTIME_SECONDS
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

        # Resolved before the streaming lease: see _generate_insert.
        ai_cols = await _apply_ai_filter(pool, req, deadline, exported)
        async with _export_lease(pool) as conn:
            async with conn.cursor(aiomysql.SSCursor) as cur:
                await _await_with_remaining_deadline(
                    cur.execute(f"USE {quote_ident(req.database)}"),
                    deadline,
                    _export_timeout(exported),
                )
                await _await_with_remaining_deadline(
                    cur.execute(select_sql), deadline, _export_timeout(exported)
                )
                cols = [d[0] for d in cur.description]
                cols_filtered = [c for c in cols if c not in ai_cols]
                keep = _kept_indexes(cols, cols_filtered)
                if req.csv_encoding == "utf-8-sig":
                    yield b"\xef\xbb\xbf"

                buf = io.StringIO()
                writer = csv.writer(buf, **writer_kwargs)
                writer.writerow(_csv_neutralize(c) for c in cols_filtered)
                while True:
                    rows = await _next_batch(cur, fetch_size, deadline, exported)
                    if not rows:
                        break
                    exported += len(rows)
                    for row in rows:
                        writer.writerow(_csv_cell(row[i]) for i in keep)
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

    # Acquired last, after every step that can raise (session lookup, pool
    # acquisition, format validation): _ExportStreamResponse only releases a
    # slot while the response is actually streamed, so a slot taken before a
    # failure here would never be returned and would permanently shrink the
    # export pool.
    await _acquire_export_slot()
    # Only a text/plain body can carry a failure comment; CSV has no comment
    # syntax, so a truncated CSV is the only signal there.
    failure_marker = _EXPORT_FAILURE_MARKER if media.startswith("text/plain") else None
    return _ExportStreamResponse(
        gen,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        failure_marker=failure_marker,
    )
