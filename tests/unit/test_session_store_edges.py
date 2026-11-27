import json
import time

import pytest

from lagun.db import session_store
from lagun.models.session import SessionCreate, SessionUpdate


@pytest.mark.asyncio
async def test_password_lookup_and_update_field_branches(keep_event_loop_awake):
    await session_store.init_db()
    assert await session_store.get_session_password("missing") is None

    created = await session_store.create_session(
        SessionCreate(name="Original", username="reader", password="secret")
    )
    noop = await session_store.update_session(created.id, SessionUpdate())
    assert noop == created

    updated = await session_store.update_session(
        created.id,
        SessionUpdate(
            name="Updated",
            host="new.test",
            port=3307,
            username="writer",
            password="new-secret",
            default_db="app",
            query_limit=250,
            ssl_enabled=True,
        ),
    )
    assert updated is not None
    assert updated.name == "Updated"
    assert updated.host == "new.test"
    assert updated.port == 3307
    assert updated.username == "writer"
    assert updated.default_db == "app"
    assert updated.query_limit == 250
    assert updated.ssl_enabled is True


@pytest.mark.asyncio
async def test_managed_session_lookup_and_audit_filters(keep_event_loop_awake):
    await session_store.init_db()
    assert await session_store.is_managed_session("missing") is False

    await session_store.record_audit_event(
        username="alice",
        method="POST",
        path="/api/v1/test",
        session_id=None,
        details=json.dumps({"ok": True}),
        status_code=200,
        duration_ms=1.5,
    )
    events = await session_store.list_audit_events(
        username="alice",
        since="2000-01-01T00:00:00+00:00",
        path="/api",
        search="ok",
        status_code=200,
    )
    assert len(events) == 1
    assert events[0]["username"] == "alice"


@pytest.mark.asyncio
async def test_purge_removes_old_events_and_checkpoints(keep_event_loop_awake):
    await session_store.init_db()
    async with session_store._connect() as db:
        await db.execute(
            "INSERT INTO audit_events "
            "(occurred_at, username, method, path, session_id, details, status_code, duration_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "2000-01-01T00:00:00+00:00",
                "old",
                "GET",
                "/old",
                None,
                None,
                200,
                1.0,
            ),
        )
        await db.commit()

    assert await session_store.purge_audit_events(1) == 1


async def test_purge_keeps_the_database_compact_when_little_was_removed(
    keep_event_loop_awake,
):
    await session_store.init_db()
    async with session_store._connect() as db:
        for index in range(5):
            occurred_at = (
                "2000-01-01T00:00:00+00:00"
                if index == 0
                else "2999-01-01T00:00:00+00:00"
            )
            await db.execute(
                "INSERT INTO audit_events "
                "(occurred_at, username, method, path, session_id, details, status_code, duration_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    occurred_at,
                    f"user-{index}",
                    "GET",
                    "/test",
                    None,
                    None,
                    200,
                    1.0,
                ),
            )
        await db.commit()

    assert await session_store.purge_audit_events(1) == 1


async def test_audit_summary_filters_by_time(keep_event_loop_awake):
    await session_store.init_db()
    await session_store.record_audit_event(
        username="alice",
        method="POST",
        path="/api/v1/test",
        session_id=None,
        details=None,
        status_code=200,
        duration_ms=1.0,
    )

    assert await session_store.audit_summary() == {"event_count": 1, "user_count": 1}
    assert await session_store.audit_summary("2999-01-01T00:00:00+00:00") == {
        "event_count": 0,
        "user_count": 0,
    }


def test_audit_warning_suppression(monkeypatch):
    monkeypatch.setattr(session_store, "_AUDIT_WRITE_WARNING_INTERVAL_SECONDS", 3600)
    monkeypatch.setattr(session_store, "_last_audit_write_warning", time.monotonic())
    monkeypatch.setattr(session_store, "_suppressed_audit_write_warnings", 0)
    session_store._warn_audit_write_failure(RuntimeError("first"))
    session_store._warn_audit_write_failure(RuntimeError("second"))
    assert session_store._suppressed_audit_write_warnings == 2
