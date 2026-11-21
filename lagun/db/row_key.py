"""The columns that identify one row of a table for a grid write.

Lagun edits a row by sending its key values in a WHERE clause. The key must be
unique, or one edit can match several rows. A primary key is the natural choice.
A UNIQUE index also identifies a row, but only when every column in it is NOT
NULL: MySQL and MariaDB allow several NULL rows in a UNIQUE index, so a NULL key
value cannot select one row.

This module owns the selection rule. The schema endpoint serves the result to
the data grid, and the mutation endpoints re-check it against the same rule, so
the client and the server cannot drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

RowKeyKind = Literal["primary", "unique"]

_ROW_KEY_SQL = """
SELECT INDEX_NAME, COLUMN_NAME, NULLABLE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = %s
  AND TABLE_NAME = %s
  AND NON_UNIQUE = 0
ORDER BY INDEX_NAME, SEQ_IN_INDEX
"""


@dataclass(frozen=True)
class RowKey:
    columns: tuple[str, ...]
    kind: RowKeyKind


async def select_row_key(cur, database: str, table: str) -> RowKey | None:
    """The shortest usable unique key, preferring the primary key.

    Returns None when the table has no primary key and no UNIQUE index whose
    columns are all NOT NULL. Functional indexes (COLUMN_NAME is NULL) are
    skipped because a grid cell cannot supply their value.
    """
    await cur.execute(_ROW_KEY_SQL, (database, table))
    indexes: dict[str, list[tuple[str | None, str]]] = {}
    for index_name, column_name, nullable in await cur.fetchall():
        indexes.setdefault(str(index_name), []).append(
            (column_name, str(nullable or ""))
        )

    candidates: list[tuple[int, int, str, RowKey]] = []
    for index_name, columns in indexes.items():
        if any(column is None for column, _ in columns):
            continue
        if any(nullable.upper() == "YES" for _, nullable in columns):
            continue
        names = tuple(str(column) for column, _ in columns)
        is_primary = index_name.upper() == "PRIMARY"
        candidates.append(
            (
                0 if is_primary else 1,
                len(names),
                index_name,
                RowKey(columns=names, kind="primary" if is_primary else "unique"),
            )
        )
    if not candidates:
        return None
    return min(candidates, key=lambda candidate: candidate[:3])[3]
