"""Pydantic models for query execution."""
from typing import Any, Literal, Optional
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


class ScriptQueryRequest(BaseModel):
    execution_id: str
    database: Optional[str] = None
    sql: Optional[str] = None
    statements: Optional[list[str]] = None
    mode: Literal["transaction"] = "transaction"


class ScriptQueryError(BaseModel):
    code: str
    problem: str
    cause: str
    fix: str
    docs_url: str


class ScriptQueryResult(BaseModel):
    ok: bool
    execution_id: str
    statements_executed: int
    affected_rows: int
    exec_time_ms: float
    failed_statement_index: Optional[int] = None
    failed_statement_preview: Optional[str] = None
    rolled_back: bool = False
    error: Optional[ScriptQueryError] = None


class ScriptQueryValidationResult(BaseModel):
    ok: bool
    statement_count: int
    operation_counts: dict[str, int]
    rejected_statement_index: Optional[int] = None
    rejected_statement_preview: Optional[str] = None
    error: Optional[ScriptQueryError] = None


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
