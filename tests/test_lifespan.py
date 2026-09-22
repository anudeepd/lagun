"""Startup and shutdown (lifespan) contract tests for the ASGI app."""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from lagun.db import pool, session_store
from lagun.main import app


@pytest.fixture(autouse=True)
def isolated_boot_environment(monkeypatch):
    """Boot tests decide for themselves whether LDAP and managed configs exist."""
    monkeypatch.delenv("LAGUN_LDAP_CONFIG", raising=False)
    monkeypatch.delenv("LAGUN_CONNECTIONS_CONFIG", raising=False)


def assert_contracted_config_error(error: BaseException, path) -> None:
    """The startup failure is a named RuntimeError, not a bare parser traceback."""
    prefix = f"Invalid LAGUN_CONNECTIONS_CONFIG at {path}: "
    message = str(error)
    assert isinstance(error, RuntimeError)
    assert message.startswith(prefix)
    assert message[len(prefix) :].strip(), "the reason must name the defect"


async def test_lifespan_initialises_the_store_and_serves_requests():
    async with app.router.lifespan_context(app):
        assert session_store._db_path().exists(), "startup must create the local store"
        assert await session_store.list_audit_events(limit=1) == []

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/config/server")

        assert response.status_code == 200
        assert response.json()["ldap_enabled"] is False


async def test_lifespan_shutdown_force_terminates_a_stalled_pool(monkeypatch):
    """A pool whose connections never come back cannot block process exit."""
    monkeypatch.setattr(pool, "_POOL_CLOSE_GRACE_SECONDS", 0.05)

    class _StalledPool:
        def __init__(self):
            self.closed = False
            self.terminated = False

        async def close(self):
            self.closed = True

        async def wait_closed(self):
            await asyncio.sleep(60)

        def terminate(self):
            self.terminated = True

    stalled = _StalledPool()
    async with app.router.lifespan_context(app):
        pool._pools["stalled"] = stalled

    assert stalled.closed is True
    assert stalled.terminated is True


async def test_lifespan_rejects_connections_config_without_ldap(monkeypatch, tmp_path):
    connections = tmp_path / "connections.yaml"
    connections.write_text("connections: []\n", encoding="utf-8")
    monkeypatch.setenv("LAGUN_CONNECTIONS_CONFIG", str(connections))

    with pytest.raises(
        RuntimeError, match="--connections-config requires --ldap-config"
    ):
        async with app.router.lifespan_context(app):
            pass


async def test_lifespan_reports_a_malformed_connections_config(monkeypatch, tmp_path):
    """A bad document shape reaches the operator as a named RuntimeError."""
    connections = tmp_path / "connections.yaml"
    connections.write_text("connections: not-a-list\n", encoding="utf-8")
    monkeypatch.setenv("LAGUN_CONNECTIONS_CONFIG", str(connections))
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", str(tmp_path / "ldap.yaml"))

    with pytest.raises(RuntimeError) as failure:
        async with app.router.lifespan_context(app):
            pass

    assert_contracted_config_error(failure.value, connections)


async def test_lifespan_reports_a_connection_entry_missing_its_password_env(
    monkeypatch, tmp_path
):
    connections = tmp_path / "connections.yaml"
    connections.write_text(
        "connections:\n  - id: dbs-production\n    allowed_users: [alice]\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LAGUN_CONNECTIONS_CONFIG", str(connections))
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", str(tmp_path / "ldap.yaml"))

    with pytest.raises(RuntimeError) as failure:
        async with app.router.lifespan_context(app):
            pass

    assert_contracted_config_error(failure.value, connections)
