"""Integration tests for the import API."""

import json


CSV_WITH_HEADER = b"name,age\nAlice,30\nBob,25\n"
CSV_NO_HEADER = b"Alice,30\nBob,25\n"


def _config(**kwargs) -> str:
    base = {"database": "lagun_test", "table": "users"}
    base.update(kwargs)
    return json.dumps(base)


# ---------------------------------------------------------------------------
# Preview endpoint
# ---------------------------------------------------------------------------


async def test_preview_returns_columns_and_rows(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import/preview",
        files={"file": ("data.csv", CSV_WITH_HEADER, "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["columns"] == ["name", "age"]
    assert len(data["rows"]) == 2
    assert data["rows"][0] == ["Alice", "30"]


async def test_preview_no_header(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import/preview",
        files={"file": ("data.csv", CSV_NO_HEADER, "text/csv")},
        data={"config": _config(first_row_header=False)},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["columns"] == ["col_1", "col_2"]
    assert len(data["rows"]) == 2


async def test_preview_empty_file_rejected(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import/preview",
        files={"file": ("data.csv", b"", "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 400


async def test_preview_nonexistent_session(client):
    r = await client.post(
        "/api/v1/sessions/no-such/import/preview",
        files={"file": ("data.csv", CSV_WITH_HEADER, "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Import endpoint
# ---------------------------------------------------------------------------


async def test_import_inserts_rows(client, session_id, test_db):
    # The table already has 2 rows (Alice, Bob); import 2 more
    csv_data = b"name,age\nCharlie,35\nDave,28\n"
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", csv_data, "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["rows_processed"] == 2
    assert data["rows_imported"] == 2

    # Verify rows were actually inserted
    r2 = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT COUNT(*) FROM users",
            "database": test_db,
        },
    )
    assert r2.json()["rows"][0][0] == 4


async def test_import_rollback_on_error(client, session_id, test_db):
    """A row that violates a constraint should roll back the whole batch."""
    # 'name' column is NOT NULL — inserting NULL should fail
    bad_csv = b"name,age\n,99\n"  # empty name → NULL violation
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", bad_csv, "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["error"] is not None

    # Row count should be unchanged (rollback worked)
    r2 = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT COUNT(*) FROM users",
            "database": test_db,
        },
    )
    assert r2.json()["rows"][0][0] == 2


async def test_import_strategy_insert_ignore(client, session_id, test_db):
    # Get Alice's id so we can try inserting a duplicate
    r = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT id FROM users WHERE name='Alice'",
            "database": test_db,
        },
    )
    alice_id = r.json()["rows"][0][0]

    duplicate_csv = f"id,name,age\n{alice_id},Alice,30\n".encode()
    r2 = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", duplicate_csv, "text/csv")},
        data={"config": _config(strategy="insert_ignore")},
    )
    assert r2.status_code == 200
    assert r2.json()["ok"] is True
    # Row count should remain 2 (duplicate ignored)
    r3 = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT COUNT(*) FROM users",
            "database": test_db,
        },
    )
    assert r3.json()["rows"][0][0] == 2


async def test_import_tab_delimited(client, session_id, test_db):
    tab_csv = b"name\tage\nEve\t22\n"
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.tsv", tab_csv, "text/csv")},
        data={"config": _config(delimiter="\\t")},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["rows_processed"] == 1


async def test_import_rejects_zero_batch_size(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", CSV_WITH_HEADER, "text/csv")},
        data={"config": _config(batch_size=0)},
    )
    assert r.status_code == 422


async def test_import_invalid_config_returns_serializable_422(
    client, session_id, test_db
):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", CSV_WITH_HEADER, "text/csv")},
        data={"config": json.dumps({"database": ""})},
    )
    assert r.status_code == 422
    assert "database must not be empty" in r.text


async def test_import_large_csv_uses_bounded_batches(client, session_id, test_db):
    rows = [f"User {i}, {i}" for i in range(2500)]
    csv_data = ("name,age\n" + "\n".join(rows) + "\n").encode()
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("large.csv", csv_data, "text/csv")},
        data={"config": _config(batch_size=37)},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["rows_processed"] == 2500
    count = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": "SELECT COUNT(*) FROM users", "database": test_db},
    )
    assert count.json()["rows"][0][0] == 2502


async def test_import_reports_multiline_row_width_error(client, session_id, test_db):
    bad_csv = b'name,age\n"multiline\nvalue",42,unexpected\n'
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("bad.csv", bad_csv, "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "row 2" in r.json()["error"]


async def test_import_mysql_dump_with_delimiter(client, session_id, test_db):
    dump = b"""-- dump
SET @old_mode=@@sql_mode;
CREATE TABLE dump_users (id INT PRIMARY KEY, name VARCHAR(32));
INSERT INTO dump_users VALUES (1, 'Alice'), (2, 'Bob');
DELIMITER $$
CREATE PROCEDURE dump_ping()
BEGIN
  SELECT 1;
END$$
DELIMITER ;
"""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("dump.sql", dump, "application/sql")},
        data={"config": json.dumps({"database": "lagun_test", "format": "mysql_dump"})},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["method"] == "mysql_dump"
    assert data["statements_succeeded"] >= 4
    rows = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT id, name FROM dump_users ORDER BY id",
            "database": test_db,
        },
    )
    assert rows.json()["rows"] == [[1, "Alice"], [2, "Bob"]]


async def test_import_mysql_dump_partial_failure(client, session_id, test_db):
    dump = b"""CREATE TABLE partial_users (id INT PRIMARY KEY);
INSERT INTO partial_users VALUES (1);
THIS IS NOT VALID SQL;
"""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("partial.sql", dump, "application/sql")},
        data={"config": json.dumps({"database": "lagun_test", "format": "mysql_dump"})},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["partial"] is True
    assert data["statements_succeeded"] == 2
    assert data["error_line"] == 3
    assert "THIS IS NOT VALID SQL" in data["error_statement"]

    rows = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT id FROM partial_users",
            "database": test_db,
        },
    )
    assert rows.json()["rows"] == [[1]]


async def test_import_rejects_upload_over_configured_limit(
    client, session_id, test_db, monkeypatch
):
    import lagun.api.import_data as import_module

    monkeypatch.setattr(import_module, "IMPORT_MAX_FILE_BYTES", 1)
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", b"name,age\n", "text/csv")},
        data={"config": _config()},
    )
    assert r.status_code == 413


async def test_import_dump_parser_failure_reports_partial_diagnostics(
    client, session_id, test_db
):
    dump = b"""CREATE TABLE parser_partial (id INT PRIMARY KEY);
INSERT INTO parser_partial VALUES (1);
SELECT 'unterminated
"""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("partial.sql", dump, "application/sql")},
        data={"config": json.dumps({"database": "lagun_test", "format": "mysql_dump"})},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["partial"] is True
    assert data["statements_succeeded"] == 2
    assert data["error_line"] == 3
    assert data["error_statement"] is None
