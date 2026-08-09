from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient

from lagun import main as lagun_main
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
async def test_audit_middleware_preserves_body_query_target_and_ignores_admin_polls(
    monkeypatch,
):
    events = []

    async def record_event(**event):
        events.append(event)

    monkeypatch.setattr(lagun_main, "ldap_enabled", lambda: True)
    monkeypatch.setattr(lagun_main.session_store, "record_audit_event", record_event)

    audit_app = FastAPI()
    audit_app.middleware("http")(lagun_main.ldap_connection_access_and_audit)

    @audit_app.middleware("http")
    async def authenticate(request: Request, call_next):
        request.state.user = "alice"
        return await call_next(request)

    @audit_app.get("/api/v1/admin/activity")
    async def admin_activity():
        return {"items": []}

    @audit_app.post("/api/v1/echo")
    async def echo(request: Request):
        return await request.json()

    body = b'{"sql":"SELECT * FROM users WHERE active = 1","filters":{"team":"ops"}}'
    async with AsyncClient(
        transport=ASGITransport(app=audit_app), base_url="http://test"
    ) as client:
        poll_response = await client.get("/api/v1/admin/activity?limit=100")
        response = await client.post(
            "/api/v1/echo?view=raw%20rows",
            content=body,
            headers={"content-type": "application/json"},
        )

    assert poll_response.status_code == 200
    assert response.status_code == 200
    assert response.json()["filters"] == {"team": "ops"}
    assert len(events) == 1
    assert events[0]["username"] == "alice"
    assert events[0]["method"] == "POST"
    assert events[0]["path"] == "/api/v1/echo?view=raw%20rows"
    assert events[0]["details"] == body.decode()


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
                "view": "data",
                "global_search": "open orders",
                "where_filter": "status = 'open' AND total >= 250",
                "row_limit": 250,
            },
        ],
    )

    result = await presence.update_presence(payload, request_for("alice"))
    rows = await presence.list_presence()

    assert result["ok"] is True
    assert rows[0]["username"] == "alice"
    assert rows[0]["active_tab_id"] == "tab-2"
    assert [tab["label"] for tab in rows[0]["tabs"]] == ["Query — reporting", "orders"]
    table_tab = rows[0]["tabs"][1]
    assert table_tab["view"] == "data"
    assert table_tab["global_search"] == "open orders"
    assert table_tab["where_filter"] == "status = 'open' AND total >= 250"
    assert table_tab["row_limit"] == 250

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
