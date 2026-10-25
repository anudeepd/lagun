#!/usr/bin/env python3
"""Read, calculate, and synchronize Lagun's release versions."""

from __future__ import annotations

import argparse
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")


def _read(root: Path) -> tuple[str, dict, dict, dict]:
    pyproject_path = root / "pyproject.toml"
    frontend_path = root / "frontend/package.json"
    package_lock_path = root / "frontend/package-lock.json"
    lock_path = root / "uv.lock"
    project = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
    frontend = json.loads(frontend_path.read_text(encoding="utf-8"))
    package_lock = json.loads(package_lock_path.read_text(encoding="utf-8"))
    uv_lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))

    version = project["project"]["version"]
    if project["project"]["name"] != "lagun":
        raise SystemExit(f"Expected project name 'lagun', got {project['project']['name']!r}")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise SystemExit(f"Expected a stable MAJOR.MINOR.PATCH version, got {version!r}")
    lock_versions = [item["version"] for item in uv_lock["package"] if item["name"] == "lagun"]
    versions = {
        "pyproject.toml": version,
        "frontend/package.json": frontend.get("version"),
        "frontend/package-lock.json": package_lock.get("version"),
        "frontend/package-lock.json packages root": package_lock.get("packages", {}).get("", {}).get("version"),
        "uv.lock": lock_versions[0] if len(lock_versions) == 1 else lock_versions,
    }
    if any(value != version for value in versions.values()):
        raise SystemExit(f"Release versions are not synchronized: {versions}")
    return version, frontend, package_lock, project


def current_version(root: Path = ROOT) -> str:
    return _read(root)[0]


def next_version(root: Path = ROOT, bump: str = "patch") -> str:
    major, minor, patch = map(int, current_version(root).split("."))
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise SystemExit(f"Unsupported version bump: {bump!r}")


def set_version(root: Path, version: str) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit(f"Expected a stable MAJOR.MINOR.PATCH version, got {version!r}")
    current, frontend, package_lock, _ = _read(root)
    pyproject_path = root / "pyproject.toml"
    text = pyproject_path.read_text(encoding="utf-8")
    project_section = re.search(r"(?ms)^\[project\]\s*$(.*?)(?=^\[|\Z)", text)
    if project_section is None:
        raise SystemExit("Missing [project] section in pyproject.toml")
    updated_section, count = re.subn(
        r'(?m)^(version\s*=\s*)"[^\"]+"\s*$',
        lambda match: f'{match.group(1)}"{version}"',
        project_section.group(1),
    )
    if count != 1:
        raise SystemExit(f"Expected one [project].version field, found {count}")
    pyproject_path.write_text(text[: project_section.start(1)] + updated_section + text[project_section.end(1) :], encoding="utf-8")

    frontend["version"] = version
    package_lock["version"] = version
    package_lock.setdefault("packages", {}).setdefault("", {})["version"] = version
    (root / "frontend/package.json").write_text(json.dumps(frontend, indent=2) + "\n", encoding="utf-8")
    (root / "frontend/package-lock.json").write_text(json.dumps(package_lock, indent=2) + "\n", encoding="utf-8")
    print(f"Synchronized version {current} -> {version}; run 'uv lock' to update uv.lock.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("current", help="print and validate the synchronized current version")
    next_command = commands.add_parser("next", help="print the next semantic version")
    next_command.add_argument("--bump", choices=("patch", "minor", "major"), default="patch")
    set_command = commands.add_parser("set", help="synchronize pyproject and npm package versions")
    set_command.add_argument("version")
    args = parser.parse_args()
    if args.command == "current":
        print(current_version())
    elif args.command == "next":
        print(next_version(bump=args.bump))
    else:
        set_version(ROOT, args.version)


if __name__ == "__main__":
    main()
