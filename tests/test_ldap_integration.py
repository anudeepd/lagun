import types
from pathlib import Path

from lagun.main import APP_CSP, _ensure_ldapgate_static_paths


def test_app_csp_allows_self_fonts():
    assert "font-src 'self'" in APP_CSP
    assert "font-src 'self' data:" in APP_CSP


def test_ensure_ldapgate_static_paths_preserves_existing_paths():
    proxy = types.SimpleNamespace(static_paths=["/custom"])
    config = types.SimpleNamespace(proxy=proxy)

    _ensure_ldapgate_static_paths(config)

    assert proxy.session_cookie_name == "lagun_session"
    assert proxy.static_paths == ["/custom", "/favicon.svg", "/favicon.ico"]


def test_login_template_uses_nonce_for_inline_assets():
    template = (
        Path(__file__).resolve().parents[1] / "lagun" / "templates" / "login.html"
    ).read_text()
    assert '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' in template
    assert '<style nonce="{{ csrf_nonce }}">' in template
    assert '<script nonce="{{ csrf_nonce }}">' in template
    assert '<input type="hidden" name="csrf_token" value="{{ csrf_token }}">' in template
    assert 'style="' not in template
