from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from lagun.api.admin import (
    AdminUserCreate,
    AdminUserMutation,
    PurgeRequest,
    add_user,
    get_activity,
    get_overview,
    get_users,
    purge_retention,
    remove_user,
)
from lagun.auth import request_admin_username
from lagun.db import session_store
from lagun.models.session import SessionCreate


def request_for(username: str | None):
    return SimpleNamespace(state=SimpleNamespace(user=username))


def test_admin_allowlist_is_explicit_and_case_insensitive(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    monkeypatch.setenv("LAGUN_ADMIN_USERS", " Alice, OPS ")

    assert request_admin_username(request_for("alice")) == "alice"
    with pytest.raises(HTTPException) as denied:
        request_admin_username(request_for("bob"))
    assert denied.value.status_code == 403


@pytest.mark.asyncio
async def test_admin_overview_requires_ldap_admin(keep_event_loop_awake, monkeypatch):
    await session_store.init_db()
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")

    with pytest.raises(HTTPException) as denied:
        await get_overview(request_for("bob"))
    assert denied.value.status_code == 403

    result = await get_overview(request_for("alice"))
    assert result["connection_count"] == 0
    assert result["window_hours"] == 24


@pytest.mark.asyncio
async def test_admin_inventory_and_activity_filters_never_return_password(
    keep_event_loop_awake, monkeypatch
):
    await session_store.init_db()
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")
    await session_store.create_session(
        SessionCreate(name="Private DB", username="reporter", password="secret"),
        "bob",
    )
    await session_store.record_audit_event(
        username="bob",
        method="POST",
        path="/api/v1/sessions/query",
        session_id="session-1",
        details='{"sql":"SELECT 1"}',
        status_code=200,
        duration_ms=4.5,
    )
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    async with session_store._connect() as db:
        await db.execute(
            "UPDATE audit_events SET occurred_at=? WHERE username=?", (old, "bob")
        )
        await db.commit()

    overview = await get_overview(request_for("alice"))
    assert overview["connection_count"] == 1
    assert overview["private_connection_count"] == 1

    result = await get_activity(
        request_for("alice"),
        username="bob",
        path="sessions",
        status_code=200,
        limit=10,
    )
    assert len(result["items"]) == 1
    assert "password" not in result["items"][0]
    assert "secret" not in str(result["items"][0])

    inventory = await session_store.list_admin_connections()
    assert inventory[0]["username"] == "reporter"
    assert "password_enc" not in inventory[0]


@pytest.mark.asyncio
async def test_admin_purge_requires_confirmation_and_deletes_old_events(
    keep_event_loop_awake, monkeypatch
):
    await session_store.init_db()
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")
    await session_store.record_audit_event(
        username="bob",
        method="GET",
        path="/api/v1/sessions",
        session_id=None,
        details=None,
        status_code=200,
        duration_ms=1,
    )
    old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    async with session_store._connect() as db:
        await db.execute(
            "UPDATE audit_events SET occurred_at=? WHERE username=?", (old, "bob")
        )
        await db.commit()

    with pytest.raises(HTTPException) as denied:
        await purge_retention(
            request_for("alice"),
            PurgeRequest(older_than_days=7, confirmation="NO"),
        )
    assert denied.value.status_code == 400

    result = await purge_retention(
        request_for("alice"),
        PurgeRequest(older_than_days=7, confirmation="PURGE"),
    )
    assert result["deleted"] == 1


@pytest.mark.asyncio
async def test_admin_users_mutate_allowlist_without_restart(monkeypatch, tmp_path):
    policy_path = tmp_path / "ldap.yaml"
    policy_path.write_text(
        "ldap:\n  url: ldap://directory.internal\n  allowed_users:\n    - alice\n"
    )
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", str(policy_path))
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")

    initial = await get_users(request_for("alice"))
    assert initial["items"] == [
        {
            "username": "alice",
            "active_clients": 0,
            "active_tabs": 0,
            "policy_state": "allowed",
        }
    ]

    added = await add_user(
        request_for("alice"),
        AdminUserCreate(username="Bob", expected_fingerprint=initial["fingerprint"]),
    )
    assert added["restart_required"] is False
    assert "bob" in policy_path.read_text()

    updated = await get_users(request_for("alice"))
    assert {item["username"] for item in updated["items"]} == {"alice", "bob"}

    removed = await remove_user(
        "bob",
        request_for("alice"),
        AdminUserMutation(expected_fingerprint=updated["fingerprint"]),
    )
    assert removed["restart_required"] is False
    assert "Bob" not in policy_path.read_text()

    with pytest.raises(HTTPException) as self_remove:
        await remove_user("alice", request_for("alice"))
    assert self_remove.value.status_code == 409

    with pytest.raises(HTTPException) as stale:
        await add_user(
            request_for("alice"),
            AdminUserCreate(
                username="charlie", expected_fingerprint=initial["fingerprint"]
            ),
        )
    assert stale.value.status_code == 409
