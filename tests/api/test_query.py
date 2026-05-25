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


async def test_row_update(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT id FROM users WHERE name = 'Alice'",
        "database": test_db,
    })
    alice_id = r.json()["rows"][0][0]

    r2 = await client.post(f"/api/v1/sessions/{session_id}/row-update", json={
        "database": test_db,
        "table": "users",
        "primary_key": {"id": alice_id},
        "updates": {"age": 31},
    })
    assert r2.status_code == 200
    data = r2.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1

    r3 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": f"SELECT age FROM users WHERE id = {alice_id}",
        "database": test_db,
    })
    assert r3.json()["rows"][0][0] == 31


async def test_row_update_zero_affected(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/row-update", json={
        "database": test_db,
        "table": "users",
        "primary_key": {"id": 99999},
        "updates": {"age": 31},
    })
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 0
    assert data["error"] is None


async def test_row_update_pk_column(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT id FROM users WHERE name = 'Alice'",
        "database": test_db,
    })
    old_id = r.json()["rows"][0][0]
    new_id = old_id + 1000

    r2 = await client.post(f"/api/v1/sessions/{session_id}/row-update", json={
        "database": test_db,
        "table": "users",
        "primary_key": {"id": old_id},
        "updates": {"id": new_id, "age": 31},
    })
    assert r2.status_code == 200
    data = r2.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1

    r3 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": f"SELECT age FROM users WHERE id = {new_id}",
        "database": test_db,
    })
    assert r3.json()["rows"][0][0] == 31

    r4 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": f"SELECT COUNT(*) FROM users WHERE id = {old_id}",
        "database": test_db,
    })
    assert r4.json()["rows"][0][0] == 0


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


async def test_row_update_many_in_sequence(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT id FROM users WHERE name = 'Alice'",
        "database": test_db,
    })
    alice_id = r.json()["rows"][0][0]

    for i in range(10):
        r = await client.post(f"/api/v1/sessions/{session_id}/row-update", json={
            "database": test_db,
            "table": "users",
            "primary_key": {"id": alice_id},
            "updates": {"age": 100 + i},
        })
        assert r.status_code == 200
        assert r.json()["affected_rows"] == 1

    r = await client.post(f"/api/v1/sessions/{session_id}/row-update", json={
        "database": test_db,
        "table": "users",
        "primary_key": {"id": alice_id},
        "updates": {"age": 200},
    })
    assert r.status_code == 200
    assert r.json()["affected_rows"] == 1

    r2 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": f"SELECT age FROM users WHERE id = {alice_id}",
        "database": test_db,
    })
    assert r2.json()["rows"][0][0] == 200


async def test_row_update_no_pk_with_null(client, session_id, test_db):
    await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": (
            "CREATE TABLE IF NOT EXISTS no_pk_users ("
            "  name VARCHAR(100),"
            "  email VARCHAR(100),"
            "  age INT"
            ")"
        ),
        "database": test_db,
    })

    await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "INSERT INTO no_pk_users (name, email, age) VALUES ('Alice', NULL, 30)",
        "database": test_db,
    })

    r = await client.post(f"/api/v1/sessions/{session_id}/row-update", json={
        "database": test_db,
        "table": "no_pk_users",
        "primary_key": {"name": "Alice", "email": None, "age": 30},
        "updates": {"age": 31},
    })
    assert r.status_code == 200
    assert r.json()["affected_rows"] == 1

    r2 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT age FROM no_pk_users WHERE name = 'Alice'",
        "database": test_db,
    })
    assert r2.json()["rows"][0][0] == 31
