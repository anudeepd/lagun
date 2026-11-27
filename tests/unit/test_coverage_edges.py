import datetime as dt

import pytest

import lagun
import lagun.db.crypto as crypto
from lagun.db.net_policy import (
    HostNotAllowedError,
    allowed_hosts,
    host_allowed,
    require_host_allowed,
)
from lagun.db.row_key import RowKey, select_row_key
from lagun.db.utils import (
    escape_value,
    format_mysql_time,
    validate_collation,
)
from lagun.limits import _positive_env_int


def test_package_version_falls_back_to_pyproject(monkeypatch):
    def missing(_name):
        raise lagun.PackageNotFoundError

    monkeypatch.setattr(lagun, "version", missing)
    assert lagun._resolve_version() == "0.3.0"


def test_package_version_unknown_when_pyproject_cannot_be_read(monkeypatch):
    def missing(_name):
        raise lagun.PackageNotFoundError

    monkeypatch.setattr(lagun, "version", missing)
    monkeypatch.setattr(
        lagun.Path,
        "open",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("missing")),
    )
    assert lagun._resolve_version() == "0.0.0+unknown"


def test_positive_env_int_falls_back_for_invalid_and_non_positive_values(monkeypatch):
    monkeypatch.setenv("LAGUN_TEST_LIMIT", "not-a-number")
    assert _positive_env_int("LAGUN_TEST_LIMIT", 7) == 7
    monkeypatch.setenv("LAGUN_TEST_LIMIT", "0")
    assert _positive_env_int("LAGUN_TEST_LIMIT", 7) == 1


class _KeyCursor:
    def __init__(self, rows):
        self.rows = rows

    async def execute(self, *_args):
        return None

    async def fetchall(self):
        return self.rows


@pytest.mark.asyncio
async def test_row_key_skips_functional_and_nullable_unique_indexes():
    functional = _KeyCursor([("functional_idx", None, "")])
    assert await select_row_key(functional, "app", "events") is None

    nullable = _KeyCursor([("email", "email", "YES")])
    assert await select_row_key(nullable, "app", "users") is None


@pytest.mark.asyncio
async def test_row_key_prefers_primary_and_shortest_unique_index():
    cursor = _KeyCursor(
        [
            ("email", "email", ""),
            ("email", "tenant", ""),
            ("PRIMARY", "id", ""),
        ]
    )
    assert await select_row_key(cursor, "app", "users") == RowKey(
        columns=("id",), kind="primary"
    )


def test_utils_cover_negative_time_collation_and_timedelta_values():
    assert format_mysql_time(dt.timedelta(microseconds=-1)) == "-00:00:00.000001"
    assert format_mysql_time(dt.timedelta(days=1, seconds=2, microseconds=3)) == (
        "24:00:02.000003"
    )
    assert escape_value(dt.timedelta(seconds=1)) == "'00:00:01'"
    with pytest.raises(ValueError, match="Invalid collation"):
        validate_collation("utf8mb4; DROP TABLE")


def test_net_policy_reads_exact_wildcard_ip_and_cidr_rules(monkeypatch):
    monkeypatch.setenv(
        "LAGUN_ALLOWED_DB_HOSTS",
        " db.internal, *.example.test, 10.0.0.0/8, 192.168.1.5 ",
    )
    assert allowed_hosts() == (
        "db.internal",
        "*.example.test",
        "10.0.0.0/8",
        "192.168.1.5",
    )
    assert host_allowed("DB.INTERNAL") is True
    assert host_allowed("api.example.test") is True
    assert host_allowed("10.2.3.4") is True
    assert host_allowed("192.168.1.5") is True
    assert host_allowed("192.168.1.6") is False
    assert host_allowed("other.test") is False
    assert host_allowed("") is False


def test_net_policy_allows_everything_without_rules_and_skips_bad_networks(monkeypatch):
    assert host_allowed("anything") is True
    assert host_allowed("10.0.0.1", ("not-a-network",)) is False
    monkeypatch.setenv("LAGUN_ALLOWED_DB_HOSTS", "allowed.test")
    with pytest.raises(HostNotAllowedError):
        require_host_allowed("blocked.test")
    assert host_allowed("blocked.test", ("*.test",)) is True


def test_crypto_uses_a_keyring_value_without_writing(monkeypatch):
    import sys
    import types

    fake = types.ModuleType("keyring")
    writes = []
    fake.get_password = lambda service, account: "stored-key"
    fake.set_password = lambda service, account, value: writes.append(value)
    monkeypatch.setitem(sys.modules, "keyring", fake)

    assert crypto._get_or_create_master_key() == b"stored-key"
    assert writes == []


def test_crypto_creates_and_stores_a_keyring_value(monkeypatch):
    import sys
    import types

    fake = types.ModuleType("keyring")
    writes = []
    fake.get_password = lambda service, account: None
    fake.set_password = lambda service, account, value: writes.append(value)
    monkeypatch.setitem(sys.modules, "keyring", fake)

    key = crypto._get_or_create_master_key()
    assert len(key) > 20
    assert writes == [key.decode()]


def test_crypto_harden_permissions_ignores_stat_errors():
    class BrokenPath:
        def stat(self):
            raise OSError("gone")

    crypto._harden_permissions(BrokenPath())


def test_crypto_leaves_an_already_private_key_file_untouched(tmp_path):
    key = tmp_path / "master.key"
    key.write_bytes(b"secret")
    key.chmod(0o600)

    crypto._harden_permissions(key)

    assert key.stat().st_mode & 0o777 == 0o600
