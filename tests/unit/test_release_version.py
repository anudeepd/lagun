import json
from pathlib import Path

import pytest

from scripts.release_version import current_version, next_version, set_version


def release_root(tmp_path: Path) -> Path:
    (tmp_path / "frontend").mkdir()
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "lagun"\nversion = "0.1.100"\n')
    (tmp_path / "uv.lock").write_text(
        'version = 1\n\n[[package]]\nname = "lagun"\nversion = "0.1.100"\n'
    )
    frontend = {"name": "lagun-frontend", "version": "0.1.100"}
    package_lock = {
        "name": "lagun-frontend",
        "version": "0.1.100",
        "packages": {"": {"name": "lagun-frontend", "version": "0.1.100"}},
    }
    (tmp_path / "frontend/package.json").write_text(json.dumps(frontend))
    (tmp_path / "frontend/package-lock.json").write_text(json.dumps(package_lock))
    return tmp_path


def test_next_version_applies_semver_bump(tmp_path: Path) -> None:
    root = release_root(tmp_path)

    assert next_version(root, "patch") == "0.1.101"
    assert next_version(root, "minor") == "0.2.0"
    assert next_version(root, "major") == "1.0.0"


def test_set_version_synchronizes_project_and_npm_manifests(tmp_path: Path) -> None:
    root = release_root(tmp_path)
    set_version(root, "0.2.0")

    assert 'version = "0.2.0"' in (root / "pyproject.toml").read_text()
    assert json.loads((root / "frontend/package.json").read_text())["version"] == "0.2.0"
    lock = json.loads((root / "frontend/package-lock.json").read_text())
    assert lock["version"] == lock["packages"][""]["version"] == "0.2.0"

    (root / "uv.lock").write_text(
        (root / "uv.lock").read_text().replace('version = "0.1.100"', 'version = "0.2.0"')
    )
    assert current_version(root) == "0.2.0"


def test_set_version_rejects_non_semver(tmp_path: Path) -> None:
    root = release_root(tmp_path)

    with pytest.raises(SystemExit, match="stable MAJOR.MINOR.PATCH"):
        set_version(root, "1.2.3-rc1")
