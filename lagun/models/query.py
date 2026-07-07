"""Pydantic models for query execution."""
from typing import Any, Optional
from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    sql: str
    database: Optional[str] = None
    limit: Optional[int] = Field(None, ge=1, le=100000)  # overrides session default


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    exec_time_ms: float
    error: Optional[str] = None
    affected_rows: Optional[int] = None
    insert_id: Optional[int] = None


class CellUpdateRequest(BaseModel):
    database: str
    table: str
    primary_key: dict[str, Any]   # {col: value} identifying the row
    column: str
    new_value: Any


class CellUpdateResult(BaseModel):
    ok: bool
    affected_rows: int
    sql_executed: str
    error: Optional[str] = None


class RowInsertRequest(BaseModel):
    database: str
    table: str
    values: dict[str, Any]        # {col: value}


class RowInsertResult(BaseModel):
    ok: bool
    insert_id: Optional[int] = None
    affected_rows: int = 0
    sql_executed: str = ""
    error: Optional[str] = None


class RowUpdateRequest(BaseModel):
    database: str
    table: str
    primary_key: dict[str, Any]   # old PK values for WHERE
    updates: dict[str, Any]       # {col: new_value, ...}


class RowUpdateResult(BaseModel):
    ok: bool
    affected_rows: int
    sql_executed: str
    error: Optional[str] = None


class RowDeleteRequest(BaseModel):
    database: str
    table: str
    primary_keys: list[dict[str, Any]]  # list of PK dicts


class RowDeleteResult(BaseModel):
    ok: bool
    affected_rows: int
    sql_executed: str
    error: Optional[str] = None
