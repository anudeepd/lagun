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

from lagun.db.utils import SYSTEM_DBS

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

# Verbs that carry a statement's target. A leading ``WITH`` prelude can precede
# any of them (``WITH cte AS (...) DELETE ...``), so target_table analyses from
# the verb rather than from the CTE list.
_WITH_TARGET_KINDS = _WRITE_KINDS | {
    "CREATE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "RENAME",
}

# Schemas a scoped session is never asked to allow: MySQL's own catalogs stay
# readable, while ``mysql`` (grants, credentials) is still refused. Membership
# is tested lower-cased because MySQL resolves these names case-insensitively.
SCOPE_REFERENCE_EXEMPT_SCHEMAS = SYSTEM_DBS - {"mysql"}

# Clauses that turn a SELECT into a server-side file write.

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


def _starts_dash_comment(sql: str, i: int) -> bool:
    """Whether the ``--`` at *i* opens a comment, per MySQL's lexer.

    MySQL requires the second dash to be followed by whitespace or a control
    character. ``--(`` and ``--+`` are two unary minus operators, and the text
    after them still executes — reading it as a comment hid live SQL from every
    caller of this module (``SELECT 1--(SELECT x FROM other_db.t)`` scanned as a
    bare ``SELECT 1``, so a scoped connection could read another schema).
    """
    after = sql[i + 2 : i + 3]
    return after == "" or after.isspace() or ord(after) < 32


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
        if ch == "-" and nxt == "-" and _starts_dash_comment(sql, i):
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
#
# The repeated group is atomic: each iteration may end with `\s*` and the next
# may start with `\s*`, so an ordinary `*` can split inter-comment whitespace
# exponentially many ways and every one of the ~20 patterns built on this prefix
# re-parses them. `/*a*/*40` before a non-matching verb was hours of event-loop
# time in a 240-byte request; atomic grouping makes the repetition all-or-nothing
# and the scan linear. Comments cannot hide a verb, so no backtracking into them
# is ever needed.
_LEADING_COMMENT_PREFIX = r"^\s*(?>(?:(?:--[^\n]*\n|#[^\n]*\n|/\*[\s\S]*?\*/)\s*)*)"
_WS_OR_END = r"(?:\s|$)"
# One or more whitespace characters or comments, atomic for the same reason as
# the prefix above. A verb and the name it introduces can be separated by a
# comment, which `\s+` misses (`USE /*c*/ other_db` scanned as naming no schema,
# and `USE` re-points the pooled connection).
_SEPARATOR = r"(?>(?:\s|--(?=[\s\x00-\x1f])[^\n]*|#[^\n]*|/\*[\s\S]*?\*/))+"


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
        # ALTER TABLE ... RENAME reaches a second schema; like RENAME TABLE, the
        # destination is checked first so the source pattern cannot mask it.
        # COLUMN/INDEX/KEY renames stay inside the table, so they are excluded.
        rf"{prefix}ALTER\s+TABLE\s+{_SQL_IDENTIFIER_RE}\s+RENAME\s+(?!(?:COLUMN|INDEX|KEY)\b)(?:TO\s+|AS\s+)?{ref}{ws}",
        rf"{prefix}ALTER\s+TABLE\s+{ref}{ws}",
        # DROP INDEX names its table after ON, which the reference scan cannot
        # treat as a table position (`JOIN ... ON a.b = c.d` would misread a
        # column), so it needs its own pattern.
        rf"{prefix}DROP\s+INDEX\s+{_SQL_IDENTIFIER_RE}\s+ON\s+{ref}{ws}",
        rf"{prefix}DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?{ref}{ws}",
        # RENAME reaches into two schemas: the destination (where the table lands)
        # and the source (the table being moved). Check both.
        rf"{prefix}RENAME\s+TABLE\s+{_SQL_IDENTIFIER_RE}\s+TO\s+{ref}{ws}",
        rf"{prefix}RENAME\s+TABLE\s+{ref}\s+TO\s+{_SQL_IDENTIFIER_RE}{ws}",
        rf"{prefix}CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+{_SQL_IDENTIFIER_RE}\s+ON\s+{ref}{ws}",
        rf"{prefix}LOCK\s+TABLES\s+{ref}{ws}",
        rf"{prefix}LOAD\s+DATA\b[^;]*?\bINTO\s+TABLE\s+{ref}{ws}",
    ]


# Table-position keywords: only schema.table after these counts as schema use.
# Column refs (t.col in SELECT/WHERE) never count, so alias dots cause no false 403.
#
# The object-DDL keywords are here for the same reason. `CREATE VIEW db.v`,
# `DROP TRIGGER db.trg`, `CREATE PROCEDURE db.p()` and `CREATE EVENT db.e` all
# name a schema in exactly this position, and no target pattern covers them, so
# without these a scoped connection could create an object in another schema.
# They are reserved words in MySQL, and a false hit needs a dotted reference
# immediately after the keyword (`event.name` reads as a column, not a schema,
# because the dot is consumed as the name's qualifier start and rejected).
_TABLE_REF_KEYWORDS = frozenset(
    {
        "FROM",
        "JOIN",
        "INTO",
        "UPDATE",
        "TABLE",
        "VIEW",
        "TRIGGER",
        "PROCEDURE",
        "FUNCTION",
        "EVENT",
        # `STRAIGHT_JOIN` contains `JOIN` after an underscore, so `\bJOIN\b`
        # does not match it and the name it introduces went unscanned.
        "STRAIGHT_JOIN",
    }
)

# Words that never name a table alias. Checked upper-cased.
_RESERVED_TABLE_WORDS = frozenset(
    {
        "WHERE",
        "GROUP",
        "ORDER",
        "HAVING",
        "LIMIT",
        "OFFSET",
        "FOR",
        "LOCK",
        "ON",
        "USING",
        "JOIN",
        "INNER",
        "LEFT",
        "RIGHT",
        "FULL",
        "OUTER",
        "CROSS",
        "NATURAL",
        "STRAIGHT_JOIN",
        "SELECT",
        "UPDATE",
        "DELETE",
        "INSERT",
        "REPLACE",
        "FROM",
        "UNION",
        "EXCEPT",
        "INTERSECT",
        "BY",
        "ASC",
        "DESC",
        "AS",
        "AND",
        "OR",
        "NOT",
        "NULL",
        "IN",
        "IS",
        "LIKE",
        "BETWEEN",
        "CASE",
        "WHEN",
        "THEN",
        "ELSE",
        "END",
        "SET",
        "VALUES",
        "DUPLICATE",
        "KEY",
        "PARTITION",
        "PROCEDURE",
        "OUTFILE",
        "DUMPFILE",
        "SHARE",
        "MODE",
        "INTO",
        "TABLE",
        "ORDER",
        "GROUP",
    }
)

_USE_SCHEMA_RE = re.compile(
    # The leading-comment prefix is not optional polish: without it a plain
    # comment hides the statement (`/* hint */ USE other_db` scanned as "no
    # schema referenced"), and `USE` then switches the pooled connection's
    # default schema outside the scope the check just enforced.
    # Comments may separate `USE` from its name, so the separator is not `\s+`.
    rf"{_LEADING_COMMENT_PREFIX}USE{_SEPARATOR}(?P<name>{_SQL_IDENTIFIER_RE})",
    re.IGNORECASE,
)

_ROUTINE_REF_RE = re.compile(
    rf"(?P<schema>{_SQL_IDENTIFIER_RE})\s*\.\s*(?P<obj>{_SQL_IDENTIFIER_RE})\s*\(",
    re.IGNORECASE,
)


def _mask_strings_and_comments(sql: str) -> str:
    """Blank strings/comments, keep backtick identifiers and structure.

    Every offset survives, so an index into the masked text still points at the
    same character of *sql*.
    """
    out: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-" and _starts_dash_comment(sql, i):
            while i < n and sql[i] != "\n":
                out.append(" ")
                i += 1
        elif ch == "#":
            while i < n and sql[i] != "\n":
                out.append(" ")
                i += 1
        elif ch == "/" and nxt == "*":
            end = _skip_comment(sql, i)
            out.append(" " * (end - i))
            i = end
        elif ch == "`":
            # A backtick identifier is opaque: its contents are copied verbatim
            # so the name stays readable to the dotted-name scan, but they are
            # never re-interpreted. A quote inside one used to start a "string"
            # and blank the rest of the statement, hiding a later reference.
            out.append(ch)
            i += 1
            while i < n:
                out.append(sql[i])
                if sql[i] == "`":
                    i += 1
                    break
                i += 1
        elif ch == "'":
            out.append(" ")
            i += 1
            while i < n:
                if sql[i] == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                elif sql[i] == "'" and i + 1 < n and sql[i + 1] == "'":
                    out.append("  ")
                    i += 2
                elif sql[i] == "'":
                    out.append(" ")
                    i += 1
                    break
                else:
                    out.append(" ")
                    i += 1
        elif ch == '"':
            out.append(" ")
            i += 1
            while i < n:
                if sql[i] == '"' and i + 1 < n and sql[i + 1] == '"':
                    out.append("  ")
                    i += 2
                elif sql[i] == '"':
                    out.append(" ")
                    i += 1
                    break
                else:
                    out.append(" ")
                    i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _read_dotted_name(text: str, pos: int) -> tuple[str | None, str | None, int]:
    """Read [schema.]table at pos. Returns (schema, table, end)."""
    m = re.match(rf"(?P<first>{_SQL_IDENTIFIER_RE})", text[pos:], re.IGNORECASE)
    if not m:
        return None, None, pos
    first_raw = m.group("first")
    after = pos + m.end()
    j = after
    while j < len(text) and text[j] in " \t\n\r":
        j += 1
    if j < len(text) and text[j] == ".":
        k = j + 1
        while k < len(text) and text[k] in " \t\n\r":
            k += 1
        m2 = re.match(rf"(?P<second>{_SQL_IDENTIFIER_RE})", text[k:], re.IGNORECASE)
        if m2:
            return (
                _unquote_sql_identifier(first_raw),
                _unquote_sql_identifier(m2.group("second")),
                k + m2.end(),
            )
    return None, _unquote_sql_identifier(first_raw), after


def _skip_table_alias(text: str, pos: int) -> int:
    """Skip optional [AS] alias after a table ref. Reserved words never alias."""
    j = pos
    while j < len(text) and text[j] in " \t\n\r":
        j += 1
    m = re.match(r"(?:AS\s+)?", text[j:], re.IGNORECASE)
    k = j + (m.end() if m else 0)
    while k < len(text) and text[k] in " \t\n\r":
        k += 1
    m2 = re.match(rf"(?P<alias>{_SQL_IDENTIFIER_RE})", text[k:], re.IGNORECASE)
    if m2 and m2.group("alias").upper() not in _RESERVED_TABLE_WORDS:
        return k + m2.end()
    return pos


def _scan_table_reference_schemas(sql: str) -> set[str]:
    """Schemas in table positions only: FROM/JOIN/INTO/UPDATE/TABLE lists.

    Column dots (t.col) ignored, so aliases never false-positive.
    Comma lists (FROM a.t, b.u) fully walked. Subqueries included.
    """
    masked = _mask_strings_and_comments(sql)
    schemas: set[str] = set()
    keyword_alt = "|".join(sorted(_TABLE_REF_KEYWORDS))
    for m in re.finditer(rf"\b({keyword_alt})\b", masked, re.IGNORECASE):
        keyword = m.group(1).upper()
        pos = m.end()
        while True:
            while pos < len(masked) and masked[pos] in " \t\n\r":
                pos += 1
            # `DROP VIEW IF EXISTS other_db.v` puts the existence clause between
            # the keyword and the object name, so the next token is `IF`. MySQL
            # allows only IF [NOT] EXISTS there, which cannot be a table name.
            exists = re.match(r"IF\s+(?:NOT\s+)?EXISTS\b", masked[pos:], re.IGNORECASE)
            if exists:
                pos += exists.end()
                continue
            if pos < len(masked) and masked[pos] == ",":
                pos += 1
                continue
            # A parenthesised table factor (`FROM (other_db.t)`) puts `(` where
            # the name would be. For `FROM (SELECT …)` the next token is a
            # keyword, which `_read_dotted_name` rejects, so this stays harmless.
            if pos < len(masked) and masked[pos] == "(":
                pos += 1
                continue
            schema, _table, end = _read_dotted_name(masked, pos)
            if _table is None:
                break
            if schema:
                schemas.add(schema)
            pos = _skip_table_alias(masked, end)
            if keyword in ("FROM", "JOIN"):
                while pos < len(masked) and masked[pos] in " \t\n\r":
                    pos += 1
                if pos < len(masked) and masked[pos] == ",":
                    pos += 1
                    continue
            break
    return schemas


def _use_schema(statement: str) -> str | None:
    m = _USE_SCHEMA_RE.match(unwrap_executable_comments(statement))
    if m:
        return _unquote_sql_identifier(m.group("name"))
    return None


def target_database(statement: str) -> str | None:
    """The schema a database-level DDL statement names, when it is explicit.

    Covers ``CREATE/DROP/ALTER DATABASE|SCHEMA`` with optional
    ``IF [NOT] EXISTS``. Returns None for anything else. Like
    :func:`target_table`, callers must treat None as "unknown", not "safe".
    """
    candidate = unwrap_executable_comments(statement)
    patterns = [
        rf"{_LEADING_COMMENT_PREFIX}CREATE\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>{_SQL_IDENTIFIER_RE}){_WS_OR_END}",
        rf"{_LEADING_COMMENT_PREFIX}DROP\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(?P<name>{_SQL_IDENTIFIER_RE}){_WS_OR_END}",
        rf"{_LEADING_COMMENT_PREFIX}ALTER\s+(?:DATABASE|SCHEMA)\s+(?P<name>{_SQL_IDENTIFIER_RE})(?:{_WS_OR_END}|(?:\s+[A-Z]))",
    ]
    for pattern in patterns:
        m = re.search(pattern, candidate, re.IGNORECASE)
        if m:
            return _unquote_sql_identifier(m.group("name"))
    return None


def referenced_schemas(statement: str) -> set[str]:
    """Every schema name explicitly referenced by a raw read or write statement.

    Only table positions (FROM/JOIN/INTO/UPDATE/TABLE lists), routine calls
    (schema.func(), target DDL/table targets, USE. Column dots (t.col,
    alias.column) never count, so aliases cannot false-positive into 403.
    Unqualified references resolve to the current database and are excluded.
    Schema-qualified routine bodies beyond schema.func() stay covered by
    MySQL grants as deeper gate.
    """
    unwrapped = unwrap_executable_comments(statement)
    schemas = _scan_table_reference_schemas(unwrapped)
    for m in _ROUTINE_REF_RE.finditer(_mask_strings_and_comments(unwrapped)):
        schemas.add(_unquote_sql_identifier(m.group("schema")))
    use = _use_schema(statement)
    if use:
        schemas.add(use)
    db = target_database(statement)
    if db:
        schemas.add(db)
    target = target_table(statement)
    if target is not None:
        schema, _ = target
        if schema:
            schemas.add(schema)
    return schemas


# Word tokens of the top-level keyword scan, same shape as top_level_keywords.
_SQL_WORD_RE = re.compile(r"[A-Za-z_]+")


def _with_main_verb_offset(statement: str) -> int | None:
    """Offset of the write verb a leading ``WITH`` prelude hides, else None.

    ``top_level_keywords`` names that verb but not where it is, and its stripped
    text has no stable offsets. The position comes from the masked text instead,
    whose offsets do map back onto *statement*. CTE bodies are parenthesised, so
    only the statement's own verb sits at depth zero, and backtick-quoted names
    are skipped so a CTE called ``delete`` cannot be read as the verb.
    """
    keywords = top_level_keywords(statement)
    verb = next((k for k in keywords[1:] if k in _WITH_TARGET_KINDS), None)
    if verb is None:
        return None
    masked = _mask_strings_and_comments(statement)
    depth = 0
    pos = 0
    while pos < len(masked):
        ch = masked[pos]
        if ch == "`":
            pos += 1
            while pos < len(masked) and masked[pos] != "`":
                pos += 1
            pos += 1
        elif ch == "(":
            depth += 1
            pos += 1
        elif ch == ")":
            depth = max(0, depth - 1)
            pos += 1
        else:
            m = _SQL_WORD_RE.match(masked, pos)
            if not m:
                pos += 1
                continue
            if depth == 0 and m.group(0).upper() == verb:
                return pos
            pos = m.end()
    return None


def _multi_table_delete_target(statement: str) -> tuple[str | None, str] | None:
    """The (schema, table) a multi-table ``DELETE`` list names, else None.

    ``DELETE t1, t2 FROM t1 JOIN t2 ...`` names its targets before FROM: the
    FROM-table pattern only sees the source side, so resolve the leading target
    list too. The scan skips comments and literals, and backtick-quoted names
    keep their real spelling.
    """
    stripped = strip_comments_and_literals(statement)
    m = re.match(
        r"\s*DELETE\s+(?P<targets>.+?)\s+(?P<from_kw>FROM)\b",
        stripped,
        re.IGNORECASE | re.DOTALL,
    )
    if not m or re.match(r"^\s*FROM\b", m.group("targets"), re.IGNORECASE):
        return None
    # `stripped` blanks out backtick-quoted identifier contents (see
    # strip_comments_and_literals), so the FROM position it locates is used to
    # slice the original `statement` instead, keeping real identifier spelling.
    # `stripped` preserves `statement`'s length/positions, so the offset lines
    # up in both — a second, independently-cased search here previously went
    # looking for a literal "FROM" and silently fell back to the whole
    # statement (including the FROM/JOIN clause) whenever the query used
    # lowercase "from".
    head = statement[: m.start("from_kw")]
    for raw_schema, raw_table in re.findall(
        rf"({_SQL_IDENTIFIER_RE})\s*\.\s*({_SQL_IDENTIFIER_RE})",
        head,
    ):
        return _unquote_sql_identifier(raw_schema), _unquote_sql_identifier(raw_table)
    return None


def target_table(statement: str) -> tuple[str | None, str] | None:
    """The (schema, table) a write statement targets, when it can be determined.

    ``schema`` is None for an unqualified reference, which means "the connection's
    current database". Returns None when the statement is not a recognised write
    — callers that need a hard decision must treat None as "unknown", not "safe".
    Multi-table ``DELETE t1, t2 FROM ...`` resolves the leading target list, so
    delete targets before FROM are included, not just the FROM-table source.
    A leading ``WITH`` prelude hides the verb behind its CTE list, so the
    statement is analysed from that verb onward — the same reading
    :func:`is_result_producing` already applies to ``WITH`` + write.
    """
    unwrapped = unwrap_executable_comments(statement)
    sliced = None
    if statement_kind(unwrapped) == "WITH":
        offset = _with_main_verb_offset(unwrapped)
        if offset is not None:
            sliced = unwrapped[offset:]
    candidates = [statement]
    if unwrapped != statement:
        candidates.append(unwrapped)
    if sliced is not None:
        candidates.append(sliced)
    for candidate in candidates:
        if candidate is not None:
            # A multi-table DELETE names its targets BEFORE `FROM`, and MySQL
            # deletes from that list, so it must beat the generic
            # `DELETE … FROM <ref>` pattern: `DELETE other_db.t1 FROM app_db.t1`
            # otherwise resolved `app_db` and let a scoped connection delete
            # from another schema.
            target = _multi_table_delete_target(candidate)
            if target is not None:
                return target
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
