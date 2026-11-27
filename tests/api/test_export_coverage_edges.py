from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from lagun.api import export as export_api


async def test_download_export_rejects_invalid_form_config(client):
    response = await client.post(
        "/api/v1/sessions/missing/export/download",
        data={"config": "{"},
    )
    assert response.status_code == 422


async def test_export_rejects_table_and_sql_together(client, session_id, test_db):
    response = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "sql": "SELECT 1",
            "format": "csv",
        },
    )
    assert response.status_code == 400
    assert "not both" in response.json()["detail"]


@pytest.mark.parametrize(
    ("sql", "detail"),
    [
        ("SELECT 'unterminated", "Invalid export query"),
        ("SELECT SLEEP(10)", "disallowed functions"),
    ],
)
async def test_export_rejects_invalid_select_sql(
    client, session_id, test_db, sql, detail
):
    response = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={"database": test_db, "sql": sql, "format": "csv"},
    )
    assert response.status_code == 400
    assert detail in response.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    [
        {"format": "insert", "insert_mode": "single"},
        {"format": "insert", "insert_mode": "batch"},
        {"format": "delete", "insert_mode": "batch"},
        {"format": "delete+insert", "insert_mode": "single"},
        {"format": "delete+insert", "insert_mode": "batch"},
        {"format": "csv"},
    ],
)
async def test_streamed_exports_flush_at_the_chunk_threshold(
    client, session_id, test_db, monkeypatch, payload
):
    monkeypatch.setattr(export_api, "_EXPORT_STREAM_CHARS", 1)
    response = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={"database": test_db, "table": "users", **payload},
    )

    assert response.status_code == 200
    if payload["format"] != "delete":
        assert "Alice" in response.text
        assert "Bob" in response.text
    else:
        assert "DELETE FROM" in response.text
    if payload["format"] != "csv":
        assert response.text.endswith("-- Lagun export complete: 2 rows\n")


async def test_csv_export_supports_no_quotes_and_ascii(client, session_id, test_db):
    response = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": test_db,
            "table": "users",
            "format": "csv",
            "csv_quotechar": "",
            "csv_escapechar": "\\",
            "csv_encoding": "ascii",
        },
    )

    assert response.status_code == 200
    assert "Alice" in response.text
    assert response.content[:1] != b"\xef"


async def test_scoped_export_allows_metadata_schema_references(monkeypatch):
    scoped = SimpleNamespace(
        managed=True,
        selected_databases=["app"],
        managed_selected_databases=["app"],
    )

    async def session(_session_id):
        return scoped

    async def pool(_session_id):
        return object()

    monkeypatch.setattr(export_api, "get_session", session)
    monkeypatch.setattr(export_api, "get_pool", pool)
    request = export_api.ExportRequest(
        database="app",
        sql="SELECT * FROM information_schema.TABLES",
        format="csv",
    )

    try:
        response = await export_api._export_response("session", request)
    finally:
        export_api._export_semaphore.release()

    assert response.media_type.startswith("text/csv")


async def test_export_rejects_an_unknown_runtime_format(monkeypatch):
    session = SimpleNamespace(
        managed=False,
        selected_databases=[],
        managed_selected_databases=[],
    )

    async def get_session(_session_id):
        return session

    async def get_pool(_session_id):
        return object()

    monkeypatch.setattr(export_api, "get_session", get_session)
    monkeypatch.setattr(export_api, "get_pool", get_pool)
    request = export_api.ExportRequest.model_construct(
        database="app", table="users", format="unknown"
    )

    with pytest.raises(HTTPException, match="Unknown format"):
        await export_api._export_response("session", request)
