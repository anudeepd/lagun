"""aiomysql connection pool registry, keyed by session ID."""
import asyncio
import ssl as ssl_mod
from typing import Optional

import aiomysql
from pymysql.constants import CLIENT

from lagun.db.session_store import get_session, get_session_password

_pools: dict[str, aiomysql.Pool] = {}
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    """Return a lazily-created lock bound to the current event loop."""
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


async def get_pool(session_id: str) -> aiomysql.Pool:
    async with _get_lock():
        if session_id not in _pools:
            session = await get_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id!r} not found")
            password = await get_session_password(session_id)
            ssl_ctx = None
            if session.ssl_enabled:
                ssl_ctx = ssl_mod.create_default_context()
            # Explicitly clear MULTI_STATEMENTS to prevent multi-query injection
            safe_flags = CLIENT.MULTI_RESULTS & ~CLIENT.MULTI_STATEMENTS
            pool = await aiomysql.create_pool(
                host=session.host,
                port=session.port,
                user=session.username,
                password=password or "",
                db=session.default_db or "",
                charset="utf8mb4",
                autocommit=True,
                minsize=1,
                maxsize=5,
                connect_timeout=10,
                ssl=ssl_ctx,
                local_infile=False,
                client_flag=safe_flags,
            )
            _pools[session_id] = pool
        return _pools[session_id]


async def close_pool(session_id: str):
    async with _get_lock():
        pool = _pools.pop(session_id, None)
        if pool:
            pool.close()
            await pool.wait_closed()


async def close_all_pools():
    async with _get_lock():
        for pool in _pools.values():
            pool.close()
            await pool.wait_closed()
        _pools.clear()
