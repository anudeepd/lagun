"""CSV/delimited data import via batch INSERT."""
import csv
import io
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, Form
from pydantic import BaseModel

from lagun.db.pool import get_pool
from lagun.db.session_store import get_session
from lagun.db.utils import quote_ident

router = APIRouter(tags=["import"])

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


class ImportConfig(BaseModel):
    database: str
    table: str
    delimiter: str = ","
    quotechar: str = '"'
    escapechar: str = '"'
    lineterminator: str = "\r\n"
    encoding: str = "utf-8"
    first_row_header: bool = True
    strategy: str = "insert"  # "insert" | "insert_ignore" | "replace"
    batch_size: int = 500


class ImportResult(BaseModel):
    ok: bool
    rows_processed: int
    rows_imported: int
    method: str  # "batch_insert"
    error: Optional[str] = None
    warnings: list[str] = []


class PreviewResult(BaseModel):
    columns: list[str]
    rows: list[list[str]]
    total_lines_sampled: int


def _parse_config(config_json: str) -> ImportConfig:
    return ImportConfig.model_validate_json(config_json)


def _csv_reader_kwargs(cfg: ImportConfig) -> dict:
    delimiter = cfg.delimiter.replace("\\t", "\t")
    kwargs: dict = dict(delimiter=delimiter)
    if cfg.quotechar:
        kwargs["quotechar"] = cfg.quotechar
        if cfg.escapechar != cfg.quotechar:
            kwargs["escapechar"] = cfg.escapechar
    else:
        kwargs["quoting"] = csv.QUOTE_NONE
        kwargs["escapechar"] = cfg.escapechar or "\\"
    return kwargs


def _normalize_line_endings(text: str) -> str:
    """Normalize all line endings to \\n for Python's csv.reader."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


async def _read_file(file: UploadFile, encoding: str) -> str:
    raw = await file.read()
    if len(raw) > MAX_FILE_SIZE:
        raise HTTPException(413, f"File too large ({len(raw)} bytes). Max is {MAX_FILE_SIZE} bytes.")
    try:
        return raw.decode(encoding)
    except UnicodeDecodeError as e:
        raise HTTPException(400, f"Cannot decode file with encoding '{encoding}': {e}")


@router.post("/sessions/{session_id}/import/preview")
async def import_preview(session_id: str, file: UploadFile, config: str = Form(...)):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")

    cfg = _parse_config(config)
    text = await _read_file(file, cfg.encoding)

    try:
        reader = csv.reader(io.StringIO(_normalize_line_endings(text)), **_csv_reader_kwargs(cfg))
        all_rows = []
        for i, row in enumerate(reader):
            if i >= 11:  # header + 10 data rows max
                break
            all_rows.append(row)
    except csv.Error as e:
        raise HTTPException(400, f"CSV parse error: {e}")

    if not all_rows:
        raise HTTPException(400, "File is empty")

    if cfg.first_row_header:
        columns = all_rows[0]
        rows = all_rows[1:]
    else:
        columns = [f"col_{i+1}" for i in range(len(all_rows[0]))]
        rows = all_rows

    return PreviewResult(
        columns=columns,
        rows=rows[:10],
        total_lines_sampled=len(rows),
    )


@router.post("/sessions/{session_id}/import")
async def import_data(session_id: str, file: UploadFile, config: str = Form(...)):
    s = await get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")

    cfg = _parse_config(config)
    raw = await file.read()
    if len(raw) > MAX_FILE_SIZE:
        raise HTTPException(413, f"File too large ({len(raw)} bytes). Max is {MAX_FILE_SIZE} bytes.")

    pool = await get_pool(session_id)
    return await _batch_insert(pool, cfg, raw)



async def _batch_insert(pool, cfg: ImportConfig, raw: bytes) -> ImportResult:
    """Client-side CSV parsing with batched parameterized INSERT/REPLACE statements."""
    try:
        text = raw.decode(cfg.encoding)
    except UnicodeDecodeError as e:
        raise HTTPException(400, f"Cannot decode file with encoding '{cfg.encoding}': {e}")

    try:
        reader = csv.reader(io.StringIO(_normalize_line_endings(text)), **_csv_reader_kwargs(cfg))
        all_rows = list(reader)
    except csv.Error as e:
        raise HTTPException(400, f"CSV parse error: {e}")

    if not all_rows:
        raise HTTPException(400, "File is empty")

    if cfg.first_row_header:
        columns = all_rows[0]
        data_rows = all_rows[1:]
    else:
        # Fetch column names from the table
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
                    raise HTTPException(400, f"Table {cfg.database}.{cfg.table} not found or has no columns")
                columns = [r[0] for r in col_rows]
        data_rows = all_rows

    db_q = quote_ident(cfg.database)
    tbl_q = quote_ident(cfg.table)
    cols_sql = ", ".join(quote_ident(c) for c in columns)
    placeholders = ", ".join("%s" for _ in columns)

    if cfg.strategy == "insert":
        stmt = f"INSERT INTO {db_q}.{tbl_q} ({cols_sql}) VALUES ({placeholders})"
    elif cfg.strategy == "insert_ignore":
        stmt = f"INSERT IGNORE INTO {db_q}.{tbl_q} ({cols_sql}) VALUES ({placeholders})"
    elif cfg.strategy == "replace":
        stmt = f"REPLACE INTO {db_q}.{tbl_q} ({cols_sql}) VALUES ({placeholders})"
    else:
        raise HTTPException(400, f"Unknown strategy: {cfg.strategy!r}")

    rows_processed = 0
    rows_imported = 0
    warnings: list[str] = []

    def _coerce_row(row: list[str]) -> list:
        """Convert empty strings to None so NULLs are inserted properly."""
        return [None if v == "" else v for v in row]

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"USE {db_q}")
            await cur.execute("SET autocommit=0")
            try:
                for i in range(0, len(data_rows), cfg.batch_size):
                    batch = data_rows[i:i + cfg.batch_size]
                    params = [_coerce_row(row) for row in batch]
                    await cur.executemany(stmt, params)
                    rows_processed += len(batch)
                    rows_imported += cur.rowcount
                await cur.execute("COMMIT")
            except Exception as e:
                await cur.execute("ROLLBACK")
                return ImportResult(
                    ok=False,
                    rows_processed=rows_processed,
                    rows_imported=rows_imported,
                    method="batch_insert",
                    error=str(e),
                    warnings=warnings,
                )
            finally:
                await cur.execute("SET autocommit=1")

    return ImportResult(
        ok=True,
        rows_processed=rows_processed,
        rows_imported=rows_imported,
        method="batch_insert",
        warnings=warnings,
    )
