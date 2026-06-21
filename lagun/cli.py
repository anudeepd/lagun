"""CLI entry point for Lagun."""
import os
import asyncio
import logging
from pathlib import Path

import click
import uvicorn


@click.group()
@click.version_option(package_name="lagun")
def main():
    """Lagun — web-based MySQL/MariaDB editor."""


def _configure_logging(log_file: Path | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind host.")
@click.option("--port", default=8080, show_default=True, help="Bind port.")
@click.option("--open/--no-open", "open_browser", default=True, show_default=True,
              help="Open browser on startup.")
@click.option("--reload", is_flag=True, default=False, help="Auto-reload on code changes (dev).")
@click.option("--ldap-config", "ldap_config", default=None,
              type=click.Path(exists=True, dir_okay=False, resolve_path=True),
              help="Path to ldapgate YAML config to enable LDAP authentication.")
@click.option("--connections-config", default=None, type=click.Path(exists=True, dir_okay=False, resolve_path=True),
              help="Server-managed LDAP connection profiles YAML file.")
@click.option("--log-file", type=click.Path(dir_okay=False, path_type=Path), default=None,
              help="Append application logs to this file.")
def serve(host: str, port: int, open_browser: bool, reload: bool, ldap_config: str | None, connections_config: str | None, log_file: Path | None):
    """Start the Lagun web server."""
    url = f"http://{host}:{port}"

    # LDAPGate logs authentication events through normal Python loggers.
    _configure_logging(log_file)
    if log_file:
        os.environ["LAGUN_LOG_FILE"] = str(log_file)

    if ldap_config:
        os.environ["LAGUN_LDAP_CONFIG"] = ldap_config
        click.echo(f"LDAP authentication enabled ({ldap_config})")
    if connections_config:
        os.environ["LAGUN_CONNECTIONS_CONFIG"] = connections_config

    click.echo(f"Starting Lagun at {url}")

    if open_browser:
        import threading, webbrowser, time
        def _open():
            time.sleep(1.5)
            webbrowser.open(url)
        threading.Thread(target=_open, daemon=True).start()

    uvicorn.run(
        "lagun.main:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
        log_config=None,
    )


def _print_audit_events(events):
    for event in events:
        click.echo(f"{event['occurred_at']} {event['username']} {event['method']} {event['path']} status={event['status_code']} {event['duration_ms']}ms")
        if event['details']:
            click.echo(f"  {event['details']}")


@main.group(invoke_without_command=True)
@click.option("--user", "username", default=None)
@click.option("--since", default=None, help="ISO date/time, for example 2026-06-21.")
@click.option("--limit", default=100, show_default=True, type=click.IntRange(1, 10000))
@click.pass_context
def audit(ctx: click.Context, username: str | None, since: str | None, limit: int):
    """Read or purge the private LDAP activity log."""
    if ctx.invoked_subcommand is None:
        from lagun.db.session_store import init_db, list_audit_events
        async def run():
            await init_db()
            return await list_audit_events(username, since, limit)
        _print_audit_events(asyncio.run(run()))


@audit.command("purge")
@click.option("--older-than", default=90, show_default=True, type=click.IntRange(1), help="Age in days.")
def audit_purge(older_than: int):
    from lagun.db.session_store import init_db, purge_audit_events
    async def run():
        await init_db()
        return await purge_audit_events(older_than)
    click.echo(f"Purged {asyncio.run(run())} audit events")
