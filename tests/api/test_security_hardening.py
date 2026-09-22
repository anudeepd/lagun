"""Regression tests for the request-hardening fixes.

Covers: cross-site write rejection, response security headers, the bulk
row-delete bound, the export statement allowlist and CSV formula neutralisation.
"""

import pytest

import lagun.api.sessions as sessions_api


# ---------------------------------------------------------------------------
# Cross-site write rejection (S-11)
# ---------------------------------------------------------------------------


async def test_cross_origin_write_is_rejected(client):
    r = await client.post(
        "/api/v1/sessions",
        json={"name": "evil", "username": "u"},
        headers={"origin": "http://evil.test"},
    )
    assert r.status_code == 403
    assert "Cross-origin" in r.json()["detail"]


async def test_cross_site_fetch_metadata_is_rejected(client):
    r = await client.post(
        "/api/v1/sessions",
        json={"name": "evil", "username": "u"},
        headers={"sec-fetch-site": "cross-site"},
    )
    assert r.status_code == 403


async def test_same_origin_write_is_allowed(client):
    r = await client.post(
        "/api/v1/sessions",
        json={"name": "same-origin", "username": "u"},
        headers={"origin": "http://test", "sec-fetch-site": "same-origin"},
    )
    assert r.status_code == 201


async def test_proxied_write_with_browser_metadata_is_allowed(client):
    """A proxy that rewrites `Host` must not turn same-origin writes into 403s.

    nginx's default `proxy_set_header Host $proxy_host` makes the app see the
    upstream host while the browser sends its public origin. `Sec-Fetch-Site` is
    browser-set and cannot be forged by page script, so it decides when present.
    """
    r = await client.post(
        "/api/v1/sessions",
        json={"name": "proxied", "username": "u"},
        headers={
            "origin": "https://lagun.example.com",
            "host": "127.0.0.1:8000",
            "sec-fetch-site": "same-origin",
        },
    )
    assert r.status_code == 201


async def test_proxied_write_with_a_forwarded_host_is_allowed(client):
    """Without `Sec-Fetch-Site` (older browsers, non-browser clients) the
    forwarded host is accepted as an alias for the rewritten `Host`."""
    r = await client.post(
        "/api/v1/sessions",
        json={"name": "proxied-forwarded", "username": "u"},
        headers={
            "origin": "https://lagun.example.com",
            "host": "127.0.0.1:8000",
            "x-forwarded-host": "lagun.example.com",
        },
    )
    assert r.status_code == 201


async def test_forwarded_host_does_not_allow_a_different_origin(client):
    """The alias must not become a blanket allow."""
    r = await client.post(
        "/api/v1/sessions",
        json={"name": "evil", "username": "u"},
        headers={
            "origin": "https://evil.test",
            "host": "127.0.0.1:8000",
            "x-forwarded-host": "lagun.example.com",
        },
    )
    assert r.status_code == 403


async def test_request_without_an_origin_header_is_allowed(client):
    """CLI and server-to-server callers send no Origin and must keep working."""
    r = await client.post("/api/v1/sessions", json={"name": "cli", "username": "u"})
    assert r.status_code == 201


# ---------------------------------------------------------------------------
# Response security headers (S-10)
# ---------------------------------------------------------------------------


async def test_security_headers_are_present_and_complete(client):
    r = await client.get("/api/v1/config/server")
    csp = r.headers["content-security-policy"]
    for directive in (
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
    ):
        assert directive in csp, directive
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["x-frame-options"] == "DENY"


# ---------------------------------------------------------------------------
# Bulk row-delete bound (S-6)
# ---------------------------------------------------------------------------


async def test_row_delete_rejects_an_unbounded_key_list(client):
    r = await client.request(
        "DELETE",
        "/api/v1/sessions/any-session/rows",
        json={
            "database": "app_db",
            "table": "users",
            "primary_keys": [{"id": i} for i in range(10_001)],
        },
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Export statement allowlist (S-9)
# ---------------------------------------------------------------------------


async def test_export_rejects_a_non_select_statement(client, session_id):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={"database": "lagun_test", "sql": "DROP TABLE users", "format": "csv"},
    )
    assert r.status_code == 400
    assert "Only SELECT" in r.json()["detail"]


async def test_export_rejects_a_server_side_file_write(client, session_id):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": "lagun_test",
            "sql": "SELECT * FROM users INTO OUTFILE '/tmp/leak'",
            "format": "csv",
        },
    )
    assert r.status_code == 400
    assert "OUTFILE" in r.json()["detail"]


async def test_export_rejects_a_comment_split_file_write(client, session_id):
    """The old blocklist regex was defeated by `INTO/**/OUTFILE`."""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": "lagun_test",
            "sql": "SELECT * FROM users INTO/**/OUTFILE '/tmp/leak'",
            "format": "csv",
        },
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# CSV formula neutralisation (S-8)
# ---------------------------------------------------------------------------


async def test_exported_csv_neutralises_formula_cells(client, session_id, test_db):
    import aiomysql

    from lagun.db.session_store import get_session

    session = await get_session(session_id)
    conn = await aiomysql.connect(
        host=session.host,
        port=session.port,
        user=session.username,
        password="test",
        autocommit=True,
    )
    try:
        async with conn.cursor() as cur:
            await cur.execute(f"USE `{test_db}`")
            await cur.execute(
                "INSERT INTO users (name, age) VALUES (%s, %s), (%s, %s)",
                ("=1+1", 1, "plain", -5),
            )
    finally:
        conn.close()

    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={"database": test_db, "table": "users", "format": "csv"},
    )
    assert r.status_code == 200
    body = r.text
    assert "'=1+1" in body
    assert "-5" in body  # a negative number is a sign, not a formula
    assert "\n=1+1" not in body.replace("\r", "")


# ---------------------------------------------------------------------------
# Probe/test egress controls (S-7)
# ---------------------------------------------------------------------------


async def test_probe_rejects_a_host_outside_the_allowlist(client, monkeypatch):
    monkeypatch.setenv("LAGUN_ALLOWED_DB_HOSTS", "db.internal")
    r = await client.post(
        "/api/v1/sessions/probe",
        json={"host": "127.0.0.1", "port": 3306, "username": "u", "password": "p"},
    )
    assert r.status_code == 403
    assert "not allowed" in r.json()["detail"]


async def test_test_endpoint_rejects_a_host_outside_the_allowlist(
    client, session_id, monkeypatch
):
    monkeypatch.setenv("LAGUN_ALLOWED_DB_HOSTS", "db.internal")
    r = await client.post(f"/api/v1/sessions/{session_id}/test")
    assert r.status_code == 403


async def test_probe_rate_limit_is_per_caller(client, monkeypatch):
    monkeypatch.delenv("LAGUN_ALLOWED_DB_HOSTS", raising=False)
    monkeypatch.setattr(sessions_api, "_PROBE_RATE_LIMIT", 1)
    monkeypatch.setattr(sessions_api, "_probe_windows", {})
    payload = {"host": "127.0.0.1", "port": 1, "username": "u", "password": "p"}

    monkeypatch.setattr(sessions_api, "request_username", lambda request: "alice")
    first = await client.post("/api/v1/sessions/probe", json=payload)
    second = await client.post("/api/v1/sessions/probe", json=payload)
    assert first.status_code == 200
    assert second.status_code == 429

    # A different caller keeps its own budget.
    monkeypatch.setattr(sessions_api, "request_username", lambda request: "bob")
    third = await client.post("/api/v1/sessions/probe", json=payload)
    assert third.status_code == 200


# ---------------------------------------------------------------------------
# Executable comments are real SQL (re-audit follow-up)
# ---------------------------------------------------------------------------


async def test_export_rejects_a_file_write_hidden_in_an_executable_comment(
    client, session_id
):
    """`/*! ... */` bodies are executed by MySQL, so they are not a hiding place."""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": "lagun_test",
            "sql": "SELECT * FROM users /*!50000 INTO OUTFILE '/tmp/leak' */",
            "format": "csv",
        },
    )
    assert r.status_code == 400


async def test_export_rejects_executable_comments_outright(client, session_id):
    r = await client.post(
        f"/api/v1/sessions/{session_id}/export",
        json={
            "database": "lagun_test",
            "sql": "/*!50000 SELECT */ * FROM users",
            "format": "csv",
        },
    )
    assert r.status_code == 400
    assert "executable comment" in r.json()["detail"]


async def test_query_limits_a_select_hidden_in_an_executable_comment(
    client, session_id, test_db
):
    """`/*!50000 SELECT */ * FROM t` is a real SELECT and must be bounded."""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": f"/*!50000 SELECT */ * FROM {test_db}.users", "limit": 1},
    )
    assert r.status_code == 200
    assert r.json()["row_count"] == 1


async def test_query_places_the_limit_before_a_locking_clause(
    client, session_id, test_db
):
    """`SELECT ... FOR UPDATE LIMIT n` is a syntax error; LIMIT must come first."""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": f"SELECT * FROM {test_db}.users FOR UPDATE", "limit": 1},
    )
    assert r.status_code == 200
    assert r.json()["row_count"] == 1


@pytest.mark.parametrize(
    "sql",
    ["DESCRIBE users", "SHOW CREATE TABLE users", "SHOW TABLES"],
)
async def test_query_leaves_statements_whose_grammar_has_no_limit_alone(
    client, session_id, test_db, sql
):
    """Appending LIMIT to these is a 1064; they must run unchanged."""
    r = await client.post(
        f"/api/v1/sessions/{session_id}/query",
        json={"sql": sql, "database": test_db},
    )
    assert r.status_code == 200
    assert r.json().get("error") is None, r.json()


# ---------------------------------------------------------------------------
# Bulk-script cancellation ownership (S-4)
# ---------------------------------------------------------------------------


async def test_bulk_cancel_is_refused_for_a_non_owner(client, monkeypatch):
    import lagun.api.query as query_api

    monkeypatch.setattr(query_api, "_active_script_queries", {"s1": {"exec-1": 4242}})
    monkeypatch.setattr(
        query_api, "_active_script_details", {("s1", "exec-1"): {"username": "alice"}}
    )

    monkeypatch.setattr(query_api, "request_username", lambda request: "bob")
    r = await client.delete("/api/v1/sessions/s1/query/script/exec-1")
    assert r.status_code == 200
    assert r.json() == {"ok": False, "error": "No active large write script"}

    # The owner gets past the ownership check and reaches the session lookup.
    monkeypatch.setattr(query_api, "request_username", lambda request: "alice")
    r2 = await client.delete("/api/v1/sessions/s1/query/script/exec-1")
    assert r2.json()["error"] != "No active large write script"


# ---------------------------------------------------------------------------
# Session test endpoint (S-1 / S-7 follow-up)
# ---------------------------------------------------------------------------


async def test_session_test_filters_databases_and_is_rate_limited(
    client, session_id, monkeypatch
):
    import lagun.api.sessions as sessions_api
    from lagun.models.session import TestResult

    seen = {}

    async def fake_probe(host, port, user, password, ssl_enabled=False):
        seen["called"] = True
        return TestResult(
            ok=True,
            server_version="8.0.0",
            latency_ms=1.0,
            databases=["app_db", "other_db"],
        )

    monkeypatch.setattr(sessions_api, "_probe_connection", fake_probe)
    monkeypatch.delenv("LAGUN_ALLOWED_DB_HOSTS", raising=False)
    monkeypatch.setattr(sessions_api, "_probe_windows", {})
    monkeypatch.setattr(sessions_api, "_PROBE_RATE_LIMIT", 1)

    first = await client.post(f"/api/v1/sessions/{session_id}/test")
    assert first.status_code == 200
    assert seen["called"] is True
    # An unrestricted session keeps the full list.
    assert first.json()["databases"] == ["app_db", "other_db"]

    # The same caller cannot hammer the endpoint (it opens an outbound connection).
    second = await client.post(f"/api/v1/sessions/{session_id}/test")
    assert second.status_code == 429
