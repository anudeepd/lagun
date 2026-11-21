"""Row-identity, commit, and query-log behavior for single-row writes."""

import aiomysql


async def _create(client, session_id, test_db, sql: str) -> None:
    r = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": sql, "database": test_db},
    )
    assert r.status_code == 200
    assert r.json()["error"] is None, r.json()


async def _visible_age(mysql_server, test_db: str, row_id: int) -> int:
    conn = await aiomysql.connect(
        host=mysql_server.host,
        port=mysql_server.port,
        user=mysql_server.admin_user,
        password=mysql_server.admin_password,
        db=test_db,
        autocommit=True,
    )
    try:
        async with conn.cursor() as cur:
            await cur.execute("SELECT age FROM leak_users WHERE id = %s", (row_id,))
            return (await cur.fetchone())[0]
    finally:
        conn.close()


async def test_row_update_without_unique_key_updates_one_row(
    client, session_id, test_db
):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE no_key_users (name VARCHAR(100), email VARCHAR(100), age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO no_key_users (name, email, age) VALUES ('Alice', NULL, 30)",
    )

    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "no_key_users",
            "primary_key": {"name": "Alice", "email": None, "age": 30},
            "updates": {"age": 31},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1
    assert data["sql_executed"].startswith(
        f"UPDATE `{test_db}`.`no_key_users` SET `age` = 31 WHERE "
    )
    assert data["sql_executed"].endswith(" LIMIT 1")

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": "SELECT age FROM no_key_users", "database": test_db},
    )
    assert check.json()["rows"] == [[31]]


async def test_row_update_does_not_mass_update_duplicates(client, session_id, test_db):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE duplicate_users (name VARCHAR(100), email VARCHAR(100), age INT, note VARCHAR(100))",
    )
    values = ", ".join("('Alice', NULL, 30, 'same')" for _ in range(83))
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO duplicate_users (name, email, age, note) VALUES "
        f"{values}, ('Bob', 'b@example.com', 25, 'other')",
    )

    # The grid sends every displayed column as the key for a table with no
    # usable unique key. The server adds LIMIT 1, so only one duplicate changes.
    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "duplicate_users",
            "primary_key": {
                "name": "Alice",
                "email": None,
                "age": 30,
                "note": "same",
            },
            "updates": {"note": "edited"},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1
    assert " LIMIT 1" in data["sql_executed"]

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": (
                "SELECT note, COUNT(*) FROM duplicate_users "
                "GROUP BY note ORDER BY note"
            ),
            "database": test_db,
        },
    )
    assert check.json()["rows"] == [["edited", 1], ["other", 1], ["same", 82]]


async def test_row_delete_without_unique_key_deletes_one_row(
    client, session_id, test_db
):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE no_key_delete (name VARCHAR(100), email VARCHAR(100), age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO no_key_delete (name, email, age) VALUES ('Alice', NULL, 30), ('Bob', 'b@example.com', 25)",
    )

    r = await client.request(
        "DELETE",
        f"/api/v1/sessions/{session_id}/rows",
        json={
            "database": test_db,
            "table": "no_key_delete",
            "primary_keys": [{"name": "Alice", "email": None, "age": 30}],
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1
    assert data["sql_executed"].endswith(" LIMIT 1")

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": "SELECT name FROM no_key_delete", "database": test_db},
    )
    assert check.json()["rows"] == [["Bob"]]


async def test_row_update_accepts_not_null_unique_key(client, session_id, test_db):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE unique_users (email VARCHAR(100) NOT NULL UNIQUE, age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO unique_users (email, age) VALUES ('alice@example.com', 30), ('bob@example.com', 25)",
    )

    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "unique_users",
            "primary_key": {"email": "alice@example.com"},
            "updates": {"age": 31},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT age FROM unique_users WHERE email = 'alice@example.com'",
            "database": test_db,
        },
    )
    assert check.json()["rows"] == [[31]]


async def test_keyless_row_edit_applies_to_duplicate_rows_one_at_a_time(
    client, session_id, test_db
):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE duplicate_edit (name VARCHAR(100), note VARCHAR(100))",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO duplicate_edit (name, note) VALUES "
        "('Alice', 'same'), ('Alice', 'same'), ('Alice', 'same')",
    )
    key = {"name": "Alice", "note": "same"}

    for _ in range(2):
        r = await client.post(
            f"/api/v1/sessions/{session_id}/row-update",
            json={
                "database": test_db,
                "table": "duplicate_edit",
                "primary_key": key,
                "updates": {"note": "edited"},
            },
        )
        assert r.json()["ok"] is True
        assert r.json()["affected_rows"] == 1

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": "SELECT note, COUNT(*) FROM duplicate_edit GROUP BY note ORDER BY note",
            "database": test_db,
        },
    )
    assert check.json()["rows"] == [["edited", 2], ["same", 1]]


async def test_keyless_delete_batch_deletes_one_row_per_key(
    client, session_id, test_db
):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE duplicate_delete (name VARCHAR(100), note VARCHAR(100))",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO duplicate_delete (name, note) VALUES "
        "('Alice', 'same'), ('Alice', 'same'), ('Alice', 'same'), "
        "('Bob', 'other')",
    )
    key = {"name": "Alice", "note": "same"}

    r = await client.request(
        "DELETE",
        f"/api/v1/sessions/{session_id}/rows",
        json={
            "database": test_db,
            "table": "duplicate_delete",
            "primary_keys": [key, key, key],
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 3

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": "SELECT name FROM duplicate_delete", "database": test_db},
    )
    assert check.json()["rows"] == [["Bob"]]


async def test_row_update_accepts_an_all_columns_key_on_a_keyed_table(
    client, session_id, test_db
):
    # A cached older frontend sends every column. The primary key is part of
    # that key, so the write is still unique and needs no LIMIT.
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE keyed_users (id INT PRIMARY KEY, name VARCHAR(100), age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO keyed_users (id, name, age) VALUES (1, 'Alice', 30)",
    )

    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "keyed_users",
            "primary_key": {"id": 1, "name": "Alice", "age": 30},
            "updates": {"age": 31},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1
    assert " LIMIT " not in data["sql_executed"]


async def test_row_update_requires_every_key_column(client, session_id, test_db):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE partial_key_users (id INT PRIMARY KEY, age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO partial_key_users (id, age) VALUES (1, 30)",
    )

    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "partial_key_users",
            "primary_key": {},
            "updates": {"age": 31},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert "must include id" in data["error"]

    check = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": "SELECT age FROM partial_key_users", "database": test_db},
    )
    assert check.json()["rows"] == [[30]]


async def test_row_update_same_value_reports_matched_row(client, session_id, test_db):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE noop_users (id INT PRIMARY KEY, age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO noop_users (id, age) VALUES (1, 30)",
    )

    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "noop_users",
            "primary_key": {"id": 1},
            "updates": {"age": 30},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["affected_rows"] == 1


async def test_editor_transaction_state_does_not_hide_grid_update(
    client, session_id, test_db, mysql_server
):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE leak_users (id INT PRIMARY KEY, age INT)",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO leak_users (id, age) VALUES (1, 30), (2, 40)",
    )

    setting = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": "SET autocommit=0", "database": test_db},
    )
    assert setting.status_code == 200

    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "leak_users",
            "primary_key": {"id": 1},
            "updates": {"age": 99},
        },
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["affected_rows"] == 1
    assert await _visible_age(mysql_server, test_db, 1) == 99


async def test_row_update_log_keeps_percent_s_in_value(client, session_id, test_db):
    await _create(
        client,
        session_id,
        test_db,
        "CREATE TABLE log_users (id INT PRIMARY KEY, name VARCHAR(100))",
    )
    await _create(
        client,
        session_id,
        test_db,
        "INSERT INTO log_users (id, name) VALUES (1, 'Alice')",
    )

    value = "100%s and %s more"
    r = await client.post(
        f"/api/v1/sessions/{session_id}/row-update",
        json={
            "database": test_db,
            "table": "log_users",
            "primary_key": {"id": 1},
            "updates": {"name": value},
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["sql_executed"] == (
        f"UPDATE `{test_db}`.`log_users` SET `name` = '{value}' WHERE `id` = 1"
    )
