"""Unit tests for the shared SQL text analysis helpers.

These back three behaviours that were previously regex-based and wrong:

* the auto-LIMIT safety net must fire for every result-producing statement, not
  just ones that literally start with ``SELECT``;
* a LIMIT inside a subquery must not suppress it;
* the export allowlist must accept a CTE-select and reject a server-side file
  write even when a comment splits the keywords.
"""

from lagun.api.sql_analysis import (
    add_row_limit,
    has_top_level_limit,
    is_result_producing,
    statement_kind,
    target_table,
    top_level_keywords,
    writes_server_file,
)


# ---------------------------------------------------------------------------
# statement_kind / top_level_keywords
# ---------------------------------------------------------------------------


def test_statement_kind_ignores_leading_comments():
    assert statement_kind("/* hint */ SELECT 1") == "SELECT"
    assert statement_kind("-- why\n SELECT 1") == "SELECT"
    assert statement_kind("# why\nSELECT 1") == "SELECT"


def test_statement_kind_ignores_keywords_inside_strings_and_identifiers():
    assert statement_kind("SELECT 'DELETE FROM x'") == "SELECT"
    assert statement_kind("SELECT `update` FROM t") == "SELECT"


def test_top_level_keywords_skips_nested_parentheses():
    keywords = top_level_keywords("WITH cte AS (SELECT 1) DELETE FROM t")
    assert keywords[0] == "WITH"
    assert "DELETE" in keywords
    # The CTE body's SELECT is inside parentheses, so it is not a top-level verb.
    assert "SELECT" not in keywords


# ---------------------------------------------------------------------------
# is_result_producing
# ---------------------------------------------------------------------------


def test_limit_capable_kinds():
    """Kinds whose grammar accepts a trailing LIMIT (verified against MySQL 8.0)."""
    for sql in (
        "SELECT 1",
        "WITH cte AS (SELECT 1) SELECT * FROM cte",
        "TABLE users",
        "VALUES ROW(1)",
    ):
        assert is_result_producing(sql), sql


def test_row_returning_kinds_without_a_limit_production_are_excluded():
    """These return rows but `... LIMIT n` is a 1064, so they must not be limited."""
    for sql in (
        "SHOW DATABASES",
        "SHOW CREATE TABLE t",
        "DESCRIBE users",
        "EXPLAIN SELECT 1",
    ):
        assert not is_result_producing(sql), sql


def test_non_result_statements_are_never_limited():
    for sql in (
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "INSERT INTO t VALUES (1)",
        "CREATE TABLE t (id INT)",
        "WITH cte AS (SELECT 1) UPDATE t SET a = 1",
        "",
    ):
        assert not is_result_producing(sql), sql


# ---------------------------------------------------------------------------
# has_top_level_limit
# ---------------------------------------------------------------------------


def test_top_level_limit_is_detected():
    assert has_top_level_limit("SELECT * FROM t LIMIT 5")
    assert has_top_level_limit("SELECT * FROM t limit 5")


def test_subquery_limit_does_not_count_as_a_top_level_limit():
    """A LIMIT in a subquery does not bound the outer result set."""
    assert not has_top_level_limit("SELECT * FROM (SELECT 1 LIMIT 1) x")


def test_limit_inside_a_string_is_not_a_limit():
    assert not has_top_level_limit("SELECT 'LIMIT 5' AS s")


# ---------------------------------------------------------------------------
# writes_server_file
# ---------------------------------------------------------------------------


def test_server_side_file_writes_are_detected():
    assert writes_server_file("SELECT * FROM t INTO OUTFILE '/tmp/x'")
    assert writes_server_file("SELECT * FROM t INTO DUMPFILE '/tmp/x'")
    # Comment-split keywords defeated the previous regex.
    assert writes_server_file("SELECT * FROM t INTO/**/OUTFILE '/tmp/x'")


def test_plain_select_does_not_write_a_server_file():
    assert not writes_server_file("SELECT * FROM t")
    assert not writes_server_file("SELECT 'INTO OUTFILE' AS s")


# ---------------------------------------------------------------------------
# target_table
# ---------------------------------------------------------------------------


def test_target_table_resolves_qualified_and_unqualified_writes():
    assert target_table("UPDATE db.t SET a = 1") == ("db", "t")
    assert target_table("DELETE FROM t WHERE id = 1") == (None, "t")
    assert target_table("INSERT INTO `db`.`t` VALUES (1)") == ("db", "t")


def test_target_table_is_none_for_non_writes():
    assert target_table("SELECT * FROM t") is None
    assert target_table("USE other_db") is None


# ---------------------------------------------------------------------------
# Executable comments (/*! ... */) are executed by MySQL, so their body is SQL
# ---------------------------------------------------------------------------


def test_statement_kind_sees_through_an_executable_comment():
    assert statement_kind("/*!50000 SELECT */ * FROM t") == "SELECT"
    assert statement_kind("/*!32301 DELETE */ FROM t WHERE id = 1") == "DELETE"


def test_ordinary_comments_stay_blanked():
    assert statement_kind("/* SELECT */ DELETE FROM t") == "DELETE"
    assert statement_kind("-- SELECT\nDELETE FROM t") == "DELETE"


def test_result_producing_sees_through_an_executable_comment():
    assert is_result_producing("/*!50000 SELECT */ * FROM t")


def test_server_file_write_hidden_in_an_executable_comment_is_detected():
    assert writes_server_file("SELECT * FROM t /*!50000 INTO OUTFILE '/tmp/x' */")
    assert writes_server_file("SELECT * FROM t INTO/**/OUTFILE '/tmp/x'")


def test_target_table_sees_through_an_executable_comment():
    assert target_table("/*!50000 DELETE */ FROM other_db.t WHERE id = 1") == (
        "other_db",
        "t",
    )


# ---------------------------------------------------------------------------
# Where a LIMIT may legally go (verified against MySQL 8.0)
# ---------------------------------------------------------------------------


def test_limit_is_appended_to_row_returning_statements():
    assert add_row_limit("SELECT * FROM t", 5) == "SELECT * FROM t LIMIT 5"
    assert add_row_limit("TABLE t", 5) == "TABLE t LIMIT 5"
    assert add_row_limit("VALUES ROW(1)", 5) == "VALUES ROW(1) LIMIT 5"
    assert (
        add_row_limit("/*!50000 SELECT */ * FROM t", 5)
        == "/*!50000 SELECT */ * FROM t LIMIT 5"
    )


def test_limit_is_inserted_before_a_locking_clause():
    """`SELECT ... FOR UPDATE LIMIT n` is a syntax error; the reverse order is not."""
    assert (
        add_row_limit("SELECT * FROM t FOR UPDATE", 5)
        == "SELECT * FROM t LIMIT 5 FOR UPDATE"
    )
    assert (
        add_row_limit("SELECT * FROM t LOCK IN SHARE MODE", 5)
        == "SELECT * FROM t LIMIT 5 LOCK IN SHARE MODE"
    )


def test_statements_whose_grammar_has_no_limit_are_left_alone():
    for sql in (
        "DESCRIBE t",
        "DESC t",
        "SHOW CREATE TABLE t",
        "SHOW TABLES",
        "EXPLAIN SELECT 1",
    ):
        assert add_row_limit(sql, 5) is None, sql


def test_no_limit_is_added_twice_or_into_an_into_clause():
    assert add_row_limit("SELECT * FROM t LIMIT 3", 5) is None
    assert add_row_limit("SELECT * FROM (SELECT 1 LIMIT 1) x LIMIT 2", 5) is None
    assert add_row_limit("SELECT * FROM t INTO OUTFILE '/tmp/x'", 5) is None
    assert add_row_limit("SELECT * FROM t INTO @a", 5) is None


def test_non_result_statements_get_no_limit():
    for sql in ("UPDATE t SET a = 1", "DELETE FROM t", "INSERT INTO t VALUES (1)", ""):
        assert add_row_limit(sql, 5) is None, sql


# ---------------------------------------------------------------------------
# Broader write recognition (used by the dump-import scope guard)
# ---------------------------------------------------------------------------


def test_target_table_recognises_the_write_forms_a_dump_uses():
    assert target_table("REPLACE INTO other_db.t VALUES (1)") == ("other_db", "t")
    assert target_table("REPLACE other_db.t VALUES (1)") == ("other_db", "t")
    assert target_table("UPDATE other_db.t AS x SET a = 1") == ("other_db", "t")
    assert target_table("UPDATE other_db.t x SET a = 1") == ("other_db", "t")
    assert target_table("DELETE x FROM other_db.t x JOIN y ON 1") == ("other_db", "t")
    assert target_table("TRUNCATE TABLE other_db.t") == ("other_db", "t")
    assert target_table("CREATE TABLE IF NOT EXISTS other_db.t (id INT)") == (
        "other_db",
        "t",
    )
    assert target_table("ALTER TABLE other_db.t ADD COLUMN c INT") == ("other_db", "t")
    assert target_table("DROP TABLE IF EXISTS other_db.t") == ("other_db", "t")
    assert target_table("RENAME TABLE a TO other_db.t") == ("other_db", "t")
    assert target_table("CREATE UNIQUE INDEX i ON other_db.t (c)") == ("other_db", "t")
    assert target_table("LOCK TABLES other_db.t WRITE") == ("other_db", "t")
    assert target_table("LOAD DATA INFILE '/x' INTO TABLE other_db.t") == (
        "other_db",
        "t",
    )


def test_target_table_still_ignores_reads():
    assert target_table("SELECT * FROM other_db.t") is None
    assert target_table("USE other_db") is None
