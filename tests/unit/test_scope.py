"""Unit tests for per-connection database scope resolution.

The scope model has two lists with different owners:

* ``managed_selected_databases`` — the administrator's allowlist, a hard ceiling.
* ``selected_databases`` — the user's narrowing. Empty means "everything the
  administrator allows" for a managed connection, and "everything" for a
  private one.

These tests pin that difference, because treating an empty user list as
"unrestricted" on a managed connection is the authorization bypass this model
exists to prevent.
"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from lagun.api.scope import (
    clamp_to_ceiling,
    effective_scope,
    filter_databases,
    outside_ceiling,
    require_db_scope,
)


def session(*, managed=False, chosen=(), ceiling=()):
    return SimpleNamespace(
        managed=managed,
        selected_databases=list(chosen),
        managed_selected_databases=list(ceiling),
    )


# ---------------------------------------------------------------------------
# Private connections keep the original semantics
# ---------------------------------------------------------------------------


def test_private_session_without_a_list_is_unrestricted():
    assert effective_scope(session()) is None


def test_private_session_with_a_list_is_limited_to_it():
    assert effective_scope(session(chosen=["app_db"])) == frozenset({"app_db"})


# ---------------------------------------------------------------------------
# Managed connections are bounded by the administrator's ceiling
# ---------------------------------------------------------------------------


def test_managed_session_without_a_ceiling_is_unrestricted():
    assert effective_scope(session(managed=True)) is None


def test_managed_empty_user_list_means_the_ceiling_not_everything():
    scope = effective_scope(session(managed=True, ceiling=["app_db", "analytics"]))
    assert scope == frozenset({"app_db", "analytics"})


def test_managed_user_list_narrows_the_ceiling():
    scope = effective_scope(
        session(managed=True, chosen=["app_db"], ceiling=["app_db", "analytics"])
    )
    assert scope == frozenset({"app_db"})


def test_managed_user_list_cannot_exceed_the_ceiling():
    """A list stored before the ceiling shrank must not widen access again."""
    scope = effective_scope(
        session(managed=True, chosen=["app_db", "other_db"], ceiling=["app_db"])
    )
    assert scope == frozenset({"app_db"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_require_db_scope_allows_an_in_scope_database():
    require_db_scope(session(managed=True, ceiling=["app_db"]), "app_db")


def test_require_db_scope_rejects_an_out_of_scope_database():
    with pytest.raises(HTTPException) as excinfo:
        require_db_scope(session(managed=True, ceiling=["app_db"]), "other_db")
    assert excinfo.value.status_code == 403
    assert "not in this connection's allowed databases" in excinfo.value.detail


def test_require_db_scope_ignores_a_missing_database():
    require_db_scope(session(managed=True, ceiling=["app_db"]), None)
    require_db_scope(session(managed=True, ceiling=["app_db"]), "")


def test_clamp_to_ceiling_drops_outside_entries_and_duplicates():
    s = session(managed=True, ceiling=["app_db", "analytics"])
    assert clamp_to_ceiling(s, ["app_db", "other_db", "app_db"]) == ["app_db"]


def test_clamp_to_ceiling_is_a_no_op_without_a_ceiling():
    assert clamp_to_ceiling(session(), ["a", "a", "b"]) == ["a", "b"]


def test_outside_ceiling_reports_only_disallowed_entries():
    s = session(managed=True, ceiling=["app_db"])
    assert outside_ceiling(s, ["app_db", "other_db"]) == ["other_db"]
    assert outside_ceiling(session(), ["anything"]) == []


def test_filter_databases_keeps_only_the_scope():
    s = session(managed=True, chosen=["app_db"], ceiling=["app_db", "analytics"])
    assert filter_databases(s, ["app_db", "analytics", "mysql"]) == ["app_db"]


def test_filter_databases_passes_everything_through_when_unrestricted():
    databases = ["app_db", "analytics"]
    assert filter_databases(session(), databases) == databases
