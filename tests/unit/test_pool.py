import asyncio
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


def make_pool() -> pool_module.ManagedPool:
    session = SimpleNamespace(
        name="shared", host="localhost", port=3306, username="lagun"
    )
    return pool_module.ManagedPool(FakeRawPool(), session)


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
