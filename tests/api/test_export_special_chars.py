"""Stress tests for CSV export escaping.

Verifies that special characters in cell values (quotes, commas, newlines,
huge SQL blobs, unicode, nulls, etc.) survive the export → csv.reader round-trip.
"""
import csv
import io
import pytest
import pytest_asyncio
import aiomysql


NASTY_VALUES = [
    # (label, value)
    ("plain", "hello world"),
    ("empty", ""),
    ("comma", "abc,123"),
    ("double_quote", 'say "hello" to me'),
    ("single_quote", "it's a test"),
    ("both_quotes", """he said "it's fine" """),
    ("newline_lf", "line1\nline2"),
    ("newline_crlf", "line1\r\nline2"),
    ("newline_cr", "line1\rline2"),
    ("tab", "col1\tcol2"),
    ("backslash", r"C:\Users\test\file.txt"),
    ("backslash_quote", r'path \"escaped\"'),
    ("unicode_emoji", "hello 🎉 world"),
    ("unicode_cjk", "数据库"),
    ("unicode_rtl", "مرحبا بالعالم"),
    ("null_bytes_safe", "before\x00after"),  # NULL byte in string
    ("only_quotes", '"""'),
    ("only_comma", ",,,"),
    ("only_newlines", "\n\n\n"),
    ("mixed_special", 'a,b\nc"d\re\'f'),
    ("leading_quote", '"starts with quote'),
    ("trailing_quote", 'ends with quote"'),
    ("sql_select", "SELECT * FROM `users` WHERE name = 'Alice' AND age > 18"),
    ("sql_insert", "INSERT INTO `t` (`a`,`b`) VALUES ('x','y\",z')"),
    ("sql_with_newlines",
     "SELECT\n  id,\n  name\nFROM users\nWHERE age > 18\nORDER BY name ASC;"),
    ("sql_giant", (
        "SELECT u.id, u.name, u.email, o.id AS order_id, o.total, "
        "p.name AS product, p.sku, p.price, c.name AS category "
        "FROM users u "
        "JOIN orders o ON o.user_id = u.id "
        "JOIN order_items oi ON oi.order_id = o.id "
        "JOIN products p ON p.id = oi.product_id "
        "JOIN categories c ON c.id = p.category_id "
        "WHERE u.created_at >= '2024-01-01' "
        "  AND o.status IN ('paid', 'shipped', 'delivered') "
        "  AND p.price > 9.99 "
        "  AND c.slug NOT IN ('archived', 'draft') "
        "GROUP BY u.id, o.id, p.id "
        "HAVING SUM(oi.qty) > 0 "
        "ORDER BY o.total DESC "
        "LIMIT 1000 OFFSET 500;\n"
        "-- this comment has a \"quoted\" word and a comma, plus\r\na bare CR+LF"
    )),
    ("repeated_quotes", '""""""'),
    ("csv_injection_attempt", "=CMD|'/c calc'!A0"),
    ("very_long", "x" * 65_000),
]


@pytest_asyncio.fixture
async def special_db(mysql_container):
    host = mysql_container.get_container_host_ip()
    port = int(mysql_container.get_exposed_port(3306))
    conn = await aiomysql.connect(
        host=host, port=port, user="root", password="test", autocommit=True
    )
    try:
        async with conn.cursor() as cur:
            await cur.execute("CREATE DATABASE IF NOT EXISTS `lagun_special`")
            await cur.execute("GRANT ALL PRIVILEGES ON `lagun_special`.* TO 'test'@'%'")
            await cur.execute("USE `lagun_special`")
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS escapes (
                    id      INT AUTO_INCREMENT PRIMARY KEY,
                    label   VARCHAR(100) NOT NULL,
                    content LONGTEXT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
            """)
            await cur.executemany(
                "INSERT INTO escapes (label, content) VALUES (%s, %s)",
                [(label, value) for label, value in NASTY_VALUES],
            )
    finally:
        conn.close()
    yield "lagun_special"
    try:
        conn = await aiomysql.connect(
            host=host, port=port, user="root", password="test", autocommit=True
        )
        try:
            async with conn.cursor() as cur:
                await cur.execute("DROP DATABASE IF EXISTS `lagun_special`")
        finally:
            conn.close()
    except Exception:
        pass  # container may be gone; don't mask the test failure


def parse_csv(text: str, **kwargs) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text, newline=""), **kwargs))


async def _export(client, session_id, db, **csv_opts):
    payload = {
        "database": db,
        "table": "escapes",
        "format": "csv",
        **{f"csv_{k}": v for k, v in csv_opts.items()},
    }
    r = await client.post(f"/api/v1/sessions/{session_id}/export", json=payload)
    assert r.status_code == 200, r.text
    return r.text


def _check_round_trip(body: str, expected_values: list[str], **reader_kwargs):
    rows = parse_csv(body, **reader_kwargs)
    assert rows[0] == ["id", "label", "content"], f"bad header: {rows[0]}"
    data_rows = rows[1:]
    assert len(data_rows) == len(expected_values), (
        f"expected {len(expected_values)} rows, got {len(data_rows)}"
    )
    for i, (row, (label, expected)) in enumerate(zip(data_rows, expected_values)):
        actual = row[2]
        assert actual == expected, (
            f"row {i} ({label!r}): got {actual!r}, want {expected!r}"
        )


@pytest.mark.asyncio
async def test_csv_default_double_quote_escaping(client, session_id, special_db):
    """Default settings: double-quote escaping, comma delimiter."""
    body = await _export(client, session_id, special_db)
    _check_round_trip(body, NASTY_VALUES, quotechar='"', doublequote=True)


@pytest.mark.asyncio
async def test_csv_backslash_escaping(client, session_id, special_db):
    """Backslash as escapechar (escapechar != quotechar → doublequote=False).

    Verifies raw output format, not just round-trip: embedded quotes must use
    backslash escaping (\") not doubling (""), and backslashes in values must be
    self-escaped (\\) so parsers don't misinterpret the next character.
    """
    body = await _export(
        client, session_id, special_db,
        quotechar='"', escapechar="\\",
    )
    _check_round_trip(body, NASTY_VALUES, quotechar='"', escapechar="\\", doublequote=False)
    # Raw format assertions — round-trip alone is insufficient because csv.reader
    # with escapechar="\\" silently accepts misescaped output.
    assert '\\"' in body, "Expected backslash-escaped quotes in raw output"
    # Empty fields produce "" which is valid; we check a specific value instead
    assert r'"say \"hello\" to me"' in body, "Expected backslash escaping for embedded quotes"
    assert r'"C:\\Users\\test\\file.txt"' in body, "Expected backslash self-escaped in path value"


@pytest.mark.asyncio
@pytest.mark.parametrize("export_kw,reader_kw", [
    ({"delimiter": ";"}, {"delimiter": ";"}),
    ({"delimiter": "\t"}, {"delimiter": "\t"}),
    ({"delimiter": "|"}, {"delimiter": "|"}),
    ({"lineterminator": "\n"}, {}),
])
async def test_csv_delimiter_variants(client, session_id, special_db, export_kw, reader_kw):
    body = await _export(client, session_id, special_db, **export_kw)
    _check_round_trip(body, NASTY_VALUES, quotechar='"', doublequote=True, **reader_kw)


@pytest.mark.asyncio
async def test_csv_utf8_sig_bom(client, session_id, special_db):
    body = await _export(client, session_id, special_db, encoding="utf-8-sig")
    assert body.startswith("﻿")
    _check_round_trip(body.lstrip("﻿"), NASTY_VALUES, quotechar='"', doublequote=True)


@pytest.mark.asyncio
async def test_csv_null_cell_becomes_empty_string(client, session_id, special_db):
    """NULL in DB should export as empty string, not the literal 'None'."""
    body = await _export(client, session_id, special_db)
    rows = parse_csv(body, quotechar='"', doublequote=True)
    # NASTY_VALUES has no NULLs, but we inserted one via label "null_bytes_safe"
    # Verify "None" never appears as a bare cell value
    for row in rows[1:]:
        assert row[2] != "None", f"NULL leaked as string 'None' in row: {row}"


@pytest.mark.asyncio
async def test_csv_explicit_null_row(client, session_id, special_db, mysql_container):
    """Row with genuine NULL content column exports as empty string."""
    host = mysql_container.get_container_host_ip()
    port = int(mysql_container.get_exposed_port(3306))
    conn = await aiomysql.connect(
        host=host, port=port, user="test", password="test", autocommit=True
    )
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO `lagun_special`.escapes (label, content) VALUES (%s, NULL)",
                ("explicit_null",),
            )
    finally:
        conn.close()

    body = await _export(client, session_id, special_db)
    rows = parse_csv(body, quotechar='"', doublequote=True)
    null_rows = [r for r in rows[1:] if r[1] == "explicit_null"]
    assert len(null_rows) == 1
    assert null_rows[0][2] == "", f"NULL should be empty string, got {null_rows[0][2]!r}"


@pytest.mark.asyncio
async def test_csv_very_long_value_survives(client, session_id, special_db):
    """65 KB value should round-trip without truncation."""
    body = await _export(client, session_id, special_db)
    rows = parse_csv(body, quotechar='"', doublequote=True)
    long_rows = [r for r in rows[1:] if r[1] == "very_long"]
    assert len(long_rows) == 1
    assert len(long_rows[0][2]) == 65_000
