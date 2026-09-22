"""HTTP-level tests for the admin console and presence routes.

The admin gate, routing and response serialisation are exercised through the
real ASGI app; only the LDAP user identity is injected, because ldapgate's
middleware is not installed in the test environment.
"""

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from lagun.api import presence
from lagun.api.admin import _MIN_RETENTION_DAYS
from lagun.db import session_store
from lagun.main import app
from lagun.models.session import SessionCreate

ADMIN_ROUTES = (
    "/api/v1/admin/overview",
    "/api/v1/admin/connections",
    "/api/v1/admin/users",
    "/api/v1/admin/activity",
    "/api/v1/admin/retention",
)


class _IdentityInjector:
    """Install an ldapgate-style user on the request scope from a header."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {key.decode(): value.decode() for key, value in scope["headers"]}
            scope.setdefault("state", {})["user"] = headers.get("x-test-user") or None
        await self.inner(scope, receive, send)


@pytest.fixture(autouse=True)
def clear_presence():
    presence._records.clear()
    yield
    presence._records.clear()


@pytest.fixture
def ldap_admin(monkeypatch, tmp_path):
    policy = tmp_path / "ldap.yaml"
    policy.write_text(
        "ldap:\n  url: ldap://directory.internal\n  allowed_users:\n    - alice\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", str(policy))
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")
    return policy


@pytest_asyncio.fixture
async def http_client(keep_event_loop_awake):
    await session_store.init_db()
    transport = ASGITransport(app=_IdentityInjector(app))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_admin_routes_reject_a_non_admin(ldap_admin, http_client):
    for route in ADMIN_ROUTES:
        response = await http_client.get(route, headers={"x-test-user": "bob"})

        assert response.status_code == 403, route
        assert response.json() == {"detail": "Administrator access denied"}, route


async def test_admin_routes_reject_a_request_without_an_identity(
    ldap_admin, http_client
):
    response = await http_client.get("/api/v1/admin/overview")

    assert response.status_code == 401
    assert response.json() == {"detail": "LDAP user identity is missing"}


async def test_admin_routes_are_closed_when_ldap_is_disabled(monkeypatch, http_client):
    monkeypatch.delenv("LAGUN_LDAP_CONFIG", raising=False)
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")

    response = await http_client.get(
        "/api/v1/admin/overview", headers={"x-test-user": "alice"}
    )

    assert response.status_code == 403
    assert "requires LDAP authentication" in response.json()["detail"]


async def test_admin_overview_and_connections_report_the_inventory(
    ldap_admin, http_client
):
    await session_store.create_session(
        SessionCreate(name="Private DB", username="reporter", password="secret"),
        "bob",
    )
    admin = {"x-test-user": "alice"}

    connections = await http_client.get("/api/v1/admin/connections", headers=admin)
    overview = await http_client.get("/api/v1/admin/overview", headers=admin)

    assert connections.status_code == 200
    items = connections.json()["items"]
    assert [item["name"] for item in items] == ["Private DB"]
    assert "password_enc" not in items[0]

    assert overview.status_code == 200
    body = overview.json()
    assert body["connection_count"] == 1
    assert body["private_connection_count"] == 1
    assert body["managed_connection_count"] == 0
    assert body["window_hours"] == 24


async def test_admin_activity_and_retention_respond_over_http(ldap_admin, http_client):
    await session_store.record_audit_event(
        username="bob",
        method="POST",
        path="/api/v1/sessions/query",
        session_id="session-1",
        details='{"sql":"SELECT 1"}',
        status_code=200,
        duration_ms=4.5,
    )
    admin = {"x-test-user": "alice"}

    activity = await http_client.get(
        "/api/v1/admin/activity", params={"limit": 10}, headers=admin
    )
    retention = await http_client.get("/api/v1/admin/retention", headers=admin)

    assert activity.status_code == 200
    events = activity.json()["items"]
    assert [(event["username"], event["method"]) for event in events] == [
        ("bob", "POST")
    ]
    assert "password" not in str(events)

    assert retention.status_code == 200
    assert retention.json()["older_than_days"] == 30
    assert retention.json()["minimum_age_days"] == _MIN_RETENTION_DAYS
    assert retention.json()["eligible_count"] == 0


async def test_admin_users_lists_the_ldap_policy(ldap_admin, http_client):
    response = await http_client.get(
        "/api/v1/admin/users", headers={"x-test-user": "alice"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == [
        {
            "username": "alice",
            "active_clients": 0,
            "active_tabs": 0,
            "policy_state": "allowed",
        }
    ]
    assert body["fingerprint"]


async def test_presence_round_trip_over_http(ldap_admin, http_client):
    admin = {"x-test-user": "alice"}
    payload = {
        "client_id": "client-1",
        "active_tab_id": "tab-2",
        "tabs": [
            {
                "id": "tab-1",
                "type": "query",
                "label": "Query — reporting",
                "session_id": "session-1",
            },
            {
                "id": "tab-2",
                "type": "table",
                "label": "orders",
                "session_id": "session-1",
                "database": "analytics",
                "table": "orders",
                "view": "data",
                "where_filter": "status = 'open'",
                "row_limit": 250,
            },
        ],
    }

    published = await http_client.post("/api/v1/presence", json=payload, headers=admin)
    listed = await http_client.get("/api/v1/admin/presence", headers=admin)

    assert published.status_code == 200
    assert published.json()["ok"] is True
    assert listed.status_code == 200
    assert listed.json()["stale_after_seconds"] == presence.PRESENCE_TTL_SECONDS
    clients = listed.json()["items"]
    assert [(item["username"], item["client_id"]) for item in clients] == [
        ("alice", "client-1")
    ]
    assert clients[0]["active_tab_id"] == "tab-2"
    assert [tab["label"] for tab in clients[0]["tabs"]] == [
        "Query — reporting",
        "orders",
    ]
    assert clients[0]["tabs"][1]["where_filter"] == "status = 'open'"

    removed = await http_client.delete("/api/v1/presence/client-1", headers=admin)
    after_removal = await http_client.get("/api/v1/admin/presence", headers=admin)

    assert removed.status_code == 200
    assert removed.json() == {"ok": True}
    assert after_removal.json()["items"] == []


async def test_presence_enforces_the_documented_field_limits(ldap_admin, http_client):
    admin = {"x-test-user": "alice"}
    over_long_label = {
        "client_id": "client-1",
        "tabs": [
            {
                "id": "tab-1",
                "type": "query",
                "label": "x" * 201,
                "session_id": "session-1",
            }
        ],
    }
    too_many_tabs = {
        "client_id": "client-1",
        "tabs": [
            {"id": f"tab-{index}", "type": "query", "label": "q", "session_id": "s"}
            for index in range(101)
        ],
    }

    label_response = await http_client.post(
        "/api/v1/presence", json=over_long_label, headers=admin
    )
    tabs_response = await http_client.post(
        "/api/v1/presence", json=too_many_tabs, headers=admin
    )

    assert label_response.status_code == 422
    assert tabs_response.status_code == 422
