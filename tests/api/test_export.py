"""Integration tests for the export API."""

import json


async def test_export_insert_format(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "insert",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "INSERT INTO" in body
    assert "`users`" in body
    assert "Alice" in body
    assert "Bob" in body


async def test_export_csv_format(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "csv",
        },
    )
    assert r.status_code == 200
    body = r.text
    # Header row
    assert "name" in body
    assert "age" in body
    # Data rows
    assert "Alice" in body
    assert "Bob" in body


async def test_export_csv_utf8_sig_bom(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "csv",
            "csv_encoding": "utf-8-sig",
        },
    )
    assert r.status_code == 200
    # Response bytes should start with the UTF-8 BOM
    assert r.content[:3] == b"\xef\xbb\xbf"


async def test_export_delete_format(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "delete",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "DELETE FROM" in body


async def test_export_sql_omits_schema_by_default(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "delete+insert",
            "insert_mode": "single",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "-- Lagun export: users" in body
    assert f"-- Lagun export: {test_db}.users" not in body
    assert "DELETE FROM `users`" in body
    assert "INSERT INTO `users`" in body
    assert f"DELETE FROM `{test_db}`.`users`" not in body
    assert f"INSERT INTO `{test_db}`.`users`" not in body


async def test_export_sql_can_include_schema(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "delete+insert",
            "insert_mode": "single",
            "include_schema": True,
        },
    )
    assert r.status_code == 200
    body = r.text
    assert f"-- Lagun export: {test_db}.users" in body
    assert f"DELETE FROM `{test_db}`.`users`" in body
    assert f"INSERT INTO `{test_db}`.`users`" in body


async def test_export_insert_single_mode(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "insert",
            "insert_mode": "single",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "INSERT INTO" in body
    assert "Alice" in body
    assert "Bob" in body
    # Single mode: each row should have its own INSERT statement
    lines = [line for line in body.split("\n") if "INSERT INTO" in line]
    assert len(lines) == 2, f"Expected 2 single-row INSERTs, got {len(lines)}: {lines}"


async def test_export_insert_batch_mode(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "insert",
            "insert_mode": "batch",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "INSERT INTO" in body
    assert "Alice" in body
    assert "Bob" in body
    # Batch mode: one INSERT line containing both rows
    insert_lines = [line for line in body.split("\n") if "INSERT INTO" in line]
    assert len(insert_lines) == 1, (
        f"Expected 1 batch INSERT, got {len(insert_lines)}: {insert_lines}"
    )


async def test_export_batch_size_spans_database_fetches(client, session_id, test_db):
    setup = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": "CREATE TABLE export_batches (id INT PRIMARY KEY)",
        },
    )
    assert setup.status_code == 200
    values = ", ".join(f"({index})" for index in range(250))
    insert = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"database": test_db, "sql": f"INSERT INTO export_batches VALUES {values}"},
    )
    assert insert.status_code == 200
    exported = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "export_batches",
            "format": "insert",
            "insert_mode": "batch",
            "batch_size": 125,
        },
    )
    assert exported.status_code == 200
    assert exported.text.count("INSERT INTO") == 2


async def test_export_delete_insert_single_mode(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "delete+insert",
            "insert_mode": "single",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "DELETE FROM" in body
    assert "INSERT INTO" in body
    # Single mode: each row has DELETE followed by INSERT
    delete_lines = [line for line in body.split("\n") if "DELETE FROM" in line]
    insert_lines = [line for line in body.split("\n") if "INSERT INTO" in line]
    assert len(delete_lines) == 2, f"Expected 2 DELETEs, got {len(delete_lines)}"
    assert len(insert_lines) == 2, f"Expected 2 INSERTs, got {len(insert_lines)}"


async def test_export_delete_insert_batch_mode(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "delete+insert",
            "insert_mode": "batch",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "DELETE FROM" in body
    assert "INSERT INTO" in body
    # Batch mode: one DELETE per row, then one batch INSERT
    delete_lines = [line for line in body.split("\n") if "DELETE FROM" in line]
    insert_lines = [line for line in body.split("\n") if "INSERT INTO" in line]
    assert len(delete_lines) == 2, f"Expected 2 DELETEs, got {len(delete_lines)}"
    assert len(insert_lines) == 1, f"Expected 1 batch INSERT, got {len(insert_lines)}"


async def test_export_delete_insert_format(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "delete+insert",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "DELETE FROM" in body
    assert "INSERT INTO" in body


async def test_export_custom_select(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "sql": "SELECT name FROM users WHERE name = 'Alice'",
            "format": "csv",
        },
    )
    assert r.status_code == 200
    body = r.text
    assert "Alice" in body
    assert "Bob" not in body


async def test_export_download_form_streams_attachment(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export/download",
        data={
            "config": json.dumps(
                {"database": test_db, "table": "users", "format": "csv"}
            )
        },
    )
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment;")
    assert "Alice" in r.text


async def test_export_non_select_sql_rejected(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "sql": "DROP TABLE users",
            "format": "csv",
        },
    )
    assert r.status_code == 400


async def test_export_rejects_multiple_select_statements(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "sql": "SELECT 1; SELECT 2",
            "format": "csv",
        },
    )
    assert r.status_code == 400


async def test_export_unknown_format_rejected(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "xml",
        },
    )
    assert r.status_code == 422


async def test_export_neither_table_nor_sql_rejected(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "format": "insert",
        },
    )
    assert r.status_code == 400


async def test_export_nonexistent_session(client):
    r = await client.post(
        "/api/v1/sessions/no-such/export",
        json={
            "database": "test",
            "table": "t",
            "format": "insert",
        },
    )
    assert r.status_code == 404


async def test_export_delete_uses_is_null(client, session_id, test_db):
    setup = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": "CREATE TABLE nullable_export (id INT, note VARCHAR(32))",
        },
    )
    assert setup.status_code == 200
    insert = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": "INSERT INTO nullable_export VALUES (1, NULL), (2, 'present')",
        },
    )
    assert insert.status_code == 200
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "nullable_export",
            "format": "delete",
        },
    )
    assert r.status_code == 200
    assert "`note` IS NULL" in r.text
    assert "`note` = NULL" not in r.text


async def test_export_streams_large_result_set(client, session_id, test_db):
    setup = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": "CREATE TABLE large_export (id INT PRIMARY KEY, value VARCHAR(32))",
        },
    )
    assert setup.status_code == 200
    values = ", ".join(f"({i}, 'value-{i}')" for i in range(1200))
    insert = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": f"INSERT INTO large_export VALUES {values}",
        },
    )
    assert insert.status_code == 200
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "large_export",
            "format": "csv",
            "batch_size": 17,
        },
    )
    assert r.status_code == 200
    assert "value-0" in r.text
    assert "value-1199" in r.text
    assert r.text.count("value-") == 1200


async def test_export_pk_values_uses_is_null(client, session_id, test_db):
    setup = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": "CREATE TABLE nullable_pk_filter (id INT, note VARCHAR(32))",
        },
    )
    assert setup.status_code == 200
    insert = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": "INSERT INTO nullable_pk_filter VALUES (NULL, 'missing'), (3, 'present')",
        },
    )
    assert insert.status_code == 200
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "nullable_pk_filter",
            "format": "delete",
            "pk_values": [{"id": None}],
        },
    )
    assert r.status_code == 200
    assert "`id` IS NULL" in r.text
    assert "missing" in r.text
    assert "present" not in r.text


async def test_export_rejects_explicit_empty_pk_filter(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "insert",
            "pk_values": [],
        },
    )
    assert r.status_code == 422


async def test_export_sql_preserves_binary_and_backslashes(client, session_id, test_db):
    create = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": (
                "CREATE TABLE export_binary "
                "(id INT PRIMARY KEY, payload VARBINARY(16), path VARCHAR(32))"
            ),
        },
    )
    assert create.status_code == 200
    insert = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "database": test_db,
            "sql": (
                "INSERT INTO export_binary VALUES "
                "(1, 0x00ff616263, 0x433a5c6e6577)"
            ),
        },
    )
    assert insert.status_code == 200
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "export_binary",
            "format": "insert",
        },
    )
    assert r.status_code == 200
    assert "0x00ff616263" in r.text
    assert "0x433a5c6e6577" in r.text
