import asyncio
import socket
import ssl
import time

import pytest

from lagun.api import sessions as sessions_api, table_ops
from lagun.models.schema import SetPrimaryKeyRequest
from lagun.models.session import TestResult as SessionTestResult


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/sessions/%s/databases",
        "/api/v1/sessions/%s/databases/app/tables",
        "/api/v1/sessions/%s/databases/app/tables/t/columns",
        "/api/v1/sessions/%s/databases/app/tables/t/row-key",
        "/api/v1/sessions/%s/databases/app/tables/t/indexes",
        "/api/v1/sessions/%s/databases/app/functions",
        "/api/v1/sessions/%s/databases/app/tables/t/create_sql",
    ],
)
async def test_schema_routes_return_404_for_an_unknown_session(client, path):
    response = await client.get(path % "does-not-exist")
    assert response.status_code == 404


async def test_schema_batch_returns_404_for_an_unknown_session(client):
    response = await client.get(
        "/api/v1/sessions/does-not-exist/tables", params={"databases": "app"}
    )
    assert response.status_code == 404


async def test_schema_batch_rejects_only_blank_database_names(client, session_id):
    response = await client.get(
        f"/api/v1/sessions/{session_id}/tables", params=[("databases", "")]
    )
    assert response.status_code == 422


async def test_schema_lists_functions_and_multiple_index_groups(
    client, session_id, test_db
):
    functions = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/functions"
    )
    assert functions.status_code == 200
    assert isinstance(functions.json(), list)

    await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={
            "sql": (
                "CREATE TABLE multi_index ("
                "id INT PRIMARY KEY, a INT, b INT, "
                "INDEX idx_a (a), UNIQUE INDEX idx_b (b), INDEX idx_ab (a, b))"
            ),
            "database": test_db,
        },
    )
    indexes = await client.get(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/multi_index/indexes"
    )
    assert indexes.status_code == 200
    names = [item["name"] for item in indexes.json()]
    assert "PRIMARY" in names
    assert "idx_a" in names
    assert "idx_b" in names
    composite = next(item for item in indexes.json() if item["name"] == "idx_ab")
    assert composite["columns"] == ["a", "b"]


def test_probe_error_messages_cover_network_and_driver_failures():
    errors = [
        (asyncio.TimeoutError(), "Timed out"),
        (socket.gaierror(), "resolved"),
        (ssl.SSLError(), "TLS"),
        (Exception(1045), "rejected"),
        (Exception(1044), "not allowed"),
        (Exception(2005), "resolved"),
        (Exception(2002), "did not accept"),
        (Exception(2003), "did not accept"),
        (Exception(9999), "could not be established"),
    ]
    for error, expected in errors:
        assert expected in sessions_api._probe_error(error, detailed=False)
    assert sessions_api._probe_error(ValueError("raw"), detailed=True) == "raw"


def test_probe_rate_limit_prunes_stale_callers(monkeypatch):
    monkeypatch.setattr(sessions_api, "_PROBE_RATE_LIMIT", 100)
    monkeypatch.setattr(sessions_api, "_PROBE_WINDOW_MAX_CALLERS", 2)
    now = time.monotonic()
    sessions_api._probe_windows = {
        "stale": [now - sessions_api._PROBE_WINDOW - 1],
        "a": [now],
        "b": [now],
    }
    sessions_api._check_probe_rate_limit("c")
    assert "stale" not in sessions_api._probe_windows


def test_invalidate_analyze_cache_clears_all_entries():
    table_ops._last_analyze[("a", "db", "t")] = 1
    table_ops._last_analyze[("b", "db", "t")] = 1
    table_ops.invalidate_analyze_cache(None)
    assert table_ops._last_analyze == {}


async def test_analyze_skips_a_table_over_the_size_limit(
    client, session_id, test_db, monkeypatch
):
    monkeypatch.setattr(table_ops, "_ANALYZE_SIZE_LIMIT_BYTES", 0)
    table_ops._last_analyze.clear()
    response = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/analyze"
    )
    assert response.status_code == 200
    assert response.json()["analyzed"] is False


async def test_primary_key_requires_columns_and_modify_nullable_can_be_omitted(
    client, session_id, test_db
):
    empty = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/primary-key",
        json={"columns": []},
    )
    assert empty.status_code == 400

    modified = await client.put(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/columns/age",
        json={"type": "INT"},
    )
    assert modified.status_code == 200
    assert "NOT NULL" not in modified.json()["sql"]

    replaced = await client.post(
        f"/api/v1/sessions/{session_id}/databases/{test_db}/tables/users/primary-key",
        json={"columns": ["id"]},
    )
    assert replaced.status_code == 201
    assert "DROP PRIMARY KEY" in replaced.json()["sql"]


async def test_session_test_skips_scope_filter_when_probe_returns_no_databases(
    client, session_id, monkeypatch
):
    async def no_databases(*_args, **_kwargs):
        return SessionTestResult(
            ok=False, error="unavailable", latency_ms=1, databases=[]
        )

    monkeypatch.setattr(sessions_api, "_probe_connection", no_databases)
    response = await client.post(f"/api/v1/sessions/{session_id}/test")
    assert response.status_code == 200
    assert response.json()["databases"] == []


async def test_primary_key_failure_that_is_not_a_missing_key_is_reraised(monkeypatch):
    class Cursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def execute(self, _sql):
            raise RuntimeError("permission denied")

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def cursor(self):
            return Cursor()

    class Pool:
        def acquire(self):
            return Connection()

    async def pool(*_args):
        return Pool()

    monkeypatch.setattr(table_ops, "_pool", pool)
    with pytest.raises(RuntimeError, match="permission denied"):
        await table_ops.set_primary_key(
            "session", "db", "table", SetPrimaryKeyRequest(columns=["id"])
        )
