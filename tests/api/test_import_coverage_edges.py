import csv
import io
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from lagun.api import import_data


@pytest.mark.parametrize(
    "config",
    [
        {"database": "db", "table": "t", "delimiter": "ab"},
        {"database": "db", "table": "t", "delimiter": ""},
        {"database": "db"},
        {"database": "db", "table": "t", "escapechar": ","},
    ],
)
def test_import_config_rejects_invalid_csv_options(config):
    with pytest.raises(ValidationError):
        import_data.ImportConfig(**config)


def test_csv_reader_kwargs_cover_custom_and_disabled_quoting():
    custom = import_data.ImportConfig(
        database="db", table="t", quotechar='"', escapechar="\\"
    )
    assert import_data._csv_reader_kwargs(custom)["escapechar"] == "\\"

    unquoted = import_data.ImportConfig(
        database="db", table="t", quotechar="", escapechar=""
    )
    kwargs = import_data._csv_reader_kwargs(unquoted)
    assert kwargs["quoting"] == csv.QUOTE_NONE
    assert kwargs["escapechar"] == "\\"


async def test_open_upload_measures_an_upload_without_a_known_size():
    class Upload:
        size = None

        def __init__(self):
            self.file = io.BytesIO(b"abc")

        async def seek(self, position):
            self.file.seek(position)

    uploaded = Upload()
    staged, total = await import_data._open_upload(uploaded)

    assert total == 3
    assert staged.tell() == 0


def test_open_text_rejects_an_unknown_encoding():
    with pytest.raises(HTTPException, match="Unknown encoding"):
        import_data._open_text(io.BytesIO(b"a"), "not-an-encoding")


def test_preview_csv_rejects_undecodable_bytes():
    config = import_data.ImportConfig(database="db", table="t", encoding="utf-8")

    with pytest.raises(HTTPException, match="Cannot decode"):
        import_data._preview_csv(io.BytesIO(b"name\n\xff\n"), config)


def test_preview_csv_reads_more_than_ten_rows_without_stopping_early():
    config = import_data.ImportConfig(database="db", table="t")
    body = ("a,b\n" + "\n".join(f"{index},{index}" for index in range(12))).encode()

    preview = import_data._preview_csv(io.BytesIO(body), config)

    assert len(preview.rows) == 10
    assert preview.total_lines_sampled == 10


def test_preview_csv_reports_parser_errors(monkeypatch):
    class BrokenReader:
        def __next__(self):
            raise csv.Error("bad csv")

    monkeypatch.setattr(
        import_data.csv, "reader", lambda *_args, **_kwargs: BrokenReader()
    )
    config = import_data.ImportConfig(database="db", table="t")

    with pytest.raises(HTTPException, match="CSV parse error"):
        import_data._preview_csv(io.BytesIO(b"name\nAlice\n"), config)


def test_column_validation_rejects_empty_and_duplicate_headers():
    with pytest.raises(HTTPException, match="must not be empty"):
        import_data._validate_columns([])
    with pytest.raises(HTTPException, match="must not be empty"):
        import_data._validate_columns(["id", " "])
    with pytest.raises(HTTPException, match="must be unique"):
        import_data._validate_columns(["id", "id"])


def test_csv_batch_reader_handles_pending_rows_and_size_limits():
    rows, pending, eof = import_data._read_csv_batch(
        iter([["b"]]), ["a"], max_rows=10, max_bytes=100
    )
    assert rows == [["a"], ["b"]]
    assert pending is None
    assert eof is True

    rows, pending, eof = import_data._read_csv_batch(
        iter([["a"], ["b"]]), None, max_rows=10, max_bytes=3
    )
    assert rows == [["a"]]
    assert pending == ["b"]
    assert eof is False

    with pytest.raises(import_data.CsvImportError, match="batch limit"):
        import_data._read_csv_batch(iter([["a"]]), None, max_rows=10, max_bytes=1)


async def test_import_warning_capture_is_bounded():
    cursor = object.__new__(import_data._ImportCursor)
    cursor.import_warnings = []
    cursor._result = SimpleNamespace(has_next=True)

    class Connection:
        async def show_warnings(self):
            raise AssertionError("warnings must not be read for a pending result")

    await cursor._show_warnings(Connection())
    assert cursor.import_warnings == []

    cursor._result = None

    class WarningsConnection:
        async def show_warnings(self):
            return [("Warning", index, "message") for index in range(102)]

    await cursor._show_warnings(WarningsConnection())

    assert len(cursor.import_warnings) == 101
    assert cursor.import_warnings[-1] == "Additional MySQL warnings omitted."


async def test_batch_import_reports_first_row_parse_and_decode_errors(monkeypatch):
    config = import_data.ImportConfig(database="db", table="t")
    with pytest.raises(HTTPException, match="File is empty"):
        await import_data._batch_insert(object(), config, io.BytesIO(b""))

    class BrokenReader:
        def __next__(self):
            raise csv.Error("bad csv")

    monkeypatch.setattr(
        import_data.csv, "reader", lambda *_args, **_kwargs: BrokenReader()
    )
    with pytest.raises(HTTPException, match="CSV parse error"):
        await import_data._batch_insert(object(), config, io.BytesIO(b"name\nAlice\n"))

    monkeypatch.undo()
    with pytest.raises(HTTPException, match="Cannot decode"):
        await import_data._batch_insert(object(), config, io.BytesIO(b"name\n\xff\n"))


async def test_preview_dump_bounds_ten_statements_and_reports_parse_errors():
    config = import_data.ImportConfig(database="db", format="mysql_dump")
    body = "".join(f"SELECT {index};\n" for index in range(12)).encode()

    preview = await import_data._preview_dump(io.BytesIO(body), config)
    assert len(preview.statements) == 10

    with pytest.raises(HTTPException, match="Cannot decode"):
        await import_data._preview_dump(io.BytesIO(b"SELECT '\xff';\n"), config)

    with pytest.raises(HTTPException, match="SQL parse error"):
        await import_data._preview_dump(io.BytesIO(b"SELECT 'unterminated"), config)


async def test_batch_import_stops_when_its_deadline_expires(monkeypatch):
    class Cursor:
        import_warnings = []
        rowcount = 1

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def execute(self, _sql):
            return None

        async def executemany(self, _sql, _params):
            return None

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def cursor(self, _cursor_class=None):
            return Cursor()

    class Pool:
        def acquire(self):
            return Connection()

    monkeypatch.setattr(import_data, "IMPORT_MAX_RUNTIME_SECONDS", 0)
    config = import_data.ImportConfig(database="db", table="t")

    result = await import_data._batch_insert(
        Pool(), config, io.BytesIO(b"name\nAlice\n")
    )

    assert result.ok is False
    assert "Import exceeded" in result.error


class DumpCursor:
    def __init__(self, *, fail_execute=False, fail_rollback=False):
        self.fail_execute = fail_execute
        self.fail_rollback = fail_rollback
        self.statements = []
        self.rowcount = 2

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def execute(self, statement):
        self.statements.append(statement)
        if statement == "ROLLBACK" and self.fail_rollback:
            raise RuntimeError("rollback unavailable")
        if "THIS IS INVALID" in statement and self.fail_execute:
            raise RuntimeError("syntax error")


class DumpConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def cursor(self):
        return self._cursor

    def close(self):
        self.closed = True


class DumpPool:
    def __init__(self, cursor):
        self.connection = DumpConnection(cursor)

    def acquire(self):
        return self.connection


def _dump_config():
    return import_data.ImportConfig(database="app", format="mysql_dump")


async def test_dump_import_counts_affected_rows():
    cursor = DumpCursor()

    result = await import_data._mysql_dump_import(
        DumpPool(cursor),
        _dump_config(),
        io.BytesIO(b"INSERT INTO app.t VALUES (1);\n"),
        None,
    )

    assert result.ok is True
    assert result.rows_imported == 2


async def test_dump_import_tolerates_statements_without_an_affected_row_count():
    cursor = DumpCursor()
    cursor.rowcount = None

    result = await import_data._mysql_dump_import(
        DumpPool(cursor),
        _dump_config(),
        io.BytesIO(b"SELECT 1;\n"),
        None,
    )

    assert result.ok is True
    assert result.rows_imported == 0


async def test_dump_import_reports_scope_and_dynamic_sql_errors():
    out_of_scope = await import_data._mysql_dump_import(
        DumpPool(DumpCursor()),
        _dump_config(),
        io.BytesIO(b"USE other_db;\n"),
        frozenset({"app"}),
    )
    assert out_of_scope.ok is False
    assert "outside this connection's allowed databases" in out_of_scope.error
    assert out_of_scope.error_line == 1

    dynamic = await import_data._mysql_dump_import(
        DumpPool(DumpCursor()),
        _dump_config(),
        io.BytesIO(b"CALL proc();\n"),
        frozenset({"app"}),
    )
    assert dynamic.ok is False
    assert "dynamic SQL" in dynamic.error


async def test_dump_import_reports_deadline_and_rollback_failures(monkeypatch):
    monkeypatch.setattr(import_data, "IMPORT_MAX_RUNTIME_SECONDS", 0)
    expired = await import_data._mysql_dump_import(
        DumpPool(DumpCursor()),
        _dump_config(),
        io.BytesIO(b"SELECT 1;\n"),
        None,
    )
    assert expired.ok is False
    assert "Import exceeded" in expired.error

    monkeypatch.setattr(import_data, "IMPORT_MAX_RUNTIME_SECONDS", 900)
    failed = await import_data._mysql_dump_import(
        DumpPool(DumpCursor(fail_execute=True, fail_rollback=True)),
        _dump_config(),
        io.BytesIO(b"THIS IS INVALID;\n"),
        None,
    )
    assert failed.ok is False
    assert "syntax error" in failed.error


async def test_import_route_rejects_an_unknown_session(client):
    response = await client.post(
        "/api/v1/sessions/missing/import",
        files={"file": ("data.csv", b"name\nAlice\n", "text/csv")},
        data={"config": '{"database":"db","table":"t"}'},
    )
    assert response.status_code == 404


async def test_import_rejects_an_empty_file(client, session_id, test_db):
    response = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", b"", "text/csv")},
        data={"config": '{"database":"lagun_test","table":"users"}'},
    )
    assert response.status_code == 400


async def test_import_without_a_header_uses_the_table_columns(
    client, session_id, test_db
):
    response = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", b"10,Carol,42\n", "text/csv")},
        data={
            "config": (
                '{"database":"lagun_test","table":"users","first_row_header":false}'
            )
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["rows_processed"] == 1


async def test_import_without_a_header_reports_a_missing_table(
    client, session_id, test_db
):
    response = await client.post(
        f"/api/v1/sessions/{session_id}/import",
        files={"file": ("data.csv", b"1,Carol\n", "text/csv")},
        data={
            "config": (
                '{"database":"lagun_test","table":"missing_table",'
                '"first_row_header":false}'
            )
        },
    )

    assert response.status_code == 400
    assert "not found or has no columns" in response.json()["detail"]
