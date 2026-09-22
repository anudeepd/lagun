import asyncio
import logging
import time
from types import SimpleNamespace

import pytest

import lagun.db.pool as pool_module


class FakeRawPool:
    def __init__(self):
        self.closed = False
        self.releases = 0

    async def acquire(self):
        return object()

    def release(self, connection):
        self.releases += 1

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None


class StuckRawPool(FakeRawPool):
    """A pool holding a connection an in-flight query never gives back."""

    def __init__(self):
        super().__init__()
        self.terminated = False
        self._never = asyncio.Event()

    async def wait_closed(self):
        await self._never.wait()

    def terminate(self):
        self.terminated = True


def make_pool(raw=None) -> pool_module.ManagedPool:
    session = SimpleNamespace(
        name="shared", host="localhost", port=3306, username="lagun"
    )
    return pool_module.ManagedPool(raw if raw is not None else FakeRawPool(), session)


@pytest.mark.asyncio
async def test_global_connection_limit_applies_backpressure(monkeypatch):
    monkeypatch.setattr(pool_module, "_GLOBAL_CONNECTION_LIMIT", 2)
    monkeypatch.setattr(pool_module, "_ACQUIRE_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(pool_module, "_runtime_loop", asyncio.get_running_loop())
    monkeypatch.setattr(pool_module, "_global_semaphore", asyncio.Semaphore(2))
    pool = make_pool()
    first = pool.acquire()
    second = pool.acquire()
    await first.__aenter__()
    await second.__aenter__()

    with pytest.raises(pool_module.DatabaseCapacityError, match="Database is busy"):
        await pool.acquire().__aenter__()

    await first.__aexit__(None, None, None)
    third = pool.acquire()
    await third.__aenter__()
    await third.__aexit__(None, None, None)
    await second.__aexit__(None, None, None)
    assert pool.raw.releases == 3


@pytest.mark.asyncio
async def test_idle_pool_closes_only_without_active_leases(monkeypatch):
    monkeypatch.setattr(pool_module, "_runtime_loop", asyncio.get_running_loop())
    monkeypatch.setattr(pool_module, "_global_semaphore", asyncio.Semaphore(2))
    pool = make_pool()
    pool.last_used = time.monotonic() - 60
    lease = pool.acquire()
    await lease.__aenter__()

    assert await pool.close_if_idle(1) is False
    await lease.__aexit__(None, None, None)
    pool.last_used = time.monotonic() - 60
    assert await pool.close_if_idle(1) is True
    assert pool.raw.closed is True


@pytest.mark.asyncio
async def test_close_all_pools_bounds_shutdown_of_stuck_pools(monkeypatch, caplog):
    monkeypatch.setattr(pool_module, "_POOL_CLOSE_GRACE_SECONDS", 0.05)
    stuck_raw = StuckRawPool()
    healthy_raw = FakeRawPool()
    pool_module._pools["stuck"] = make_pool(stuck_raw)
    pool_module._pools["healthy"] = make_pool(healthy_raw)

    started = time.monotonic()
    with caplog.at_level(logging.WARNING, logger="lagun.db.pool"):
        # Without the grace period this would never return.
        await asyncio.wait_for(pool_module.close_all_pools(), timeout=1)
    elapsed = time.monotonic() - started

    assert elapsed < 0.5
    assert stuck_raw.terminated is True
    assert healthy_raw.closed is True
    assert pool_module._pools == {}
    assert "Force-terminated 1 database pool(s)" in caplog.text


@pytest.mark.asyncio
async def test_first_connection_failure_is_mapped_not_raw(monkeypatch, tmp_path):
    """A driver failure while opening a session's pool must not escape as a 500.

    The lease path already maps this to 502; the pool-creation path did not, so
    any exception `aiomysql.create_pool` itself raises (bad arguments, a future
    non-zero minsize) surfaced as an unmapped 500.
    """
    from lagun.db import session_store
    from lagun.models.session import SessionCreate

    monkeypatch.setenv("LAGUN_DB", str(tmp_path / "lagun.db"))
    monkeypatch.setattr(session_store, "_DB_PATH", None)
    await session_store.init_db()
    session = await session_store.create_session(
        SessionCreate(
            name="Dead DB", host="db.internal", port=3306, username="u", password="p"
        ),
        "owner",
    )

    async def failing_create_pool(**kwargs):
        raise OSError("name resolution failed")

    monkeypatch.setattr(pool_module.aiomysql, "create_pool", failing_create_pool)
    monkeypatch.setattr(pool_module, "_runtime_loop", asyncio.get_running_loop())
    monkeypatch.setattr(pool_module, "_pools", {})

    with pytest.raises(pool_module.DatabaseConnectionError) as raised:
        await pool_module.get_pool(session.id)

    assert "db.internal:3306" in str(raised.value)
    assert raised.value.session_name == "Dead DB"
