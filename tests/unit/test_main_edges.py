from types import SimpleNamespace

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse

import lagun.main as main_module
from lagun.api import import_data


def request(method="GET", path="/api/v1/sessions", headers=None, query=""):
    raw_headers = [
        (name.lower().encode(), value.encode()) for name, value in (headers or {}).items()
    ]
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "query_string": query.encode(),
            "headers": raw_headers,
            "scheme": "http",
            "server": ("test", 80),
            "client": ("127.0.0.1", 1234),
        }
    )


async def passthrough(_request):
    return JSONResponse({"ok": True})


def test_audit_helpers_cover_unparseable_truncated_and_secret_values(monkeypatch):
    monkeypatch.setattr(main_module, "_AUDIT_MAX_DETAILS_CHARS", 5)
    assert main_module._audit_details(b"") is None
    assert main_module._audit_details(b"not json").startswith("[unpa")
    assert "[truncated]" in main_module._audit_details(b"not json")
    redacted = main_module._audit_details(
        b'{"password":"secret","auth":{"token":"x"}}'
    )
    assert "secret" not in redacted
    assert "[truncated]" in redacted
    assert main_module._audit_target(request(query="a=1&b=2")) == (
        "/api/v1/sessions?a=1&b=2"
    )


def test_should_audit_request_and_safe_request_id():
    assert main_module._should_audit_request(request(), None) is False
    assert main_module._should_audit_request(request(), "alice") is True
    assert main_module._should_audit_request(
        request(method="GET", path="/api/v1/admin/users"), "alice"
    ) is False
    assert main_module._should_audit_request(
        request(method="POST", path="/api/v1/admin/users"), "alice"
    ) is True
    assert main_module._should_audit_request(
        request(path="/api/v1/presence"), "alice"
    ) is False
    assert main_module._safe_request_id("abc-123") == "abc-123"
    assert len(main_module._safe_request_id("bad value")) == 12


def test_origin_allowed_accepts_forwarded_and_dev_origins(monkeypatch):
    req = request(headers={"host": "app.test", "x-forwarded-host": "proxy.test"})
    assert main_module._origin_allowed(req, "http://app.test") is True
    assert main_module._origin_allowed(req, "http://proxy.test") is True
    assert main_module._origin_allowed(req, "http://other.test") is False
    assert main_module._origin_allowed(req, "http://[") is False

    monkeypatch.setenv("LAGUN_DEV", "1")
    assert main_module._origin_allowed(req, "http://localhost:5173") is True


@pytest.mark.asyncio
async def test_cross_site_middleware_blocks_untrusted_origins():
    blocked = await main_module.reject_cross_site_writes(
        request(
            method="POST",
            path="/api/v1/config/import",
            headers={"sec-fetch-site": "cross-site"},
        ),
        passthrough,
    )
    assert blocked.status_code == 403

    same_site_blocked = await main_module.reject_cross_site_writes(
        request(
            method="POST",
            path="/api/v1/config/import",
            headers={"sec-fetch-site": "same-site", "origin": "http://other.test"},
        ),
        passthrough,
    )
    assert same_site_blocked.status_code == 403

    origin_blocked = await main_module.reject_cross_site_writes(
        request(
            method="POST",
            path="/api/v1/config/import",
            headers={"origin": "http://other.test"},
        ),
        passthrough,
    )
    assert origin_blocked.status_code == 403

    safe = await main_module.reject_cross_site_writes(
        request(
            method="POST",
            path="/api/v1/config/import",
            headers={"sec-fetch-site": "same-origin"},
        ),
        passthrough,
    )
    assert safe.status_code == 200


@pytest.mark.asyncio
async def test_request_id_and_security_headers_middleware():
    response = await main_module.add_request_id(
        request(headers={"x-request-id": "trace-1"}), passthrough
    )
    assert response.headers["X-Request-ID"] == "trace-1"

    error_response = await main_module.add_request_id(
        request(), lambda _request: _error_response()
    )
    assert error_response.status_code == 500

    secured = await main_module.add_app_security_headers(
        request(path="/assets/app.js"), passthrough
    )
    assert secured.headers["Cache-Control"] == main_module.HASHED_ASSET_CACHE_CONTROL
    assert secured.headers["X-Frame-Options"] == "DENY"

    auth = await main_module.add_app_security_headers(
        request(path="/_auth/login"), passthrough
    )
    assert "Content-Security-Policy" not in auth.headers


async def _error_response():
    return JSONResponse({"bad": True}, status_code=500)


@pytest.mark.asyncio
async def test_readyz_and_spa_fallback_edges(monkeypatch):
    monkeypatch.setattr(main_module, "_startup_complete", False)
    starting = await main_module.readyz()
    assert starting.status_code == 503

    monkeypatch.setattr(main_module, "_startup_complete", True)
    assert await main_module.readyz() == {"status": "ready"}
    api_missing = await main_module.spa_fallback("api/missing")
    assert api_missing.status_code == 404

    monkeypatch.setattr(main_module, "_static", None)
    assert await main_module.spa_fallback("anything") == {
        "detail": "Frontend not built. Run: cd frontend && npm run build"
    }
    assert (await main_module.favicon()).status_code == 404
    assert (await main_module.third_party_licenses()).status_code == 404


def test_ldap_static_and_body_limit_helpers_cover_missing_proxy():
    main_module._ensure_ldapgate_static_paths(SimpleNamespace(proxy=None))
    main_module._warn_if_ldap_body_limit_blocks_imports(SimpleNamespace(proxy=None))

    proxy = SimpleNamespace(
        session_cookie_name="ldapgate_session",
        static_paths=["/existing"],
        max_body_size=import_data.IMPORT_MAX_FILE_BYTES + 1024 * 1024 - 1,
    )
    main_module._ensure_ldapgate_static_paths(SimpleNamespace(proxy=proxy))
    main_module._warn_if_ldap_body_limit_blocks_imports(SimpleNamespace(proxy=proxy))
    assert proxy.session_cookie_name == "lagun_session"
    assert "/healthz" in proxy.static_paths


@pytest.mark.asyncio
async def test_audited_request_blocks_config_and_inaccessible_sessions(monkeypatch):
    async def call(_request):
        return JSONResponse({"ok": True})

    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "ldap.yaml")
    monkeypatch.setenv("LAGUN_ADMIN_USERS", "alice")
    blocked = await main_module._handle_audited_request(
        request(method="POST", path="/api/v1/config/export"),
        call,
        "alice",
    )
    assert blocked.status_code == 403

    monkeypatch.setattr(
        main_module.session_store, "can_access_session", _access_denied
    )
    invisible = await main_module._handle_audited_request(
        request(path="/api/v1/sessions/abc"),
        call,
        "alice",
    )
    assert invisible.status_code == 404


async def _access_denied(_session_id, _username):
    return False


@pytest.mark.asyncio
async def test_lifespan_rejects_connections_config_without_ldap(monkeypatch):
    monkeypatch.setenv("LAGUN_CONNECTIONS_CONFIG", "connections.yaml")
    monkeypatch.delenv("LAGUN_LDAP_CONFIG", raising=False)
    with pytest.raises(RuntimeError, match="requires --ldap-config"):
        async with main_module.lifespan(main_module.app):
            pass


@pytest.mark.asyncio
async def test_lifespan_wraps_connections_config_errors(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "ldap.yaml")
    monkeypatch.setenv("LAGUN_CONNECTIONS_CONFIG", "connections.yaml")

    async def broken(_path):
        raise ValueError("bad config")

    monkeypatch.setattr(main_module, "sync_connections_config", broken)
    with pytest.raises(RuntimeError, match="Invalid LAGUN_CONNECTIONS_CONFIG"):
        async with main_module.lifespan(main_module.app):
            pass


def test_redaction_handles_plain_values_and_secret_keys():
    assert main_module._redact_secrets("plain") == "plain"
    assert main_module._is_secret_key("client_secret") is True
    assert main_module._cap_details("short") == "short"
