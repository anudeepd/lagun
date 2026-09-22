"""Credential encryption using Fernet + OS keychain master key."""

import base64
import logging
import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

_log = logging.getLogger(__name__)

_KEY_SERVICE = "lagun"
_KEY_ACCOUNT = "master_key"
_FALLBACK_PATH = Path.home() / ".lagun" / "master.key"


class CredentialDecryptError(RuntimeError):
    """Stored credentials cannot be decrypted with the current master key."""


def _harden_permissions(path: Path) -> None:
    """Best-effort 0600 on an existing key file."""
    try:
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            path.chmod(0o600)
    except OSError:
        pass


def _get_or_create_master_key() -> bytes:
    """Retrieve the master key from the OS keyring, falling back to a private file."""
    try:
        import keyring

        stored = keyring.get_password(_KEY_SERVICE, _KEY_ACCOUNT)
        if stored:
            return stored.encode()
        key = Fernet.generate_key()
        keyring.set_password(_KEY_SERVICE, _KEY_ACCOUNT, key.decode())
        return key
    except Exception as exc:
        # Silent fallback would hide the weaker storage mode, and an operator who
        # believes the keyring is in use would not know the file is the real key.
        _log.warning(
            "OS keyring unavailable (%s); using %s instead. Keep that file "
            "private and stable — it decrypts every stored connection password.",
            exc,
            _FALLBACK_PATH,
        )

    _FALLBACK_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = Fernet.generate_key()
    try:
        # Create the file 0600 atomically: writing first and chmod-ing afterwards
        # leaves a window where another local user can read the key.
        fd = os.open(_FALLBACK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        _harden_permissions(_FALLBACK_PATH)
        return _FALLBACK_PATH.read_bytes().strip()
    try:
        os.write(fd, key)
    finally:
        os.close(fd)
    return key


_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_get_or_create_master_key())
    return _fernet


def encrypt_password(password: str) -> str:
    """Encrypt a password and return a base64 string."""
    return _get_fernet().encrypt(password.encode()).decode()


def decrypt_password(encrypted: str) -> str:
    """Decrypt an encrypted password string.

    Raises :class:`CredentialDecryptError` when the master key no longer matches
    the stored ciphertext (for example a deployment that switched between the
    keyring and the file fallback), so callers can report something actionable
    instead of an opaque 500.
    """
    try:
        return _get_fernet().decrypt(encrypted.encode()).decode()
    except InvalidToken as exc:
        raise CredentialDecryptError(
            "Stored credentials cannot be decrypted — the master key changed "
            "since they were saved. Re-enter the password for this connection."
        ) from exc


_KDF_ITERATIONS = 600_000


def derive_key_from_passphrase(passphrase: str, salt: bytes) -> bytes:
    """Derive a Fernet-compatible key from a passphrase using PBKDF2-HMAC-SHA256."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=_KDF_ITERATIONS,
    )
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode("utf-8")))


def encrypt_with_passphrase(password: str, passphrase: str, salt: bytes) -> str:
    """Encrypt a password with a key derived from passphrase+salt."""
    return (
        Fernet(derive_key_from_passphrase(passphrase, salt))
        .encrypt(password.encode())
        .decode()
    )


def decrypt_with_passphrase(encrypted: str, passphrase: str, salt: bytes) -> str:
    """Decrypt a token produced by encrypt_with_passphrase. Raises InvalidToken on wrong passphrase."""
    return (
        Fernet(derive_key_from_passphrase(passphrase, salt))
        .decrypt(encrypted.encode())
        .decode()
    )
