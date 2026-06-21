"""aiosqlite CRUD for saved sessions."""
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiosqlite

from lagun.db.crypto import encrypt_password, decrypt_password
from lagun.models.session import SessionCreate, SessionRead, SessionUpdate

_DB_PATH = Path.home() / ".lagun" / "lagun.db"

_SCHEMA = """
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
    selected_databases  TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS shared_session_access (
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (session_id, username)
);

CREATE TABLE IF NOT EXISTS hidden_shared_sessions (
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (session_id, username)
);

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
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


async def init_db():
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.executescript(_SCHEMA)
        # Migrate existing DBs that lack the selected_databases column
        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN selected_databases TEXT NOT NULL DEFAULT '[]'")
            await db.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        for column in ("owner_username TEXT", "managed INTEGER NOT NULL DEFAULT 0", "config_key TEXT", "is_default INTEGER NOT NULL DEFAULT 0"):
            try:
                await db.execute(f"ALTER TABLE sessions ADD COLUMN {column}")
                await db.commit()
            except sqlite3.OperationalError:
                pass
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS sessions_config_key_unique "
            "ON sessions(config_key) WHERE config_key IS NOT NULL"
        )
        await db.commit()


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
        selected_databases=json.loads(row["selected_databases"]) if row["selected_databases"] else [],
        managed=bool(row["managed"]),
        is_default=bool(row["is_default"]),
    )


_READ_COLUMNS = "id, name, host, port, username, default_db, query_limit, ssl_enabled, created_at, updated_at, selected_databases, managed, is_default"


async def list_sessions(owner_username: str | None = None) -> list[SessionRead]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT {_READ_COLUMNS} FROM sessions ORDER BY is_default DESC, name"
        ) as cur:
            rows = await cur.fetchall()
    return [_row_to_model(r) for r in rows]


async def list_sessions_for_user(username: str) -> list[SessionRead]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT DISTINCT s.{_READ_COLUMNS.replace(', ', ', s.')} FROM sessions s "
            "LEFT JOIN shared_session_access a ON a.session_id = s.id AND a.username = ? "
            "LEFT JOIN hidden_shared_sessions h ON h.session_id = s.id AND h.username = ? "
            "WHERE s.owner_username = ? OR (s.managed = 1 AND a.username IS NOT NULL AND h.username IS NULL) "
            "ORDER BY s.is_default DESC, s.name", (username, username, username)
        ) as cur:
            rows = await cur.fetchall()
    return [_row_to_model(r) for r in rows]


async def get_session(session_id: str) -> Optional[SessionRead]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT {_READ_COLUMNS} FROM sessions WHERE id = ?",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
    return _row_to_model(row) if row else None


async def get_session_password(session_id: str) -> Optional[str]:
    async with aiosqlite.connect(_DB_PATH) as db:
        async with db.execute(
            "SELECT password_enc FROM sessions WHERE id = ?", (session_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    return decrypt_password(row[0])


async def create_session(data: SessionCreate, owner_username: str | None = None) -> SessionRead:
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    enc = encrypt_password(data.password)
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            "INSERT INTO sessions (id, name, host, port, username, password_enc, default_db, query_limit, ssl_enabled, created_at, updated_at, selected_databases, owner_username, managed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
            (sid, data.name, data.host, data.port, data.username, enc,
             data.default_db, data.query_limit, int(data.ssl_enabled), now, now,
             json.dumps(data.selected_databases), owner_username),
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
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            f"UPDATE sessions SET {set_clause} WHERE id = ?",
            (*fields.values(), session_id),
        )
        await db.commit()
    return await get_session(session_id)


async def delete_session(session_id: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as db:
        cur = await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()
        return cur.rowcount > 0


async def can_access_session(session_id: str, username: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM sessions s LEFT JOIN shared_session_access a ON a.session_id=s.id AND a.username=? "
            "LEFT JOIN hidden_shared_sessions h ON h.session_id=s.id AND h.username=? "
            "WHERE s.id=? AND (s.owner_username=? OR (s.managed=1 AND a.username IS NOT NULL AND h.username IS NULL))",
            (username, username, session_id, username),
        ) as cur:
            return await cur.fetchone() is not None


async def is_managed_session(session_id: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as db:
        async with db.execute("SELECT managed FROM sessions WHERE id=?", (session_id,)) as cur:
            row = await cur.fetchone()
    return bool(row and row[0])


async def hide_shared_session(session_id: str, username: str) -> None:
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute("INSERT OR IGNORE INTO hidden_shared_sessions (session_id, username) VALUES (?, ?)", (session_id, username))
        await db.commit()


async def record_audit_event(*, username: str, method: str, path: str, session_id: str | None,
                             details: str | None, status_code: int, duration_ms: float) -> None:
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            "INSERT INTO audit_events (occurred_at, username, method, path, session_id, details, status_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(), username, method, path, session_id, details, status_code, duration_ms),
        )
        await db.commit()


async def list_audit_events(username: str | None = None, since: str | None = None, limit: int = 100) -> list[dict]:
    clauses: list[str] = []
    values: list[object] = []
    if username:
        clauses.append("username = ?")
        values.append(username)
    if since:
        clauses.append("occurred_at >= ?")
        values.append(since)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT occurred_at, username, method, path, session_id, details, status_code, duration_ms FROM audit_events{where} ORDER BY id DESC LIMIT ?",
            (*values, limit),
        ) as cur:
            return [dict(row) for row in await cur.fetchall()]


async def purge_audit_events(older_than_days: int) -> int:
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    async with aiosqlite.connect(_DB_PATH) as db:
        cur = await db.execute("DELETE FROM audit_events WHERE occurred_at < ?", (cutoff,))
        await db.commit()
        return cur.rowcount


async def list_sessions_raw() -> list[dict]:
    """Return all sessions as dicts including password_enc. Used only by config export."""
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, host, port, username, password_enc, default_db, "
            "query_limit, ssl_enabled, created_at, updated_at, selected_databases "
            "FROM sessions ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]
