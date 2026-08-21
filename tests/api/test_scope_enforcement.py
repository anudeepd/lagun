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
