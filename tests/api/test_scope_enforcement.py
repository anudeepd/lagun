"""Regression tests for server-side selected_databases scope enforcement.

These tests guard the security fix shipped in 0.1.79 that closes an authorization
bypass where restricted users could run queries or DDL against out-of-scope
databases. They assert the scope check fires BEFORE any connection pool access,
so out-of-scope requests never touch the database.

No MySQL container is required: each test mocks ``get_pool`` to raise if it is
called, then verifies the 403 from the scope check makes the pool unreached.
"""

import pytest

import lagun.api.schema as schema_module
from lagun.api import table_ops as table_ops_api
from lagun.db import session_store
from lagun.models.session import SessionCreate


@pytest.fixture
async def scoped_session():
    """A session restricted to selected_databases=['lagun_test']."""
    await session_store.init_db()
    return await session_store.create_session(
        SessionCreate(
            name="scoped",
            host="localhost",
            port=3306,
            username="test",
            password="test",
            selected_databases=["lagun_test"],
        ),
        "alice",
    )


def _pool_guard(monkeypatch, module):
    """Patch ``get_pool`` on ``module`` so any call proves the scope check missed."""
    calls = []

    async def fake_get_pool(session_id):
        calls.append(session_id)
        raise RuntimeError(
            f"pool accessed despite scope mismatch (module={module.__name__})"
        )

    monkeypatch.setattr(f"{module.__name__}.get_pool", fake_get_pool)
    return calls


class _RaisingPool:
    """Async context manager that raises on acquire — proves pool was actually used."""

    def __init__(self):
        self.acquire_calls = 0

    def acquire(self):
        self.acquire_calls += 1
        return self

    async def __aenter__(self):
        raise RuntimeError("pool acquired despite scope check")

    async def __aexit__(self, exc_type, exc, tb):
        return False


def _fake_get_pool_or_404(pool, session):
    """Build a fake ``_get_pool_or_404`` that returns (pool, session).

    The endpoint catches generic exceptions raised by pool.acquire() and
    converts them to a 200 response with the error in the body. A successful
    mock return lets the scope check run: out-of-scope raises HTTPException(403)
    (bubbles to FastAPI as 403); in-scope proceeds to pool.acquire() which
    raises RuntimeError (caught → 200 with error).
    """

    async def fake(session_id):
        return pool, session

    return fake


# ---------------------------------------------------------------------------
# schema.py — list_tables / list_columns / list_indexes / list_functions / get_create_sql
# ---------------------------------------------------------------------------


async def test_schema_list_tables_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables"
    )
    assert r.status_code == 403
    assert "not in this connection's allowed databases" in r.json()["detail"]
    assert pool_calls == []


async def test_schema_list_columns_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables/users/columns"
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_schema_list_indexes_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables/users/indexes"
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_schema_list_functions_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/functions"
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_schema_get_create_sql_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables/users/create_sql"
    )
    assert r.status_code == 403
    assert pool_calls == []


# ---------------------------------------------------------------------------
# table_ops.py — DDL endpoints must reject out-of-scope DB before pool access
# ---------------------------------------------------------------------------


async def test_table_ops_drop_table_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, table_ops_api)
    r = await client.delete(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables/users"
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_table_ops_truncate_table_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, table_ops_api)
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables/users/truncate"
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_table_ops_create_table_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, table_ops_api)
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables",
        json={
            "name": "evil",
            "columns": [{"name": "id", "type": "INT", "nullable": False}],
        },
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_table_ops_drop_column_rejects_out_of_scope_db(
    client, scoped_session, monkeypatch
):
    pool_calls = _pool_guard(monkeypatch, table_ops_api)
    r = await client.delete(
        f"/api/v1/sessions/{scoped_session.id}/databases/other_db/tables/users/columns/id"
    )
    assert r.status_code == 403
    assert pool_calls == []


# ---------------------------------------------------------------------------
# query.py — effective_db bypass guard (req.database or session.default_db)
# ---------------------------------------------------------------------------


async def test_query_explicit_database_rejects_out_of_scope(
    client, scoped_session, monkeypatch
):
    """req.database out-of-scope → 403, pool.acquire never called."""
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404",
        _fake_get_pool_or_404(pool, scoped_session),
    )
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/query",
        json={"sql": "SELECT 1", "database": "other_db"},
    )
    assert r.status_code == 403
    assert "not in this connection's allowed databases" in r.json()["detail"]
    assert pool.acquire_calls == 0


async def test_query_empty_database_falls_back_to_default_db_scope(client, monkeypatch):
    """ISSUE-guard: empty req.database must NOT bypass scope when session.default_db
    is out-of-scope. Omitting database used to skip the check entirely.
    """
    await session_store.init_db()
    s = await session_store.create_session(
        SessionCreate(
            name="scoped-default",
            host="localhost",
            port=3306,
            username="u",
            password="p",
            selected_databases=["lagun_test"],
            default_db="other_db",
        ),
        "alice",
    )
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, s)
    )
    r = await client.post(
        f"/api/v1/sessions/{s.id}/query",
        json={"sql": "SELECT 1", "database": ""},
    )
    assert r.status_code == 403
    assert "other_db" in r.json()["detail"]
    assert pool.acquire_calls == 0


async def test_query_empty_database_proceeds_when_default_db_in_scope(
    client, monkeypatch
):
    """Empty req.database + default_db in selected_databases → scope passes, pool acquired."""
    await session_store.init_db()
    s = await session_store.create_session(
        SessionCreate(
            name="scoped-default-ok",
            host="localhost",
            port=3306,
            username="u",
            password="p",
            selected_databases=["lagun_test"],
            default_db="lagun_test",
        ),
        "alice",
    )
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, s)
    )
    r = await client.post(
        f"/api/v1/sessions/{s.id}/query",
        json={"sql": "SELECT 1", "database": ""},
    )
    # Scope check passes → pool.acquire() called → mock raises RuntimeError →
    # endpoint catches and returns 200 with error in body. We verify the
    # scope check passed by confirming pool.acquire() was reached.
    assert r.status_code == 200
    assert pool.acquire_calls == 1


async def test_query_unrestricted_session_allows_any_explicit_db(client, monkeypatch):
    """Session with selected_databases unconfigured (None) allows any explicit DB."""
    await session_store.init_db()
    s = await session_store.create_session(
        SessionCreate(
            name="unrestricted",
            host="localhost",
            port=3306,
            username="u",
            password="p",
        ),
        "alice",
    )
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, s)
    )
    r = await client.post(
        f"/api/v1/sessions/{s.id}/query",
        json={"sql": "SELECT 1", "database": "anything"},
    )
    assert r.status_code == 200  # scope passed; pool.acquire raised → caught
    assert pool.acquire_calls == 1


# ---------------------------------------------------------------------------
# Managed (connections.yaml) connections: the administrator's list is a ceiling
# ---------------------------------------------------------------------------


@pytest.fixture
async def managed_session(monkeypatch, tmp_path):
    """A shared connection whose allowlist comes from connections.yaml."""
    import yaml

    from lagun.db.connections_config import sync_connections_config

    monkeypatch.setenv("LAGUN_TEST_SHARED_DB_PASSWORD", "shared-secret")
    config = tmp_path / "connections.yaml"
    config.write_text(
        yaml.safe_dump(
            {
                "connections": [
                    {
                        "id": "shared",
                        "name": "Shared",
                        "host": "localhost",
                        "port": 3306,
                        "username": "shared_user",
                        "password_env": "LAGUN_TEST_SHARED_DB_PASSWORD",
                        "selected_databases": ["app_db", "analytics"],
                        "allowed_users": ["alice"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    await session_store.init_db()
    await sync_connections_config(str(config))
    connections = await session_store.list_admin_connections()
    session_id = next(c["id"] for c in connections if c["config_key"] == "shared")
    return await session_store.get_session(session_id)


async def test_managed_session_exposes_the_administrator_allowlist(
    client, managed_session
):
    r = await client.get(f"/api/v1/sessions/{managed_session.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["managed"] is True
    assert body["managed_selected_databases"] == ["app_db", "analytics"]
    # Empty user list means "everything the admin allows", never "everything".
    assert body["selected_databases"] == []


async def test_managed_session_rejects_widening_the_scope(client, managed_session):
    """The bypass this guards: PUT {"selected_databases": []} used to lift isolation."""
    r = await client.put(
        f"/api/v1/sessions/{managed_session.id}",
        json={"selected_databases": ["other_db"]},
    )
    assert r.status_code == 403
    assert "administrator's allowed list" in r.json()["detail"]

    stored = await session_store.get_session(managed_session.id)
    assert stored.selected_databases == []


async def test_managed_session_accepts_narrowing_within_the_scope(
    client, managed_session
):
    r = await client.put(
        f"/api/v1/sessions/{managed_session.id}",
        json={"selected_databases": ["app_db"]},
    )
    assert r.status_code == 200
    assert r.json()["selected_databases"] == ["app_db"]


async def test_managed_session_still_locks_connection_identity(client, managed_session):
    r = await client.put(
        f"/api/v1/sessions/{managed_session.id}", json={"host": "elsewhere"}
    )
    assert r.status_code == 403


async def test_resync_clamps_a_narrowing_that_leaves_the_new_ceiling(
    client, managed_session, monkeypatch, tmp_path
):
    """Shrinking the ceiling must take effect immediately, not on next edit."""
    import yaml

    from lagun.db.connections_config import sync_connections_config

    r = await client.put(
        f"/api/v1/sessions/{managed_session.id}",
        json={"selected_databases": ["app_db"]},
    )
    assert r.status_code == 200

    config = tmp_path / "connections-shrunk.yaml"
    config.write_text(
        yaml.safe_dump(
            {
                "connections": [
                    {
                        "id": "shared",
                        "name": "Shared",
                        "host": "localhost",
                        "port": 3306,
                        "username": "shared_user",
                        "password_env": "LAGUN_TEST_SHARED_DB_PASSWORD",
                        "selected_databases": ["analytics"],
                        "allowed_users": ["alice"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    await sync_connections_config(str(config))

    stored = await session_store.get_session(managed_session.id)
    assert stored.managed_selected_databases == ["analytics"]
    assert stored.selected_databases == []  # the stale narrowing was dropped


# ---------------------------------------------------------------------------
# export / import must apply the same scope as query and schema
# ---------------------------------------------------------------------------


async def test_export_rejects_out_of_scope_database(
    client, scoped_session, monkeypatch
):
    import lagun.api.export as export_api

    pool_calls = _pool_guard(monkeypatch, export_api)
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/export",
        json={"database": "other_db", "table": "users", "format": "csv"},
    )
    assert r.status_code == 403
    assert pool_calls == []


async def test_import_preview_rejects_out_of_scope_database(
    client, scoped_session, monkeypatch
):
    import lagun.api.import_data as import_api

    pool_calls = _pool_guard(monkeypatch, import_api)
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/import/preview",
        files={"file": ("rows.csv", b"a,b\n1,2\n", "text/csv")},
        data={"config": '{"database": "other_db", "format": "csv", "table": "users"}'},
    )
    assert r.status_code == 403
    assert pool_calls == []


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        (
            "post",
            "/cell-update",
            {
                "database": "other_db",
                "table": "users",
                "column": "name",
                "new_value": "x",
                "primary_key": {"id": 1},
            },
        ),
        (
            "post",
            "/row-update",
            {
                "database": "other_db",
                "table": "users",
                "primary_key": {"id": 1},
                "updates": {"name": "x"},
            },
        ),
        (
            "post",
            "/row-insert",
            {"database": "other_db", "table": "users", "values": {"name": "x"}},
        ),
        (
            "delete",
            "/rows",
            {"database": "other_db", "table": "users", "primary_keys": [{"id": 1}]},
        ),
    ],
)
async def test_row_mutations_reject_out_of_scope_database(
    client, scoped_session, monkeypatch, method, path, payload
):
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, scoped_session)
    )
    url = f"/api/v1/sessions/{scoped_session.id}{path}"
    r = await (
        client.post(url, json=payload)
        if method == "post"
        else client.request("DELETE", url, json=payload)
    )
    assert r.status_code == 403
    assert pool.acquire_calls == 0


# ---------------------------------------------------------------------------
# the database listing feeds the UI picker, so it is filtered too
# ---------------------------------------------------------------------------


class _ListingPool:
    """Pool stub whose SHOW DATABASES returns a fixed schema list."""

    def __init__(self, databases):
        self._databases = databases

    def acquire(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return _ListingCursor(self._databases)


class _ListingCursor:
    def __init__(self, databases):
        self._databases = databases

    async def execute(self, sql, *args):
        return None

    async def fetchall(self):
        return [(name,) for name in self._databases]

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


async def test_list_databases_is_filtered_to_the_scope(
    client, scoped_session, monkeypatch
):
    pool = _ListingPool(["app_db", "lagun_test", "other_db", "information_schema"])

    async def fake_get_pool(session_id):
        return pool

    monkeypatch.setattr("lagun.api.schema.get_pool", fake_get_pool)
    r = await client.get(f"/api/v1/sessions/{scoped_session.id}/databases")
    assert r.status_code == 200
    assert r.json() == ["lagun_test"]


async def test_list_databases_is_complete_for_an_unrestricted_session(
    client, monkeypatch
):
    await session_store.init_db()
    s = await session_store.create_session(
        SessionCreate(
            name="unrestricted", host="localhost", port=3306, username="u", password="p"
        ),
        "alice",
    )
    pool = _ListingPool(["app_db", "other_db", "information_schema"])

    async def fake_get_pool(session_id):
        return pool

    monkeypatch.setattr("lagun.api.schema.get_pool", fake_get_pool)
    r = await client.get(f"/api/v1/sessions/{s.id}/databases")
    assert r.status_code == 200
    assert r.json() == ["app_db", "other_db"]


# ---------------------------------------------------------------------------
# the bulk write script is a write path too, so it obeys the same scope
# ---------------------------------------------------------------------------


async def test_bulk_script_rejects_out_of_scope_database(
    client, scoped_session, monkeypatch
):
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, scoped_session)
    )
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/query/script",
        json={
            "execution_id": "exec-1",
            "database": "other_db",
            "statements": ["UPDATE users SET name = 'x' WHERE id = 1"],
        },
    )
    # The request names an out-of-scope database, so it is refused outright.
    assert r.status_code == 403
    assert "not in this connection's allowed databases" in r.json()["detail"]
    assert pool.acquire_calls == 0


async def test_bulk_script_rejects_a_schema_qualified_statement_outside_scope(
    client, scoped_session, monkeypatch
):
    """req.database is in scope, but the statement reaches another schema."""
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, scoped_session)
    )
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/query/script",
        json={
            "execution_id": "exec-2",
            "database": "lagun_test",
            "statements": ["UPDATE other_db.users SET name = 'x' WHERE id = 1"],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "OUT_OF_SCOPE_DATABASE"
    assert pool.acquire_calls == 0


async def test_bulk_script_validate_rejects_out_of_scope_database(
    client, scoped_session, monkeypatch
):
    pool = _RaisingPool()
    monkeypatch.setattr(
        "lagun.api.query._get_pool_or_404", _fake_get_pool_or_404(pool, scoped_session)
    )
    r = await client.post(
        f"/api/v1/sessions/{scoped_session.id}/query/script/validate",
        json={
            "execution_id": "exec-3",
            "database": "other_db",
            "statements": ["DELETE FROM users WHERE id = 1"],
        },
    )
    assert r.status_code == 403
    assert pool.acquire_calls == 0


# ---------------------------------------------------------------------------
# Every schema endpoint must use the shared scope rule, including for a managed
# connection whose own list is empty (the ceiling is the scope).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/databases/other_db/tables",
        "/databases/other_db/tables/users/columns",
        "/databases/other_db/tables/users/indexes",
        "/databases/other_db/functions",
        "/databases/other_db/tables/users/create_sql",
    ],
)
async def test_managed_ceiling_is_enforced_on_schema_endpoints(
    client, managed_session, monkeypatch, path
):
    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(f"/api/v1/sessions/{managed_session.id}{path}")
    assert r.status_code == 403
    assert pool_calls == []


async def test_managed_narrowing_is_enforced_on_schema_endpoints(
    client, managed_session, monkeypatch
):
    """A database inside the ceiling but outside the user's narrowing is refused."""
    narrowed = await client.put(
        f"/api/v1/sessions/{managed_session.id}",
        json={"selected_databases": ["app_db"]},
    )
    assert narrowed.status_code == 200

    pool_calls = _pool_guard(monkeypatch, schema_module)
    r = await client.get(
        f"/api/v1/sessions/{managed_session.id}/databases/analytics/tables"
    )
    assert r.status_code == 403
    assert pool_calls == []
