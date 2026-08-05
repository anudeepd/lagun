from types import SimpleNamespace

import pytest

from lagun.api import presence, query
from lagun.api.presence import PresenceUpdate
from lagun.main import _audit_details


def request_for(username: str | None):
    return SimpleNamespace(state=SimpleNamespace(user=username))


def test_request_details_preserve_complete_json_body():
    body = (
        '{"bulk":{"fullSql":"SELECT * FROM users WHERE email=\'alice@example.test\'"},'
        '"statements":["UPDATE users SET name=\'Alice\'"],'
        '"padding":"' + ("x" * 32_001) + '"}'
    ).encode()

    assert _audit_details(body) == body.decode()


@pytest.mark.asyncio
async def test_presence_reports_open_tabs_and_expires_stale_clients(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    payload = PresenceUpdate(
        client_id="client-1",
        active_tab_id="tab-2",
        tabs=[
            {
                "id": "tab-1",
                "type": "query",
                "label": "Query — reporting",
                "session_id": "session-1",
                "database": "analytics",
                "table": None,
            },
            {
                "id": "tab-2",
                "type": "table",
                "label": "orders",
                "session_id": "session-1",
                "database": "analytics",
                "table": "orders",
            },
        ],
    )

    result = await presence.update_presence(payload, request_for("alice"))
    rows = await presence.list_presence()

    assert result["ok"] is True
    assert rows[0]["username"] == "alice"
    assert rows[0]["active_tab_id"] == "tab-2"
    assert [tab["label"] for tab in rows[0]["tabs"]] == ["Query — reporting", "orders"]

    presence._records[("alice", "client-1")].seen_epoch = 0
    assert await presence.list_presence() == []


@pytest.mark.asyncio
async def test_active_query_snapshot_contains_complete_sql(monkeypatch):
    query._active_query_executions.clear()
    query._active_script_queries.clear()
    query._active_script_details.clear()
    query._active_query_executions[("session-1", "exec-1")] = query._ActiveQuery(
        thread_id=123,
        owner_username="alice",
        execution_id="exec-1",
        started_at="2026-08-05T00:00:00+00:00",
        started_epoch=0,
        database="analytics",
        tab_id="tab-1",
        sql="SELECT * FROM orders WHERE customer='alice@example.test'",
    )

    async def fake_get_session(session_id: str):
        assert session_id == "session-1"
        return SimpleNamespace(name="Reporting", host="db.internal", port=3306)

    monkeypatch.setattr(query, "get_session", fake_get_session)
    try:
        rows = await query.list_active_queries()
    finally:
        query._active_query_executions.clear()

    assert rows == [
        {
            "session_id": "session-1",
            "execution_id": "exec-1",
            "username": "alice",
            "database": "analytics",
            "tab_id": "tab-1",
            "sql": "SELECT * FROM orders WHERE customer='alice@example.test'",
            "started_at": "2026-08-05T00:00:00+00:00",
            "elapsed_ms": rows[0]["elapsed_ms"],
            "state": "running",
            "kind": "query",
            "session_name": "Reporting",
            "host": "db.internal",
            "port": 3306,
        }
    ]
