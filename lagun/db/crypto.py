"""Credential encryption using Fernet + OS keychain master key."""
import base64
from pathlib import Path

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

_KEY_SERVICE = "lagun"
_KEY_ACCOUNT = "master_key"
_FALLBACK_PATH = Path.home() / ".lagun" / "master.key"


def _get_or_create_master_key() -> bytes:
    """Retrieve master key from keyring, falling back to file."""
    try:
        import keyring
        stored = keyring.get_password(_KEY_SERVICE, _KEY_ACCOUNT)
        if stored:
            return stored.encode()
        key = Fernet.generate_key()
        keyring.set_password(_KEY_SERVICE, _KEY_ACCOUNT, key.decode())
        return key
    except Exception:
        pass

    # Headless fallback
    _FALLBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    if _FALLBACK_PATH.exists():
        return _FALLBACK_PATH.read_bytes().strip()
    key = Fernet.generate_key()
    _FALLBACK_PATH.write_bytes(key)
    _FALLBACK_PATH.chmod(0o600)
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
    """Decrypt an encrypted password string."""
    return _get_fernet().decrypt(encrypted.encode()).decode()


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
    return Fernet(derive_key_from_passphrase(passphrase, salt)).encrypt(password.encode()).decode()


def decrypt_with_passphrase(encrypted: str, passphrase: str, salt: bytes) -> str:
    """Decrypt a token produced by encrypt_with_passphrase. Raises InvalidToken on wrong passphrase."""
    return Fernet(derive_key_from_passphrase(passphrase, salt)).decrypt(encrypted.encode()).decode()
