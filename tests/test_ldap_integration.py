import re
import types
from pathlib import Path

import pytest

from lagun.api.config import get_server_config
from lagun.main import APP_CSP, _ensure_ldapgate_static_paths


def _login_template() -> str:
    return (
        Path(__file__).resolve().parents[1] / "lagun" / "templates" / "login.html"
    ).read_text()


def test_app_csp_allows_self_fonts():
    assert "font-src 'self'" in APP_CSP
    assert "font-src 'self' data:" in APP_CSP


def test_ensure_ldapgate_static_paths_preserves_existing_paths():
    proxy = types.SimpleNamespace(static_paths=["/custom"])
    config = types.SimpleNamespace(proxy=proxy)

    _ensure_ldapgate_static_paths(config)

    assert proxy.session_cookie_name == "lagun_session"
    # The notices file is public in every mode: the licence obligation does not
    # depend on being logged in.
    assert proxy.static_paths == [
        "/custom",
        "/favicon.svg",
        "/favicon.ico",
        "/THIRD_PARTY_LICENSES.txt",
    ]


@pytest.mark.asyncio
async def test_server_config_exposes_ldap_idle_timeout(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    monkeypatch.setenv("LAGUN_LDAP_IDLE_TIMEOUT", "900")

    assert await get_server_config(
        types.SimpleNamespace(state=types.SimpleNamespace(user=None))
    ) == {
        "ldap_enabled": True,
        "ldap_idle_timeout": 900,
        "is_admin": False,
    }


def test_login_template_uses_nonce_for_inline_assets():
    template = _login_template()
    assert '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' in template
    assert '<style nonce="{{ csrf_nonce }}">' in template
    assert '<script nonce="{{ csrf_nonce }}">' in template
    assert (
        '<input type="hidden" name="csrf_token" value="{{ csrf_token }}">' in template
    )
    assert 'id="password"' in template
    assert 'type="password"' in template
    assert 'class="password-toggle"' in template
    assert 'input[type="password"]::-ms-reveal' in template
    assert "::-moz-reveal" not in template
    # Shared login card: the error is announced once (role=alert) and linked to
    # the fields, and the username is restored only after a failed attempt.
    assert 'id="login-error" role="alert"' in template
    assert 'aria-describedby="login-error"' in template
    assert "const hasError = {{ 'true' if error else 'false' }};" in template
    assert "if (hasError && username && !username.value)" in template
    assert "sessionStorage.setItem(storageKey, username.value);" in template
    assert "@media (prefers-reduced-motion: reduce)" in template
    assert "animation: login-card-in 340ms" in template
    assert "animation: login-error-up 180ms" in template
    assert "transform: translateY(14px) scale(.985)" in template
    assert "top: -3.6rem;" in template
    assert "Secured by" in template
    assert "security-lock" in template
    assert "max-width: 400px;" in template
    assert "min-height: 40px;" in template
    assert "line-height: 1.25rem;" in template
    assert ".submit-label { min-width: 4.75rem; }" in template
    assert "appearance: none;" not in template
    assert "-webkit-appearance: none;" not in template
    assert 'class="password-field"' in template
    assert "padding-inline-end: 3rem;" in template
    assert "password.type = showing ? 'text' : 'password';" in template
    assert "password.focus();" in template
    # tabindex="-1" belongs to the error the server rendered (it takes focus so
    # an AT reads it); the form controls keep their natural tab order.
    assert 'id="login-error" role="alert" tabindex="-1"' in template
    assert all(
        'tabindex="-1"' not in tag
        for tag in re.findall(r"<(?:form|input)\b[^>]*>", template)
    )
    assert '<span class="submit-label" aria-live="polite">Sign in</span>' in template
    assert "label.textContent = 'Signing in…';" in template
    # Busy state lives on the form so it does not suppress the label's live region.
    assert "loginForm.setAttribute('aria-busy', 'true');" in template
    assert 'aria-live="polite"' in template
    assert "event.preventDefault();" in template
    assert "requestAnimationFrame(function() {" in template
    assert "HTMLFormElement.prototype.submit.call(loginForm);" in template
    assert 'input[type="password"]::-ms-reveal' in template
    assert "::-webkit-credentials-auto-fill-button" not in template
    assert "::-webkit-textfield-decoration-container" not in template
    assert "@-moz-document" not in template
    assert 'style="' not in template


def test_login_template_moves_focus_onto_the_error_it_rendered():
    """A server-rendered alert is never announced by a live region.

    The page has to move focus to it instead, and only when it exists: the
    username keeps ``autofocus`` in the render that has no error, so the two
    cannot fight over the initial focus.
    """
    template = _login_template()
    script = re.search(
        r'<script nonce="\{\{ csrf_nonce \}\}">(.*?)</script>', template, re.S
    ).group(1)

    assert "const loginError = document.getElementById('login-error');" in script
    assert re.search(
        r"if \(hasError && loginError\) \{\n\s*loginError\.focus\(\);", script
    )
    assert "{% if not error %} autofocus{% endif %}" in template
