"""Audit-log redaction: request bodies must never store credentials verbatim.

The audit middleware keeps JSON request bodies so an operator can see what was
asked for. Connection create/update, probe and config export all carry a
plaintext password or passphrase, and the audit store is unencrypted SQLite that
every administrator can read, so those values are replaced before they are
written.
"""

import json

from lagun.main import _audit_details


def test_credentials_are_redacted_at_the_top_level():
    body = json.dumps(
        {
            "name": "prod",
            "host": "db.internal",
            "username": "root",
            "password": "hunter2",
        }
    ).encode()

    details = _audit_details(body)

    assert "hunter2" not in details
    parsed = json.loads(details)
    assert parsed["password"] == "***"
    # Non-secret fields stay readable so the log is still useful.
    assert parsed["host"] == "db.internal"
    assert parsed["username"] == "root"


def test_credentials_are_redacted_when_nested():
    body = json.dumps(
        {
            "connections": [
                {"name": "a", "password": "secret-a"},
                {"name": "b", "password": "secret-b"},
            ],
            "passphrase": "export-key",
        }
    ).encode()

    details = _audit_details(body)

    assert "secret-a" not in details
    assert "secret-b" not in details
    assert "export-key" not in details
    assert details.count("***") == 3


def test_key_matching_is_case_insensitive():
    body = json.dumps({"Password": "hunter2", "NEW_PASSWORD": "hunter3"}).encode()
    details = _audit_details(body)
    assert "hunter2" not in details
    assert "hunter3" not in details


def test_unparseable_bodies_are_not_stored():
    details = _audit_details(b'{"password": "hunter2"')
    assert "hunter2" not in details


def test_empty_body_yields_no_details():
    assert _audit_details(b"") is None
