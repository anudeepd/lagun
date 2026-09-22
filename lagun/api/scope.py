"""Per-connection database scope.

A saved connection carries two lists:

* ``managed_selected_databases`` — the administrator's allowlist for a shared
  connection defined in ``connections.yaml``. Only an administrator changes it,
  and it acts as a hard ceiling. An **empty** ceiling means the administrator
  deliberately placed no restriction (this matches the documented meaning of
  omitting ``selected_databases`` in ``connections.yaml``: "show all non-system
  schemas"); the loader logs a warning when a managed entry has no allowlist so
  that choice is never silent.
* ``selected_databases`` — the databases the *user* narrowed the connection to.
  For a managed connection an empty list means "everything the administrator
  allows", never "everything on the server".

For a private (user-created) connection there is no ceiling and the user's own
list is the scope; an empty list means unrestricted, which keeps a local
single-user install behaving as before.

Every endpoint that touches a named database must call :func:`require_db_scope`
before acquiring a connection, so the check can never be bypassed by reaching a
different code path.
"""

from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException

_SCOPE_ERROR = "Database '{db}' is not in this connection's allowed databases."


def _ceiling(session) -> frozenset[str]:
    if not getattr(session, "managed", False):
        return frozenset()
    return frozenset(session.managed_selected_databases or [])


def effective_scope(session) -> frozenset[str] | None:
    """The databases this session may touch, or ``None`` when unrestricted."""
    chosen = frozenset(session.selected_databases or [])
    ceiling = _ceiling(session)
    if not ceiling:
        # Unmanaged connection, or a managed one with no administrator ceiling.
        return chosen or None
    return (chosen & ceiling) if chosen else ceiling


def clamp_to_ceiling(session, databases: Iterable[str]) -> list[str]:
    """Drop duplicates and anything the administrator's ceiling excludes."""
    values = list(dict.fromkeys(databases or []))
    ceiling = _ceiling(session)
    if not ceiling:
        return values
    return [db for db in values if db in ceiling]


def outside_ceiling(session, databases: Iterable[str]) -> list[str]:
    """User-supplied databases the administrator's ceiling does not include."""
    ceiling = _ceiling(session)
    if not ceiling:
        return []
    return [db for db in dict.fromkeys(databases or []) if db not in ceiling]


def require_db_scope(session, db: str | None) -> None:
    """Raise 403 when *db* falls outside this connection's allowed databases."""
    if not db:
        return
    scope = effective_scope(session)
    if scope is not None and db not in scope:
        raise HTTPException(403, _SCOPE_ERROR.format(db=db))


def filter_databases(session, databases: Iterable[str]) -> list[str]:
    """Restrict a database listing to the ones this session may use."""
    scope = effective_scope(session)
    if scope is None:
        return list(databases)
    return [db for db in databases if db in scope]
