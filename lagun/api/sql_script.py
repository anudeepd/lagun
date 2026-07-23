"""Incremental parsing helpers for MySQL SQL scripts."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from io import StringIO
from typing import Iterator, TextIO

_DEFAULT_MAX_STATEMENT_BYTES = 64 * 1024 * 1024
_DELIMITER_RE = re.compile(r"^\s*DELIMITER(?:\s+)(\S+)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class SqlStatement:
    sql: str
    line: int


class SqlScriptError(ValueError):
    """Raised when a SQL script cannot be split safely."""


def _max_statement_bytes() -> int:
    return int(
        os.getenv("LAGUN_IMPORT_MAX_STATEMENT_BYTES", str(_DEFAULT_MAX_STATEMENT_BYTES))
    )


def _has_sql_content(text: str) -> bool:
    """Return whether text contains SQL or an executable MySQL comment."""
    i = 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        if text.startswith("--", i):
            end = text.find("\n", i + 2)
            i = len(text) if end < 0 else end + 1
            continue
        if text[i] == "#":
            end = text.find("\n", i + 1)
            i = len(text) if end < 0 else end + 1
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                return True
            if text.startswith("/*!", i):
                return True
            i = end + 2
            continue
        return True
    return False


def _directive_line(line: str) -> str | None:
    if not re.match(r"^\s*DELIMITER\b", line, re.IGNORECASE):
        return None
    match = _DELIMITER_RE.match(line)
    if not match:
        raise SqlScriptError("DELIMITER directive requires a non-whitespace terminator")
    token = match.group(1)
    if any(ch.isspace() for ch in token):
        raise SqlScriptError("DELIMITER directive requires a non-whitespace terminator")
    return token


def iter_sql_statements(
    stream: TextIO, *, mysql_delimiter: bool = True
) -> Iterator[SqlStatement]:
    """Yield SQL statements from *stream* without loading the script at once."""
    delimiter = ";"
    current: list[str] = []
    current_bytes = 0
    statement_line = 1
    line = 1
    line_buffer_start = 0
    current_has_content = False
    in_single = in_double = in_backtick = False
    in_line_comment = in_block_comment = False
    escaped = False
    max_bytes = _max_statement_bytes()

    def append(text: str) -> None:
        nonlocal current_bytes
        current.append(text)
        current_bytes += len(text.encode("utf-8"))
        if current_bytes > max_bytes:
            raise SqlScriptError(
                f"SQL statement starting on line {statement_line} exceeds {max_bytes} bytes"
            )

    def process_line(*, newline: bool) -> None:
        nonlocal current_bytes, delimiter, line, line_buffer_start
        nonlocal statement_line, current_has_content
        candidate = "".join(current[line_buffer_start:]).rstrip("\r\n")
        directive = None
        if mysql_delimiter and not current_has_content:
            directive = _directive_line(candidate)
            if directive is None and _has_sql_content(candidate):
                current_has_content = True
            elif directive is not None:
                del current[line_buffer_start:]
                current_bytes = sum(len(part.encode("utf-8")) for part in current)
                delimiter = directive
                statement_line = line + 1
        if newline:
            line += 1
            if not current_has_content:
                statement_line = line
        line_buffer_start = len(current)

    def emit() -> SqlStatement | None:
        nonlocal current, current_bytes, line_buffer_start, current_has_content
        sql = "".join(current).strip()
        current = []
        current_bytes = 0
        line_buffer_start = 0
        current_has_content = False
        if not _has_sql_content(sql):
            return None
        return SqlStatement(sql=sql, line=statement_line)

    carry = ""
    while True:
        chunk = stream.read(64 * 1024)
        at_eof = not chunk
        data = carry + chunk
        carry = ""
        if not at_eof:
            keep = min(max(len(delimiter) - 1, 2), len(data))
            carry = data[-keep:]
            data = data[:-keep]
        i = 0
        while i < len(data):
            ch = data[i]
            nxt = data[i + 1] if i + 1 < len(data) else ""

            if in_line_comment:
                append(ch)
                if ch == "\n":
                    in_line_comment = False
                    process_line(newline=True)
                i += 1
                continue

            if in_block_comment:
                if ch == "*" and nxt == "/":
                    append("*/")
                    i += 2
                    in_block_comment = False
                else:
                    append(ch)
                    if ch == "\n":
                        process_line(newline=True)
                    i += 1
                continue

            if in_single or in_double or in_backtick:
                quote = "'" if in_single else '"' if in_double else "`"
                append(ch)
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == quote:
                    if nxt == quote:
                        append(nxt)
                        i += 2
                        continue
                    in_single = in_double = in_backtick = False
                if ch == "\n":
                    process_line(newline=True)
                i += 1
                continue

            if ch == "-" and nxt == "-":
                append("--")
                in_line_comment = True
                i += 2
                continue
            if ch == "#":
                append(ch)
                in_line_comment = True
                i += 1
                continue
            if ch == "/" and nxt == "*":
                append("/*")
                in_block_comment = True
                i += 2
                continue
            if ch == "'":
                append(ch)
                in_single = True
                escaped = False
                i += 1
                continue
            if ch == '"':
                append(ch)
                in_double = True
                escaped = False
                i += 1
                continue
            if ch == "`":
                append(ch)
                in_backtick = True
                escaped = False
                i += 1
                continue

            if delimiter and data.startswith(delimiter, i):
                if mysql_delimiter and not current_has_content:
                    candidate = "".join(current[line_buffer_start:]) + delimiter
                    if _directive_line(candidate) is not None:
                        append(delimiter)
                        i += len(delimiter)
                        continue
                result = emit()
                if result is not None:
                    yield result
                i += len(delimiter)
                continue

            append(ch)
            i += 1
            if ch == "\n":
                process_line(newline=True)

        if at_eof:
            break

    if current:
        process_line(newline=False)
    if in_single or in_double or in_backtick:
        raise SqlScriptError(
            f"unterminated quoted value starting on line {statement_line}"
        )
    if in_block_comment:
        raise SqlScriptError(
            f"unterminated block comment starting on line {statement_line}"
        )
    result = emit()
    if result is not None:
        yield result


def split_sql_script(sql: str) -> list[str]:
    """In-memory adapter matching the bulk-query splitter semantics."""
    return [
        statement.sql
        for statement in iter_sql_statements(StringIO(sql), mysql_delimiter=False)
    ]
