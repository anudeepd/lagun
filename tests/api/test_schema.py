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
