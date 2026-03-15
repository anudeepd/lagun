"""aiosqlite CRUD for saved sessions."""
import json
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
        except Exception:
            pass  # Column already exists


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
    )


async def list_sessions() -> list[SessionRead]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, host, port, username, default_db, "
            "query_limit, ssl_enabled, created_at, updated_at, selected_databases FROM sessions ORDER BY name"
        ) as cur:
            rows = await cur.fetchall()
    return [_row_to_model(r) for r in rows]


async def get_session(session_id: str) -> Optional[SessionRead]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, name, host, port, username, default_db, "
            "query_limit, ssl_enabled, created_at, updated_at, selected_databases FROM sessions WHERE id = ?",
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


async def create_session(data: SessionCreate) -> SessionRead:
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    enc = encrypt_password(data.password)
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, data.name, data.host, data.port, data.username, enc,
             data.default_db, data.query_limit, int(data.ssl_enabled), now, now,
             json.dumps(data.selected_databases)),
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
