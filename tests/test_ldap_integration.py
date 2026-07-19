import types
from pathlib import Path

import pytest

from lagun.api.config import get_server_config
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


@pytest.mark.asyncio
async def test_server_config_exposes_ldap_idle_timeout(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    monkeypatch.setenv("LAGUN_LDAP_IDLE_TIMEOUT", "900")

    assert await get_server_config() == {
        "ldap_enabled": True,
        "ldap_idle_timeout": 900,
    }


def test_login_template_uses_nonce_for_inline_assets():
    template = (
        Path(__file__).resolve().parents[1] / "lagun" / "templates" / "login.html"
    ).read_text()
    assert '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' in template
    assert '<style nonce="{{ csrf_nonce }}">' in template
    assert '<script nonce="{{ csrf_nonce }}">' in template
    assert '<input type="hidden" name="csrf_token" value="{{ csrf_token }}">' in template
    assert 'class="password-toggle"' not in template
    assert "password.type = visible ? 'password' : 'text';" not in template
    assert 'class="feedback-slot" aria-live="polite"' in template
    assert "sessionStorage.setItem(usernameStorageKey, username.value);" in template
    assert "document.getElementById('login-error') && savedUsername" in template
    assert "@media (prefers-reduced-motion: reduce)" in template
    assert "animation: lagun-surface-in 280ms" in template
    assert "transform: translateY(10px) scale(.985)" in template
    assert "bottom: calc(100% + 0.75rem)" in template
    assert "Secured by" in template
    assert "security-lock" in template
    assert "max-width: 380px;" in template
    assert "min-height: 40px;" in template
    assert "line-height: 1.25rem;" in template
    assert ".submit-label { min-width: 4.75rem; }" in template
    assert "appearance: none;" in template
    assert "-webkit-appearance: none;" in template
    assert 'tabindex="-1"' not in template
    assert '<span class="submit-label" aria-live="polite">Sign in</span>' in template
    assert "submitLabel.textContent = 'Signing in';" in template
    assert "btn.setAttribute('aria-busy', 'true');" in template
    assert "event.preventDefault();" in template
    assert "requestAnimationFrame(function() {" in template
    assert "HTMLFormElement.prototype.submit.call(loginForm);" in template
    assert "::-ms-reveal" not in template
    assert "::-webkit" not in template
    assert "@-moz-document" not in template
    assert 'style="' not in template
