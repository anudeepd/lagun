"""Unit tests for lagun/db/crypto.py."""

import pytest
from cryptography.fernet import InvalidToken

from lagun.db.crypto import (
    encrypt_password,
    decrypt_password,
    derive_key_from_passphrase,
    encrypt_with_passphrase,
    decrypt_with_passphrase,
)


def test_encrypt_decrypt_roundtrip():
    plain = "supersecret"
    assert decrypt_password(encrypt_password(plain)) == plain


def test_encrypt_produces_different_ciphertext_each_time():
    """Fernet uses a random IV so identical plaintexts produce different tokens."""
    enc1 = encrypt_password("same")
    enc2 = encrypt_password("same")
    assert enc1 != enc2


def test_decrypt_returns_original_string():
    for password in ("", "pass123", "p@$$w0rd!", "日本語"):
        assert decrypt_password(encrypt_password(password)) == password


def test_derive_key_is_deterministic():
    salt = b"\x00" * 16
    k1 = derive_key_from_passphrase("passphrase", salt)
    k2 = derive_key_from_passphrase("passphrase", salt)
    assert k1 == k2


def test_derive_key_differs_with_different_salt():
    k1 = derive_key_from_passphrase("same", b"salt1" + b"\x00" * 11)
    k2 = derive_key_from_passphrase("same", b"salt2" + b"\x00" * 11)
    assert k1 != k2


def test_derive_key_differs_with_different_passphrase():
    salt = b"\xaa" * 16
    k1 = derive_key_from_passphrase("pass1", salt)
    k2 = derive_key_from_passphrase("pass2", salt)
    assert k1 != k2


def test_encrypt_with_passphrase_roundtrip():
    salt = b"\x01" * 16
    plain = "my-db-password"
    passphrase = "user-chosen-passphrase"
    enc = encrypt_with_passphrase(plain, passphrase, salt)
    assert decrypt_with_passphrase(enc, passphrase, salt) == plain


def test_decrypt_with_wrong_passphrase_raises():
    salt = b"\x02" * 16
    enc = encrypt_with_passphrase("secret", "correct-pass", salt)
    with pytest.raises(InvalidToken):
        decrypt_with_passphrase(enc, "wrong-pass", salt)


def test_decrypt_with_wrong_salt_raises():
    enc = encrypt_with_passphrase("secret", "pass", b"\x03" * 16)
    with pytest.raises(InvalidToken):
        decrypt_with_passphrase(enc, "pass", b"\x04" * 16)


# ---------------------------------------------------------------------------
# Master key file permissions (S-13)
# ---------------------------------------------------------------------------


def _break_keyring(monkeypatch):
    """Force the file fallback by making the OS keyring unusable."""
    import sys
    import types

    fake = types.ModuleType("keyring")

    def _boom(*args, **kwargs):
        raise RuntimeError("no keyring backend")

    fake.get_password = _boom
    fake.set_password = _boom
    monkeypatch.setitem(sys.modules, "keyring", fake)


def test_fallback_key_file_is_private_from_creation(monkeypatch, tmp_path):
    import stat

    import lagun.db.crypto as crypto

    _break_keyring(monkeypatch)
    key_path = tmp_path / "nested" / "master.key"
    monkeypatch.setattr(crypto, "_FALLBACK_PATH", key_path)

    key = crypto._get_or_create_master_key()

    assert key_path.read_bytes().strip() == key
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(key_path.parent.stat().st_mode) == 0o700


def test_existing_world_readable_key_file_is_tightened(monkeypatch, tmp_path):
    import stat

    import lagun.db.crypto as crypto

    _break_keyring(monkeypatch)
    key_path = tmp_path / "master.key"
    key_path.write_bytes(b"existing-key")
    key_path.chmod(0o644)
    monkeypatch.setattr(crypto, "_FALLBACK_PATH", key_path)

    assert crypto._get_or_create_master_key() == b"existing-key"
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600


def test_decrypt_failure_is_reported_as_a_typed_error():
    """A changed master key must not surface as an opaque InvalidToken."""
    import lagun.db.crypto as crypto
    from lagun.db.crypto import CredentialDecryptError

    other = crypto.Fernet(crypto.Fernet.generate_key()).encrypt(b"secret").decode()
    with pytest.raises(CredentialDecryptError):
        decrypt_password(other)
