"""Integration tests for the schema browser API."""


async def test_list_databases(client, session_id, test_db):
    r = await client.get(f"/api/v1/sessions/{session_id}/databases")
    assert r.status_code == 200
    dbs = r.json()
    assert test_db in dbs
    # System databases should be excluded
    assert "information_schema" not in dbs
    assert "performance_schema" not in dbs
    assert "mysql" not in dbs
    assert "sys" not in dbs


async def test_list_databases_nonexistent_session(client):
    r = await client.get("/api/v1/sessions/no-such-session/databases")
    assert r.status_code == 404


async def test_list_tables(client, session_id, test_db):
    r = await client.get(f"/api/v1/sessions/{session_id}/databases/{test_db}/tables")
    assert r.status_code == 200
    tables = r.json()
    names = [t["name"] for t in tables]
    assert "users" in names

    users = next(t for t in tables if t["name"] == "users")
    assert users["table_type"] == "BASE TABLE"
    assert users["engine"] == "InnoDB"


async def test_list_tables_batch_covers_every_schema(
    client, session_id, test_db, mysql_database
):
    """One request returns the tables of every requested schema, keyed by schema."""
    async with mysql_database("lagun_other") as conn:
        async with conn.cursor() as cur:
            await cur.execute("CREATE TABLE widgets (id INT PRIMARY KEY)")
        r = await client.get(
            f"/api/v1/sessions/{session_id}/tables",
            params=[
                ("databases", test_db),
                ("databases", "lagun_other"),
                ("databases", "lagun_absent"),
            ],
        )
        assert r.status_code == 200
        grouped = r.json()
        # Every requested schema is keyed, including schemas with no tables.
        assert set(grouped) == {test_db, "lagun_other", "lagun_absent"}
        assert "users" in [t["name"] for t in grouped[test_db]]
        assert [t["name"] for t in grouped["lagun_other"]] == ["widgets"]
        assert grouped["lagun_absent"] == []

        users = next(t for t in grouped[test_db] if t["name"] == "users")
        assert users["table_type"] == "BASE TABLE"
        assert users["engine"] == "InnoDB"


async def test_list_tables_batch_deduplicates_repeated_schemas(
    client, session_id, test_db
):
    r = await client.get(
        f"/api/v1/sessions/{session_id}/tables",
        params=[("databases", test_db), ("databases", test_db)],
    )
    assert r.status_code == 200
    assert set(r.json()) == {test_db}


async def test_list_tables_batch_rejects_empty_and_oversized_requests(
    client, session_id
):
    missing = await client.get(f"/api/v1/sessions/{session_id}/tables")
    assert missing.status_code == 422

    oversized = await client.get(
        f"/api/v1/sessions/{session_id}/tables",
        params=[("databases", f"db_{i}") for i in range(257)],
    )
    assert oversized.status_code == 422


async def test_list_tables_batch_enforces_database_scope(
    client, mysql_server, test_db
):
    """A batch that mentions a database outside the session's scope is refused."""
    r = await client.post(
        "/api/v1/sessions",
        json={
            "name": "scoped",
            "host": mysql_server.host,
            "port": mysql_server.port,
            "username": mysql_server.admin_user,
            "password": mysql_server.admin_password,
            "default_db": test_db,
            "query_limit": 100,
            "ssl_enabled": False,
            "selected_databases": [test_db],
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]
    try:
        allowed = await client.get(
            f"/api/v1/sessions/{sid}/tables", params=[("databases", test_db)]
        )
        assert allowed.status_code == 200

        denied = await client.get(
            f"/api/v1/sessions/{sid}/tables",
            params=[("databases", test_db), ("databases", "mysql")],
        )
        assert denied.status_code == 403
        assert "mysql" in denied.json()["detail"]
    finally:
        await client.delete(f"/api/v1/sessions/{sid}")


async def test_list_columns(client, session_id, test_db):
    r = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns"
    )
    assert r.status_code == 200
    cols = r.json()
    col_names = [c["name"] for c in cols]
    assert col_names == ["id", "name", "age"]

    id_col = next(c for c in cols if c["name"] == "id")
    assert id_col["is_primary_key"] is True
    assert id_col["is_auto_increment"] is True

    name_col = next(c for c in cols if c["name"] == "name")
    assert name_col["is_nullable"] is False

    age_col = next(c for c in cols if c["name"] == "age")
    assert age_col["is_nullable"] is True


async def test_list_indexes(client, session_id, test_db):
    r = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes"
    )
    assert r.status_code == 200
    indexes = r.json()
    index_names = [i["name"] for i in indexes]
    assert "PRIMARY" in index_names

    primary = next(i for i in indexes if i["name"] == "PRIMARY")
    assert primary["is_unique"] is True
    assert "id" in primary["columns"]


async def test_get_create_sql(client, session_id, test_db):
    r = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/create_sql"
    )
    assert r.status_code == 200
    sql = r.json()["create_sql"]
    assert "CREATE TABLE" in sql
    assert "users" in sql
    assert "id" in sql
