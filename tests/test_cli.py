"""CLI contract tests: `lagun serve`, `lagun audit` and `lagun audit purge`."""

import asyncio
import importlib.metadata
import os
import threading

import pytest
from click.testing import CliRunner

from lagun.cli import main
from lagun.db import session_store

runner = CliRunner()

_LAGUN_ENV_VARS = (
    "LAGUN_ADMIN_USERS",
    "LAGUN_CONNECTIONS_CONFIG",
    "LAGUN_LDAP_CONFIG",
    "LAGUN_LOG_FILE",
)


@pytest.fixture(autouse=True)
def restore_lagun_env():
    """`serve` writes its flags into os.environ; undo that after every test."""
    saved = {name: os.environ.pop(name, None) for name in _LAGUN_ENV_VARS}
    yield
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


def _capture_uvicorn(monkeypatch) -> list[tuple[tuple, dict]]:
    calls: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(
        "lagun.cli.uvicorn.run", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    return calls


def test_serve_forwards_bind_options_to_uvicorn(monkeypatch):
    calls = _capture_uvicorn(monkeypatch)

    result = runner.invoke(
        main,
        ["serve", "--no-open", "--host", "0.0.0.0", "--port", "9123", "--reload"],
    )

    assert result.exit_code == 0, result.output
    args, kwargs = calls[0]
    assert args == ("lagun.main:app",)
    assert kwargs["host"] == "0.0.0.0"
    assert kwargs["port"] == 9123
    assert kwargs["reload"] is True
    assert kwargs["log_config"] is None
    assert "Starting Lagun at http://0.0.0.0:9123" in result.output


def test_serve_defaults_to_the_loopback_bind(monkeypatch):
    calls = _capture_uvicorn(monkeypatch)

    result = runner.invoke(main, ["serve", "--no-open"])

    assert result.exit_code == 0, result.output
    _, kwargs = calls[0]
    assert (kwargs["host"], kwargs["port"], kwargs["reload"]) == (
        "127.0.0.1",
        8080,
        False,
    )


def test_serve_opens_the_browser_unless_no_open_is_passed(monkeypatch):
    started: list[dict] = []

    class _FakeThread:
        def __init__(self, target=None, daemon=None, **kwargs):
            started.append({"target": target, "daemon": daemon})

        def start(self):
            pass

    monkeypatch.setattr(threading, "Thread", _FakeThread)
    _capture_uvicorn(monkeypatch)

    assert runner.invoke(main, ["serve"]).exit_code == 0
    assert len(started) == 1
    assert started[0]["daemon"] is True

    started.clear()
    assert runner.invoke(main, ["serve", "--no-open"]).exit_code == 0
    assert started == []


def test_serve_exposes_the_ldap_flags_through_the_environment(monkeypatch, tmp_path):
    _capture_uvicorn(monkeypatch)
    ldap_config = tmp_path / "ldap.yaml"
    ldap_config.write_text(
        "ldap:\n  url: ldap://directory.internal\n", encoding="utf-8"
    )
    connections = tmp_path / "connections.yaml"
    connections.write_text("connections: []\n", encoding="utf-8")
    log_file = tmp_path / "logs" / "lagun.log"

    result = runner.invoke(
        main,
        [
            "serve",
            "--no-open",
            "--ldap-config",
            str(ldap_config),
            "--admin-user",
            "alice",
            "--admin-user",
            "bob",
            "--connections-config",
            str(connections),
            "--log-file",
            str(log_file),
        ],
    )

    assert result.exit_code == 0, result.output
    assert os.environ["LAGUN_LDAP_CONFIG"] == str(ldap_config)
    assert os.environ["LAGUN_ADMIN_USERS"] == "alice,bob"
    assert os.environ["LAGUN_CONNECTIONS_CONFIG"] == str(connections)
    assert os.environ["LAGUN_LOG_FILE"] == str(log_file)
    assert log_file.exists()
    assert f"LDAP authentication enabled ({ldap_config})" in result.output
    assert "Admin console enabled for 2 LDAP user(s)" in result.output


def test_serve_refuses_a_missing_config_path(tmp_path):
    result = runner.invoke(
        main,
        ["serve", "--no-open", "--connections-config", str(tmp_path / "absent.yaml")],
    )

    assert result.exit_code == 2
    assert "does not exist" in result.output


def test_serve_boot_fails_when_connections_config_has_no_ldap(monkeypatch, tmp_path):
    """The startup guard surfaces as a RuntimeError, not a bare traceback."""
    connections = tmp_path / "connections.yaml"
    connections.write_text("connections: []\n", encoding="utf-8")

    def boot_app(app_path, **kwargs):
        from lagun.main import app

        async def boot():
            async with app.router.lifespan_context(app):
                pass

        asyncio.run(boot())

    monkeypatch.setattr("lagun.cli.uvicorn.run", boot_app)

    result = runner.invoke(
        main, ["serve", "--no-open", "--connections-config", str(connections)]
    )

    assert isinstance(result.exception, RuntimeError)
    assert "--connections-config requires --ldap-config" in str(result.exception)


def test_audit_prints_events_with_the_requested_filters(monkeypatch):
    captured: dict = {}

    async def fake_init_db():
        return None

    async def fake_list_audit_events(username=None, since=None, limit=100):
        captured.update(username=username, since=since, limit=limit)
        return [
            {
                "occurred_at": "2026-06-21T09:15:00+00:00",
                "username": "alice",
                "method": "GET",
                "path": "/api/v1/sessions",
                "status_code": 200,
                "duration_ms": 3.5,
                "details": '{"ok":true}',
            },
            {
                "occurred_at": "2026-06-21T09:16:00+00:00",
                "username": "bob",
                "method": "POST",
                "path": "/api/v1/query",
                "status_code": 400,
                "duration_ms": 1.25,
                "details": None,
            },
        ]

    monkeypatch.setattr(session_store, "init_db", fake_init_db)
    monkeypatch.setattr(session_store, "list_audit_events", fake_list_audit_events)

    result = runner.invoke(
        main, ["audit", "--user", "alice", "--since", "2026-06-01", "--limit", "5"]
    )

    assert result.exit_code == 0, result.output
    assert captured == {"username": "alice", "since": "2026-06-01", "limit": 5}
    lines = result.output.splitlines()
    assert (
        "2026-06-21T09:15:00+00:00 alice GET /api/v1/sessions status=200 3.5ms" in lines
    )
    assert '  {"ok":true}' in lines
    assert "2026-06-21T09:16:00+00:00 bob POST /api/v1/query status=400 1.25ms" in lines


@pytest.mark.parametrize("limit", ["0", "10001", "many"])
def test_audit_rejects_a_limit_outside_the_documented_range(limit):
    result = runner.invoke(main, ["audit", "--limit", limit])

    assert result.exit_code == 2


def test_audit_uses_the_default_limit_of_one_hundred(monkeypatch):
    captured: dict = {}

    async def fake_init_db():
        return None

    async def fake_list_audit_events(username=None, since=None, limit=100):
        captured.update(limit=limit)
        return []

    monkeypatch.setattr(session_store, "init_db", fake_init_db)
    monkeypatch.setattr(session_store, "list_audit_events", fake_list_audit_events)

    assert runner.invoke(main, ["audit"]).exit_code == 0
    assert captured == {"limit": 100}


def test_audit_purge_reports_the_deleted_count(monkeypatch):
    captured: dict = {}

    async def fake_init_db():
        return None

    async def fake_purge_audit_events(older_than_days):
        captured.update(older_than_days=older_than_days)
        return 12

    monkeypatch.setattr(session_store, "init_db", fake_init_db)
    monkeypatch.setattr(session_store, "purge_audit_events", fake_purge_audit_events)

    result = runner.invoke(main, ["audit", "purge", "--older-than", "30"])

    assert result.exit_code == 0, result.output
    assert result.output.strip() == "Purged 12 audit events"
    assert captured == {"older_than_days": 30}


def test_audit_purge_defaults_to_ninety_days_and_rejects_zero(monkeypatch):
    captured: dict = {}

    async def fake_init_db():
        return None

    async def fake_purge_audit_events(older_than_days):
        captured.update(older_than_days=older_than_days)
        return 0

    monkeypatch.setattr(session_store, "init_db", fake_init_db)
    monkeypatch.setattr(session_store, "purge_audit_events", fake_purge_audit_events)

    assert runner.invoke(main, ["audit", "purge"]).exit_code == 0
    assert captured == {"older_than_days": 90}
    assert runner.invoke(main, ["audit", "purge", "--older-than", "0"]).exit_code == 2


def test_version_flag_reports_the_installed_package_version():
    result = runner.invoke(main, ["--version"])

    assert result.exit_code == 0
    assert importlib.metadata.version("lagun") in result.output
