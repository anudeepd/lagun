"""Shared SQL identifier quoting and validation utilities."""

import re
import math

SYSTEM_DBS = frozenset({"information_schema", "performance_schema", "sys", "mysql"})

_IDENT_RE = re.compile(r"^[\w$]+$", re.ASCII)


def quote_ident(name: str) -> str:
    """Quote a SQL identifier, rejecting anything that isn't a simple name."""
    if not _IDENT_RE.match(name):
        raise ValueError(f"Invalid identifier: {name!r}")
    return f"`{name}`"


# Allowlists for DDL values that get interpolated into SQL without parameterization.
_VALID_ENGINES = frozenset(
    {
        "InnoDB",
        "MyISAM",
        "MEMORY",
        "CSV",
        "ARCHIVE",
        "BLACKHOLE",
        "MERGE",
        "FEDERATED",
        "NDB",
    }
)
_VALID_INDEX_TYPES = frozenset({"BTREE", "HASH", "FULLTEXT", "SPATIAL"})

# Charset/collation: ASCII alphanumeric plus underscore only.
_CHARSET_RE = re.compile(r"^[a-zA-Z0-9_]+$")


def validate_engine(engine: str) -> str:
    upper = engine.upper()
    for valid in _VALID_ENGINES:
        if valid.upper() == upper:
            return valid
    raise ValueError(f"Unknown engine: {engine!r}")


def validate_index_type(index_type: str) -> str:
    upper = index_type.upper()
    for valid in _VALID_INDEX_TYPES:
        if valid.upper() == upper:
            return valid
    raise ValueError(f"Unknown index type: {index_type!r}")


def validate_charset(charset: str) -> str:
    if not _CHARSET_RE.match(charset):
        raise ValueError(f"Invalid charset: {charset!r}")
    return charset


def validate_collation(collation: str) -> str:
    if not _CHARSET_RE.match(collation):
        raise ValueError(f"Invalid collation: {collation!r}")
    return collation


def validate_col_type(col_type: str) -> str:
    """Validate a column type string.

    Allows things like VARCHAR(255), DECIMAL(10,2), INT UNSIGNED, etc.
    Rejects semicolons, comments, subqueries, and other SQL metacharacters.
    """
    forbidden = re.compile(r"[;\'\"\\]|--")
    if forbidden.search(col_type):
        raise ValueError(f"Invalid column type: {col_type!r}")
    # Block subqueries and SQL keywords that shouldn't appear in type definitions
    dangerous = re.compile(
        r"\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|UNION|INTO|FROM|WHERE|EXEC)\b",
        re.IGNORECASE,
    )
    if dangerous.search(col_type):
        raise ValueError(f"Invalid column type: {col_type!r}")
    return col_type


def escape_value(v) -> str:
    """Serialize a Python value as a lossless MySQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, float):
        if not math.isfinite(v):
            raise ValueError(f"MySQL cannot represent non-finite float {v!r}")
        return repr(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"0x{bytes(v).hex()}"
    s = str(v)
    if "\\" in s or "\0" in s or "\x1a" in s:
        return f"0x{s.encode('utf-8').hex()}"
    return f"'{s.replace(chr(39), chr(39) * 2)}'"


def escape_string_literal(val: str) -> str:
    """Escape a string for embedding in a SQL single-quoted literal.

    Returns the *inner* content (without surrounding quotes). Uses
    SQL-standard quote-doubling.  Rejects values containing dangerous
    metacharacters that should never appear in DDL string contexts.
    """
    if any(c in val for c in (";",)) or "--" in val or "/*" in val:
        raise ValueError(f"Value contains disallowed characters: {val!r}")
    return val.replace("'", "''")


_DEFAULT_EXPRESSION_RE = re.compile(
    r"^(?:(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|"
    r"LOCALTIMESTAMP)(?:\((?:[0-6])?\))?|(?:UUID|RAND)\(\))$",
    re.IGNORECASE,
)
_DEFAULT_TIMESTAMP_RE = re.compile(
    r"^CURRENT_TIMESTAMP(?:\((?:[0-6])?\))?$",
    re.IGNORECASE,
)


def format_default_clause(value: str | None, *, literal: bool = False) -> str:
    """Format a safe MySQL/MariaDB column DEFAULT clause."""
    if value is None:
        return ""
    stripped = value.strip()
    if literal:
        return f" DEFAULT '{escape_string_literal(value)}'"
    if stripped.upper() == "NULL":
        return f" DEFAULT {stripped}"
    if _DEFAULT_EXPRESSION_RE.fullmatch(stripped):
        expression = (
            stripped if _DEFAULT_TIMESTAMP_RE.fullmatch(stripped) else f"({stripped})"
        )
        return f" DEFAULT {expression}"
    return f" DEFAULT '{escape_string_literal(value)}'"
