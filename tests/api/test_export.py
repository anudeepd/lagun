"""Integration tests for the export API."""


async def test_export_insert_format(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "table": "users",
        "format": "insert",
    })
    assert r.status_code == 200
    body = r.text
    assert "INSERT INTO" in body
    assert "`users`" in body
    assert "Alice" in body
    assert "Bob" in body


async def test_export_csv_format(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "table": "users",
        "format": "csv",
    })
    assert r.status_code == 200
    body = r.text
    # Header row
    assert "name" in body
    assert "age" in body
    # Data rows
    assert "Alice" in body
    assert "Bob" in body


async def test_export_csv_utf8_sig_bom(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "table": "users",
        "format": "csv",
        "csv_encoding": "utf-8-sig",
    })
    assert r.status_code == 200
    # Response bytes should start with the UTF-8 BOM
    assert r.content[:3] == b"\xef\xbb\xbf"


async def test_export_delete_format(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "table": "users",
        "format": "delete",
    })
    assert r.status_code == 200
    body = r.text
    assert "DELETE FROM" in body


async def test_export_delete_insert_format(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "table": "users",
        "format": "delete+insert",
    })
    assert r.status_code == 200
    body = r.text
    assert "DELETE FROM" in body
    assert "INSERT INTO" in body


async def test_export_custom_select(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "sql": f"SELECT name FROM users WHERE name = 'Alice'",
        "format": "csv",
    })
    assert r.status_code == 200
    body = r.text
    assert "Alice" in body
    assert "Bob" not in body


async def test_export_non_select_sql_rejected(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "sql": "DROP TABLE users",
        "format": "csv",
    })
    assert r.status_code == 400


async def test_export_unknown_format_rejected(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "table": "users",
        "format": "xml",
    })
    assert r.status_code == 400


async def test_export_neither_table_nor_sql_rejected(client, session_id, test_db):
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json={
        "database": test_db,
        "format": "insert",
    })
    assert r.status_code == 400


async def test_export_nonexistent_session(client):
    r = await client.post("/api/v1/sessions/no-such/export", json={
        "database": "test",
        "table": "t",
        "format": "insert",
    })
    assert r.status_code == 404
