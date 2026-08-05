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


def admin_users() -> list[str]:
    """Return normalized LDAP usernames allowed to use the admin console."""
    raw = os.getenv("LAGUN_ADMIN_USERS", "")
    return sorted({user.strip().lower() for user in raw.split(",") if user.strip()})


def is_admin_user(username: str | None) -> bool:
    return bool(username and username.strip().lower() in admin_users())


def request_admin_username(request: Request) -> str:
    """Require LDAP authentication plus the explicit administrator allowlist."""
    if not ldap_enabled():
        raise HTTPException(
            403,
            "Admin console requires LDAP authentication and LAGUN_ADMIN_USERS.",
        )
    username = request_username(request)
    if not username or not is_admin_user(username):
        raise HTTPException(403, "Administrator access denied")
    return username
