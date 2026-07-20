"""FastAPI application factory."""
import os
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from lagun.db.session_store import init_db
from lagun.db import session_store
from lagun.db.connections_config import sync_connections_config
from lagun.auth import ldap_enabled
from lagun.db.pool import DatabaseConnectionError
from lagun.api import sessions, query, schema, table_ops, export, import_data, config


if _log_file := os.getenv("LAGUN_LOG_FILE"):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(), logging.FileHandler(_log_file, encoding="utf-8")],
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    if os.getenv("LAGUN_CONNECTIONS_CONFIG") and not os.getenv("LAGUN_LDAP_CONFIG"):
        raise RuntimeError("--connections-config requires --ldap-config")
    await sync_connections_config(os.getenv("LAGUN_CONNECTIONS_CONFIG"))
    yield
    from lagun.db.pool import close_all_pools
    await close_all_pools()


APP_CSP = (
    "default-src 'self'; "
    "connect-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self' data:"
)
APP_SHELL_CACHE_CONTROL = "no-cache, must-revalidate"
HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"


app = FastAPI(title="Lagun API", version="0.1.50", lifespan=lifespan)


def _audit_details(body: bytes) -> str | None:
    """Keep useful request details while never persisting submitted passwords."""
    if not body or len(body) > 32_000:
        return None
    try:
        data = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(data, dict):
        for key in list(data):
            if "password" in key.lower():
                data[key] = "[redacted]"
    return json.dumps(data, ensure_ascii=False)[:16_000]


@app.middleware("http")
async def ldap_connection_access_and_audit(request: Request, call_next):
    """Enforce session ownership and write a private audit row in LDAP mode."""
    username = getattr(request.state, "user", None) if ldap_enabled() else None
    session_match = re.match(r"^/api/v1/sessions/([^/]+)(?:/|$)", request.url.path)
    session_id = session_match.group(1) if session_match and session_match.group(1) != "probe" else None
    started = time.monotonic()
    if username and request.url.path in {"/api/v1/config/export", "/api/v1/config/import"}:
        response = JSONResponse(status_code=403, content={"detail": "Connection config import/export is disabled in LDAP mode"})
    elif username and session_id and not await session_store.can_access_session(session_id, username):
        response = JSONResponse(status_code=404, content={"detail": "Session not found"})
    else:
        response = await call_next(request)
    duration = round((time.monotonic() - started) * 1000, 2)
    if username and request.url.path.startswith("/api/v1/"):
        try:
            content_length = request.headers.get("content-length")
            details = None
            if content_length:
                try:
                    if int(content_length) <= 32_000:
                        details = _audit_details(await request.body())
                except ValueError:
                    pass
            await session_store.record_audit_event(
                username=username, method=request.method, path=request.url.path,
                session_id=session_id, details=details,
                status_code=response.status_code, duration_ms=duration,
            )
        except Exception:
            # Activity logging must never make a database action fail.
            pass
    return response


@app.exception_handler(DatabaseConnectionError)
async def database_connection_error_handler(request: Request, exc: DatabaseConnectionError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.middleware("http")
async def add_app_security_headers(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/_auth/"):
        response.headers.setdefault("Content-Security-Policy", APP_CSP)
    if request.url.path.startswith("/assets/"):
        response.headers.setdefault("Cache-Control", HASHED_ASSET_CACHE_CONTROL)
    return response

# CORS for development (Vite dev server)
if os.getenv("LAGUN_DEV"):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# API routers
prefix = "/api/v1"
app.include_router(sessions.router, prefix=prefix)
app.include_router(query.router, prefix=prefix)
app.include_router(schema.router, prefix=prefix)
app.include_router(table_ops.router, prefix=prefix)
app.include_router(export.router, prefix=prefix)
app.include_router(import_data.router, prefix=prefix)
app.include_router(config.router, prefix=prefix)


# Static file serving (pre-built frontend)
def _static_dir() -> Path | None:
    # Prefer the on-disk package directory (works for editable + wheel installs)
    pkg_dir = Path(__file__).parent / "static"
    if pkg_dir.exists() and any(pkg_dir.iterdir()):
        return pkg_dir
    # Fallback: importlib.resources for non-standard layouts
    try:
        pkg_static = files("lagun").joinpath("static")
        # Use the Traversable path directly (avoids as_file context manager
        # whose temporary backing can be cleaned up after the with-block)
        candidate = Path(str(pkg_static))
        if candidate.exists() and any(candidate.iterdir()):
            return candidate
    except Exception:
        pass
    return None


_static = _static_dir()
if _static and (_static / "assets").exists():
    app.mount("/assets", StaticFiles(directory=_static / "assets"), name="assets")

@app.get("/favicon.svg", include_in_schema=False)
async def favicon():
    if _static:
        fav = _static / "favicon.svg"
        if fav.exists():
            return FileResponse(str(fav), media_type="image/svg+xml")
    return JSONResponse(status_code=404, content={"detail": "Not found"})


def _ensure_ldapgate_static_paths(config) -> None:
    """Allow only login-page public assets without exposing the SPA bundle."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    if getattr(proxy_config, "session_cookie_name", "ldapgate_session") == "ldapgate_session":
        proxy_config.session_cookie_name = "lagun_session"
    static_paths = list(getattr(proxy_config, "static_paths", []) or [])
    for path in ("/favicon.svg", "/favicon.ico"):
        if path not in static_paths:
            static_paths.append(path)
    proxy_config.static_paths = static_paths


_ldap_config_path = os.getenv("LAGUN_LDAP_CONFIG")
if _ldap_config_path:
    try:
        from ldapgate.config import load_config
        from ldapgate.middleware import add_ldap_auth
    except ImportError as e:
        raise RuntimeError(
            "ldapgate is not installed but LAGUN_LDAP_CONFIG is set. "
            "Install it with: pip install 'lagun[ldap]' or pip install -e /path/to/ldapgate"
        ) from e
    _login_template = Path(__file__).parent / "templates" / "login.html"
    _ldap_config = load_config(_ldap_config_path)
    _ensure_ldapgate_static_paths(_ldap_config)
    os.environ["LAGUN_LDAP_IDLE_TIMEOUT"] = str(
        getattr(getattr(_ldap_config, "proxy", None), "idle_timeout", 0) or 0
    )
    add_ldap_auth(app, _ldap_config, template_path=str(_login_template))


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    if _static:
        index = _static / "index.html"
        if index.exists():
            return FileResponse(
                str(index), headers={"Cache-Control": APP_SHELL_CACHE_CONTROL}
            )
    return {"detail": "Frontend not built. Run: cd frontend && npm run build"}
