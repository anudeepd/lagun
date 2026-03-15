"""Config export/import: backup and restore saved connection sessions."""
import base64
import json
import os
import secrets
import tempfile
from datetime import datetime, timezone
from typing import Optional

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from lagun.db import session_store
from lagun.db.crypto import decrypt_password, encrypt_with_passphrase, decrypt_with_passphrase
from lagun.models.session import SessionCreate

router = APIRouter(tags=["config"])

_EXPORT_VERSION = 1
_KDF_ITERATIONS = 600_000


class ExportRequest(BaseModel):
    passphrase: str


class ImportResult(BaseModel):
    imported: int
    skipped: int


@router.post("/config/export")
async def export_config(req: ExportRequest):
    if not req.passphrase:
        raise HTTPException(400, "A passphrase is required to protect the exported passwords")

    raw_rows = await session_store.list_sessions_raw()
    salt_bytes = secrets.token_bytes(16)
    salt_b64 = base64.b64encode(salt_bytes).decode()

    sessions_out = []
    for s in raw_rows:
        plaintext = decrypt_password(s["password_enc"])
        sessions_out.append({
            "name":               s["name"],
            "host":               s["host"],
            "port":               s["port"],
            "username":           s["username"],
            "password_enc":       encrypt_with_passphrase(plaintext, req.passphrase, salt_bytes),
            "default_db":         s["default_db"],
            "query_limit":        s["query_limit"],
            "ssl_enabled":        bool(s["ssl_enabled"]),
            "selected_databases": json.loads(s["selected_databases"] or "[]"),
        })

    payload = {
        "version":        _EXPORT_VERSION,
        "exported_at":    datetime.now(timezone.utc).isoformat(),
        "kdf":            "pbkdf2-hmac-sha256",
        "kdf_salt":       salt_b64,
        "kdf_iterations": _KDF_ITERATIONS,
        "sessions":       sessions_out,
    }

    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(payload, tmp, indent=2, ensure_ascii=False)
        tmp.flush()
        tmp.close()
    except Exception:
        os.unlink(tmp.name)
        raise

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"lagun_sessions_{ts}.json"
    return FileResponse(
        tmp.name,
        media_type="application/json",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        background=BackgroundTask(lambda: os.unlink(tmp.name) if os.path.exists(tmp.name) else None),
    )


@router.post("/config/import", response_model=ImportResult)
async def import_config(
    file: UploadFile,
    passphrase: str = Form(...),
):
    if not passphrase:
        raise HTTPException(400, "A passphrase is required to decrypt the imported passwords")

    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 5 MB)")

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(400, f"Invalid JSON: {exc}")

    if payload.get("version") != _EXPORT_VERSION:
        raise HTTPException(400, f"Unsupported export version: {payload.get('version')}")

    try:
        salt_bytes = base64.b64decode(payload["kdf_salt"])
    except Exception as exc:
        raise HTTPException(400, f"Malformed kdf_salt: {exc}")

    imported = 0
    skipped = 0

    for entry in payload.get("sessions", []):
        try:
            try:
                plaintext_password = decrypt_with_passphrase(entry["password_enc"], passphrase, salt_bytes)
            except InvalidToken:
                raise HTTPException(400, "Wrong passphrase — could not decrypt passwords")

            await session_store.create_session(SessionCreate(
                name=              entry["name"],
                host=              entry.get("host", "localhost"),
                port=              entry.get("port", 3306),
                username=          entry.get("username", ""),
                password=          plaintext_password,
                default_db=        entry.get("default_db"),
                query_limit=       entry.get("query_limit", 100),
                ssl_enabled=       bool(entry.get("ssl_enabled", False)),
                selected_databases=entry.get("selected_databases", []),
            ))
            imported += 1
        except HTTPException:
            raise
        except Exception:
            skipped += 1

    return ImportResult(imported=imported, skipped=skipped)
