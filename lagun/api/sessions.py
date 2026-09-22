"""Sessions API: CRUD + connection test."""

import asyncio
import logging
import socket
import ssl as ssl_mod
import time
from fastapi import APIRouter, HTTPException, Request

import aiomysql

from lagun.api.scope import filter_databases, outside_ceiling
from lagun.auth import ldap_enabled, request_username
from lagun.db import session_store, pool as pool_mod
from lagun.db.net_policy import allowed_hosts, require_host_allowed
from lagun.db.session_store import get_session_password
from lagun.db.utils import SYSTEM_DBS
from lagun.models.session import (
    SessionCreate,
    SessionRead,
    SessionUpdate,
    TestResult,
    ProbeRequest,
)

_log = logging.getLogger(__name__)

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
    require_host_allowed(data.host)
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
    if data.host is not None:
        require_host_allowed(data.host)
    if s.managed:
        # Only the selected_databases subset is user-editable on managed
        # sessions; everything else is owned by connections.yaml.
        for field in _MANAGED_LOCKED_FIELDS:
            if field in sent_fields:
                raise HTTPException(
                    403,
                    f"Field '{field}' is locked: managed in connections.yaml — ask an admin to change.",
                )
        if data.selected_databases is not None:
            # The administrator's list is a ceiling: a user may narrow it, never
            # widen it (an empty list means "everything the admin allows").
            extra = outside_ceiling(s, data.selected_databases)
            if extra:
                raise HTTPException(
                    403,
                    "Selected databases must stay within the administrator's "
                    f"allowed list: {', '.join(sorted(extra))}.",
                )
    # Invalidate the pool only when a credential-relevant field is actually
    # changing; no-op and selected_databases-only updates shouldn't force a
    # needless reconnect.
    if sent_fields & _CREDENTIAL_FIELDS:
        await pool_mod.close_pool(session_id)
    return await session_store.update_session(session_id, data)


@router.delete(
    "/sessions/{session_id}",
    status_code=204,
    responses={204: {"description": "Session deleted. No body."}},
)
async def delete_session(session_id: str, request: Request):
    username = request_username(request)
    if username and await session_store.is_managed_session(session_id):
        await session_store.hide_shared_session(session_id, username)
        return
    ok = await session_store.delete_session(session_id)
    if not ok:
        raise HTTPException(404, "Session not found")
    await pool_mod.close_pool(session_id)


# Probe/test hardening. Lagun connects out from the server on request, so these
# endpoints are an egress surface: a shared instance must not be usable as an
# internal port scanner or a credential-guessing relay.
#
#  * LAGUN_ALLOWED_DB_HOSTS (see lagun/db/net_policy.py) optionally pins egress
#    to known hosts/CIDRs, and is re-checked when a pool connects.
#  * The rate-limit window is per caller (LDAP user, or the client address when
#    running unauthenticated) so one client cannot exhaust the shared budget.
#  * Failure messages are categories rather than raw driver text whenever there
#    is a multi-user boundary or a locked-down allowlist; the raw error still
#    goes to the server log for the operator.
_probe_semaphore = asyncio.Semaphore(3)  # max 3 concurrent probes
_probe_windows: dict[str, list[float]] = {}
_PROBE_RATE_LIMIT = 60  # max probes per minute per caller
_PROBE_WINDOW = 60.0  # seconds
_PROBE_WINDOW_MAX_CALLERS = 1024


def _probe_caller_key(request: Request) -> str:
    return request_username(request) or (
        request.client.host if request.client else "unknown"
    )


def _check_probe_rate_limit(caller: str) -> None:
    now = time.monotonic()
    window = [t for t in _probe_windows.get(caller, []) if now - t < _PROBE_WINDOW]
    if len(window) >= _PROBE_RATE_LIMIT:
        _probe_windows[caller] = window
        raise HTTPException(
            429, "Too many probe requests. Please wait before trying again."
        )
    window.append(now)
    _probe_windows[caller] = window
    if len(_probe_windows) > _PROBE_WINDOW_MAX_CALLERS:
        for stale in [
            key
            for key, stamps in _probe_windows.items()
            if not stamps or now - stamps[-1] > _PROBE_WINDOW
        ]:
            _probe_windows.pop(stale, None)


def _probe_error(exc: BaseException, *, detailed: bool) -> str:
    """Describe a failed connection attempt without leaking reachability detail."""
    if detailed:
        return str(exc)
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "Timed out while connecting."
    if isinstance(exc, socket.gaierror):
        return "Host name could not be resolved."
    if isinstance(exc, ssl_mod.SSLError):
        return "TLS handshake failed."
    code = getattr(exc, "args", [None])[0] if getattr(exc, "args", None) else None
    if code == 1045:
        return "The server rejected these credentials."
    if code == 1044:
        return "The account is not allowed to use that database."
    if code == 2005:
        return "Host name could not be resolved."
    if code in (2002, 2003):
        return "The server did not accept the connection."
    return "The connection could not be established."


def _probe_detail_allowed() -> bool:
    """Raw driver text is only exposed when there is no multi-user boundary."""
    return not allowed_hosts() and not ldap_enabled()


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
        _log.warning("connection test to %s:%s failed: %s", host, port, exc)
        return TestResult(
            ok=False,
            error=_probe_error(exc, detailed=_probe_detail_allowed()),
            latency_ms=round((time.monotonic() - t0) * 1000, 2),
        )
    finally:
        if conn:
            conn.close()


@router.post("/sessions/probe", response_model=TestResult)
async def probe_connection(data: ProbeRequest, request: Request):
    """Test a connection without saving it and return available databases."""
    require_host_allowed(data.host)
    async with _probe_semaphore:
        _check_probe_rate_limit(_probe_caller_key(request))
        return await _probe_connection(
            data.host, data.port, data.username, data.password, data.ssl_enabled
        )


@router.post("/sessions/{session_id}/test", response_model=TestResult)
async def test_session(session_id: str, request: Request):
    session = await session_store.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    require_host_allowed(session.host)
    password = await get_session_password(session_id)
    # Same egress budget as /sessions/probe: this endpoint opens a connection to
    # a caller-chosen (stored) host, so it is rate-limited per caller too.
    async with _probe_semaphore:
        _check_probe_rate_limit(_probe_caller_key(request))
        result = await _probe_connection(
            session.host,
            session.port,
            session.username,
            password or "",
            session.ssl_enabled,
        )
    # The probe reports every schema the account can see; a scoped connection
    # must only reveal the ones it is allowed to use.
    if result.databases:
        result.databases = filter_databases(session, result.databases)
    return result
