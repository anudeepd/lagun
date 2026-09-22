"""Outbound host policy for database connection targets.

Lagun connects out from the server on request, so an operator can pin egress to
known hosts with ``LAGUN_ALLOWED_DB_HOSTS`` (comma separated; exact names,
``*.suffix`` wildcards, IPs and CIDRs). Unset means "any host", which keeps a
local single-user install working.

The check lives here rather than in the sessions API so that every path that can
open an outbound connection applies it: probe, saved-session test, session
create/update, and pool creation (which also covers sessions saved before the
allowlist was configured).
"""

from __future__ import annotations

import ipaddress
import os


class HostNotAllowedError(RuntimeError):
    """The configured egress allowlist does not include this host."""


def allowed_hosts() -> tuple[str, ...]:
    """The configured allowlist, read per call so tests and reloads see it."""
    raw = os.getenv("LAGUN_ALLOWED_DB_HOSTS", "")
    return tuple(entry.strip().lower() for entry in raw.split(",") if entry.strip())


def host_allowed(host: str, allowed: tuple[str, ...] | None = None) -> bool:
    """True when *host* may be connected to under the current policy."""
    entries = allowed_hosts() if allowed is None else allowed
    if not entries:
        return True
    candidate = (host or "").strip().lower()
    if not candidate:
        return False
    if candidate in entries:
        return True
    for entry in entries:
        if entry.startswith("*.") and candidate.endswith(entry[1:]):
            return True
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    for entry in entries:
        try:
            if address in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue
    return False


def require_host_allowed(host: str) -> None:
    """Raise :class:`HostNotAllowedError` when *host* is outside the policy."""
    if not host_allowed(host):
        raise HostNotAllowedError(
            "Connections to this host are not allowed by this server's configuration."
        )
