"""Integration tests for the sessions API."""
import pytest


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

async def test_list_sessions_empty(client):
    r = await client.get("/api/v1/sessions")
    assert r.status_code == 200
    assert r.json() == []


async def test_create_and_get_session(client):
    payload = {"name": "My DB", "host": "db.example.com", "port": 3306, "username": "root"}
    r = await client.post("/api/v1/sessions", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "My DB"
    assert data["host"] == "db.example.com"
    assert data["username"] == "root"
    assert "id" in data
    assert "password" not in data  # password must never be returned

    sid = data["id"]
    r2 = await client.get(f"/api/v1/sessions/{sid}")
    assert r2.status_code == 200
    assert r2.json()["id"] == sid


async def test_create_session_defaults(client):
    r = await client.post("/api/v1/sessions", json={"name": "Defaults", "username": "u"})
    assert r.status_code == 201
    data = r.json()
    assert data["host"] == "localhost"
    assert data["port"] == 3306
    assert data["query_limit"] == 100
    assert data["ssl_enabled"] is False


async def test_list_sessions_returns_created(client):
    await client.post("/api/v1/sessions", json={"name": "A", "username": "u"})
    await client.post("/api/v1/sessions", json={"name": "B", "username": "u"})
    r = await client.get("/api/v1/sessions")
    names = [s["name"] for s in r.json()]
    assert "A" in names
    assert "B" in names


async def test_update_session(client):
    r = await client.post("/api/v1/sessions", json={"name": "Old", "username": "u"})
    sid = r.json()["id"]
    r2 = await client.put(f"/api/v1/sessions/{sid}", json={"name": "New", "port": 3307})
    assert r2.status_code == 200
    data = r2.json()
    assert data["name"] == "New"
    assert data["port"] == 3307


async def test_delete_session(client):
    r = await client.post("/api/v1/sessions", json={"name": "Temp", "username": "u"})
    sid = r.json()["id"]
    r2 = await client.delete(f"/api/v1/sessions/{sid}")
    assert r2.status_code == 204
    r3 = await client.get(f"/api/v1/sessions/{sid}")
    assert r3.status_code == 404


async def test_get_nonexistent_session_returns_404(client):
    r = await client.get("/api/v1/sessions/does-not-exist")
    assert r.status_code == 404


async def test_update_nonexistent_session_returns_404(client):
    r = await client.put("/api/v1/sessions/does-not-exist", json={"name": "X"})
    assert r.status_code == 404


async def test_delete_nonexistent_session_returns_404(client):
    r = await client.delete("/api/v1/sessions/does-not-exist")
    assert r.status_code == 404


async def test_create_session_validates_name_too_long(client):
    r = await client.post("/api/v1/sessions", json={"name": "x" * 101, "username": "u"})
    assert r.status_code == 422


async def test_create_session_validates_port_range(client):
    r = await client.post("/api/v1/sessions", json={"name": "n", "username": "u", "port": 99999})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Connection probe
# ---------------------------------------------------------------------------

async def test_probe_bad_host_returns_ok_false(client):
    r = await client.post("/api/v1/sessions/probe", json={
        "host": "nonexistent.invalid",
        "port": 3306,
        "username": "user",
        "password": "pass",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["error"] is not None


async def test_probe_good_connection(client, mysql_container):
    r = await client.post("/api/v1/sessions/probe", json={
        "host": mysql_container.get_container_host_ip(),
        "port": int(mysql_container.get_exposed_port(3306)),
        "username": "test",
        "password": "test",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["server_version"] is not None
    assert isinstance(data["latency_ms"], float)


async def test_test_session_endpoint(client, session_id):
    r = await client.post(f"/api/v1/sessions/{session_id}/test")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True


async def test_test_nonexistent_session_returns_404(client):
    r = await client.post("/api/v1/sessions/does-not-exist/test")
    assert r.status_code == 404
