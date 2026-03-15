"""Pydantic models for sessions."""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class SessionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    host: str = Field(default="localhost")
    port: int = Field(default=3306, ge=1, le=65535)
    username: str = Field(..., min_length=1)
    password: str = Field(default="")
    default_db: Optional[str] = None
    query_limit: int = Field(default=100, ge=1, le=100000)
    ssl_enabled: bool = False
    selected_databases: list[str] = Field(default_factory=list)


class SessionUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    host: Optional[str] = None
    port: Optional[int] = Field(None, ge=1, le=65535)
    username: Optional[str] = Field(None, min_length=1)
    password: Optional[str] = None
    default_db: Optional[str] = None
    query_limit: Optional[int] = Field(None, ge=1, le=100000)
    ssl_enabled: Optional[bool] = None
    selected_databases: Optional[list[str]] = None


class SessionRead(BaseModel):
    id: str
    name: str
    host: str
    port: int
    username: str
    default_db: Optional[str]
    query_limit: int
    ssl_enabled: bool
    selected_databases: list[str]
    created_at: datetime
    updated_at: datetime
    # password_enc is intentionally omitted


class TestResult(BaseModel):
    ok: bool
    server_version: Optional[str] = None
    latency_ms: Optional[float] = None
    databases: list[str] = Field(default_factory=list)
    error: Optional[str] = None


class ProbeRequest(BaseModel):
    host: str = Field(default="localhost")
    port: int = Field(default=3306, ge=1, le=65535)
    username: str
    password: str = Field(default="")
    ssl_enabled: bool = False
