import base64
import json

import pytest

import lagun.api.config as config_api
from lagun.db.crypto import encrypt_with_passphrase
from lagun.db import session_store


async def test_server_config_survives_an_invalid_idle_timeout(client, monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_IDLE_TIMEOUT", "not-a-number")
    response = await client.get("/api/v1/config/server")
    assert response.status_code == 200
    assert response.json()["ldap_idle_timeout"] == 0


def test_export_tempfile_cleans_up_when_writing_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(
        config_api.json,
        "dump",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk full")),
    )
    monkeypatch.setattr(
        config_api.os,
        "unlink",
        lambda _path: (_ for _ in ()).throw(FileNotFoundError),
    )
    with pytest.raises(OSError, match="disk full"):
        config_api._write_export_tempfile({"sessions": []})


async def test_export_cleanup_tolerates_a_missing_file():
    await session_store.init_db()
    response = await config_api.export_config(
        config_api.ExportRequest(passphrase="passphrase")
    )
    assert response.status_code == 200
    assert response.background is not None
    await response.background()
    await response.background()


async def _import_payload(client, payload, passphrase="pass"):
    return await client.post(
        "/api/v1/config/import",
        files={
            "file": (
                "sessions.json",
                json.dumps(payload).encode("utf-8"),
                "application/json",
            )
        },
        data={"passphrase": passphrase},
    )


async def test_import_requires_a_passphrase(client):
    response = await client.post(
        "/api/v1/config/import",
        files={"file": ("sessions.json", b"{}", "application/json")},
        data={"passphrase": ""},
    )
    assert response.status_code == 400
    assert "passphrase is required" in response.json()["detail"]


@pytest.mark.parametrize(
    "payload, expected",
    [
        (
            {
                "version": 1,
                "kdf": "wrong",
                "kdf_iterations": config_api._KDF_ITERATIONS,
                "kdf_salt": base64.b64encode(b"0" * 16).decode(),
                "sessions": [],
            },
            "key derivation",
        ),
        (
            {
                "version": 1,
                "kdf": "pbkdf2-hmac-sha256",
                "kdf_iterations": 1,
                "kdf_salt": base64.b64encode(b"0" * 16).decode(),
                "sessions": [],
            },
            "parameters",
        ),
        (
            {
                "version": 1,
                "kdf": "pbkdf2-hmac-sha256",
                "kdf_iterations": config_api._KDF_ITERATIONS,
                "kdf_salt": "***",
                "sessions": [],
            },
            "Malformed kdf_salt",
        ),
        (
            {
                "version": 1,
                "kdf": "pbkdf2-hmac-sha256",
                "kdf_iterations": config_api._KDF_ITERATIONS,
                "kdf_salt": base64.b64encode(b"short").decode(),
                "sessions": [],
            },
            "expected 16 bytes",
        ),
        (
            {
                "version": 1,
                "kdf": "pbkdf2-hmac-sha256",
                "kdf_iterations": config_api._KDF_ITERATIONS,
                "kdf_salt": base64.b64encode(b"0" * 16).decode(),
                "sessions": {},
            },
            "must be an array",
        ),
    ],
)
async def test_import_rejects_malformed_envelopes(client, payload, expected):
    response = await _import_payload(client, payload)
    assert response.status_code == 400
    assert expected in response.json()["detail"]


async def test_import_skips_non_objects_and_invalid_entries(client):
    salt = b"0" * 16
    valid_password = encrypt_with_passphrase("db-pass", "pass", salt)
    payload = {
        "version": 1,
        "kdf": "pbkdf2-hmac-sha256",
        "kdf_iterations": config_api._KDF_ITERATIONS,
        "kdf_salt": base64.b64encode(salt).decode(),
        "sessions": [
            "not-an-object",
            {
                "name": "Missing required fields",
                "password_enc": valid_password,
            },
        ],
    }

    response = await _import_payload(client, payload)
    assert response.status_code == 200
    assert response.json() == {"imported": 0, "skipped": 2}


async def test_import_skips_a_session_that_fails_to_save(client, monkeypatch):
    salt = b"1" * 16
    payload = {
        "version": 1,
        "kdf": "pbkdf2-hmac-sha256",
        "kdf_iterations": config_api._KDF_ITERATIONS,
        "kdf_salt": base64.b64encode(salt).decode(),
        "sessions": [
            {
                "source_id": "",
                "name": "Cannot save",
                "host": "db.test",
                "port": 3306,
                "username": "reader",
                "password_enc": encrypt_with_passphrase("db-pass", "pass", salt),
            }
        ],
    }

    async def fail(_session):
        raise OSError("store unavailable")

    monkeypatch.setattr(config_api.session_store, "create_session", fail)
    response = await _import_payload(client, payload)
    assert response.status_code == 200
    assert response.json() == {"imported": 0, "skipped": 1}
