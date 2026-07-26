"""Bounded MySQL connection pools keyed by saved session ID."""

import asyncio
import os
import ssl as ssl_mod
import time
from contextlib import suppress

import aiomysql
from pymysql.constants import CLIENT

from lagun.db.session_store import get_session, get_session_password

_POOL_MAX_SIZE = max(1, int(os.getenv("LAGUN_DB_POOL_MAX_SIZE", "10")))
_GLOBAL_CONNECTION_LIMIT = max(
    1, int(os.getenv("LAGUN_DB_GLOBAL_CONNECTION_LIMIT", "100"))
)
_ACQUIRE_TIMEOUT_SECONDS = max(
    0.1, float(os.getenv("LAGUN_DB_ACQUIRE_TIMEOUT_SECONDS", "10"))
)
_POOL_IDLE_SECONDS = max(
    1, float(os.getenv("LAGUN_DB_POOL_IDLE_SECONDS", "900"))
)
_POOL_REAP_INTERVAL_SECONDS = max(
    1, float(os.getenv("LAGUN_DB_POOL_REAP_INTERVAL_SECONDS", "60"))
)


class DatabaseConnectionError(Exception):
    """Raised when a saved session cannot open a database connection."""

    def __init__(
        self, session_name: str, host: str, port: int, username: str, cause: Exception
    ):
        self.session_name = session_name
        self.host = host
        self.port = port
        self.username = username
        self.cause = cause
        super().__init__(
            f"Could not connect to {host}:{port} as {username} for '{session_name}': {cause}"
        )


class DatabaseCapacityError(Exception):
    """Raised when bounded database capacity cannot be acquired promptly."""


class _PoolLease:
    def __init__(self, pool: "ManagedPool"):
        self.pool = pool
        self.connection = None
        self.global_slot = False

    async def __aenter__(self):
        await self.pool.begin_acquire()
        semaphore = _get_global_semaphore()
        try:
            await asyncio.wait_for(
                semaphore.acquire(), timeout=_ACQUIRE_TIMEOUT_SECONDS
            )
            self.global_slot = True
            self.connection = await asyncio.wait_for(
                self.pool.raw.acquire(), timeout=_ACQUIRE_TIMEOUT_SECONDS
            )
            self.pool.touch()
            return self.connection
        except TimeoutError as error:
            if self.global_slot:
                semaphore.release()
                self.global_slot = False
            await self.pool.end_acquire()
            raise DatabaseCapacityError(
                "Database is busy. Try again after active queries finish."
            ) from error
        except Exception as error:
            if self.global_slot:
                semaphore.release()
                self.global_slot = False
            await self.pool.end_acquire()
            raise DatabaseConnectionError(
                self.pool.session_name,
                self.pool.host,
                self.pool.port,
                self.pool.username,
                error,
            ) from error

    async def __aexit__(self, exc_type, exc, traceback):
        try:
            if self.connection is not None:
                self.pool.raw.release(self.connection)
                self.connection = None
        finally:
            if self.global_slot:
                _get_global_semaphore().release()
                self.global_slot = False
            self.pool.touch()
            await self.pool.end_acquire()


class ManagedPool:
    """Add global backpressure, deadlines, and idle lifecycle to aiomysql pools."""

    def __init__(self, raw: aiomysql.Pool, session):
        self.raw = raw
        self.session_name = session.name
        self.host = session.host
        self.port = session.port
        self.username = session.username
        self.last_used = time.monotonic()
        self._active = 0
        self._closing = False
        self._state_lock = asyncio.Lock()

    def acquire(self) -> _PoolLease:
        return _PoolLease(self)

    def touch(self) -> None:
        self.last_used = time.monotonic()

    async def begin_acquire(self) -> None:
        async with self._state_lock:
            if self._closing:
                raise DatabaseCapacityError(
                    "Database connection pool is recycling. Try again."
                )
            self._active += 1

    async def end_acquire(self) -> None:
        async with self._state_lock:
            self._active -= 1

    async def close_if_idle(self, idle_seconds: float) -> bool:
        async with self._state_lock:
            if (
                self._closing
                or self._active
                or time.monotonic() - self.last_used < idle_seconds
            ):
                return False
            self._closing = True
            self.raw.close()
            return True

    async def close(self) -> None:
        async with self._state_lock:
            if not self._closing:
                self._closing = True
                self.raw.close()

    async def wait_closed(self) -> None:
        await self.raw.wait_closed()


_pools: dict[str, ManagedPool] = {}
_pool_locks: dict[str, asyncio.Lock] = {}
_lock: asyncio.Lock | None = None
_global_semaphore: asyncio.Semaphore | None = None
_runtime_loop: asyncio.AbstractEventLoop | None = None
_reaper_task: asyncio.Task | None = None


def _ensure_runtime() -> None:
    global _lock, _global_semaphore, _runtime_loop
    loop = asyncio.get_running_loop()
    if _runtime_loop is not loop or _lock is None or _global_semaphore is None:
        _runtime_loop = loop
        _lock = asyncio.Lock()
        _global_semaphore = asyncio.Semaphore(_GLOBAL_CONNECTION_LIMIT)
        _pool_locks.clear()


def _get_lock() -> asyncio.Lock:
    _ensure_runtime()
    assert _lock is not None
    return _lock


def _get_global_semaphore() -> asyncio.Semaphore:
    _ensure_runtime()
    assert _global_semaphore is not None
    return _global_semaphore


async def get_pool(session_id: str) -> ManagedPool:
    _ensure_runtime()
    if session_id in _pools:
        return _pools[session_id]
    session_lock = _pool_locks.setdefault(session_id, asyncio.Lock())
    async with session_lock:
        if session_id in _pools:
            return _pools[session_id]
        session = await get_session(session_id)
        if not session:
            raise ValueError(f"Session {session_id!r} not found")
        password = await get_session_password(session_id)
        ssl_ctx = None
        if session.ssl_enabled:
            ssl_ctx = ssl_mod.create_default_context()
        safe_flags = CLIENT.MULTI_RESULTS & ~CLIENT.MULTI_STATEMENTS
        raw = await aiomysql.create_pool(
            host=session.host,
            port=session.port,
            user=session.username,
            password=password or "",
            db=session.default_db or "",
            charset="utf8mb4",
            autocommit=True,
            minsize=0,
            maxsize=max(1, _POOL_MAX_SIZE),
            connect_timeout=10,
            pool_recycle=1800,
            ssl=ssl_ctx,
            local_infile=False,
            client_flag=safe_flags,
        )
        pool = ManagedPool(raw, session)
        async with _get_lock():
            _pools[session_id] = pool
        return pool


async def close_pool(session_id: str) -> None:
    async with _get_lock():
        pool = _pools.pop(session_id, None)
        _pool_locks.pop(session_id, None)
    if pool:
        await pool.close()
        await pool.wait_closed()


async def _reap_idle_pools() -> None:
    while True:
        await asyncio.sleep(max(1, _POOL_REAP_INTERVAL_SECONDS))
        for session_id, pool in list(_pools.items()):
            if await pool.close_if_idle(max(1, _POOL_IDLE_SECONDS)):
                async with _get_lock():
                    if _pools.get(session_id) is pool:
                        del _pools[session_id]
                        _pool_locks.pop(session_id, None)
                await pool.wait_closed()


def start_pool_reaper() -> None:
    global _reaper_task
    if _reaper_task is None or _reaper_task.done():
        _reaper_task = asyncio.create_task(
            _reap_idle_pools(), name="lagun-db-pool-reaper"
        )


async def close_all_pools() -> None:
    global _reaper_task
    if _reaper_task:
        _reaper_task.cancel()
        with suppress(asyncio.CancelledError):
            await _reaper_task
        _reaper_task = None
    async with _get_lock():
        pools = list(_pools.values())
        _pools.clear()
        _pool_locks.clear()
    for pool in pools:
        await pool.close()
    for pool in pools:
        await pool.wait_closed()
