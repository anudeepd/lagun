"""Schema versioning for the SQLite session store (OPS-02)."""

import sqlite3

import pytest

import lagun.db.session_store as session_store

_CURRENT_COLUMNS = {
    "selected_databases",
    "owner_username",
    "managed",
    "config_key",
    "is_default",
    "managed_selected_databases",
}

# The schema as released before any of the columns above existed: a database at
# user_version 0 that a pre-versioning install may still have on disk.
_LEGACY_SCHEMA = """
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    host            TEXT NOT NULL DEFAULT 'localhost',
    port            INTEGER NOT NULL DEFAULT 3306,
    username        TEXT NOT NULL,
    password_enc    TEXT NOT NULL,
    default_db      TEXT,
    query_limit     INTEGER NOT NULL DEFAULT 100,
    ssl_enabled     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE TABLE shared_session_access (
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (session_id, username)
);
CREATE TABLE hidden_shared_sessions (
    session_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (session_id, username)
);
CREATE TABLE audit_events (
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
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO sessions (
    id, name, host, port, username, password_enc, default_db,
    query_limit, ssl_enabled, created_at, updated_at
) VALUES (
    'legacy-1', 'Legacy reporting', 'db.internal', 3306, 'reporter', 'enc', 'app',
    100, 0, '2025-01-01T00:00:00+00:00', '2025-01-01T00:00:00+00:00'
);
"""


def _create_legacy_db(path):
    connection = sqlite3.connect(path)
    try:
        connection.executescript(_LEGACY_SCHEMA)
        connection.commit()
    finally:
        connection.close()


async def _read_version() -> int:
    async with session_store._connect() as db:
        async with db.execute("PRAGMA user_version") as cur:
            row = await cur.fetchone()
    return int(row[0])


async def _read_session_columns() -> set[str]:
    async with session_store._connect() as db:
        async with db.execute("PRAGMA table_info(sessions)") as cur:
            rows = await cur.fetchall()
    return {row[1] for row in rows}


@pytest.mark.asyncio
async def test_legacy_database_upgrades_in_place(
    keep_event_loop_awake, monkeypatch, tmp_path
):
    path = tmp_path / "legacy.db"
    _create_legacy_db(path)
    monkeypatch.setattr(session_store, "_DB_PATH", path)
    assert await _read_version() == 0

    await session_store.init_db()

    assert await _read_version() == session_store._SCHEMA_VERSION
    assert _CURRENT_COLUMNS <= await _read_session_columns()
    async with session_store._connect() as db:
        async with db.execute(
            "SELECT id, username, selected_databases FROM sessions"
        ) as cur:
            assert await cur.fetchall() == [("legacy-1", "reporter", "[]")]
        async with db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        ) as cur:
            indexes = {row[0] for row in await cur.fetchall()}
    assert {
        "sessions_config_key_unique",
        "sessions_owner_username_idx",
        "audit_events_occurred_at_idx",
    } <= indexes

    # Second startup is a no-op: the version is already current and every
    # ADD COLUMN would report a duplicate column.
    await session_store.init_db()
    assert await _read_version() == session_store._SCHEMA_VERSION


@pytest.mark.asyncio
async def test_unversioned_current_schema_is_stamped(
    keep_event_loop_awake, monkeypatch, tmp_path
):
    """Reproduces a real ~/.lagun/lagun.db: current columns, user_version 0."""
    path = tmp_path / "unversioned.db"
    monkeypatch.setattr(session_store, "_DB_PATH", path)
    await session_store.init_db()
    async with session_store._connect() as db:
        await db.execute(
            "INSERT INTO sessions (id, name, username, password_enc, created_at, updated_at) "
            "VALUES ('s-1', 'Existing', 'reporter', 'enc', '2025-01-01T00:00:00+00:00', "
            "'2025-01-01T00:00:00+00:00')"
        )
        await db.execute("PRAGMA user_version = 0")
        await db.commit()
    assert await _read_version() == 0

    await session_store.init_db()

    assert await _read_version() == session_store._SCHEMA_VERSION
    async with session_store._connect() as db:
        async with db.execute("SELECT name FROM sessions") as cur:
            assert await cur.fetchall() == [("Existing",)]


@pytest.mark.asyncio
async def test_failing_migration_raises_with_context_and_rolls_back(
    keep_event_loop_awake, monkeypatch, tmp_path
):
    path = tmp_path / "broken.db"
    monkeypatch.setattr(session_store, "_DB_PATH", path)
    monkeypatch.setattr(
        session_store,
        "_MIGRATIONS",
        (
            (
                1,
                "deliberately broken",
                (
                    "CREATE TABLE migration_probe (value TEXT)",
                    "ALTER TABLE no_such_table ADD COLUMN value TEXT",
                ),
            ),
        ),
    )

    with pytest.raises(RuntimeError) as raised:
        await session_store.init_db()

    message = str(raised.value)
    assert "migration 1 (deliberately broken) failed" in message
    assert "no such table" in message
    # The statement before the failure was rolled back with the version.
    assert await _read_version() == 0
    async with session_store._connect() as db:
        async with db.execute(
            "SELECT name FROM sqlite_master WHERE name = 'migration_probe'"
        ) as cur:
            assert await cur.fetchall() == []
