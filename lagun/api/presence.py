"""Ephemeral browser workspace presence for administrator visibility."""

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from lagun.auth import request_username

router = APIRouter(tags=["presence"])
_PRESENCE_TTL_SECONDS = 45


class PresenceTab(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    type: str = Field(min_length=1, max_length=32)
    label: str = Field(max_length=200)
    session_id: str = Field(min_length=1, max_length=128)
    database: str | None = Field(default=None, max_length=128)
    table: str | None = Field(default=None, max_length=128)
    view: str | None = Field(default=None, max_length=32)
    global_search: str | None = Field(default=None, max_length=1000)
    where_filter: str | None = Field(default=None, max_length=32000)
    row_limit: int | None = Field(default=None, ge=1, le=100000)


class PresenceUpdate(BaseModel):
    client_id: str = Field(min_length=1, max_length=128)
    active_tab_id: str | None = Field(default=None, max_length=128)
    tabs: list[PresenceTab] = Field(default_factory=list, max_length=100)


@dataclass
class _PresenceRecord:
    username: str
    client_id: str
    active_tab_id: str | None
    tabs: list[dict[str, Any]]
    seen_epoch: float
    seen_at: str


_records: dict[tuple[str, str], _PresenceRecord] = {}
_lock = asyncio.Lock()


def _username(request: Request) -> str:
    return request_username(request) or "local"


@router.post("/presence")
async def update_presence(payload: PresenceUpdate, request: Request):
    now = time.time()
    username = _username(request)
    record = _PresenceRecord(
        username=username,
        client_id=payload.client_id,
        active_tab_id=payload.active_tab_id,
        tabs=[tab.model_dump(exclude_none=True) for tab in payload.tabs],
        seen_epoch=now,
        seen_at=datetime.now(timezone.utc).isoformat(),
    )
    async with _lock:
        _records[(username, payload.client_id)] = record
    return {"ok": True, "seen_at": record.seen_at}


@router.delete("/presence/{client_id}")
async def delete_presence(client_id: str, request: Request):
    async with _lock:
        _records.pop((_username(request), client_id), None)
    return {"ok": True}


async def list_presence() -> list[dict[str, Any]]:
    cutoff = time.time() - _PRESENCE_TTL_SECONDS
    async with _lock:
        for key, record in list(_records.items()):
            if record.seen_epoch < cutoff:
                del _records[key]
        return [
            {
                "username": record.username,
                "client_id": record.client_id,
                "active_tab_id": record.active_tab_id,
                "tabs": record.tabs,
                "seen_at": record.seen_at,
                "age_seconds": round(max(0, time.time() - record.seen_epoch), 1),
            }
            for record in _records.values()
        ]


PRESENCE_TTL_SECONDS = _PRESENCE_TTL_SECONDS
