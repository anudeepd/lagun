import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from lagun import ldap_policy
from lagun.ldap_policy import (
    LDAPPolicyStore,
    PolicyConflict,
    PolicyError,
    PolicyUnavailable,
    apply_live_allowlist,
    configure_live_policy,
    live_session_manager,
    valid_username,
)


def policy_file(tmp_path, allowed="alice\n    - bob", extra=""):
    path = tmp_path / "ldap.yaml"
    path.write_text(
        "ldap:\n"
        "  url: ldap://directory.internal\n"
        f"  allowed_users:\n    - {allowed}\n"
        f"{extra}",
        encoding="utf-8",
    )
    return path


def test_policy_snapshot_and_mutations_preserve_other_yaml(tmp_path):
    path = policy_file(tmp_path)
    store = LDAPPolicyStore(path)
    snapshot = store.snapshot()
    assert snapshot["allowed_users"] == ["alice", "bob"]
    assert len(snapshot["fingerprint"]) == 64

    added = store.mutate("carol", True)
    assert "carol" in added.allowed_users
    assert path.with_name(added.backup_id).exists()
    assert "url: ldap://directory.internal" in path.read_text(encoding="utf-8")

    duplicate = store.mutate("CAROL", True)
    assert duplicate.allowed_users == ("alice", "bob", "carol")

    removed = store.mutate("ALICE", False)
    assert "alice" not in removed.allowed_users

    with pytest.raises(PolicyConflict):
        store.mutate("dave", True, snapshot["fingerprint"])


def test_policy_rejects_unavailable_paths_and_symlinks(tmp_path):
    with pytest.raises(PolicyUnavailable):
        LDAPPolicyStore(None).snapshot()
    with pytest.raises(PolicyUnavailable):
        LDAPPolicyStore(None).mutate("alice", True)
    with pytest.raises(PolicyUnavailable):
        LDAPPolicyStore(tmp_path / "missing" / "ldap.yaml").snapshot()

    target = policy_file(tmp_path)
    link = tmp_path / "linked.yaml"
    link.symlink_to(target)
    with pytest.raises(PolicyUnavailable, match="symlinks"):
        LDAPPolicyStore(link).snapshot()

    def unreadable(self):
        raise OSError("denied")

    original = type(target).read_bytes
    type(target).read_bytes = unreadable
    try:
        with pytest.raises(PolicyUnavailable, match="cannot be read"):
            LDAPPolicyStore(target).snapshot()
    finally:
        type(target).read_bytes = original


def test_policy_reports_a_lock_that_cannot_be_opened(tmp_path, monkeypatch):
    path = policy_file(tmp_path)

    def unavailable(*_args, **_kwargs):
        raise OSError("lock denied")

    monkeypatch.setattr(Path, "open", unavailable)
    with pytest.raises(PolicyUnavailable, match="lock is unavailable"):
        LDAPPolicyStore(path).mutate("alice", True)


def test_policy_rejects_invalid_documents(tmp_path):
    cases = [
        "not: [valid",
        "- list\n",
        "ldap: []\n",
        "ldap:\n  allowed_users: alice\n",
    ]
    for content in cases:
        path = tmp_path / "invalid.yaml"
        path.write_text(content, encoding="utf-8")
        with pytest.raises(PolicyError):
            LDAPPolicyStore(path).snapshot()


def test_policy_reports_missing_yaml_and_render_failures(tmp_path, monkeypatch):
    path = policy_file(tmp_path)
    monkeypatch.setitem(sys.modules, "yaml", None)
    with pytest.raises(PolicyUnavailable, match="PyYAML"):
        LDAPPolicyStore(path).snapshot()

    monkeypatch.setitem(sys.modules, "yaml", yaml)

    def fail_dump(*_args, **_kwargs):
        raise OSError("cannot render")

    monkeypatch.setattr(yaml, "safe_dump", fail_dump)
    with pytest.raises(PolicyError, match="could not be rendered"):
        LDAPPolicyStore(path).mutate("carol", True)


def test_policy_reports_missing_yaml_during_render(tmp_path, monkeypatch):
    path = policy_file(tmp_path)
    store = LDAPPolicyStore(path)
    monkeypatch.setattr(
        store,
        "_read",
        lambda: (b"", {"ldap": {"allowed_users": ["alice"]}}, "fingerprint"),
    )
    monkeypatch.setitem(sys.modules, "yaml", None)

    with pytest.raises(PolicyUnavailable, match="PyYAML"):
        store.mutate("carol", True)


def test_policy_removes_a_pending_temp_file_when_replacement_fails(
    tmp_path, monkeypatch
):
    path = policy_file(tmp_path)

    def fail_replace(*_args, **_kwargs):
        raise OSError("replace denied")

    monkeypatch.setattr(ldap_policy.os, "replace", fail_replace)
    with pytest.raises(PolicyUnavailable, match="replaced safely"):
        LDAPPolicyStore(path).mutate("carol", True)

    pending = [
        candidate
        for candidate in tmp_path.iterdir()
        if candidate.name.startswith(f".{path.name}.")
        and candidate.name != f".{path.name}.lock"
    ]
    assert pending == []


def test_policy_reports_backup_failures(tmp_path, monkeypatch):
    path = policy_file(tmp_path)

    def fail_copy(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(ldap_policy.shutil, "copyfile", fail_copy)
    with pytest.raises(PolicyUnavailable, match="replaced safely"):
        LDAPPolicyStore(path).mutate("carol", True)


def test_policy_live_helpers_and_username_validation():
    ldap = SimpleNamespace(allowed_users=["alice"])
    config = SimpleNamespace(ldap=ldap)
    manager = object()
    configure_live_policy(config, manager)
    apply_live_allowlist(["bob"])
    assert ldap.allowed_users == ["bob"]
    assert live_session_manager() is manager

    assert valid_username("alice") is True
    assert valid_username("") is False
    assert valid_username("a" * 129) is False
    assert valid_username("a\x00b") is False
