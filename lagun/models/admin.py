"""Pydantic models for the LDAP administrator API."""

from typing import Literal, Optional
from pydantic import BaseModel

from lagun.models.presence import PresenceEntry


class AdminConnection(BaseModel):
    """Saved connection metadata for administrators; never carries secrets."""

    id: str
    name: str
    host: str
    port: int
    username: str
    default_db: Optional[str]
    query_limit: int
    ssl_enabled: bool
    created_at: str
    updated_at: str
    selected_databases: list[str]
    managed_selected_databases: list[str]
    managed: bool
    is_default: bool
    owner_username: Optional[str]
    config_key: Optional[str]
    shared_user_count: int


class AdminOverview(BaseModel):
    connection_count: int
    managed_connection_count: int
    private_connection_count: int
    audit_event_count: int
    audit_user_count: int
    live_user_count: int
    active_query_count: int
    window_hours: int
    observed_at: int


class AdminConnectionsResponse(BaseModel):
    items: list[AdminConnection]
    observed_at: int


class AdminUser(BaseModel):
    """One account the admin policy knows about, with its live client activity."""

    username: str
    active_clients: int
    active_tabs: int
    policy_state: Literal["allowed", "observed"]


class AdminUsersResponse(BaseModel):
    items: list[AdminUser]
    fingerprint: str
    observed_at: int


class AdminUserAddResult(BaseModel):
    ok: bool
    username: str
    policy_state: Literal["allowed"]
    restart_required: bool
    fingerprint: str


class AdminUserRemovalResult(BaseModel):
    ok: bool
    username: str
    policy_state: Literal["removed"]
    restart_required: bool
    revoked_sessions: int
    fingerprint: str


class AuditEvent(BaseModel):
    id: int
    occurred_at: str
    username: str
    method: str
    path: str
    session_id: Optional[str]
    details: Optional[str]
    status_code: int
    duration_ms: float


class AdminActivityResponse(BaseModel):
    items: list[AuditEvent]
    # Keyset cursor for the next, older page; null when this page is the last.
    next_before_id: Optional[int]
    observed_at: int


class ActiveQuery(BaseModel):
    """A live normal or bulk execution, as tracked by the query layer."""

    session_id: str
    execution_id: str
    username: str
    database: Optional[str]
    tab_id: Optional[str]
    sql: str
    started_at: str
    elapsed_ms: float
    state: Literal["queued", "running"]
    kind: Literal["query", "bulk"]


class AdminQueriesResponse(BaseModel):
    items: list[ActiveQuery]
    observed_at: int


class AdminPresenceResponse(BaseModel):
    items: list[PresenceEntry]
    stale_after_seconds: int
    observed_at: int


class AdminRetention(BaseModel):
    older_than_days: int
    minimum_age_days: int
    eligible_count: int
    observed_at: int


class AdminPurgeResult(BaseModel):
    deleted: int
    older_than_days: int
    observed_at: int
