"""LDAP administrator API for connection inventory and audit operations."""

import asyncio
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from lagun.auth import admin_users, request_admin_username
from lagun.api import presence, query
from lagun.db import session_store
from lagun.ldap_policy import (
    LDAPPolicyStore,
    PolicyConflict,
    PolicyError,
    apply_live_allowlist,
    live_session_manager,
    valid_username,
)

router = APIRouter(prefix="/admin", tags=["admin"])

_MIN_RETENTION_DAYS = 7
_MAX_RETENTION_DAYS = 3650


class PurgeRequest(BaseModel):
    older_than_days: int = Field(
        ge=_MIN_RETENTION_DAYS,
        le=_MAX_RETENTION_DAYS,
    )
    confirmation: str = Field(min_length=1, max_length=32)


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    expected_fingerprint: str | None = Field(default=None, max_length=128)


class AdminUserMutation(BaseModel):
    expected_fingerprint: str | None = Field(default=None, max_length=128)


def _observed_at() -> int:
    return int(datetime.now(timezone.utc).timestamp())


@router.get("/overview")
async def get_overview(request: Request):
    request_admin_username(request)
    connections = await session_store.list_admin_connections()
    day_ago = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    audit = await session_store.audit_summary(day_ago)
    live_presence = await presence.list_presence()
    active_queries = await query.list_active_queries()
    return {
        "connection_count": len(connections),
        "managed_connection_count": sum(1 for item in connections if item["managed"]),
        "private_connection_count": sum(
            1 for item in connections if not item["managed"]
        ),
        "audit_event_count": audit["event_count"],
        "audit_user_count": audit["user_count"],
        "live_user_count": len({item["username"] for item in live_presence}),
        "active_query_count": len(active_queries),
        "window_hours": 24,
        "observed_at": _observed_at(),
    }


@router.get("/connections")
async def get_connections(request: Request):
    request_admin_username(request)
    return {
        "items": await session_store.list_admin_connections(),
        "observed_at": _observed_at(),
    }


async def _user_policy_payload() -> dict:
    snapshot = await asyncio.to_thread(
        LDAPPolicyStore(os.getenv("LAGUN_LDAP_CONFIG")).snapshot
    )
    allowed = {str(username).casefold() for username in snapshot["allowed_users"]}
    display_names: dict[str, str] = {}
    for raw_username in snapshot["allowed_users"]:
        username = str(raw_username).strip()
        display_names.setdefault(username.casefold(), username)
    stats: dict[str, dict[str, int]] = {}
    for item in await presence.list_presence():
        username = str(item["username"]).strip()
        key = username.casefold()
        display_names.setdefault(key, username)
        entry = stats.setdefault(key, {"active_clients": 0, "active_tabs": 0})
        entry["active_clients"] += 1
        entry["active_tabs"] += len(item.get("tabs", []))
    items = [
        {
            "username": username,
            "active_clients": stats.get(key, {}).get("active_clients", 0),
            "active_tabs": stats.get(key, {}).get("active_tabs", 0),
            "policy_state": "allowed" if key in allowed else "observed",
        }
        for key, username in sorted(display_names.items())
    ]
    return {
        "items": items,
        "fingerprint": snapshot["fingerprint"],
        "observed_at": _observed_at(),
    }


def _normalize_username(username: str) -> str:
    normalized = username.strip().casefold()
    if not valid_username(normalized):
        raise HTTPException(400, "Invalid LDAP username")
    return normalized


def _policy_exception(exc: PolicyError) -> HTTPException:
    status = 409 if isinstance(exc, PolicyConflict) else 503
    return HTTPException(status, str(exc))


@router.get("/users")
async def get_users(request: Request):
    request_admin_username(request)
    try:
        return await _user_policy_payload()
    except PolicyError as exc:
        raise _policy_exception(exc) from exc


@router.post("/users")
async def add_user(request: Request, payload: AdminUserCreate):
    request_admin_username(request)
    username = _normalize_username(payload.username)
    try:
        mutation = await asyncio.to_thread(
            LDAPPolicyStore(os.getenv("LAGUN_LDAP_CONFIG")).mutate,
            username,
            True,
            payload.expected_fingerprint,
        )
    except PolicyError as exc:
        raise _policy_exception(exc) from exc
    apply_live_allowlist(list(mutation.allowed_users))
    manager = live_session_manager()
    restore = getattr(manager, "restore_user_sessions", None)
    if callable(restore):
        await asyncio.to_thread(restore, username)
    return {
        "ok": True,
        "username": username,
        "policy_state": "allowed",
        "restart_required": False,
        "fingerprint": mutation.fingerprint,
    }


@router.delete("/users/{username}")
async def remove_user(
    username: str,
    request: Request,
    payload: AdminUserMutation | None = None,
):
    request_admin_username(request)
    username = _normalize_username(username)
    if username in {admin.casefold() for admin in admin_users()}:
        raise HTTPException(409, "Administrator users cannot be removed")
    expected_fingerprint = payload.expected_fingerprint if payload else None
    try:
        mutation = await asyncio.to_thread(
            LDAPPolicyStore(os.getenv("LAGUN_LDAP_CONFIG")).mutate,
            username,
            False,
            expected_fingerprint,
        )
    except PolicyError as exc:
        raise _policy_exception(exc) from exc
    apply_live_allowlist(list(mutation.allowed_users))
    manager = live_session_manager()
    revoke = getattr(manager, "revoke_user_sessions", None)
    revoked_sessions = (
        int(await asyncio.to_thread(revoke, username)) if callable(revoke) else 0
    )
    return {
        "ok": True,
        "username": username,
        "policy_state": "removed",
        "restart_required": False,
        "revoked_sessions": revoked_sessions,
        "fingerprint": mutation.fingerprint,
    }


@router.get("/activity")
async def get_activity(
    request: Request,
    username: str | None = None,
    path: str | None = None,
    since: str | None = None,
    status_code: int | None = Query(default=None, ge=100, le=599),
    limit: int = Query(default=100, ge=1, le=500),
):
    request_admin_username(request)
    return {
        "items": await session_store.list_audit_events(
            username=username.strip() if username else None,
            since=since,
            path=path.strip() if path else None,
            status_code=status_code,
            limit=limit,
        ),
        "observed_at": _observed_at(),
    }


@router.get("/queries")
async def get_queries(request: Request):
    request_admin_username(request)
    return {"items": await query.list_active_queries(), "observed_at": _observed_at()}


@router.get("/presence")
async def get_presence(request: Request):
    request_admin_username(request)
    return {
        "items": await presence.list_presence(),
        "stale_after_seconds": presence.PRESENCE_TTL_SECONDS,
        "observed_at": _observed_at(),
    }


@router.get("/retention")
async def get_retention(
    request: Request,
    older_than_days: int = Query(
        default=30, ge=_MIN_RETENTION_DAYS, le=_MAX_RETENTION_DAYS
    ),
):
    request_admin_username(request)
    return {
        "older_than_days": older_than_days,
        "minimum_age_days": _MIN_RETENTION_DAYS,
        "eligible_count": await session_store.count_audit_events_before(
            older_than_days
        ),
        "observed_at": _observed_at(),
    }


@router.post("/retention/purge")
async def purge_retention(request: Request, payload: PurgeRequest):
    request_admin_username(request)
    if payload.confirmation != "PURGE":
        raise HTTPException(400, "Type PURGE to confirm audit cleanup")
    deleted = await session_store.purge_audit_events(payload.older_than_days)
    return {
        "deleted": deleted,
        "older_than_days": payload.older_than_days,
        "observed_at": _observed_at(),
    }
