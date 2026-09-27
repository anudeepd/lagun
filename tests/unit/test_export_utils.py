import pytest
import time

from lagun.api.export import _resolve_ai_columns, _target_table_label, _target_table_sql


def test_target_table_sql_omits_schema_by_default():
    assert _target_table_sql("my_db", "users") == "`users`"


def test_target_table_sql_includes_schema_when_requested():
    assert _target_table_sql("my_db", "users", include_schema=True) == "`my_db`.`users`"


def test_target_table_sql_escapes_embedded_backticks():
    """The table name is quoted, so a backtick in it cannot end the identifier."""
    assert (
        _target_table_sql("my_db", "we`ird", include_schema=True) == "`my_db`.`we``ird`"
    )


def test_target_table_label_matches_schema_option():
    assert _target_table_label("my_db", "users") == "users"
    assert _target_table_label("my_db", "users", include_schema=True) == "my_db.users"


class _FakeCursor:
    """Records the executed SQL/args; returns preset rows from fetchall."""

    def __init__(self, rows):
        self.rows = rows
        self.sql: str = ""
        self.args: object | None = None
        self.error: BaseException | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, args=None):
        self.sql = sql
        self.args = args
        if self.error is not None:
            raise self.error

    async def fetchall(self):
        return self.rows


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class _FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _FakePool:
    def __init__(self, cursor):
        self._acquire = _FakeAcquire(_FakeConn(cursor))

    def acquire(self):
        return self._acquire


async def test_resolve_ai_columns_returns_matching_columns():
    cursor = _FakeCursor([("id",), ("seq",)])
    pool = _FakePool(cursor)

    result = await _resolve_ai_columns(pool, "mydb", "users", time.monotonic() + 30, 0)

    assert result == {"id", "seq"}
    # SQL targets information_schema.COLUMNS for the exact table/schema. The
    # table's own column list is the filter set, so no IN clause is needed.
    assert "information_schema.COLUMNS" in cursor.sql
    assert "TABLE_SCHEMA=%s" in cursor.sql
    assert "TABLE_NAME=%s" in cursor.sql
    assert cursor.args == ("mydb", "users")


async def test_resolve_ai_columns_returns_empty_set_when_no_ai_columns():
    pool = _FakePool(_FakeCursor([]))

    result = await _resolve_ai_columns(pool, "mydb", "users", time.monotonic() + 30, 0)

    assert result == set()


async def test_resolve_ai_columns_raises_on_lookup_failure(caplog):
    failing = _FakeCursor([])
    failing.error = RuntimeError("boom")
    pool = _FakePool(failing)

    with pytest.raises(RuntimeError, match="boom"):
        await _resolve_ai_columns(pool, "mydb", "users", time.monotonic() + 30, 0)

    assert any(
        "Failed to resolve auto-increment columns for mydb.users; export aborted"
        in record.message
        for record in caplog.records
    )


async def test_resolve_ai_columns_stall_surfaces_export_timeout():
    """A stalled metadata lookup must not hold the pooled connection past deadline."""
    import asyncio

    from lagun.api.export import _ExportTimeout

    class _StalledCursor(_FakeCursor):
        async def execute(self, sql, args=None):
            await asyncio.sleep(30)

    pool = _FakePool(_StalledCursor([]))
    with pytest.raises(_ExportTimeout, match="Export exceeded"):
        await _resolve_ai_columns(pool, "mydb", "users", time.monotonic() + 0.2, 0)


# ---------------------------------------------------------------------------
# Export concurrency bulkhead
# ---------------------------------------------------------------------------


async def test_export_slot_exhaustion_fails_fast_with_503(monkeypatch):
    """All slots pinned (trickling clients) -> next export gets 503, not a hang."""
    import lagun.api.export as export_api
    from fastapi import HTTPException

    monkeypatch.setattr(export_api, "_EXPORT_QUEUE_TIMEOUT_SECONDS", 0.05)
    for _ in range(export_api._EXPORT_MAX_CONCURRENCY):
        await export_api._export_semaphore.acquire()
    try:
        with pytest.raises(HTTPException) as exc_info:
            await export_api._acquire_export_slot()
        assert exc_info.value.status_code == 503
        assert exc_info.value.headers == {"Retry-After": "5"}
    finally:
        for _ in range(export_api._EXPORT_MAX_CONCURRENCY):
            export_api._export_semaphore.release()


async def test_export_stream_response_releases_slot_on_finish_and_on_abort():
    """The response, not the body generator, returns the slot deterministically.

    Starlette sends ``http.response.start`` before pulling the first body chunk,
    so a client that aborts at that point never drives the generator: the release
    cannot depend on generator finalisation.
    """
    import asyncio

    import lagun.api.export as export_api
    from lagun.api.export import _ExportStreamResponse

    max_slots = export_api._EXPORT_MAX_CONCURRENCY
    assert export_api._export_semaphore._value == max_slots

    sent: list[dict] = []

    async def _send(message: dict) -> None:
        sent.append(message)

    # Never reports a disconnect, so the body streams to its end.
    never = asyncio.Event()

    async def _receive() -> dict:
        await never.wait()
        return {"type": "http.disconnect"}  # pragma: no cover

    async def _chunks():
        yield b"a"
        yield b"b"

    # Normal completion: the slot returns when the response is done.
    await export_api._acquire_export_slot()
    response = _ExportStreamResponse(_chunks(), media_type="text/plain")
    await response({"type": "http"}, _receive, _send)
    assert [m["type"] for m in sent] == [
        "http.response.start",
        "http.response.body",
        "http.response.body",
        "http.response.body",
    ]
    assert [m.get("body") for m in sent[1:]] == [b"a", b"b", b""]
    assert export_api._export_semaphore._value == max_slots

    # Abort before the first chunk: __call__ raises and the slot still returns.
    async def _no_chunks():
        raise RuntimeError("client gone")
        yield b""  # pragma: no cover

    await export_api._acquire_export_slot()
    response = _ExportStreamResponse(_no_chunks(), media_type="text/plain")
    with pytest.raises(RuntimeError, match="client gone"):
        await response({"type": "http"}, _receive, _send)
    assert export_api._export_semaphore._value == max_slots


async def test_export_stream_response_appends_failure_marker_for_text_plain():
    """A body that raises after the first chunk is detectable in the body.

    Starlette sends ``http.response.start`` before the body runs, so a
    mid-stream failure cannot become a 4xx. A text/plain export appends a
    ``-- Lagun export FAILED: <message>`` comment as its final chunk, and the
    original exception still propagates so the slot is released and the error
    is logged.
    """
    import asyncio

    import lagun.api.export as export_api
    from lagun.api.export import _EXPORT_FAILURE_MARKER, _ExportStreamResponse

    sent: list[dict] = []

    async def _send(message: dict) -> None:
        sent.append(message)

    never = asyncio.Event()

    async def _receive() -> dict:
        await never.wait()
        return {"type": "http.disconnect"}  # pragma: no cover

    async def _chunks():
        yield b"-- Lagun export: users\n"
        raise RuntimeError("pool blew up")

    await export_api._acquire_export_slot()
    response = _ExportStreamResponse(
        _chunks(), media_type="text/plain", failure_marker=_EXPORT_FAILURE_MARKER
    )
    with pytest.raises(RuntimeError, match="pool blew up"):
        await response({"type": "http"}, _receive, _send)

    assert [m["type"] for m in sent] == [
        "http.response.start",
        "http.response.body",
        "http.response.body",
    ]
    assert sent[1]["body"] == b"-- Lagun export: users\n"
    assert sent[2]["body"] == b"-- Lagun export FAILED: pool blew up\n"
    assert sent[2]["more_body"] is False
    assert export_api._export_semaphore._value == export_api._EXPORT_MAX_CONCURRENCY


async def test_export_stream_response_omits_failure_marker_for_csv():
    """CSV has no comment syntax, so a failed CSV body carries no marker."""
    import asyncio

    import lagun.api.export as export_api
    from lagun.api.export import _ExportStreamResponse

    sent: list[dict] = []

    async def _send(message: dict) -> None:
        sent.append(message)

    never = asyncio.Event()

    async def _receive() -> dict:
        await never.wait()
        return {"type": "http.disconnect"}  # pragma: no cover

    async def _chunks():
        yield b'"id"\r\n'
        raise RuntimeError("pool blew up")

    await export_api._acquire_export_slot()
    response = _ExportStreamResponse(
        _chunks(), media_type="text/csv", failure_marker=None
    )
    with pytest.raises(RuntimeError, match="pool blew up"):
        await response({"type": "http"}, _receive, _send)

    assert [m["type"] for m in sent] == [
        "http.response.start",
        "http.response.body",
    ]
    assert sent[1]["body"] == b'"id"\r\n'
    assert export_api._export_semaphore._value == export_api._EXPORT_MAX_CONCURRENCY


# ---------------------------------------------------------------------------
# CSV formula neutralisation (S-8)
# ---------------------------------------------------------------------------


def test_formula_prefixes_are_neutralised():
    from lagun.api.export import _csv_neutralize

    for value in ("=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tpayload", "\rpayload"):
        assert _csv_neutralize(value) == "'" + value, value


def test_numeric_values_keep_their_meaning():
    """A leading - or + on a number is a sign, not a formula trigger."""
    from lagun.api.export import _csv_neutralize

    for value in ("-5", "+1.5", "-1e6", "-0.5", "+2.0E-3"):
        assert _csv_neutralize(value) == value, value


def test_ordinary_and_empty_values_are_untouched():
    from lagun.api.export import _csv_neutralize

    for value in ("", "hello", "C:\\Users", "a=b"):
        assert _csv_neutralize(value) == value, value


def test_csv_cell_renders_null_as_empty_and_neutralises_the_rest():
    from lagun.api.export import _csv_cell

    assert _csv_cell(None) == ""
    assert _csv_cell("=1+1") == "'=1+1"
    assert _csv_cell(-5) == "-5"


async def test_export_failure_before_the_stream_does_not_hold_a_slot(monkeypatch):
    """A slot is released if the request dies before the body is streamed.

    The wrapper that returns the slot runs only while the response is streamed,
    so acquiring any earlier would leak it permanently on a failure path.
    """
    import lagun.api.export as export_api
    from lagun.api.export import ExportRequest

    class _Session:
        managed = False
        selected_databases: list[str] = []
        managed_selected_databases: list[str] = []

    async def _fake_get_session(_session_id):
        return _Session()

    async def _unavailable_pool(_session_id):
        raise RuntimeError("pool unavailable")

    monkeypatch.setattr(export_api, "get_session", _fake_get_session)
    monkeypatch.setattr(export_api, "get_pool", _unavailable_pool)

    slots = export_api._export_semaphore._value
    with pytest.raises(RuntimeError, match="pool unavailable"):
        await export_api._export_response(
            "session-id", ExportRequest(database="db", table="t", format="csv")
        )
    assert export_api._export_semaphore._value == slots
