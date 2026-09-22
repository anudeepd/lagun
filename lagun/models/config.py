"""Pydantic models for server configuration and session export."""

from typing import Optional
from pydantic import BaseModel


class ServerConfig(BaseModel):
    """The LDAP-related features this server exposes to the calling user."""

    ldap_enabled: bool
    ldap_idle_timeout: int
    is_admin: bool


class ExportedSession(BaseModel):
    """One saved connection inside an export file; its password is re-encrypted."""

    source_id: str
    name: str
    host: str
    port: int
    username: str
    password_enc: str
    default_db: Optional[str]
    query_limit: int
    ssl_enabled: bool
    selected_databases: list[str]


class SessionExport(BaseModel):
    """The JSON document downloaded from the config export route."""

    version: int
    exported_at: str
    kdf: str
    kdf_salt: str
    kdf_iterations: int
    sessions: list[ExportedSession]
