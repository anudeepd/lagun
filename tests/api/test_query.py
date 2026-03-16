"""Integration tests for the query API."""


async def test_select_all(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT * FROM users",
        "database": test_db,
    })
    assert r.status_code == 200
    data = r.json()
    assert data["error"] is None
    assert "id" in data["columns"]
    assert "name" in data["columns"]
    assert len(data["rows"]) == 2
    assert data["row_count"] == 2


async def test_select_auto_limit(client, session_id, test_db):
    """A SELECT without LIMIT should have one appended automatically."""
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT * FROM users",
        "database": test_db,
        "limit": 1,
    })
    assert r.status_code == 200
    data = r.json()
    assert data["error"] is None
    assert len(data["rows"]) == 1


async def test_select_with_existing_limit_not_doubled(client, session_id, test_db):
    """A SELECT that already has LIMIT should not get another one appended."""
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT * FROM users LIMIT 1",
        "database": test_db,
    })
    assert r.status_code == 200
    assert len(r.json()["rows"]) == 1


async def test_insert_returns_affected_rows(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "INSERT INTO users (name, age) VALUES ('Charlie', 35)",
        "database": test_db,
    })
    assert r.status_code == 200
    data = r.json()
    assert data["error"] is None
    assert data["affected_rows"] == 1
    assert data["insert_id"] is not None


async def test_invalid_sql_returns_error_field(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT * FROM nonexistent_table_xyz",
        "database": test_db,
    })
    assert r.status_code == 200
    data = r.json()
    assert data["error"] is not None


async def test_query_nonexistent_session(client):
    r = await client.post("/api/v1/sessions/does-not-exist/query", json={"sql": "SELECT 1"})
    assert r.status_code == 404


async def test_cell_update(client, session_id, test_db):
    # First, get the id of Alice
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT id FROM users WHERE name = 'Alice'",
        "database": test_db,
    })
    alice_id = r.json()["rows"][0][0]

    r2 = await client.post(f"/api/v1/sessions/{session_id}/cell-update", json={
        "database": test_db,
        "table": "users",
        "column": "age",
        "new_value": 31,
        "primary_key": {"id": alice_id},
    })
    assert r2.status_code == 200
    data = r2.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1

    # Verify the change persisted
    r3 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": f"SELECT age FROM users WHERE id = {alice_id}",
        "database": test_db,
    })
    assert r3.json()["rows"][0][0] == 31


async def test_row_insert(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/row-insert", json={
        "database": test_db,
        "table": "users",
        "values": {"name": "Dave", "age": 40},
    })
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["insert_id"] is not None

    # Verify row was inserted
    r2 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT COUNT(*) FROM users",
        "database": test_db,
    })
    assert r2.json()["rows"][0][0] == 3


async def test_row_delete(client, session_id, test_db):
    # Get ids of both rows
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT id FROM users ORDER BY id",
        "database": test_db,
    })
    ids = [row[0] for row in r.json()["rows"]]

    r2 = await client.request("DELETE", f"/api/v1/sessions/{session_id}/rows", json={
        "database": test_db,
        "table": "users",
        "primary_keys": [{"id": ids[0]}],
    })
    assert r2.status_code == 200
    data = r2.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1

    # Verify only one row remains
    r3 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT COUNT(*) FROM users",
        "database": test_db,
    })
    assert r3.json()["rows"][0][0] == 1
