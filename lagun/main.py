"""FastAPI application factory."""
import os
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from lagun.db.session_store import init_db
from lagun.api import sessions, query, schema, table_ops, export, import_data, config


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    from lagun.db.pool import close_all_pools
    await close_all_pools()


app = FastAPI(title="Lagun API", version="0.1.0", lifespan=lifespan)

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


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse(status_code=404, content={"detail": "Not found"})
    if _static:
        index = _static / "index.html"
        if index.exists():
            return FileResponse(str(index))
    return {"detail": "Frontend not built. Run: cd frontend && npm run build"}
