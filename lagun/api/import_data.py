"""Incremental CSV and MySQL dump import."""

from __future__ import annotations

import asyncio
import csv
import io
import os
import re
import tempfile
from typing import BinaryIO, Literal, Optional, TextIO

from fastapi import APIRouter, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from lagun.api.sql_script import SqlScriptError, iter_sql_statements
from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident

router = APIRouter(tags=["import"])

IMPORT_MAX_FILE_BYTES = int(
    os.getenv("LAGUN_IMPORT_MAX_FILE_BYTES", str(1024 * 1024 * 1024))
)
IMPORT_CHUNK_BYTES = int(os.getenv("LAGUN_IMPORT_CHUNK_BYTES", str(1024 * 1024)))
IMPORT_MAX_BATCH_BYTES = int(os.getenv("LAGUN_IMPORT_MAX_BATCH_BYTES", str(512 * 1024)))


class ImportConfig(BaseModel):
    database: str
    format: Literal["csv", "mysql_dump"] = "csv"
    table: str | None = None
    delimiter: str = ","
    quotechar: str = '"'
    escapechar: str = '"'
    lineterminator: str = "\r\n"
    encoding: str = "utf-8"
    first_row_header: bool = True
    strategy: Literal["insert", "insert_ignore", "replace"] = "insert"
    batch_size: int = Field(default=500, ge=1, le=10_000)
    preserve_empty_strings: bool = False

    @field_validator("database")
    @classmethod
    def non_empty_database(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("database must not be empty")
        return value

    @field_validator("delimiter", "quotechar", "escapechar")
    @classmethod
    def csv_character(cls, value: str, info) -> str:
        if info.field_name == "delimiter":
            value = value.replace("\\t", "\t")
        if len(value) > 1:
            raise ValueError(f"{info.field_name} must be 0 or 1 characters")
        if info.field_name == "delimiter" and not value:
            raise ValueError("delimiter must be exactly one character")
        return value

    @model_validator(mode="after")
    def csv_table_required(self) -> "ImportConfig":
        if self.format == "csv" and not self.table:
            raise ValueError("table is required for csv imports")
        return self


class ImportResult(BaseModel):
    ok: bool
    rows_processed: int
    rows_imported: int
    method: str
    error: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)
    statements_processed: int = 0
    statements_succeeded: int = 0
    error_statement: str | None = None
    error_line: int | None = None
    partial: bool = False


class PreviewResult(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    total_lines_sampled: int = 0
    format: Literal["csv", "mysql_dump"] = "csv"
    statements: list[dict[str, int | str]] = Field(default_factory=list)


def _parse_config(config_json: str) -> ImportConfig:
    try:
        return ImportConfig.model_validate_json(config_json)
    except ValidationError as error:
        raise HTTPException(422, detail=error.errors(include_context=False)) from error


def _csv_reader_kwargs(cfg: ImportConfig) -> dict:
    delimiter = cfg.delimiter.replace("\\t", "\t")
    kwargs: dict = {"delimiter": delimiter}
    if cfg.quotechar:
        kwargs["quotechar"] = cfg.quotechar
        if cfg.escapechar and cfg.escapechar != cfg.quotechar:
            kwargs["escapechar"] = cfg.escapechar
    else:
        kwargs["quoting"] = csv.QUOTE_NONE
        kwargs["escapechar"] = cfg.escapechar or "\\"
    return kwargs


async def _stage_upload(file: UploadFile) -> tuple[BinaryIO, int]:
    staged = tempfile.SpooledTemporaryFile(max_size=IMPORT_CHUNK_BYTES, mode="w+b")
    total = 0
    try:
        while True:
            chunk = await file.read(IMPORT_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > IMPORT_MAX_FILE_BYTES:
                raise HTTPException(
                    413,
                    f"File too large ({total} bytes). Max is {IMPORT_MAX_FILE_BYTES} bytes.",
                )
            await asyncio.to_thread(staged.write, chunk)
        staged.seek(0)
        return staged, total
    except Exception:
        staged.close()
        raise


def _decode_error(encoding: str, error: UnicodeDecodeError) -> HTTPException:
    return HTTPException(400, f"Cannot decode file with encoding '{encoding}': {error}")


def _open_text(staged: BinaryIO, encoding: str) -> TextIO:
    try:
        return io.TextIOWrapper(staged, encoding=encoding, newline="")
    except LookupError as error:
        raise HTTPException(400, f"Unknown encoding '{encoding}': {error}") from error


def _preview_csv(staged: BinaryIO, cfg: ImportConfig) -> PreviewResult:
    staged.seek(0)
    text = _open_text(staged, cfg.encoding)
    try:
        reader = csv.reader(text, **_csv_reader_kwargs(cfg))
        sampled: list[list[str]] = []
        for _ in range(11):
            try:
                sampled.append(next(reader))
            except StopIteration:
                break
        if not sampled:
            raise HTTPException(400, "File is empty")
        if cfg.first_row_header:
            columns = sampled[0]
            rows = sampled[1:]
        else:
            columns = [f"col_{i + 1}" for i in range(len(sampled[0]))]
            rows = sampled
        return PreviewResult(
            columns=columns, rows=rows[:10], total_lines_sampled=len(rows), format="csv"
        )
    except csv.Error as error:
        raise HTTPException(400, f"CSV parse error: {error}") from error
    except UnicodeDecodeError as error:
        raise _decode_error(cfg.encoding, error) from error
    finally:
        text.detach()


async def _preview_dump(staged: BinaryIO, cfg: ImportConfig) -> PreviewResult:
    staged.seek(0)
    text = _open_text(staged, cfg.encoding)
    try:
        statements = []
        iterator = iter_sql_statements(text)
        while len(statements) < 10:
            item = await asyncio.to_thread(_next_sql_statement, iterator)
            if item is None:
                break
            statements.append({"line": item.line, "sql": item.sql})
        return PreviewResult(format="mysql_dump", statements=statements)
    except UnicodeDecodeError as error:
        raise _decode_error(cfg.encoding, error) from error
    except SqlScriptError as error:
        raise HTTPException(400, f"SQL parse error: {error}") from error
    finally:
        text.detach()


def _validate_columns(columns: list[str]) -> None:
    if not columns or any(not column.strip() for column in columns):
        raise HTTPException(400, "CSV header columns must not be empty")
    if len(set(columns)) != len(columns):
        raise HTTPException(400, "CSV header columns must be unique")


class CsvImportError(ValueError):
    """Raised for CSV errors that should become structured import results."""


def _read_csv_batch(
    reader: csv.reader,
    pending: list[str] | None,
    max_rows: int,
    max_bytes: int,
) -> tuple[list[list[str]], list[str] | None, bool]:
    rows: list[list[str]] = []
    pending_row = pending
    batch_bytes = 0
    while len(rows) < max_rows:
        if pending_row is not None:
            row = pending_row
            pending_row = None
        else:
            try:
                row = next(reader)
            except StopIteration:
                return rows, None, True
        row_bytes = sum(len(value.encode("utf-8")) for value in row) + len(row)
        if row_bytes > max_bytes:
            raise CsvImportError(f"CSV row exceeds the {max_bytes}-byte batch limit")
        if rows and batch_bytes + row_bytes > max_bytes:
            pending_row = row
            break
        rows.append(row)
        batch_bytes += row_bytes
    return rows, pending_row, False


def _coerce_row(row: list[str], preserve_empty_strings: bool) -> list[str | None]:
    if preserve_empty_strings:
        return row
    return [None if value == "" else value for value in row]


async def _batch_insert(pool, cfg: ImportConfig, staged: BinaryIO) -> ImportResult:
    staged.seek(0)
    text = _open_text(staged, cfg.encoding)
    rows_processed = 0
    rows_imported = 0
    warnings: list[str] = []
    reader = csv.reader(text, **_csv_reader_kwargs(cfg))
    try:
        try:
            first_row = await asyncio.to_thread(lambda: next(reader, None))
            if first_row is None:
                raise HTTPException(400, "File is empty")
        except csv.Error as error:
            raise HTTPException(400, f"CSV parse error: {error}") from error
        except UnicodeDecodeError as error:
            raise _decode_error(cfg.encoding, error) from error
        if cfg.first_row_header:
            columns = first_row
            _validate_columns(columns)
            pending: list[str] | None = None
        else:
            columns = []
            pending = first_row

        db_q = quote_ident(cfg.database)
        tbl_q = quote_ident(cfg.table or "")
        if not cfg.first_row_header:
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT COLUMN_NAME FROM information_schema.COLUMNS
                           WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
                           ORDER BY ORDINAL_POSITION""",
                        (cfg.database, cfg.table),
                    )
                    col_rows = await cur.fetchall()
                    if not col_rows:
                        raise HTTPException(
                            400,
                            f"Table {cfg.database}.{cfg.table} not found or has no columns",
                        )
                    columns = [row[0] for row in col_rows]

        placeholders = ", ".join("%s" for _ in columns)
        cols_sql = ", ".join(quote_ident(column) for column in columns)
        prefix = {
            "insert": "INSERT",
            "insert_ignore": "INSERT IGNORE",
            "replace": "REPLACE",
        }[cfg.strategy]
        stmt = f"{prefix} INTO {db_q}.{tbl_q} ({cols_sql}) VALUES ({placeholders})"

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(f"USE {db_q}")
                    await cur.execute("SET autocommit=0")
                    while True:
                        batch, pending, eof = await asyncio.to_thread(
                            _read_csv_batch,
                            reader,
                            pending,
                            cfg.batch_size,
                            IMPORT_MAX_BATCH_BYTES,
                        )
                        if not batch:
                            break
                        for offset, row in enumerate(batch):
                            source_row = (
                                rows_processed
                                + offset
                                + (2 if cfg.first_row_header else 1)
                            )
                            if len(row) != len(columns):
                                raise CsvImportError(
                                    f"CSV row {source_row} has {len(row)} fields; expected {len(columns)}"
                                )
                        params = [
                            _coerce_row(row, cfg.preserve_empty_strings)
                            for row in batch
                        ]
                        await cur.executemany(stmt, params)
                        rows_processed += len(batch)
                        rows_imported += max(cur.rowcount, 0)
                        if eof:
                            break
                    await cur.execute("COMMIT")
                except HTTPException as error:
                    try:
                        await cur.execute("ROLLBACK")
                    except Exception:
                        pass
                    return ImportResult(
                        ok=False,
                        rows_processed=rows_processed,
                        rows_imported=rows_imported,
                        method="batch_insert",
                        error=str(error.detail),
                        warnings=warnings,
                    )
                except (CsvImportError, csv.Error, UnicodeDecodeError) as error:
                    try:
                        await cur.execute("ROLLBACK")
                    except Exception:
                        pass
                    return ImportResult(
                        ok=False,
                        rows_processed=rows_processed,
                        rows_imported=rows_imported,
                        method="batch_insert",
                        error=str(error),
                        warnings=warnings,
                    )
                except Exception as error:
                    try:
                        await cur.execute("ROLLBACK")
                    except Exception:
                        pass
                    return ImportResult(
                        ok=False,
                        rows_processed=rows_processed,
                        rows_imported=rows_imported,
                        method="batch_insert",
                        error=str(error),
                        warnings=warnings,
                    )
                finally:
                    try:
                        await cur.execute("SET autocommit=1")
                    except Exception:
                        conn.close()
        return ImportResult(
            ok=True,
            rows_processed=rows_processed,
            rows_imported=rows_imported,
            method="batch_insert",
            warnings=warnings,
        )
    finally:
        text.detach()


def _statement_preview(sql: str) -> str:
    return " ".join(sql[:500].split())


def _next_sql_statement(iterator):
    return next(iterator, None)


def _error_line(error: BaseException) -> int | None:
    match = re.search(r"line (\d+)", str(error), re.IGNORECASE)
    return int(match.group(1)) if match else None


async def _mysql_dump_import(pool, cfg: ImportConfig, staged: BinaryIO) -> ImportResult:
    staged.seek(0)
    text = _open_text(staged, cfg.encoding)
    processed = succeeded = rows_imported = 0
    error_statement: str | None = None
    error_line: int | None = None
    error: str | None = None
    try:
        async with pool.acquire() as conn:
            try:
                async with conn.cursor() as cur:
                    try:
                        await cur.execute(f"USE {quote_ident(cfg.database)}")
                        iterator = iter_sql_statements(text)
                        while True:
                            item = await asyncio.to_thread(
                                _next_sql_statement, iterator
                            )
                            if item is None:
                                break
                            processed += 1
                            error_line = item.line
                            try:
                                await cur.execute(item.sql)
                            except Exception as exc:
                                error = str(exc)
                                error_statement = _statement_preview(item.sql)
                                break
                            succeeded += 1
                            if cur.rowcount is not None and cur.rowcount >= 0:
                                rows_imported += cur.rowcount
                        if error is None:
                            error_line = None
                    except (SqlScriptError, UnicodeDecodeError) as exc:
                        error = (
                            f"SQL parse error: {exc}"
                            if isinstance(exc, SqlScriptError)
                            else str(exc)
                        )
                        error_statement = None
                        error_line = _error_line(exc)
                    except Exception as exc:
                        error = str(exc)
                        error_statement = None
                        error_line = None
                    if error is not None:
                        try:
                            await cur.execute("ROLLBACK")
                        except Exception:
                            pass
            finally:
                # Dumps may alter arbitrary session state or hold explicit locks.
                # Never return that connection to the shared pool.
                conn.close()
    finally:
        text.detach()
    if error is not None:
        return ImportResult(
            ok=False,
            rows_processed=0,
            rows_imported=rows_imported,
            method="mysql_dump",
            error=error,
            statements_processed=processed,
            statements_succeeded=succeeded,
            error_statement=error_statement,
            error_line=error_line,
            partial=succeeded > 0,
        )
    return ImportResult(
        ok=True,
        rows_processed=0,
        rows_imported=rows_imported,
        method="mysql_dump",
        statements_processed=processed,
        statements_succeeded=succeeded,
    )


@router.post("/sessions/{session_id}/import/preview")
async def import_preview(session_id: str, file: UploadFile, config: str = Form(...)):
    if not await get_session(session_id):
        raise HTTPException(404, "Session not found")
    cfg = _parse_config(config)
    staged, _ = await _stage_upload(file)
    try:
        if cfg.format == "csv":
            return await asyncio.to_thread(_preview_csv, staged, cfg)
        return await _preview_dump(staged, cfg)
    finally:
        staged.close()


@router.post("/sessions/{session_id}/import")
async def import_data(session_id: str, file: UploadFile, config: str = Form(...)):
    if not await get_session(session_id):
        raise HTTPException(404, "Session not found")
    cfg = _parse_config(config)
    staged, _ = await _stage_upload(file)
    try:
        pool = await get_pool(session_id)
        if cfg.format == "csv":
            return await _batch_insert(pool, cfg, staged)
        return await _mysql_dump_import(pool, cfg, staged)
    finally:
        staged.close()
