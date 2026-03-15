"""CLI entry point for Lagun."""
import os
import click
import uvicorn


@click.group()
@click.version_option(package_name="lagun")
def main():
    """Lagun — web-based MySQL/MariaDB editor."""


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind host.")
@click.option("--port", default=8080, show_default=True, help="Bind port.")
@click.option("--open/--no-open", "open_browser", default=True, show_default=True,
              help="Open browser on startup.")
@click.option("--reload", is_flag=True, default=False, help="Auto-reload on code changes (dev).")
def serve(host: str, port: int, open_browser: bool, reload: bool):
    """Start the Lagun web server."""
    url = f"http://{host}:{port}"
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
    )
