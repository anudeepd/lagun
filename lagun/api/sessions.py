"""Sessions API: CRUD + connection test."""

import asyncio
import ssl as ssl_mod
import time
from fastapi import APIRouter, HTTPException, Request

import aiomysql

from lagun.db import session_store, pool as pool_mod
from lagun.db.session_store import get_session_password
from lagun.db.utils import SYSTEM_DBS
from lagun.auth import request_username
from lagun.models.session import (
    SessionCreate,
    SessionRead,
    SessionUpdate,
    TestResult,
    ProbeRequest,
)

router = APIRouter(tags=["sessions"])

# Fields on managed (connections.yaml) sessions that only an admin may change.
# Users may only update the selected_databases subset.
_MANAGED_LOCKED_FIELDS = (
    "name",
    "host",
    "port",
    "username",
    "password",
    "default_db",
    "query_limit",
    "ssl_enabled",
)

# Fields that change the live DB connection. Only updates touching these
# require tearing down the connection pool so reconnects pick up new credentials.
_CREDENTIAL_FIELDS = {
    "host",
    "port",
    "username",
    "password",
    "default_db",
    "ssl_enabled",
}


@router.get("/sessions", response_model=list[SessionRead])
async def list_sessions(request: Request):
    username = request_username(request)
    return (
        await session_store.list_sessions_for_user(username)
        if username
        else await session_store.list_sessions()
    )


@router.post("/sessions", response_model=SessionRead, status_code=201)
async def create_session(data: SessionCreate, request: Request):
    return await session_store.create_session(
        data, owner_username=request_username(request)
    )


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
    sent_fields = set(data.model_dump(exclude_unset=True))
    if s.managed:
        # Only the selected_databases subset is user-editable on managed
        # sessions; everything else is owned by connections.yaml.
        for field in _MANAGED_LOCKED_FIELDS:
            if field in sent_fields:
                raise HTTPException(
                    403,
                    f"Field '{field}' is locked: managed in connections.yaml — ask an admin to change.",
                )
    # Invalidate the pool only when a credential-relevant field is actually
    # changing; no-op and selected_databases-only updates shouldn't force a
    # needless reconnect.
    if sent_fields & _CREDENTIAL_FIELDS:
        await pool_mod.close_pool(session_id)
    return await session_store.update_session(session_id, data)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, request: Request):
    username = request_username(request)
    if username and await session_store.is_managed_session(session_id):
        await session_store.hide_shared_session(session_id, username)
        return
    ok = await session_store.delete_session(session_id)
    if not ok:
        raise HTTPException(404, "Session not found")
    await pool_mod.close_pool(session_id)


# Simple rate limiter for probe endpoint
_probe_semaphore = asyncio.Semaphore(3)  # max 3 concurrent probes
_probe_timestamps: list[float] = []
_PROBE_RATE_LIMIT = 60  # max probes per minute
_PROBE_WINDOW = 60.0  # seconds


async def _probe_connection(
    host: str, port: int, user: str, password: str, ssl_enabled: bool = False
) -> TestResult:
    t0 = time.monotonic()
    conn = None
    try:
        ssl_ctx = ssl_mod.create_default_context() if ssl_enabled else None
        conn = await aiomysql.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            connect_timeout=5,
            ssl=ssl_ctx,
        )
        latency = (time.monotonic() - t0) * 1000
        async with conn.cursor() as cur:
            await cur.execute("SELECT VERSION()")
            row = await cur.fetchone()
            server_version = row[0]
            await cur.execute("SHOW DATABASES")
            db_rows = await cur.fetchall()
        databases = [r[0] for r in db_rows if r[0].lower() not in SYSTEM_DBS]
        return TestResult(
            ok=True,
            server_version=server_version,
            latency_ms=round(latency, 2),
            databases=databases,
        )
    except Exception as exc:
        return TestResult(
            ok=False,
            error=str(exc),
            latency_ms=round((time.monotonic() - t0) * 1000, 2),
        )
    finally:
        if conn:
            conn.close()


@router.post("/sessions/probe", response_model=TestResult)
async def probe_connection(data: ProbeRequest):
    """Test a connection without saving it and return available databases."""
    async with _probe_semaphore:
        now = time.monotonic()
        _probe_timestamps[:] = [t for t in _probe_timestamps if now - t < _PROBE_WINDOW]
        if len(_probe_timestamps) >= _PROBE_RATE_LIMIT:
            raise HTTPException(
                429, "Too many probe requests. Please wait before trying again."
            )
        _probe_timestamps.append(now)
        return await _probe_connection(
            data.host, data.port, data.username, data.password, data.ssl_enabled
        )


@router.post("/sessions/{session_id}/test", response_model=TestResult)
async def test_session(session_id: str):
    session = await session_store.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    password = await get_session_password(session_id)
    return await _probe_connection(
        session.host,
        session.port,
        session.username,
        password or "",
        session.ssl_enabled,
    )
