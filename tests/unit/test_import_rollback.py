"""The CSV batch import's abort path.

A rollback that fails or times out leaves the transaction open, and the
`SET autocommit=1` that used to follow ran unconditionally — implicitly
COMMITting the partial batch while the response reported `rows_imported=0`.
"""

import io

from lagun.api import import_data
from lagun.api.import_data import _batch_insert


class _Cursor:
    def __init__(self, *, fail_rollback: bool):
        self.fail_rollback = fail_rollback
        self.statements: list[str] = []
        self.rowcount = 0

    async def execute(self, sql, args=None):
        self.statements.append(sql)
        if sql.startswith("ROLLBACK") and self.fail_rollback:
            raise RuntimeError("rollback failed")
        return None

    async def executemany(self, sql, params):
        self.statements.append(sql)
        raise RuntimeError("insert failed")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Conn:
    def __init__(self, cursor: _Cursor):
        self._cursor = cursor
        self.closed = False

    def cursor(self):
        return self._cursor

    def close(self):
        self.closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Pool:
    def __init__(self, conn: _Conn):
        self._conn = conn

    def acquire(self):
        return self._conn


def _config():
    return import_data.ImportConfig(
        database="app_db",
        table="t",
        format="csv",
        first_row_header=True,
        strategy="insert",
    )


async def test_a_failed_rollback_discards_the_connection_instead_of_committing():
    cursor = _Cursor(fail_rollback=True)
    conn = _Conn(cursor)

    result = await _batch_insert(_Pool(conn), _config(), io.BytesIO(b"a,b\n1,2\n"))

    assert result.ok is False
    assert result.rows_imported == 0
    # The connection is dropped rather than returned with an open transaction…
    assert conn.closed is True
    # …and nothing runs on it afterwards: `SET autocommit=1` would commit the
    # partial batch the rollback just failed to undo.
    assert not [s for s in cursor.statements if "autocommit=1" in s]


async def test_a_successful_rollback_restores_the_session_default():
    cursor = _Cursor(fail_rollback=False)
    conn = _Conn(cursor)

    result = await _batch_insert(_Pool(conn), _config(), io.BytesIO(b"a,b\n1,2\n"))

    assert result.ok is False
    assert conn.closed is False
    assert "ROLLBACK" in cursor.statements
    assert "SET autocommit=1" in cursor.statements
