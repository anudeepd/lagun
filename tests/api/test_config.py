"""Integration tests for the config export/import API."""
import json


async def _create_session(client, name="Test Session"):
    r = await client.post("/api/v1/sessions", json={
        "name": name,
        "host": "db.example.com",
        "username": "root",
        "password": "secret",
    })
    assert r.status_code == 201
    return r.json()["id"]


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

async def test_export_requires_passphrase(client):
    r = await client.post("/api/v1/config/export", json={"passphrase": ""})
    assert r.status_code == 400


async def test_export_produces_valid_json(client):
    await _create_session(client, "Export Test")
    r = await client.post("/api/v1/config/export", json={"passphrase": "mypass"})
    assert r.status_code == 200
    payload = r.json()
    assert payload["version"] == 1
    assert "sessions" in payload
    assert "kdf_salt" in payload


async def test_export_contains_session(client):
    await _create_session(client, "Exported Session")
    r = await client.post("/api/v1/config/export", json={"passphrase": "mypass"})
    payload = r.json()
    names = [s["name"] for s in payload["sessions"]]
    assert "Exported Session" in names


async def test_export_does_not_leak_plaintext_password(client):
    await _create_session(client, "Password Check")
    r = await client.post("/api/v1/config/export", json={"passphrase": "mypass"})
    payload = r.json()
    session = next(s for s in payload["sessions"] if s["name"] == "Password Check")
    # password_enc should be a Fernet token (base64-like), never the plaintext "secret"
    assert session["password_enc"] != "secret"
    assert len(session["password_enc"]) > 20  # it's an encrypted blob


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

async def _make_export_file(client, passphrase="pass") -> bytes:
    """Export current sessions and return the raw JSON bytes."""
    r = await client.post("/api/v1/config/export", json={"passphrase": passphrase})
    return r.content


async def test_roundtrip_export_import(client):
    sid = await _create_session(client, "Roundtrip")
    export_bytes = await _make_export_file(client, "secret-passphrase")

    # Delete original session
    await client.delete(f"/api/v1/sessions/{sid}")

    # Import it back
    r = await client.post(
        "/api/v1/config/import",
        files={"file": ("sessions.json", export_bytes, "application/json")},
        data={"passphrase": "secret-passphrase"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["imported"] >= 1
    assert data["skipped"] == 0

    # Verify the session is back
    r2 = await client.get("/api/v1/sessions")
    names = [s["name"] for s in r2.json()]
    assert "Roundtrip" in names


async def test_import_wrong_passphrase_returns_400(client):
    await _create_session(client, "WrongPass Test")
    export_bytes = await _make_export_file(client, "correct-pass")

    r = await client.post(
        "/api/v1/config/import",
        files={"file": ("sessions.json", export_bytes, "application/json")},
        data={"passphrase": "wrong-pass"},
    )
    assert r.status_code == 400


async def test_import_invalid_json_returns_400(client):
    r = await client.post(
        "/api/v1/config/import",
        files={"file": ("sessions.json", b"not valid json", "application/json")},
        data={"passphrase": "pass"},
    )
    assert r.status_code == 400


async def test_import_wrong_version_returns_400(client):
    payload = json.dumps({"version": 99, "sessions": [], "kdf_salt": "AA=="}).encode()
    r = await client.post(
        "/api/v1/config/import",
        files={"file": ("sessions.json", payload, "application/json")},
        data={"passphrase": "pass"},
    )
    assert r.status_code == 400
