"""Tests for LDAP-owned and server-managed connection storage."""
import os

from lagun.db import session_store
from lagun.db.connections_config import sync_connections_config
from lagun.models.session import SessionCreate


async def test_private_connections_are_visible_only_to_their_owner(keep_event_loop_awake):
    await session_store.init_db()
    alice = await session_store.create_session(SessionCreate(name="Alice", username="db"), "alice")
    await session_store.create_session(SessionCreate(name="Bob", username="db"), "bob")

    assert [s.name for s in await session_store.list_sessions_for_user("alice")] == ["Alice"]
    assert await session_store.can_access_session(alice.id, "alice")
    assert not await session_store.can_access_session(alice.id, "bob")


async def test_shared_connection_can_be_hidden_by_one_user_only(tmp_path, monkeypatch, keep_event_loop_awake):
    await session_store.init_db()
    config = tmp_path / "connections.yaml"
    config.write_text("""
connections:
  - id: shared-db
    name: Shared DB
    username: shared
    password_env: TEST_SHARED_PASSWORD
    default: true
    allowed_users: [alice, bob]
""")
    monkeypatch.setenv("TEST_SHARED_PASSWORD", "secret")

    await sync_connections_config(str(config))
    alice_session = (await session_store.list_sessions_for_user("alice"))[0]
    assert alice_session.managed and alice_session.is_default
    assert [s.name for s in await session_store.list_sessions_for_user("bob")] == ["Shared DB"]

    await session_store.hide_shared_session(alice_session.id, "alice")
    assert await session_store.list_sessions_for_user("alice") == []
    assert [s.name for s in await session_store.list_sessions_for_user("bob")] == ["Shared DB"]


async def test_audit_events_can_be_filtered_and_purged(keep_event_loop_awake):
    await session_store.init_db()
    await session_store.record_audit_event(
        username="alice", method="POST", path="/api/v1/sessions/id/query",
        session_id="id", details="SELECT 1", status_code=200, duration_ms=2.5,
    )
    assert (await session_store.list_audit_events("alice"))[0]["details"] == "SELECT 1"
    assert await session_store.purge_audit_events(0) == 1
