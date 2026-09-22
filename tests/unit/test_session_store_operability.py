"""Operability of the SQLite session store: purge reclaim, lazy path, audit
write visibility and the audit keyset cursor (OPS-05, OPS-12, API-4)."""

import logging

import pytest

import lagun.db.session_store as session_store

_AUDIT_INSERT = (
    "INSERT INTO audit_events "
    "(occurred_at, username, method, path, session_id, details, status_code, duration_ms) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
)


def _audit_row(
    path: str = "/api/v1/x",
    details: str | None = None,
    when: str = "2020-01-01T00:00:00+00:00",
):
    return (when, "ops", "GET", path, None, details, 200, 1.0)


async def _record(**overrides) -> None:
    kwargs = {
        "username": "ops",
        "method": "GET",
        "path": "/api/v1/x",
        "session_id": None,
        "details": None,
        "status_code": 200,
        "duration_ms": 1.0,
    }
    kwargs.update(overrides)
    await session_store.record_audit_event(**kwargs)


@pytest.mark.asyncio
async def test_purge_audit_events_reclaims_disk(
    keep_event_loop_awake, monkeypatch, tmp_path
):
    path = tmp_path / "store.db"
    monkeypatch.setattr(session_store, "_DB_PATH", path)
    await session_store.init_db()
    async with session_store._connect() as db:
        await db.executemany(
            _AUDIT_INSERT, [_audit_row(details="x" * 2048) for _ in range(2000)]
        )
        await db.commit()
    grown = path.stat().st_size
    assert grown > 1_000_000

    removed = await session_store.purge_audit_events(older_than_days=365)

    assert removed == 2000
    # A bare DELETE leaves both the freed pages and the write-ahead log in place.
    assert path.stat().st_size < grown / 2
    wal = path.with_name(path.name + "-wal")
    assert not wal.exists() or wal.stat().st_size == 0


@pytest.mark.asyncio
async def test_lagun_db_set_after_import_is_honoured(
    keep_event_loop_awake, monkeypatch, tmp_path
):
    # _DB_PATH pinned to None is the "nothing resolved yet" state this process
    # starts in; the environment must be consulted at call time, not at import.
    monkeypatch.setattr(session_store, "_DB_PATH", None)
    first = tmp_path / "first" / "lagun.db"
    monkeypatch.setenv("LAGUN_DB", str(first))

    await session_store.init_db()
    assert first.is_file()

    # Not frozen at first use either: a later LAGUN_DB change is picked up.
    second = tmp_path / "second" / "lagun.db"
    monkeypatch.setenv("LAGUN_DB", str(second))
    await session_store.init_db()
    assert second.is_file()


@pytest.mark.asyncio
async def test_audit_write_failure_warns_once_per_interval(
    monkeypatch, caplog, tmp_path
):
    # A real failure mode: the store path cannot be opened, as when the file is
    # read-only, the disk is full, or an operator pointed LAGUN_DB at a file.
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("")
    monkeypatch.setattr(session_store, "_DB_PATH", blocker / "lagun.db")
    monkeypatch.setattr(session_store, "_AUDIT_WRITE_WARNING_INTERVAL_SECONDS", 60.0)
    monkeypatch.setattr(session_store, "_last_audit_write_warning", 0.0)
    monkeypatch.setattr(session_store, "_suppressed_audit_write_warnings", 0)

    with caplog.at_level(logging.WARNING, logger="lagun.db.session_store"):
        for _ in range(3):
            # Auditing must never fail the request it describes.
            await _record()

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "unable to open database file" in warnings[0].getMessage()

    monkeypatch.setattr(session_store, "_AUDIT_WRITE_WARNING_INTERVAL_SECONDS", 0.0)
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="lagun.db.session_store"):
        await _record()

    assert "2 earlier failures suppressed" in caplog.records[-1].getMessage()


@pytest.mark.asyncio
async def test_audit_listing_pages_backwards_with_before_id(
    keep_event_loop_awake, monkeypatch, tmp_path
):
    monkeypatch.setattr(session_store, "_DB_PATH", tmp_path / "store.db")
    await session_store.init_db()
    for index in range(5):
        await _record(path=f"/api/v1/events/{index}")

    # Omitting before_id still returns the newest rows, newest first.
    everything = await session_store.list_audit_events()
    assert [row["id"] for row in everything] == [5, 4, 3, 2, 1]
    assert [row["path"] for row in everything] == [
        f"/api/v1/events/{index}" for index in reversed(range(5))
    ]
    assert await session_store.list_audit_events(limit=2) == everything[:2]

    first_page = await session_store.list_audit_events(limit=2)
    second_page = await session_store.list_audit_events(
        limit=2, before_id=first_page[-1]["id"]
    )
    third_page = await session_store.list_audit_events(
        limit=2, before_id=second_page[-1]["id"]
    )

    assert [row["id"] for row in first_page] == [5, 4]
    assert [row["id"] for row in second_page] == [3, 2]
    assert [row["id"] for row in third_page] == [1]
    assert all(row["id"] < first_page[-1]["id"] for row in second_page)
    assert all(row["id"] < second_page[-1]["id"] for row in third_page)

    # The cursor composes with the existing filters.
    filtered = await session_store.list_audit_events(path="events/", before_id=4)
    assert [row["id"] for row in filtered] == [3, 2, 1]
    assert await session_store.list_audit_events(before_id=1) == []
