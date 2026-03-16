"""Integration tests for DDL table operations."""


# ---------------------------------------------------------------------------
# Create / Drop table
# ---------------------------------------------------------------------------

async def test_create_and_drop_table(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables",
        json={
            "name": "products",
            "columns": [
                {"name": "id", "type": "INT", "nullable": False,
                 "auto_increment": True, "primary_key": True},
                {"name": "title", "type": "VARCHAR(200)", "nullable": False},
                {"name": "price", "type": "DECIMAL(10,2)", "nullable": True},
            ],
        },
    )
    assert r.status_code == 201
    assert r.json()["ok"] is True

    # Verify it appears in the table list
    r2 = await client.get(f"/api/v1/sessions/{session_id}/databases/{test_db}/tables")
    names = [t["name"] for t in r2.json()]
    assert "products" in names

    # Drop it
    r3 = await client.delete(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/products"
    )
    assert r3.status_code == 200
    assert r3.json()["ok"] is True

    r4 = await client.get(f"/api/v1/sessions/{session_id}/databases/{test_db}/tables")
    names = [t["name"] for t in r4.json()]
    assert "products" not in names


async def test_truncate_table(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/truncate"
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = await client.post(f"/api/v1/sessions/{session_id}/query", json={
        "sql": "SELECT COUNT(*) FROM users",
        "database": test_db,
    })
    assert r2.json()["rows"][0][0] == 0


# ---------------------------------------------------------------------------
# Indexes
# ---------------------------------------------------------------------------

async def test_create_and_drop_index(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes",
        json={"name": "idx_name", "columns": ["name"], "unique": False, "index_type": "BTREE"},
    )
    assert r.status_code == 201
    assert r.json()["ok"] is True

    # Verify index appears
    r2 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes"
    )
    names = [i["name"] for i in r2.json()]
    assert "idx_name" in names

    # Drop it
    r3 = await client.delete(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes/idx_name"
    )
    assert r3.status_code == 200
    assert r3.json()["ok"] is True

    r4 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes"
    )
    names = [i["name"] for i in r4.json()]
    assert "idx_name" not in names


async def test_create_unique_index(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes",
        json={"name": "uniq_name", "columns": ["name"], "unique": True, "index_type": "BTREE"},
    )
    assert r.status_code == 201
    r2 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/indexes"
    )
    uniq = next(i for i in r2.json() if i["name"] == "uniq_name")
    assert uniq["is_unique"] is True


# ---------------------------------------------------------------------------
# Primary key
# ---------------------------------------------------------------------------

async def test_set_primary_key(client, session_id, test_db):
    # Create a table without a PK first
    await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables",
        json={
            "name": "nopk",
            "columns": [{"name": "code", "type": "VARCHAR(10)", "nullable": False}],
        },
    )
    r = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/nopk/primary-key",
        json={"columns": ["code"]},
    )
    assert r.status_code == 201
    assert r.json()["ok"] is True


async def test_drop_primary_key(client, session_id, test_db):
    # 'users' has an AUTO_INCREMENT PK; remove the AUTO_INCREMENT first via MODIFY
    # then drop the PK so MySQL doesn't complain about losing AUTO_INCREMENT
    await client.put(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns/id",
        json={"type": "INT", "nullable": False},
    )
    r = await client.delete(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/primary-key"
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------

async def test_add_column(client, session_id, test_db):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns",
        json={"name": "email", "type": "VARCHAR(255)", "nullable": True},
    )
    assert r.status_code == 201
    assert r.json()["ok"] is True

    r2 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns"
    )
    col_names = [c["name"] for c in r2.json()]
    assert "email" in col_names


async def test_modify_column(client, session_id, test_db):
    r = await client.put(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns/age",
        json={"type": "SMALLINT", "nullable": True},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns"
    )
    age = next(c for c in r2.json() if c["name"] == "age")
    assert "smallint" in age["column_type"].lower()


async def test_rename_column(client, session_id, test_db):
    r = await client.put(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns/age",
        json={"name": "years", "type": "INT", "nullable": True},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns"
    )
    col_names = [c["name"] for c in r2.json()]
    assert "years" in col_names
    assert "age" not in col_names


async def test_drop_column(client, session_id, test_db):
    r = await client.delete(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns/age"
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    r2 = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns"
    )
    col_names = [c["name"] for c in r2.json()]
    assert "age" not in col_names
