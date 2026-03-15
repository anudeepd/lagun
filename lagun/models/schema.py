"""Pydantic models for schema introspection."""
from typing import Optional
from pydantic import BaseModel


class ColumnInfo(BaseModel):
    name: str
    data_type: str
    column_type: str
    is_nullable: bool
    column_default: Optional[str]
    is_primary_key: bool
    is_auto_increment: bool
    extra: str
    comment: str


class IndexInfo(BaseModel):
    name: str
    columns: list[str]
    is_unique: bool
    index_type: str


class TableInfo(BaseModel):
    name: str
    table_type: str          # BASE TABLE | VIEW
    engine: Optional[str]
    row_count: Optional[int]
    data_length: Optional[int]
    comment: str


class ColumnDef(BaseModel):
    name: str
    type: str
    nullable: bool = True
    auto_increment: bool = False
    primary_key: bool = False
    default: Optional[str] = None
    comment: Optional[str] = None


class CreateTableRequest(BaseModel):
    name: str
    columns: list[ColumnDef]
    engine: str = "InnoDB"
    charset: str = "utf8mb4"
    collation: str = "utf8mb4_unicode_ci"


class CreateIndexRequest(BaseModel):
    name: str
    columns: list[str]
    unique: bool = False
    index_type: str = "BTREE"


class SetPrimaryKeyRequest(BaseModel):
    columns: list[str]


class AddColumnRequest(BaseModel):
    name: str
    type: str
    nullable: bool = True
    default: Optional[str] = None
    comment: Optional[str] = None


class ModifyColumnRequest(BaseModel):
    name: Optional[str] = None
    type: str  # required — the current column type must always be provided
    nullable: Optional[bool] = None
    default: Optional[str] = None
    comment: Optional[str] = None
