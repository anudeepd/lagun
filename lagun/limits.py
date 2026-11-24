"""Runtime limits shared by request models and API responses."""

from __future__ import annotations

import os


def _positive_env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(1, value)


# The UI offers typed limits up to this value and the server refuses anything
# larger. It is deliberately one setting: a second hard-coded ceiling in a
# request model would silently override the operator's configured value.
QUERY_MAX_RESULT_ROWS = _positive_env_int("LAGUN_QUERY_MAX_RESULT_ROWS", 1_000_000)
