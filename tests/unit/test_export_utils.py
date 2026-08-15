import pytest

from lagun.api.export import _resolve_ai_columns, _target_table_label, _target_table_sql


def test_target_table_sql_omits_schema_by_default():
    assert _target_table_sql("my_db", "users") == "`users`"


def test_target_table_sql_includes_schema_when_requested():
    assert _target_table_sql("my_db", "users", include_schema=True) == "`my_db`.`users`"


def test_target_table_sql_rejects_invalid_identifiers():
    with pytest.raises(ValueError):
        _target_table_sql("my_db", "we`ird", include_schema=True)


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

    result = await _resolve_ai_columns(pool, "mydb", "users", ["id", "name", "seq"])

    assert result == {"id", "seq"}
    # SQL targets information_schema.COLUMNS for the exact table/schema and
    # restricts to the requested columns via an IN clause.
    assert "information_schema.COLUMNS" in cursor.sql
    assert "TABLE_SCHEMA=%s" in cursor.sql
    assert "TABLE_NAME=%s" in cursor.sql
    assert cursor.args == ("mydb", "users", "id", "name", "seq")


async def test_resolve_ai_columns_returns_empty_set_when_no_ai_columns():
    pool = _FakePool(_FakeCursor([]))

    result = await _resolve_ai_columns(pool, "mydb", "users", ["id"])

    assert result == set()


async def test_resolve_ai_columns_raises_on_lookup_failure(caplog):
    failing = _FakeCursor([])
    failing.error = RuntimeError("boom")
    pool = _FakePool(failing)

    with pytest.raises(RuntimeError, match="boom"):
        await _resolve_ai_columns(pool, "mydb", "users", ["id"])

    assert any(
        "Failed to resolve auto-increment columns for mydb.users; export aborted"
        in record.message
        for record in caplog.records
    )
