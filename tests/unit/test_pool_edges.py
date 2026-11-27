import asyncio
from types import SimpleNamespace

import pytest
from pymysql.constants import SERVER_STATUS

import lagun.db.pool as pool_module


class Conn:
    def __init__(self, status=0, closed=False):
        self.closed = closed
        self.server_status = status
        self.rolled_back = False
        self.autocommit_value = None
        self.close_calls = 0

    async def rollback(self):
        self.rolled_back = True

    async def autocommit(self, value):
        self.autocommit_value = value

    def close(self):
        self.close_calls += 1


class Raw:
    def __init__(self):
        self.released = []
        self.closed = False

    async def wait_closed(self):
        return None

    def release(self, conn):
        self.released.append(conn)

    def close(self):
        self.closed = True


def session():
    return SimpleNamespace(
        name="db",
        host="db.test",
        port=3306,
        username="reader",
        ssl_enabled=False,
        default_db=None,
    )


@pytest.mark.asyncio
async def test_restore_connection_state_handles_all_status_combinations(monkeypatch):
    closed = Conn(closed=True)
    assert await pool_module.restore_connection_state(closed) is False

    clean = Conn(SERVER_STATUS.SERVER_STATUS_AUTOCOMMIT)
    assert await pool_module.restore_connection_state(clean) is False

    dirty = Conn(SERVER_STATUS.SERVER_STATUS_IN_TRANS)
    assert await pool_module.restore_connection_state(dirty) is True
    assert dirty.rolled_back is True
    assert dirty.autocommit_value is True

    rollback_only = Conn(
        SERVER_STATUS.SERVER_STATUS_IN_TRANS | SERVER_STATUS.SERVER_STATUS_AUTOCOMMIT
    )
    assert await pool_module.restore_connection_state(rollback_only) is True
    assert rollback_only.rolled_back is True
    assert rollback_only.autocommit_value is None


@pytest.mark.asyncio
async def test_pool_lease_cleans_up_after_cancelled_and_failed_restore(monkeypatch):
    for error in (asyncio.CancelledError(), RuntimeError("reset failed")):
        raw = Raw()
        pool = pool_module.ManagedPool(raw, session())
        lease = pool_module._PoolLease(pool)
        conn = Conn()
        lease.connection = conn

        async def restore(_conn, error=error):
            raise error

        monkeypatch.setattr(pool_module, "restore_connection_state", restore)
        if isinstance(error, asyncio.CancelledError):
            with pytest.raises(asyncio.CancelledError):
                await lease.__aexit__(None, None, None)
        else:
            await lease.__aexit__(None, None, None)
        assert conn.close_calls == 1
        assert raw.released == [conn]


@pytest.mark.asyncio
async def test_pool_lease_reports_acquire_failures_and_releases_slot(monkeypatch):
    raw = Raw()

    async def fail():
        raise OSError("connect failed")

    raw.acquire = fail
    pool = pool_module.ManagedPool(raw, session())
    monkeypatch.setattr(pool_module, "_ACQUIRE_TIMEOUT_SECONDS", 0.1)
    with pytest.raises(pool_module.DatabaseConnectionError):
        await pool.acquire().__aenter__()

    async def timeout():
        await asyncio.sleep(1)

    raw.acquire = timeout
    with pytest.raises(pool_module.DatabaseCapacityError):
        await pool.acquire().__aenter__()


@pytest.mark.asyncio
async def test_pool_lease_reports_a_global_slot_failure_before_it_is_held(monkeypatch):
    class BrokenSemaphore:
        async def acquire(self):
            raise OSError("global limiter failed")

    pool = pool_module.ManagedPool(Raw(), session())
    monkeypatch.setattr(pool_module, "_get_global_semaphore", lambda: BrokenSemaphore())

    with pytest.raises(pool_module.DatabaseConnectionError, match="global limiter"):
        await pool.acquire().__aenter__()


@pytest.mark.asyncio
async def test_pool_lease_without_a_connection_only_updates_state():
    pool = pool_module.ManagedPool(Raw(), session())
    lease = pool_module._PoolLease(pool)
    await pool.begin_acquire()

    await lease.__aexit__(None, None, None)

    assert pool._active == 0


@pytest.mark.asyncio
async def test_pool_begin_acquire_rejects_a_closing_pool():
    pool = pool_module.ManagedPool(Raw(), session())
    pool._closing = True
    with pytest.raises(pool_module.DatabaseCapacityError, match="recycling"):
        await pool.begin_acquire()


@pytest.mark.asyncio
async def test_get_pool_rejects_missing_sessions_and_uses_ssl(monkeypatch):
    monkeypatch.setattr(pool_module, "_pools", {})
    monkeypatch.setattr(pool_module, "_pool_locks", {})

    async def missing(_session_id):
        return None

    monkeypatch.setattr(pool_module, "get_session", missing)
    with pytest.raises(ValueError, match="not found"):
        await pool_module.get_pool("missing")

    secured = session()
    secured.ssl_enabled = True

    async def found(_session_id):
        return secured

    created = {}
    ssl_created = []

    async def create_pool(**kwargs):
        created.update(kwargs)
        return Raw()

    async def password(_session_id):
        return "secret"

    monkeypatch.setattr(pool_module, "get_session", found)
    monkeypatch.setattr(pool_module, "get_session_password", password)
    monkeypatch.setattr(pool_module, "require_host_allowed", lambda _host: None)
    monkeypatch.setattr(pool_module.aiomysql, "create_pool", create_pool)
    monkeypatch.setattr(
        pool_module.ssl_mod,
        "create_default_context",
        lambda: ssl_created.append(True) or SimpleNamespace(),
    )
    pool = await pool_module.get_pool("secured")
    assert pool.session_name == "db"
    assert ssl_created == [True]
    assert created["ssl"] is not None


@pytest.mark.asyncio
async def test_reaper_removes_idle_pools_and_start_is_idempotent(monkeypatch):
    pool = pool_module.ManagedPool(Raw(), session())

    async def close_if_idle(_seconds):
        return True

    pool.close_if_idle = close_if_idle
    pool_module._pools.clear()
    pool_module._pools["idle"] = pool
    calls = 0

    async def sleep(_seconds):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(pool_module.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await pool_module._reap_idle_pools()
    assert "idle" not in pool_module._pools

    pool_module._reaper_task = None
    pool_module.start_pool_reaper()
    task = pool_module._reaper_task
    pool_module.start_pool_reaper()
    assert pool_module._reaper_task is task
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    pool_module._reaper_task = None


@pytest.mark.asyncio
async def test_close_pool_is_a_noop_for_an_unknown_pool():
    pool_module._pools.clear()
    await pool_module.close_pool("unknown")


@pytest.mark.asyncio
async def test_closing_a_pool_twice_does_not_close_it_again():
    raw = Raw()
    pool = pool_module.ManagedPool(raw, session())
    pool._closing = True

    await pool.close()

    assert raw.closed is False


@pytest.mark.asyncio
async def test_reaper_skips_active_pools_and_leaves_a_replacement_in_place(
    monkeypatch,
):
    active = SimpleNamespace(
        close_if_idle=lambda _seconds: _false(),
        wait_closed=lambda: _done(),
    )
    replacement = object()

    class Replaced:
        async def close_if_idle(self, _seconds):
            pool_module._pools["replaced"] = replacement
            return True

        async def wait_closed(self):
            return None

    pool_module._pools.clear()
    pool_module._pools["active"] = active
    pool_module._pools["replaced"] = Replaced()
    calls = 0

    async def sleep(_seconds):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(pool_module.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await pool_module._reap_idle_pools()

    assert pool_module._pools["replaced"] is replacement
    assert "active" in pool_module._pools


async def _false():
    return False


async def _done():
    return None
