import datetime

import pytest
from pydantic import ValidationError

from lagun.api import export as export_api


def test_export_csv_cell_and_where_helpers():
    assert export_api._csv_cell(None) == ""
    assert export_api._csv_cell(b"\x00\xff") == "0x00ff"
    assert export_api._csv_cell(memoryview(b"ab")) == "0x6162"
    assert export_api._csv_cell(datetime.timedelta(seconds=1)) == "00:00:01"
    assert export_api._csv_cell("=cmd") == "'=cmd"
    assert export_api._where_clause(["a"], (1,), ["missing"]) == ""
    assert export_api._where_clause(["a"], (None,), ["a"]) == "`a` IS NULL"


@pytest.mark.parametrize(
    "payload",
    [
        {"database": "db", "csv_delimiter": ",,"},
        {"database": "db", "csv_delimiter": ""},
        {"database": "db", "csv_lineterminator": "bad"},
        {"database": "db", "csv_delimiter": ",", "csv_quotechar": ","},
        {"database": "db", "csv_delimiter": ",", "csv_escapechar": ","},
        {"database": "db", "sql": "SELECT 1", "format": "delete"},
        {"database": "db", "format": "delete", "pk_values": [{"id": 1}]},
        {"database": "db", "table": "t", "format": "delete", "pk_values": []},
        {
            "database": "db",
            "table": "t",
            "format": "delete",
            "pk_values": [{}],
        },
        {
            "database": "db",
            "table": "t",
            "format": "delete",
            "pk_values": [{"id": 1}] * 10_001,
        },
        {
            "database": "db",
            "table": "t",
            "format": "delete",
            "pk_values": [{f"c{i}": 1 for i in range(50_001)}],
        },
        {"database": "db", "table": "t", "format": "delete", "pk_values": [{"": 1}]},
    ],
)
def test_export_request_validators_reject_bad_input(payload):
    with pytest.raises(ValidationError):
        export_api.ExportRequest(**payload)


def test_export_request_accepts_the_valid_extremes():
    req = export_api.ExportRequest(
        database="db",
        table="t",
        format="delete+insert",
        insert_mode="batch",
        pk_values=[{"id": 1}],
        csv_delimiter="\t",
        csv_quotechar="",
        csv_escapechar="\\",
        csv_lineterminator="\n",
        csv_encoding="ascii",
    )
    assert req.pk_values == [{"id": 1}]


@pytest.mark.asyncio
async def test_export_stream_response_ignores_a_failed_failure_marker_send():
    async def body():
        yield b"body"
        raise RuntimeError("stream failed")

    async def receive():
        return {"type": "http.disconnect"}

    sent = []
    body_sends = 0

    async def send(message):
        nonlocal body_sends
        sent.append(message)
        if message["type"] == "http.response.body":
            body_sends += 1
            if body_sends == 2:
                raise OSError("client gone")

    await export_api._export_semaphore.acquire()
    response = export_api._ExportStreamResponse(
        body(),
        media_type="text/plain",
        failure_marker=export_api._EXPORT_FAILURE_MARKER,
    )
    with pytest.raises(RuntimeError, match="stream failed"):
        await response(
            {"type": "http", "method": "GET", "path": "/"},
            receive,
            send,
        )
    body_messages = [
        message for message in sent if message["type"] == "http.response.body"
    ]
    assert body_messages[0]["body"] == b"body"
    assert body_messages[1]["body"] == b"-- Lagun export FAILED: stream failed\n"
    assert not export_api._export_semaphore.locked()
