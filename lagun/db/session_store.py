"""aiosqlite CRUD for saved sessions."""

import json
import logging
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiosqlite

from lagun.db.crypto import encrypt_password, decrypt_password
from lagun.models.session import SessionCreate, SessionRead, SessionUpdate

_log = logging.getLogger(__name__)


def _default_db_path() -> Path:
    """Return the persistent store path, with an operator-controlled override."""
    return Path(os.getenv("LAGUN_DB", Path.home() / ".lagun" / "lagun.db")).expanduser()


# None means "not pinned": the path is resolved from the environment on every
# use, so LAGUN_DB set after this module was imported (tests, `lagun serve`)
# is honoured. Tests pin it to a per-test temp file.
_DB_PATH: Path | None = None
_SQLITE_BUSY_SECONDS = float(os.getenv("LAGUN_SQLITE_BUSY_SECONDS", "10"))


def _db_path() -> Path:
    """Resolve the store path lazily, honouring LAGUN_DB at call time."""
    return _DB_PATH if _DB_PATH is not None else _default_db_path()


def _connect() -> aiosqlite.Connection:
    return aiosqlite.connect(_db_path(), timeout=max(1, _SQLITE_BUSY_SECONDS))


_BASELINE_TABLES: tuple[str, ...] = (
    """
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    host                TEXT NOT NULL DEFAULT 'localhost',
    port                INTEGER NOT NULL DEFAULT 3306,
    username            TEXT NOT NULL,
    password_enc        TEXT NOT NULL,
    default_db          TEXT,
    query_limit         INTEGER NOT NULL DEFAULT 100,
    ssl_enabled         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    selected_databases  TEXT NOT NULL DEFAULT '[]',
    managed_selected_databases TEXT NOT NULL DEFAULT '[]'
)
""",
    """
CREATE TABLE IF NOT EXISTS shared_session_access (
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (session_id, username)
)
""",
    """
CREATE TABLE IF NOT EXISTS hidden_shared_sessions (
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (session_id, username)
)
""",
    """
CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    username TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    session_id TEXT,
    details TEXT,
    status_code INTEGER NOT NULL,
    duration_ms REAL NOT NULL
)
""",
    """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
""",
)

# Columns added to `sessions` after the first release. Databases written by any
# released version converge on the same shape because the only tolerated error
# is the specific "duplicate column name" one (see _apply_statement).
_SESSIONS_ADDED_COLUMNS: tuple[str, ...] = (
    "selected_databases TEXT NOT NULL DEFAULT '[]'",
    "owner_username TEXT",
    "managed INTEGER NOT NULL DEFAULT 0",
    "config_key TEXT",
    "is_default INTEGER NOT NULL DEFAULT 0",
    "managed_selected_databases TEXT NOT NULL DEFAULT '[]'",
)

_BASELINE_INDEXES: tuple[str, ...] = (
    "CREATE UNIQUE INDEX IF NOT EXISTS sessions_config_key_unique "
    "ON sessions(config_key) WHERE config_key IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS sessions_owner_username_idx "
    "ON sessions(owner_username)",
    "CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx "
    "ON audit_events(occurred_at)",
)

# Numbered migrations applied in order, keyed on PRAGMA user_version. Version 1
# is the schema as of 0.1.93, so a database written by an older release is at
# user_version 0 and is upgraded in place on the next startup.
_MIGRATIONS: tuple[tuple[int, str, tuple[str, ...]], ...] = (
    (
        1,
        "baseline schema, session ownership columns and audit indexes",
        _BASELINE_TABLES
        + tuple(
            f"ALTER TABLE sessions ADD COLUMN {column}"
            for column in _SESSIONS_ADDED_COLUMNS
        )
        + _BASELINE_INDEXES,
    ),
)
_SCHEMA_VERSION = _MIGRATIONS[-1][0]


async def _apply_statement(db: aiosqlite.Connection, statement: str) -> None:
    """Run one migration statement.

    The only error tolerated is SQLite's "duplicate column name" from an ADD
    COLUMN that a database created by an older release already carries. Every
    other failure (locked database, missing table, constraint failure) must
    reach the runner so the migration is reported instead of half-applied.
    """
    try:
        await db.execute(statement)
    except sqlite3.OperationalError as error:
        if "duplicate column name" in str(error).lower() and "ADD COLUMN" in statement:
            return
        raise


async def _migrate(db: aiosqlite.Connection) -> int:
    """Apply migrations newer than the database's user_version; return the version."""
    async with db.execute("PRAGMA user_version") as cur:
        row = await cur.fetchone()
    version = int(row[0]) if row else 0
    for target, description, statements in _MIGRATIONS:
        if target <= version:
            continue
        try:
            # An explicit BEGIN: `executescript` implicitly commits, and each
            # migration (user_version included) must apply atomically.
            await db.execute("BEGIN")
            for statement in statements:
                await _apply_statement(db, statement)
            await db.execute(f"PRAGMA user_version = {target}")
            await db.commit()
        except Exception as error:
            await db.rollback()
            raise RuntimeError(
                f"lagun.db migration {target} ({description}) failed: {error}"
            ) from error
        version = target
    return version


async def init_db():
    # The store holds encrypted passwords and audit details, so keep the
    # directory private. mode applies only when the directory is created;
    # an existing one is left as the operator set it.
    _db_path().parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    async with _connect() as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA synchronous=NORMAL")
        await db.execute(
            f"PRAGMA busy_timeout={int(max(1, _SQLITE_BUSY_SECONDS) * 1000)}"
        )
        await _migrate(db)


def _row_to_model(row: aiosqlite.Row) -> SessionRead:
    return SessionRead(
        id=row["id"],
        name=row["name"],
        host=row["host"],
        port=row["port"],
        username=row["username"],
        default_db=row["default_db"],
        query_limit=row["query_limit"],
        ssl_enabled=bool(row["ssl_enabled"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
        selected_databases=json.loads(row["selected_databases"])
        if row["selected_databases"]
        else [],
        managed_selected_databases=json.loads(row["managed_selected_databases"])
        if row["managed_selected_databases"]
        else [],
        managed=bool(row["managed"]),
        is_default=bool(row["is_default"]),
    )


_READ_COLUMNS = "id, name, host, port, username, default_db, query_limit, ssl_enabled, created_at, updated_at, selected_databases, managed_selected_databases, managed, is_default"


async def list_sessions(owner_username: str | None = None) -> list[SessionRead]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT {_READ_COLUMNS} FROM sessions ORDER BY is_default DESC, name"
        ) as cur:
            rows = await cur.fetchall()
    return [_row_to_model(r) for r in rows]


async def list_admin_connections() -> list[dict]:
    """Return connection metadata for authorized administrators, never secrets."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT
                s.id,
                s.name,
                s.host,
                s.port,
                s.username,
                s.default_db,
                s.query_limit,
                s.ssl_enabled,
                s.created_at,
                s.updated_at,
                s.selected_databases,
                s.managed_selected_databases,
                s.managed,
                s.is_default,
                s.owner_username,
                s.config_key,
                (
                    SELECT COUNT(*)
                    FROM shared_session_access a
                    WHERE a.session_id = s.id
                ) AS shared_user_count
            FROM sessions s
            ORDER BY s.managed DESC, s.is_default DESC, s.name
            """
        ) as cur:
            rows = await cur.fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "host": row["host"],
            "port": row["port"],
            "username": row["username"],
            "default_db": row["default_db"],
            "query_limit": row["query_limit"],
            "ssl_enabled": bool(row["ssl_enabled"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "selected_databases": json.loads(row["selected_databases"])
            if row["selected_databases"]
            else [],
            "managed_selected_databases": json.loads(row["managed_selected_databases"])
            if row["managed_selected_databases"]
            else [],
            "managed": bool(row["managed"]),
            "is_default": bool(row["is_default"]),
            "owner_username": row["owner_username"],
            "config_key": row["config_key"],
            "shared_user_count": int(row["shared_user_count"]),
        }
        for row in rows
    ]


async def audit_summary(since: str | None = None) -> dict[str, int]:
    clauses: list[str] = []
    values: list[object] = []
    if since:
        clauses.append("occurred_at >= ?")
        values.append(since)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    async with _connect() as db:
        async with db.execute(
            f"SELECT COUNT(*), COUNT(DISTINCT username) FROM audit_events{where}",
            values,
        ) as cur:
            count, users = await cur.fetchone()
    return {"event_count": int(count), "user_count": int(users)}


async def count_audit_events_before(older_than_days: int) -> int:
    from datetime import timedelta

    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    async with _connect() as db:
        async with db.execute(
            "SELECT COUNT(*) FROM audit_events WHERE occurred_at < ?", (cutoff,)
        ) as cur:
            (count,) = await cur.fetchone()
    return int(count)


async def list_sessions_for_user(username: str) -> list[SessionRead]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT DISTINCT s.{_READ_COLUMNS.replace(', ', ', s.')} FROM sessions s "
            "LEFT JOIN shared_session_access a ON a.session_id = s.id AND a.username = ? "
            "LEFT JOIN hidden_shared_sessions h ON h.session_id = s.id AND h.username = ? "
            "WHERE s.owner_username = ? OR (s.managed = 1 AND a.username IS NOT NULL AND h.username IS NULL) "
            "ORDER BY s.is_default DESC, s.name",
            (username, username, username),
        ) as cur:
            rows = await cur.fetchall()
    return [_row_to_model(r) for r in rows]


async def get_session(session_id: str) -> Optional[SessionRead]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT {_READ_COLUMNS} FROM sessions WHERE id = ?",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
    return _row_to_model(row) if row else None


async def get_session_password(session_id: str) -> Optional[str]:
    async with _connect() as db:
        async with db.execute(
            "SELECT password_enc FROM sessions WHERE id = ?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    # decrypt_password raises CredentialDecryptError when the master key changed,
    # which main.py maps to an actionable response.
    return decrypt_password(row[0])


async def create_session(
    data: SessionCreate, owner_username: str | None = None
) -> SessionRead:
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    enc = encrypt_password(data.password)
    async with _connect() as db:
        await db.execute(
            "INSERT INTO sessions (id, name, host, port, username, password_enc, default_db, query_limit, ssl_enabled, created_at, updated_at, selected_databases, owner_username, managed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
            (
                sid,
                data.name,
                data.host,
                data.port,
                data.username,
                enc,
                data.default_db,
                data.query_limit,
                int(data.ssl_enabled),
                now,
                now,
                json.dumps(data.selected_databases),
                owner_username,
            ),
        )
        await db.commit()
    return await get_session(sid)


async def update_session(session_id: str, data: SessionUpdate) -> Optional[SessionRead]:
    fields = {}
    if data.name is not None:
        fields["name"] = data.name
    if data.host is not None:
        fields["host"] = data.host
    if data.port is not None:
        fields["port"] = data.port
    if data.username is not None:
        fields["username"] = data.username
    if data.password is not None:
        fields["password_enc"] = encrypt_password(data.password)
    if data.default_db is not None:
        fields["default_db"] = data.default_db
    if data.query_limit is not None:
        fields["query_limit"] = data.query_limit
    if data.ssl_enabled is not None:
        fields["ssl_enabled"] = int(data.ssl_enabled)
    if data.selected_databases is not None:
        fields["selected_databases"] = json.dumps(data.selected_databases)

    if not fields:
        return await get_session(session_id)

    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    async with _connect() as db:
        await db.execute(
            f"UPDATE sessions SET {set_clause} WHERE id = ?",
            (*fields.values(), session_id),
        )
        await db.commit()
    return await get_session(session_id)


async def delete_session(session_id: str) -> bool:
    async with _connect() as db:
        cur = await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()
        ok = cur.rowcount > 0
    if ok:
        # Drop ANALYZE throttle entries cached for this session (table_ops.py).
        # Deferred import keeps the api -> session_store dependency acyclic.
        from lagun.api.table_ops import invalidate_analyze_cache

        invalidate_analyze_cache(session_id)
    return ok


async def can_access_session(session_id: str, username: str) -> bool:
    async with _connect() as db:
        async with db.execute(
            "SELECT 1 FROM sessions s LEFT JOIN shared_session_access a ON a.session_id=s.id AND a.username=? "
            "LEFT JOIN hidden_shared_sessions h ON h.session_id=s.id AND h.username=? "
            "WHERE s.id=? AND (s.owner_username=? OR (s.managed=1 AND a.username IS NOT NULL AND h.username IS NULL))",
            (username, username, session_id, username),
        ) as cur:
            return await cur.fetchone() is not None


async def is_managed_session(session_id: str) -> bool:
    async with _connect() as db:
        async with db.execute(
            "SELECT managed FROM sessions WHERE id=?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
    return bool(row and row[0])


async def hide_shared_session(session_id: str, username: str) -> None:
    async with _connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO hidden_shared_sessions (session_id, username) VALUES (?, ?)",
            (session_id, username),
        )
        await db.commit()


# Audit writes must never fail the request they describe, but a silent gap
# (read-only store, full disk, locked database) is invisible to operators. Warn
# at most once per interval and report how many failures were held back.
_AUDIT_WRITE_WARNING_INTERVAL_SECONDS = max(
    0.0, float(os.getenv("LAGUN_AUDIT_WRITE_WARNING_INTERVAL_SECONDS", "60"))
)
_last_audit_write_warning = 0.0
_suppressed_audit_write_warnings = 0


def _warn_audit_write_failure(error: Exception) -> None:
    global _last_audit_write_warning, _suppressed_audit_write_warnings
    now = time.monotonic()
    if now - _last_audit_write_warning < _AUDIT_WRITE_WARNING_INTERVAL_SECONDS:
        _suppressed_audit_write_warnings += 1
        return
    suppressed = _suppressed_audit_write_warnings
    _suppressed_audit_write_warnings = 0
    _last_audit_write_warning = now
    held_back = f" ({suppressed} earlier failures suppressed)" if suppressed else ""
    _log.warning("Could not write audit event: %s%s", error, held_back, exc_info=error)


async def record_audit_event(
    *,
    username: str,
    method: str,
    path: str,
    session_id: str | None,
    details: str | None,
    status_code: int,
    duration_ms: float,
) -> None:
    try:
        async with _connect() as db:
            await db.execute(
                "INSERT INTO audit_events (occurred_at, username, method, path, session_id, details, status_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    username,
                    method,
                    path,
                    session_id,
                    details,
                    status_code,
                    duration_ms,
                ),
            )
            await db.commit()
    except Exception as error:
        # Swallowed so auditing can never fail the database action it describes,
        # but no longer silently: the operator gets the exception (rate-limited).
        _warn_audit_write_failure(error)


def _audit_contains_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_audit_events(
    username: str | None = None,
    since: str | None = None,
    limit: int = 100,
    path: str | None = None,
    status_code: int | None = None,
    search: str | None = None,
    before_id: int | None = None,
) -> list[dict]:
    clauses: list[str] = []
    values: list[object] = []
    if before_id is not None:
        # Keyset cursor: rows strictly older than the first row of the previous
        # page. `id` is returned so the caller can build the next cursor.
        clauses.append("id < ?")
        values.append(before_id)
    if username:
        clauses.append("LOWER(username) LIKE LOWER(?) ESCAPE '\\'")
        values.append(_audit_contains_pattern(username))
    if since:
        clauses.append("occurred_at >= ?")
        values.append(since)
    if path:
        clauses.append("LOWER(path) LIKE LOWER(?) ESCAPE '\\'")
        values.append(_audit_contains_pattern(path))
    if status_code is not None:
        clauses.append("status_code = ?")
        values.append(status_code)
    if search:
        pattern = _audit_contains_pattern(search)
        clauses.append(
            "("
            "LOWER(username) LIKE LOWER(?) ESCAPE '\\' OR "
            "LOWER(method) LIKE LOWER(?) ESCAPE '\\' OR "
            "LOWER(path) LIKE LOWER(?) ESCAPE '\\' OR "
            "LOWER(COALESCE(details, '')) LIKE LOWER(?) ESCAPE '\\'"
            ")"
        )
        values.extend([pattern] * 4)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT id, occurred_at, username, method, path, session_id, details, status_code, duration_ms FROM audit_events{where} ORDER BY id DESC LIMIT ?",
            (*values, limit),
        ) as cur:
            return [dict(row) for row in await cur.fetchall()]


# A purge that removed at least this share of the remaining table rebuilds the
# file so the freed pages return to the filesystem (VACUUM); every purge
# checkpoints so the write-ahead log can be truncated.
_PURGE_VACUUM_MIN_SHARE = 0.25


async def purge_audit_events(older_than_days: int) -> int:
    from datetime import timedelta

    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    async with _connect() as db:
        cur = await db.execute(
            "DELETE FROM audit_events WHERE occurred_at < ?", (cutoff,)
        )
        removed = cur.rowcount
        await db.commit()
        async with db.execute("SELECT COUNT(*) FROM audit_events") as count_cur:
            (remaining,) = await count_cur.fetchone()
        # Without this the deleted pages stay in the file (and in the -wal
        # sibling) forever, so a successful purge never returns space.
        if removed and removed >= _PURGE_VACUUM_MIN_SHARE * (removed + remaining):
            await db.execute("VACUUM")
        await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return removed


async def list_sessions_raw() -> list[dict]:
    """Return all sessions as dicts including password_enc. Used only by config export."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, host, port, username, password_enc, default_db, "
            "query_limit, ssl_enabled, created_at, updated_at, selected_databases "
            "FROM sessions ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]
