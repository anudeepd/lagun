"""FastAPI application factory."""

import json
import logging
import os
import uuid
import re
import time
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from lagun import __version__
from lagun.db.session_store import init_db
from lagun.db import session_store
from lagun.db.connections_config import sync_connections_config
from lagun.db.crypto import CredentialDecryptError
from lagun.db.net_policy import HostNotAllowedError
from lagun.db.pool import DatabaseCapacityError, DatabaseConnectionError
from lagun.auth import ldap_enabled
from lagun.api import (
    sessions,
    query,
    schema,
    table_ops,
    export,
    import_data,
    config,
    admin,
    presence,
)
from lagun.ldap_policy import configure_live_policy

_log = logging.getLogger("lagun")

if _log_file := os.getenv("LAGUN_LOG_FILE"):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(_log_file, encoding="utf-8"),
        ],
    )


# Readiness flag: set once startup has finished, cleared when shutdown starts.
_startup_complete = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _startup_complete
    await init_db()
    if os.getenv("LAGUN_CONNECTIONS_CONFIG") and not os.getenv("LAGUN_LDAP_CONFIG"):
        raise RuntimeError("--connections-config requires --ldap-config")
    config_path = os.getenv("LAGUN_CONNECTIONS_CONFIG")
    try:
        await sync_connections_config(config_path)
    except Exception as exc:
        # A typo in a server-managed file used to abort startup with a raw
        # traceback and no indication of which file or entry was wrong.
        raise RuntimeError(
            f"Invalid LAGUN_CONNECTIONS_CONFIG at {config_path}: {exc}"
        ) from exc
    from lagun.db.pool import close_all_pools, start_pool_reaper

    start_pool_reaper()
    _startup_complete = True
    try:
        yield
    finally:
        _startup_complete = False
        await close_all_pools()


APP_CSP = (
    "default-src 'self'; "
    "base-uri 'self'; "
    "connect-src 'self'; "
    "font-src 'self' data:; "
    "form-action 'self'; "
    "frame-ancestors 'none'; "
    "img-src 'self' data:; "
    "object-src 'none'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'"
)
APP_SHELL_CACHE_CONTROL = "no-cache, must-revalidate"
HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"


_DEV_MODE = bool(os.getenv("LAGUN_DEV"))
app = FastAPI(
    title="Lagun API",
    version=__version__,
    lifespan=lifespan,
    # FastAPI's Swagger UI loads its bundle from a CDN, which the app's own CSP
    # blocks, so /docs rendered blank while /openapi.json stayed world-readable.
    docs_url="/docs" if _DEV_MODE else None,
    redoc_url="/redoc" if _DEV_MODE else None,
    openapi_url="/openapi.json" if _DEV_MODE else None,
)
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)


# Request bodies are kept for operator review, but never verbatim: connection
# create/update and probe all carry a plaintext password, and config export
# carries a passphrase. Those must not reach the durable audit store, the admin
# console or `lagun audit`.
_AUDIT_REDACTED = "***"
_AUDIT_SECRET_KEYS = frozenset(
    {
        "password",
        "passphrase",
        "new_password",
        "old_password",
        "password_enc",
        "secret",
        "token",
    }
)


def _redact_secrets(value: Any) -> Any:
    """Recursively replace credential-bearing values with a placeholder."""
    if isinstance(value, dict):
        return {
            key: (
                _AUDIT_REDACTED
                if str(key).lower() in _AUDIT_SECRET_KEYS
                else _redact_secrets(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_secrets(item) for item in value]
    return value


def _audit_details(body: bytes) -> str | None:
    """JSON request details for operator review, with credentials removed."""
    if not body:
        return None
    text = body.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text)
    except ValueError:
        # An unparseable body cannot be redacted safely, so record only that it
        # existed rather than storing raw bytes that might hold a password.
        return "[unparseable request body omitted]"
    return json.dumps(
        _redact_secrets(parsed), ensure_ascii=False, separators=(",", ":")
    )


def _audit_target(request: Request) -> str:
    """Preserve the raw request target, including encoded query parameters."""
    query = request.url.query
    return f"{request.url.path}?{query}" if query else request.url.path


def _should_audit_request(request: Request, username: str | None) -> bool:
    if (
        not username
        or not request.url.path.startswith("/api/v1/")
        or request.url.path.startswith("/api/v1/presence")
    ):
        return False
    # Read-only admin polling would otherwise fill the audit window with the
    # console observing itself. Admin mutations remain auditable.
    return request.method != "GET" or not request.url.path.startswith("/api/v1/admin/")


@app.middleware("http")
async def ldap_connection_access_and_audit(request: Request, call_next):
    """Enforce session ownership and write a private audit row in LDAP mode."""
    username = getattr(request.state, "user", None) if ldap_enabled() else None
    session_match = re.match(r"^/api/v1/sessions/([^/]+)(?:/|$)", request.url.path)
    session_id = (
        session_match.group(1)
        if session_match and session_match.group(1) != "probe"
        else None
    )
    started = time.monotonic()
    should_audit = _should_audit_request(request, username)
    details = None
    if should_audit and request.headers.get("content-type", "").startswith(
        "application/json"
    ):
        try:
            # Read before dispatch. Starlette caches this body for the endpoint;
            # reading it after dispatch fails once the endpoint consumes the stream.
            details = _audit_details(await request.body())
        except Exception:
            # Activity logging must never make a database action fail.
            details = None

    if username and request.url.path in {
        "/api/v1/config/export",
        "/api/v1/config/import",
    }:
        response = JSONResponse(
            status_code=403,
            content={
                "detail": "Connection config import/export is disabled in LDAP mode"
            },
        )
    elif (
        username
        and session_id
        and not await session_store.can_access_session(session_id, username)
    ):
        response = JSONResponse(
            status_code=404, content={"detail": "Session not found"}
        )
    else:
        response = await call_next(request)
    duration = round((time.monotonic() - started) * 1000, 2)
    if should_audit:
        try:
            await session_store.record_audit_event(
                username=username,
                method=request.method,
                path=_audit_target(request),
                session_id=session_id,
                details=details,
                status_code=response.status_code,
                duration_ms=duration,
            )
        except Exception:
            # Activity logging must never make a database action fail.
            pass
    return response


@app.exception_handler(DatabaseConnectionError)
async def database_connection_error_handler(
    request: Request, exc: DatabaseConnectionError
):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(DatabaseCapacityError)
async def database_capacity_error_handler(request: Request, exc: DatabaseCapacityError):
    return JSONResponse(
        status_code=503,
        content={"detail": str(exc)},
        headers={"Retry-After": "1"},
    )


@app.exception_handler(CredentialDecryptError)
async def credential_decrypt_error_handler(
    request: Request, exc: CredentialDecryptError
):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.exception_handler(HostNotAllowedError)
async def host_not_allowed_error_handler(request: Request, exc: HostNotAllowedError):
    return JSONResponse(status_code=403, content={"detail": str(exc)})


_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def _safe_request_id(candidate: str | None) -> str:
    """Accept an inbound correlation id only if it is short and plain.

    The value is echoed in a response header and written to the log, so an
    unbounded or control-character-bearing value would let a caller forge log
    lines or bloat a header.
    """
    if candidate and _REQUEST_ID_RE.match(candidate):
        return candidate
    return uuid.uuid4().hex[:12]


def _origin_allowed(request: Request, origin: str) -> bool:
    """True when *origin* is this server (or the Vite dev server).

    A reverse proxy that rewrites `Host` (nginx's default `proxy_set_header Host
    $proxy_host`) would otherwise make every write look cross-origin, so a
    forwarded host is accepted as an alias. This cannot be abused by a browser:
    setting `X-Forwarded-Host` is not a CORS-safelisted header, so a page that
    tried it would need a preflight, which this app never grants.
    """
    allowed = {request.headers.get("host", "")}
    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_host:
        allowed.add(forwarded_host.split(",")[0].strip())
    if os.getenv("LAGUN_DEV"):
        allowed |= {"localhost:5173", "127.0.0.1:5173"}
    try:
        netloc = urlsplit(origin).netloc
    except ValueError:
        return False
    return bool(netloc) and netloc in allowed


@app.middleware("http")
async def reject_cross_site_writes(request: Request, call_next):
    """Reject state-changing API requests that come from another origin.

    SameSite cookies are not sufficient on their own: several endpoints accept
    CORS-safelisted content types (multipart and form-encoded), so a cross-origin
    page can issue them as simple requests that never trigger a preflight. A
    request with no Origin header (curl, server-to-server) is left alone.
    """
    if request.method in {
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
    } and request.url.path.startswith("/api/"):
        # `Sec-Fetch-Site` is set by the browser itself and cannot be forged by
        # page script, so when it is present it decides on its own. The
        # Origin-versus-Host comparison is the fallback for clients that do not
        # send it, and it is the fragile one behind a proxy that rewrites Host.
        # `Sec-Fetch-Site` is set by the browser itself and cannot be forged by
        # page script, so when it is present it decides on its own. The
        # Origin-versus-Host comparison is the fallback for clients that do not
        # send it, and it is the fragile one behind a proxy that rewrites Host.
        fetch_site = request.headers.get("sec-fetch-site")
        if fetch_site:
            if fetch_site not in {"same-origin", "same-site", "none"}:
                return JSONResponse(
                    status_code=403, content={"detail": "Cross-origin request rejected"}
                )
        else:
            origin = request.headers.get("origin")
            if origin and not _origin_allowed(request, origin):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Cross-origin request rejected"},
                )
    return await call_next(request)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    """Tag every request so a client-visible failure can be found in the log."""
    request_id = _safe_request_id(request.headers.get("x-request-id"))
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers.setdefault("X-Request-ID", request_id)
    if response.status_code >= 500:
        _log.error(
            "request %s %s %s -> %s",
            request_id,
            request.method,
            request.url.path,
            response.status_code,
        )
    return response


@app.middleware("http")
async def add_app_security_headers(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/_auth/"):
        response.headers.setdefault("Content-Security-Policy", APP_CSP)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
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
app.include_router(admin.router, prefix=prefix)
app.include_router(presence.router, prefix=prefix)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Liveness: the process is serving requests."""
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
async def readyz():
    """Readiness: startup finished and shutdown has not begun."""
    if not _startup_complete:
        return JSONResponse(status_code=503, content={"status": "starting"})
    return {"status": "ready"}


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


@app.get("/THIRD_PARTY_LICENSES.txt", include_in_schema=False)
async def third_party_licenses():
    """Serve the notices for the third-party code bundled in the frontend build.

    The file ships inside the wheel (`lagun/static/`), but with no route the SPA
    catch-all answered this path with `index.html`, so a running instance could
    not hand the notices to anyone.
    """
    if _static:
        notices = _static / "THIRD_PARTY_LICENSES.txt"
        if notices.exists():
            return FileResponse(str(notices), media_type="text/plain; charset=utf-8")
    return JSONResponse(status_code=404, content={"detail": "Not found"})


def _ensure_ldapgate_static_paths(config) -> None:
    """Allow only login-page public assets without exposing the SPA bundle."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    if (
        getattr(proxy_config, "session_cookie_name", "ldapgate_session")
        == "ldapgate_session"
    ):
        proxy_config.session_cookie_name = "lagun_session"
    static_paths = list(getattr(proxy_config, "static_paths", []) or [])
    for path in ("/favicon.svg", "/favicon.ico", "/THIRD_PARTY_LICENSES.txt"):
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
    _ldap_session_manager = add_ldap_auth(
        app, _ldap_config, template_path=str(_login_template)
    )
    configure_live_policy(_ldap_config, _ldap_session_manager)


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
