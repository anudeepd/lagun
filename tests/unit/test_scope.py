"""Unit tests for per-connection database scope resolution.

The scope model has two lists with different owners:

* ``managed_selected_databases`` — the administrator's allowlist, a hard ceiling.
* ``selected_databases`` — the user's narrowing. Empty means "everything the
  administrator allows" for a managed connection, and "everything" for a
  private one. A shared connection is one row for several users, so that value
  is kept per user (``session_user_scope``) and loaded for the acting user only;
  the row's own column is the narrowing of a private connection, or of the local
  single-user install.

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
from lagun.db import session_store
from lagun.db.connections_config import sync_connections_config
from lagun.models.session import SessionCreate, SessionUpdate


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


# ---------------------------------------------------------------------------
# A shared (connections.yaml) connection keeps each user's narrowing to itself
# ---------------------------------------------------------------------------


def _act_as(username: str) -> None:
    """Install *username* for the store's per-user scope resolution.

    Nothing is reset here on purpose: the middleware (the only other caller) runs
    set and reset in one request context, while a test body runs in a context of
    its own, so the value cannot leak into another test.
    """
    session_store.set_acting_username(username)


def _write_shared_config(tmp_path, ceiling):
    config = tmp_path / "connections.yaml"
    config.write_text(
        "connections:\n"
        "  - id: shared\n"
        "    name: Shared\n"
        "    username: shared_user\n"
        "    password_env: TEST_SHARED_PASSWORD\n"
        f"    selected_databases: [{', '.join(ceiling)}]\n"
        "    allowed_users: [alice, bob]\n",
        encoding="utf-8",
    )
    return config


async def _shared_session(monkeypatch, tmp_path, ceiling=("app_db", "analytics")):
    """A managed row whose allowlist covers alice and bob."""
    await session_store.init_db()
    monkeypatch.setenv("TEST_SHARED_PASSWORD", "shared-secret")
    config = _write_shared_config(tmp_path, ceiling)
    await sync_connections_config(str(config))
    return (await session_store.list_sessions_for_user("alice"))[0].id


async def _shared_column(session_id) -> str:
    async with session_store._connect() as db:
        async with db.execute(
            "SELECT selected_databases FROM sessions WHERE id = ?", (session_id,)
        ) as cur:
            return (await cur.fetchone())[0]


async def test_two_users_narrow_one_shared_session_independently(
    monkeypatch, tmp_path, keep_event_loop_awake
):
    session_id = await _shared_session(monkeypatch, tmp_path)

    _act_as("alice")
    alice = await session_store.update_session(
        session_id, SessionUpdate(selected_databases=["app_db"])
    )
    assert alice.selected_databases == ["app_db"]
    assert effective_scope(alice) == frozenset({"app_db"})

    _act_as("bob")
    bob = await session_store.get_session(session_id)
    # Bob narrowed nothing, so he still sees everything the admin allows.
    assert bob.selected_databases == []
    assert effective_scope(bob) == frozenset({"app_db", "analytics"})

    _act_as("alice")
    reloaded = await session_store.get_session(session_id)
    assert effective_scope(reloaded) == frozenset({"app_db"})
    # Alice's choice never landed on the row both users share.
    assert await _shared_column(session_id) == "[]"


async def test_the_ceiling_bounds_each_users_own_narrowing(
    monkeypatch, tmp_path, keep_event_loop_awake
):
    session_id = await _shared_session(monkeypatch, tmp_path)

    _act_as("alice")
    await session_store.update_session(
        session_id, SessionUpdate(selected_databases=["app_db"])
    )
    _act_as("bob")
    await session_store.update_session(
        session_id, SessionUpdate(selected_databases=["analytics"])
    )

    # The administrator shrinks the allowlist; a stored narrowing outside it is
    # bounded immediately because the ceiling is applied at read time.
    config = _write_shared_config(tmp_path, ("analytics",))
    await sync_connections_config(str(config))

    _act_as("alice")
    stored_alice = await session_store.get_session(session_id)
    assert effective_scope(stored_alice) == frozenset()
    with pytest.raises(HTTPException) as excinfo:
        require_db_scope(stored_alice, "app_db")
    assert excinfo.value.status_code == 403

    _act_as("bob")
    stored_bob = await session_store.get_session(session_id)
    assert effective_scope(stored_bob) == frozenset({"analytics"})


async def test_unmanaged_session_keeps_its_own_column(keep_event_loop_awake):
    await session_store.init_db()
    _act_as("alice")
    private = await session_store.create_session(
        SessionCreate(name="Private", username="db", password="p"),
        "alice",
    )

    updated = await session_store.update_session(
        private.id, SessionUpdate(selected_databases=["mine"])
    )

    assert updated.selected_databases == ["mine"]
    assert effective_scope(updated) == frozenset({"mine"})
    async with session_store._connect() as db:
        async with db.execute("SELECT COUNT(*) FROM session_user_scope") as cur:
            assert (await cur.fetchone())[0] == 0


async def test_shared_session_without_a_known_user_keeps_the_column(
    monkeypatch, tmp_path, keep_event_loop_awake
):
    """The local single-user install (no LDAP) behaves exactly as before."""
    session_id = await _shared_session(monkeypatch, tmp_path)

    updated = await session_store.update_session(
        session_id, SessionUpdate(selected_databases=["app_db"])
    )

    assert updated.selected_databases == ["app_db"]
    assert effective_scope(updated) == frozenset({"app_db"})
    assert await _shared_column(session_id) == '["app_db"]'
    async with session_store._connect() as db:
        async with db.execute("SELECT COUNT(*) FROM session_user_scope") as cur:
            assert (await cur.fetchone())[0] == 0
