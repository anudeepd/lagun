"""Lagun — web-based MySQL/MariaDB editor."""

import tomllib
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def _resolve_version() -> str:
    """Return the package version, from installed metadata when there is one.

    ``pyproject.toml`` is the single source of truth: an installed distribution
    carries the version setuptools stamped into it from that file, and an
    uninstalled checkout (``python -c "import lagun"`` from the repository root)
    is read back from the same file.
    """
    try:
        return version("lagun")
    except PackageNotFoundError:
        pass
    try:
        with (Path(__file__).resolve().parent.parent / "pyproject.toml").open(
            "rb"
        ) as fh:
            return str(tomllib.load(fh)["project"]["version"])
    except (OSError, KeyError, TypeError, ValueError):
        return "0.0.0+unknown"


__version__ = _resolve_version()
