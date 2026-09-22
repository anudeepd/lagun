"""Pydantic models for ephemeral browser workspace presence."""

from typing import Any, Optional
from pydantic import BaseModel, Field


class PresenceAck(BaseModel):
    """Confirmation that a client's presence report was recorded."""

    ok: bool
    seen_at: str


class PresenceRemovalResult(BaseModel):
    """Confirmation that a client's presence was dropped."""

    ok: bool


class PresenceEntry(BaseModel):
    """One live browser client, as reported to administrators."""

    username: str
    client_id: str
    active_tab_id: Optional[str]
    # Tab payloads verbatim: exactly the keys the client reported.
    tabs: list[dict[str, Any]] = Field(default_factory=list)
    seen_at: str
    age_seconds: float
