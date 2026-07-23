"""Small LDAP-aware authorization helpers.

These helpers deliberately become no-ops for the existing single-user mode.
"""

import os

from fastapi import HTTPException, Request


def ldap_enabled() -> bool:
    return bool(os.getenv("LAGUN_LDAP_CONFIG"))


def request_username(request: Request) -> str | None:
    """Return the username installed by ldapgate, if LDAP mode is enabled."""
    if not ldap_enabled():
        return None
    username = getattr(request.state, "user", None)
    if not isinstance(username, str) or not username:
        raise HTTPException(401, "LDAP user identity is missing")
    return username
