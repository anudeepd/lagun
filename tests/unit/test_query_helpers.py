"""Focused regression tests for row-write helpers and remaining-deadline paths.

Covers: binary text preservation (only 0x-prefixed text decodes),
pooled-connection discard on row-write timeouts, and the remaining-deadline
wrappers for export/import batch loops (mocked, no database required).
"""

import asyncio
import time

from lagun.api import query as query_api
from lagun.api.export import (
    _ExportTimeout,
    _await_with_remaining_deadline,
    _export_timeout,
    _next_batch,
)
from lagun.api.import_data import (
    ImportTimeout,
    _await_with_remaining_import_deadline,
    _import_timeout,
)


def test_coerce_binary_preserves_plain_text():
    """Only 0x-prefixed text decodes to bytes for binary columns."""
    assert query_api._coerce_binary_value("hello", "varbinary") == "hello"
    assert query_api._coerce_binary_value("6162", "varbinary") == "6162"
    assert query_api._coerce_binary_value("0x6162", "varbinary") == b"ab"
    assert query_api._coerce_binary_value("0xZZ", "varbinary") == "0xZZ"
    assert query_api._coerce_binary_value("hello", "varchar") == "hello"
    assert query_api._coerce_binary_value(None, "varbinary") is None


def test_discard_lease_connection_closes_and_never_raises():
    closed = []

    class _Conn:
        def close(self):
            closed.append(True)

    query_api._discard_lease_connection(_Conn())
    assert closed == [True]

    class _BadConn:
        def close(self):
            raise RuntimeError("already closed")

    query_api._discard_lease_connection(_BadConn())


async def test_cell_update_timeout_discards_the_leased_connection(monkeypatch):
    """A timed-out row write closes the leased connection before propagating."""

    class _Cursor:
        def __init__(self, conn):
            self._conn = conn
            self.calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def execute(self, sql, params=None):
            self.calls += 1
            if self.calls == 1:
                return None  # metadata lookup for _column_data_types
            raise TimeoutError("stalled")

        async def fetchall(self):
            return [("age", "int")]

    class _Conn:
        def __init__(self):
            self.closed = False
            self.cursor_calls = 0

        def cursor(self):
            self.cursor_calls += 1
            return _Cursor(self)

        def close(self):
            self.closed = True

    class _Lease:
        def __init__(self, conn):
            self._conn = conn

        async def __aenter__(self):
            return self._conn

        async def __aexit__(self, *args):
            return False

    class _Pool:
        def __init__(self):
            self.conn = _Conn()

        def acquire(self):
            return _Lease(self.conn)

    pool = _Pool()
    session = type("S", (), {"selected_databases": [], "managed": False})()

    async def fake_pool_or_404(session_id):
        return pool, session

    monkeypatch.setattr(query_api, "_get_pool_or_404", fake_pool_or_404)
    monkeypatch.setattr(query_api, "_QUERY_MAX_RUNTIME_SECONDS", 5.0)

    req = (
        query_api.CellUpdateRequest(
            database="lagun_test",
            table="users",
            column="age",
            new_value=31,
            primary_key={"id": 1},
        )
        if hasattr(query_api, "CellUpdateRequest")
        else None
    )
    if req is None:
        from lagun.models.query import CellUpdateRequest as _Req

        req = _Req(
            database="lagun_test",
            table="users",
            column="age",
            new_value=31,
            primary_key={"id": 1},
        )
    result = await query_api.cell_update("sid", req)
    assert result.ok is False
    assert pool.conn.closed is True


async def test_export_remaining_deadline_fails_fast_with_export_taxonomy():
    """A stalled export await cannot exceed the remaining runtime."""
    deadline = time.monotonic() - 1  # already expired: floor of 0.1s applies

    async def stalled():
        await asyncio.sleep(30)
        return "never"

    try:
        await _await_with_remaining_deadline(stalled(), deadline, _export_timeout(7))
    except _ExportTimeout as exc:
        assert "7 rows" in str(exc)
    else:  # pragma: no cover - must time out
        raise AssertionError("stalled export await was not bounded")


async def test_export_next_batch_bounds_a_stalled_fetchmany():
    class _Cur:
        async def fetchmany(self, n):
            await asyncio.sleep(30)
            return []

    deadline = time.monotonic() - 1
    try:
        await _next_batch(_Cur(), 100, deadline, 3)
    except _ExportTimeout as exc:
        assert "3 rows" in str(exc)
    else:  # pragma: no cover - must time out
        raise AssertionError("stalled fetchmany was not bounded")


async def test_import_remaining_deadline_preserves_taxonomy_and_counts():
    """A stalled import await surfaces as ImportTimeout, not TimeoutError."""
    deadline = time.monotonic() - 1

    async def stalled():
        await asyncio.sleep(30)
        return "never"

    try:
        await _await_with_remaining_import_deadline(stalled(), deadline, 12)
    except ImportTimeout as exc:
        assert "12 rows" in str(exc)
    else:  # pragma: no cover - must time out
        raise AssertionError("stalled import await was not bounded")
    assert isinstance(_import_timeout(5, "statements"), ImportTimeout)
