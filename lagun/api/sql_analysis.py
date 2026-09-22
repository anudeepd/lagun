"""SQL text analysis shared by the query, export and import paths.

Pure string work: no database access and no FastAPI imports, so it is safe to
use from any layer. Everything here is deliberately conservative — the helpers
answer "what kind of statement is this?" and "what does it reference?", never
"is this SQL safe to run?".

MySQL executable comments (``/*!12345 ... */``) are executed by the server, so
their body is treated as real SQL throughout: it is kept visible to every
classifier rather than blanked like an ordinary comment. Getting that wrong is
not cosmetic — ``SELECT ... /*!50000 INTO OUTFILE '/x' */`` really does write a
file, and ``/*!50000 SELECT */ * FROM t`` really does return rows.
"""

from __future__ import annotations

import re

_SQL_IDENTIFIER_RE = r"(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)"
_SQL_TABLE_REF_RE = (
    rf"(?P<first>{_SQL_IDENTIFIER_RE})(?:\s*\.\s*(?P<second>{_SQL_IDENTIFIER_RE}))?"
)

# Statement kinds that return rows and whose grammar accepts a trailing LIMIT.
# Verified against MySQL 8.0: `TABLE t LIMIT 1` and `VALUES ROW(1) LIMIT 1` are
# valid, while `DESCRIBE t LIMIT 1`, `SHOW CREATE TABLE t LIMIT 1` and
# `SHOW TABLES LIMIT 1` are all syntax errors — so SHOW/DESC/DESCRIBE/EXPLAIN are
# deliberately excluded even though they return rows.
RESULT_PRODUCING_KINDS = frozenset({"SELECT", "WITH", "TABLE", "VALUES"})
_WRITE_KINDS = frozenset({"INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE"})

# Clauses that turn a SELECT into a server-side file write.
_FILE_WRITE_CLAUSE_RE = re.compile(r"\bINTO\s+(?:OUTFILE|DUMPFILE)\b", re.IGNORECASE)

# Grammar slots that must follow a LIMIT, so a LIMIT is inserted before them.
# `SELECT ... FOR UPDATE LIMIT 1` is a syntax error; `SELECT ... LIMIT 1 FOR UPDATE` is not.
_TRAILING_LOCK_RE = re.compile(
    r"\b(FOR\s+UPDATE|FOR\s+SHARE|LOCK\s+IN\s+SHARE\s+MODE)\s*;?\s*$", re.IGNORECASE
)


def _skip_comment(sql: str, start: int) -> int:
    """Index just past the comment beginning at *start*, or len(sql)."""
    i = start + 2
    while i + 1 < len(sql) and not (sql[i] == "*" and sql[i + 1] == "/"):
        i += 1
    return min(len(sql), i + 2)


def strip_comments_and_literals(sql: str) -> str:
    """Blank out comments and string/identifier contents, preserving structure.

    Keywords inside a comment, a string literal or a quoted identifier must not
    be mistaken for statement keywords, so each is replaced by a placeholder of
    the same shape. The one exception is an executable comment (``/*!``): MySQL
    runs its body, so the body is kept and only the markers and version number
    are dropped.
    """
    result: list[str] = []
    i = 0
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if ch == "-" and nxt == "-":
            i += 2
            while i < len(sql) and sql[i] != "\n":
                i += 1
            result.append(" ")
        elif ch == "#":
            i += 1
            while i < len(sql) and sql[i] != "\n":
                i += 1
            result.append(" ")
        elif ch == "/" and nxt == "*":
            if i + 2 < len(sql) and sql[i + 2] == "!":
                i += 3
                while i < len(sql) and (sql[i].isdigit() or sql[i] in " \t"):
                    i += 1
                result.append(" ")
                continue
            i = _skip_comment(sql, i)
            result.append(" ")
        elif ch == "'":
            i += 1
            while i < len(sql):
                if sql[i] == "\\" and i + 1 < len(sql) and sql[i + 1] == "'":
                    i += 2
                elif sql[i] == "'" and i + 1 < len(sql) and sql[i + 1] == "'":
                    i += 2
                elif sql[i] == "'":
                    i += 1
                    break
                else:
                    i += 1
            result.append("''")
        elif ch == '"':
            i += 1
            while i < len(sql):
                if sql[i] == '"' and i + 1 < len(sql) and sql[i + 1] == '"':
                    i += 2
                elif sql[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
            result.append('""')
        elif ch == "`":
            result.append("`")
            i += 1
            while i < len(sql) and sql[i] != "`":
                result.append("_")
                i += 1
            if i < len(sql):
                result.append("`")
                i += 1
        else:
            result.append(ch)
            i += 1
    return "".join(result)


def unwrap_executable_comments(sql: str) -> str:
    """Drop the ``/*!``/``*/`` markers but keep the body MySQL would execute.

    Used where identifiers matter (a stripped text replaces identifier contents
    with underscores), so a leading version comment cannot hide a statement's
    target table.
    """
    if "/*!" not in sql:
        return sql
    result: list[str] = []
    i = 0
    while i < len(sql):
        if sql.startswith("/*!", i):
            i += 3
            while i < len(sql) and (sql[i].isdigit() or sql[i] in " \t"):
                i += 1
            result.append(" ")
            continue
        if sql.startswith("*/", i):
            i += 2
            result.append(" ")
            continue
        result.append(sql[i])
        i += 1
    return "".join(result)


def statement_kind(statement: str) -> str | None:
    """First keyword of a statement, ignoring leading comments and literals."""
    stripped = strip_comments_and_literals(statement)
    m = re.search(r"\b([A-Za-z]+)\b", stripped)
    return m.group(1).upper() if m else None


def top_level_keywords(statement: str) -> list[str]:
    """Keywords appearing outside any parentheses, in order.

    ``WITH cte AS (SELECT ...) UPDATE t SET ...`` yields ``["WITH", "UPDATE"]``,
    which is what lets callers distinguish a CTE-wrapped SELECT from a
    CTE-wrapped write.
    """
    stripped = strip_comments_and_literals(statement)
    keywords: list[str] = []
    depth = 0
    for match in re.finditer(r"[A-Za-z_]+|[()]", stripped):
        token = match.group(0)
        if token == "(":
            depth += 1
        elif token == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            keywords.append(token.upper())
    return keywords


def is_result_producing(statement: str) -> bool:
    """True when the statement returns rows and can safely take a LIMIT clause."""
    keywords = top_level_keywords(statement)
    if not keywords:
        return False
    kind = keywords[0]
    if kind not in RESULT_PRODUCING_KINDS:
        return False
    if kind == "WITH":
        # MySQL allows WITH before UPDATE/DELETE/INSERT; a trailing LIMIT would
        # be a syntax error there, so require a result-producing top-level verb.
        return not any(word in _WRITE_KINDS for word in keywords[1:])
    return True


def has_top_level_limit(statement: str) -> bool:
    """True when the statement already carries a LIMIT outside any subquery."""
    return "LIMIT" in top_level_keywords(statement)


def writes_server_file(statement: str) -> bool:
    """True when a SELECT would write to a server-side file (INTO OUTFILE)."""
    return bool(_FILE_WRITE_CLAUSE_RE.search(strip_comments_and_literals(statement)))


def has_top_level_into(statement: str) -> bool:
    """True when the statement has a top-level INTO clause.

    ``SELECT ... INTO OUTFILE`` / ``INTO @var`` do not return a row set to the
    client, and their grammar puts the clause where a LIMIT cannot follow, so the
    row limit is skipped rather than appended into a syntax error.
    """
    return "INTO" in top_level_keywords(statement)


def add_row_limit(statement: str, limit: int) -> str | None:
    """Return *statement* with a LIMIT applied, or None when none is needed.

    None means "leave the statement alone": it is not a row-returning statement,
    it already has a top-level LIMIT, or its grammar has nowhere to put one.
    """
    if limit <= 0 or not is_result_producing(statement):
        return None
    if has_top_level_limit(statement) or has_top_level_into(statement):
        return None
    lock = _TRAILING_LOCK_RE.search(statement)
    if lock:
        return f"{statement[: lock.start()].rstrip()} LIMIT {limit} {lock.group(1)}"
    return f"{statement} LIMIT {limit}"


def _unquote_sql_identifier(identifier: str) -> str:
    identifier = identifier.strip()
    if identifier.startswith("`") and identifier.endswith("`"):
        return identifier[1:-1].replace("``", "`")
    return identifier


# Leading comments of any kind, including a version comment, before the verb.
_LEADING_COMMENT_PREFIX = r"^\s*(?:(?:--[^\n]*\n|#[^\n]*\n|/\*[\s\S]*?\*/)\s*)*"
_WS_OR_END = r"(?:\s|$)"


def _target_patterns(prefix: str) -> list[str]:
    ref = _SQL_TABLE_REF_RE
    ws = _WS_OR_END
    return [
        rf"{prefix}INSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+)?(?:IGNORE\s+)?INTO\s+{ref}{ws}",
        rf"{prefix}REPLACE\s+(?:LOW_PRIORITY\s+|DELAYED\s+)?(?:INTO\s+)?{ref}{ws}",
        rf"{prefix}UPDATE\s+{ref}\s+SET\b",
        rf"{prefix}UPDATE\s+{ref}\s+(?:AS\s+)?{_SQL_IDENTIFIER_RE}\s+SET\b",
        rf"{prefix}DELETE\s+FROM\s+{ref}{ws}",
        rf"{prefix}DELETE\b[^;]*?\bFROM\s+{ref}{ws}",
        rf"{prefix}TRUNCATE\s+(?:TABLE\s+)?{ref}{ws}",
        rf"{prefix}CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{ref}{ws}",
        rf"{prefix}ALTER\s+TABLE\s+{ref}{ws}",
        rf"{prefix}DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?{ref}{ws}",
        # RENAME reaches into two schemas: the destination (where the table lands)
        # and the source (the table being moved). Check both.
        rf"{prefix}RENAME\s+TABLE\s+{_SQL_IDENTIFIER_RE}\s+TO\s+{ref}{ws}",
        rf"{prefix}RENAME\s+TABLE\s+{ref}\s+TO\s+{_SQL_IDENTIFIER_RE}{ws}",
        rf"{prefix}CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+{_SQL_IDENTIFIER_RE}\s+ON\s+{ref}{ws}",
        rf"{prefix}LOCK\s+TABLES\s+{ref}{ws}",
        rf"{prefix}LOAD\s+DATA\b[^;]*?\bINTO\s+TABLE\s+{ref}{ws}",
    ]


def target_table(statement: str) -> tuple[str | None, str] | None:
    """The (schema, table) a write statement targets, when it can be determined.

    ``schema`` is None for an unqualified reference, which means "the connection's
    current database". Returns None when the statement is not a recognised write
    — callers that need a hard decision must treat None as "unknown", not "safe".
    """
    candidates = [statement]
    unwrapped = unwrap_executable_comments(statement)
    if unwrapped != statement:
        candidates.append(unwrapped)
    for candidate in candidates:
        for pattern in _target_patterns(_LEADING_COMMENT_PREFIX):
            m = re.search(pattern, candidate, re.IGNORECASE)
            if not m:
                continue
            first = _unquote_sql_identifier(m.group("first"))
            second = m.group("second")
            if second:
                return first, _unquote_sql_identifier(second)
            return None, first
    return None
