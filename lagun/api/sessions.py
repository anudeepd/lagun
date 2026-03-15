"""Sessions API: CRUD + connection test."""
import asyncio
import time
from fastapi import APIRouter, HTTPException

import aiomysql

from lagun.db import session_store, pool as pool_mod
from lagun.db.session_store import get_session_password
from lagun.db.utils import SYSTEM_DBS
from lagun.models.session import SessionCreate, SessionRead, SessionUpdate, TestResult, ProbeRequest

router = APIRouter(tags=["sessions"])


@router.get("/sessions", response_model=list[SessionRead])
async def list_sessions():
    return await session_store.list_sessions()


@router.post("/sessions", response_model=SessionRead, status_code=201)
async def create_session(data: SessionCreate):
    return await session_store.create_session(data)


@router.get("/sessions/{session_id}", response_model=SessionRead)
async def get_session(session_id: str):
    s = await session_store.get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return s


@router.put("/sessions/{session_id}", response_model=SessionRead)
async def update_session(session_id: str, data: SessionUpdate):
    s = await session_store.get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    # Invalidate pool so reconnection uses updated credentials
    await pool_mod.close_pool(session_id)
    return await session_store.update_session(session_id, data)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str):
    ok = await session_store.delete_session(session_id)
    if not ok:
        raise HTTPException(404, "Session not found")
    await pool_mod.close_pool(session_id)



# Simple rate limiter for probe endpoint
_probe_semaphore = asyncio.Semaphore(3)  # max 3 concurrent probes
_probe_timestamps: list[float] = []
_PROBE_RATE_LIMIT = 10  # max probes per minute
_PROBE_WINDOW = 60.0  # seconds


async def _probe_connection(host: str, port: int, user: str, password: str) -> TestResult:
    t0 = time.monotonic()
    conn = None
    try:
        conn = await aiomysql.connect(
            host=host, port=port, user=user, password=password, connect_timeout=5,
        )
        latency = (time.monotonic() - t0) * 1000
        async with conn.cursor() as cur:
            await cur.execute("SELECT VERSION()")
            row = await cur.fetchone()
            server_version = row[0]
            await cur.execute("SHOW DATABASES")
            db_rows = await cur.fetchall()
        databases = [r[0] for r in db_rows if r[0].lower() not in SYSTEM_DBS]
        return TestResult(ok=True, server_version=server_version,
                          latency_ms=round(latency, 2), databases=databases)
    except Exception as exc:
        return TestResult(ok=False, error=str(exc),
                          latency_ms=round((time.monotonic() - t0) * 1000, 2))
    finally:
        if conn:
            conn.close()


@router.post("/sessions/probe", response_model=TestResult)
async def probe_connection(data: ProbeRequest):
    """Test a connection without saving it and return available databases."""
    now = time.monotonic()
    # Prune old timestamps and check rate limit
    _probe_timestamps[:] = [t for t in _probe_timestamps if now - t < _PROBE_WINDOW]
    if len(_probe_timestamps) >= _PROBE_RATE_LIMIT:
        raise HTTPException(429, "Too many probe requests. Please wait before trying again.")
    _probe_timestamps.append(now)

    async with _probe_semaphore:
        return await _probe_connection(data.host, data.port, data.username, data.password)


@router.post("/sessions/{session_id}/test", response_model=TestResult)
async def test_session(session_id: str):
    session = await session_store.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    password = await get_session_password(session_id)
    return await _probe_connection(session.host, session.port, session.username, password or "")
