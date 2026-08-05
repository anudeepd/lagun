"""Atomic LDAP allowlist mutation with live policy updates."""

from __future__ import annotations

import fcntl
import hashlib
import os
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class PolicyError(RuntimeError):
    """Base class for LDAP policy mutation failures."""


class PolicyUnavailable(PolicyError):
    """LDAP policy path or YAML support is unavailable."""


class PolicyConflict(PolicyError):
    """LDAP policy changed since the administrator loaded it."""


@dataclass(frozen=True)
class PolicyMutation:
    fingerprint: str
    backup_id: str
    allowed_users: tuple[str, ...]


class LDAPPolicyStore:
    """Atomically mutate ldap.allowed_users while preserving other YAML fields."""

    _lock = threading.Lock()

    def __init__(self, path: str | os.PathLike[str] | None):
        self.path = Path(path).expanduser() if path else None

    @contextmanager
    def _file_lock(self):
        if self.path is None:
            raise PolicyUnavailable("LDAP configuration path is not configured")
        lock_path = self.path.with_name(f".{self.path.name}.lock")
        try:
            with lock_path.open("a+", encoding="utf-8") as lock:
                os.chmod(lock_path, 0o600)
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        except OSError as exc:
            raise PolicyUnavailable("LDAP configuration lock is unavailable") from exc

    def _read(self) -> tuple[bytes, dict[str, Any], str]:
        if self.path is None:
            raise PolicyUnavailable("LDAP configuration path is not configured")
        if self.path.is_symlink():
            raise PolicyUnavailable("LDAP configuration symlinks are not supported")
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise PolicyUnavailable("LDAP configuration cannot be read") from exc
        fingerprint = hashlib.sha256(raw).hexdigest()
        try:
            import yaml

            document = yaml.safe_load(raw) or {}
        except ImportError as exc:
            raise PolicyUnavailable(
                "PyYAML is required for LDAP policy mutation"
            ) from exc
        except Exception as exc:
            raise PolicyError("LDAP configuration is not valid YAML") from exc
        if not isinstance(document, dict) or not isinstance(document.get("ldap"), dict):
            raise PolicyError("LDAP configuration must contain a mapping at ldap")
        allowed = document["ldap"].get("allowed_users")
        if not isinstance(allowed, list):
            raise PolicyError(
                "LDAP policy mutation requires ldap.allowed_users to be a list"
            )
        return raw, document, fingerprint

    def snapshot(self) -> dict[str, Any]:
        _raw, document, fingerprint = self._read()
        allowed = tuple(
            str(item).strip()
            for item in document["ldap"].get("allowed_users", [])
            if str(item).strip()
        )
        return {"fingerprint": fingerprint, "allowed_users": list(allowed)}

    def mutate(
        self,
        username: str,
        enabled: bool,
        expected_fingerprint: str | None = None,
    ) -> PolicyMutation:
        with self._lock, self._file_lock():
            _raw, document, current_fingerprint = self._read()
            if expected_fingerprint and expected_fingerprint != current_fingerprint:
                raise PolicyConflict(
                    "LDAP configuration changed; reload policy before retrying"
                )
            allowed = [
                str(item).strip()
                for item in document["ldap"].get("allowed_users", [])
                if str(item).strip()
            ]
            folded = username.casefold()
            if enabled:
                if not any(item.casefold() == folded for item in allowed):
                    allowed.append(username)
            else:
                allowed = [item for item in allowed if item.casefold() != folded]
            document["ldap"]["allowed_users"] = allowed
            try:
                import yaml

                rendered = yaml.safe_dump(
                    document, sort_keys=False, allow_unicode=True
                ).encode("utf-8")
            except ImportError as exc:
                raise PolicyUnavailable(
                    "PyYAML is required for LDAP policy mutation"
                ) from exc
            except Exception as exc:
                raise PolicyError("LDAP configuration could not be rendered") from exc
            backup_id = (
                f"{self.path.name}.bak-{time.time_ns()}-{current_fingerprint[:12]}"
            )
            backup = self.path.with_name(backup_id)
            temp_name = ""
            try:
                mode = self.path.stat().st_mode & 0o777
                shutil.copyfile(self.path, backup)
                os.chmod(backup, mode & 0o600 or 0o600)
                fd, temp_name = tempfile.mkstemp(
                    prefix=f".{self.path.name}.", dir=self.path.parent
                )
                try:
                    os.fchmod(fd, mode & 0o600 or 0o600)
                    with os.fdopen(fd, "wb") as temp:
                        temp.write(rendered)
                        temp.flush()
                        os.fsync(temp.fileno())
                    os.replace(temp_name, self.path)
                finally:
                    if temp_name and os.path.exists(temp_name):
                        os.unlink(temp_name)
            except OSError as exc:
                raise PolicyUnavailable(
                    "LDAP configuration could not be replaced safely"
                ) from exc
            new_fingerprint = hashlib.sha256(rendered).hexdigest()
            return PolicyMutation(new_fingerprint, backup_id, tuple(allowed))


def valid_username(value: str) -> bool:
    return bool(value) and len(value) <= 128 and "\x00" not in value


_live_config: Any = None
_session_manager: Any = None


def configure_live_policy(config: Any, session_manager: Any = None) -> None:
    global _live_config, _session_manager
    _live_config = config
    _session_manager = session_manager


def apply_live_allowlist(allowed_users: list[str]) -> None:
    ldap_settings = getattr(_live_config, "ldap", None)
    if ldap_settings is not None:
        ldap_settings.allowed_users = list(allowed_users)


def live_session_manager() -> Any:
    return _session_manager
