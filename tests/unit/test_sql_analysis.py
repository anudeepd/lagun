"""Unit tests for the shared SQL text analysis helpers.

These back three behaviours that were previously regex-based and wrong:

* the auto-LIMIT safety net must fire for every result-producing statement, not
  just ones that literally start with ``SELECT``;
* a LIMIT inside a subquery must not suppress it;
* the export allowlist must accept a CTE-select and reject a server-side file
  write even when a comment splits the keywords.
"""

import time

from lagun.api.sql_analysis import (
    _use_schema,
    add_row_limit,
    has_top_level_limit,
    is_result_producing,
    referenced_schemas,
    statement_kind,
    strip_comments_and_literals,
    target_database,
    target_table,
    top_level_keywords,
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


def test_multi_table_delete_resolves_targets_before_from():
    """``DELETE t1, t2 FROM ...`` names targets before FROM, not just sources."""
    assert target_table("DELETE other_db.t1 FROM other_db.t1 JOIN t2 ON 1") == (
        "other_db",
        "t1",
    )
    assert target_table("DELETE t1 FROM other_db.t1 JOIN other_db.t2 ON 1") == (
        "other_db",
        "t1",
    )
    assert target_table("DELETE FROM t WHERE id = 1") == (None, "t")


def test_target_table_reads_through_a_with_prelude():
    """A CTE wrapper hides the verb behind its CTE list; read from the verb on."""
    assert target_table("WITH x AS (SELECT 1) DELETE FROM app_db.t WHERE 1=1") == (
        "app_db",
        "t",
    )
    assert target_table("WITH x AS (SELECT 1) DELETE FROM t WHERE 1=1") == (None, "t")
    assert target_table("WITH x AS (SELECT 1) UPDATE app_db.t SET a = 1") == (
        "app_db",
        "t",
    )
    assert target_table("WITH x AS (SELECT 1) INSERT INTO app_db.t VALUES (1)") == (
        "app_db",
        "t",
    )
    assert target_table(
        "WITH RECURSIVE r AS (SELECT 1) REPLACE INTO app_db.t VALUES (1)"
    ) == ("app_db", "t")
    assert target_table("WITH x AS (SELECT 1) TRUNCATE TABLE app_db.t") == (
        "app_db",
        "t",
    )


def test_with_prelude_nested_and_quoted_names_do_not_confuse_the_verb_scan():
    """Only the verb sits at depth zero; a backticked CTE is not a keyword."""
    assert target_table(
        "WITH x AS (SELECT * FROM (SELECT 1) y) DELETE FROM app_db.t WHERE 1=1"
    ) == ("app_db", "t")
    assert target_table(
        "WITH `delete` AS (SELECT 1) DELETE FROM app_db.t WHERE 1=1"
    ) == ("app_db", "t")
    # A comment between the prelude and the verb keeps the slice aligned.
    assert target_table(
        "WITH x AS (SELECT 1) /* why */ DELETE FROM app_db.t WHERE 1=1"
    ) == ("app_db", "t")
    assert target_table(
        "WITH x AS (SELECT 'UPDATE app_db.t') DELETE FROM app_db.t"
    ) == (
        "app_db",
        "t",
    )


def test_multi_table_delete_reads_through_a_with_prelude():
    assert target_table(
        "WITH x AS (SELECT 1) DELETE t1 FROM app_db.t1 JOIN u ON 1"
    ) == (
        "app_db",
        "t1",
    )


def test_with_prelude_without_a_write_verb_is_not_a_target():
    """A CTE-wrapped read is still a read, so it has no write target."""
    assert target_table("WITH x AS (SELECT 1) SELECT * FROM app_db.t") is None
    assert target_table("WITH x AS (SELECT 1) SELECT 1") is None


def test_target_database_recognises_database_level_ddl():
    assert target_database("CREATE DATABASE other_db") == "other_db"
    assert target_database("CREATE SCHEMA IF NOT EXISTS `other_db`") == "other_db"
    assert target_database("DROP DATABASE IF EXISTS other_db") == "other_db"
    assert target_database("ALTER DATABASE other_db DEFAULT CHARACTER SET utf8mb4") == (
        "other_db"
    )
    assert target_database("CREATE TABLE t (id INT)") is None
    assert target_database("SELECT * FROM other_db.t") is None


def test_referenced_schemas_covers_reads_and_multi_table_writes():
    assert referenced_schemas("SELECT * FROM other_db.t JOIN app_db.u ON 1") == {
        "other_db",
        "app_db",
    }
    assert referenced_schemas("SELECT * FROM `other_db`.`t`") == {"other_db"}
    assert referenced_schemas("DELETE other_db.t1 FROM other_db.t1 JOIN t2 ON 1") == {
        "other_db"
    }
    assert referenced_schemas("CREATE DATABASE other_db") == {"other_db"}
    # Comments, literals and quoted identifiers never produce hits.
    assert referenced_schemas("SELECT 'other_db.t'") == set()
    assert referenced_schemas("/* other_db.t */ SELECT 1") == set()
    assert referenced_schemas("SELECT * FROM t /*!50000 INTO OUTFILE '/x' */") == set()
    assert referenced_schemas("SELECT * FROM t") == set()


def test_referenced_schemas_ignores_column_dots():
    """Alias dots (t.col) never count as schema use: no false 403."""
    assert referenced_schemas("SELECT t.id FROM users t") == set()
    assert referenced_schemas("SELECT * FROM app_db.t WHERE t.col = 1") == {"app_db"}
    assert referenced_schemas("SELECT u.name FROM users u JOIN orders o ON 1") == set()
    assert referenced_schemas("SELECT * FROM a.t, b.u") == {"a", "b"}


def test_referenced_schemas_covers_use_and_routines():
    assert referenced_schemas("USE other_db") == {"other_db"}
    assert referenced_schemas("SELECT other_db.f(1)") == {"other_db"}


def test_referenced_schemas_covers_object_ddl_positions():
    """Qualified object DDL names its schema where no target pattern looks."""
    assert referenced_schemas("CREATE VIEW other_db.v AS SELECT 1") == {"other_db"}
    assert referenced_schemas("DROP TRIGGER other_db.trg") == {"other_db"}
    assert referenced_schemas("DROP PROCEDURE other_db.p") == {"other_db"}
    assert referenced_schemas("DROP FUNCTION other_db.f") == {"other_db"}
    assert referenced_schemas(
        "CREATE EVENT other_db.e ON SCHEDULE EVERY 1 DAY DO SELECT 1"
    ) == {"other_db"}


def test_object_ddl_keywords_do_not_false_positive():
    """The new keywords only fire on a dotted name right after them."""
    assert referenced_schemas("CREATE VIEW v AS SELECT 1") == set()
    assert referenced_schemas("DROP VIEW IF EXISTS v") == set()
    assert referenced_schemas("SELECT event FROM t") == set()
    assert referenced_schemas("SELECT event.name FROM t") == set()
    assert referenced_schemas("SELECT `view`.id FROM t") == set()
    assert referenced_schemas("SELECT * FROM t ORDER BY event") == set()


def test_target_table_resolves_ddl_destinations():
    """ALTER ... RENAME and DROP INDEX name a table no reference keyword covers."""
    assert target_table("ALTER TABLE t RENAME TO other_db.t2") == ("other_db", "t2")
    assert target_table("ALTER TABLE t RENAME AS other_db.t2") == ("other_db", "t2")
    assert target_table("ALTER TABLE t RENAME other_db.t2") == ("other_db", "t2")
    assert target_table("DROP INDEX i ON other_db.t") == ("other_db", "t")
    # In-table renames keep the table as the target, not the new column name.
    assert target_table("ALTER TABLE t RENAME COLUMN a TO b") == (None, "t")
    assert target_table("ALTER TABLE t RENAME INDEX i TO j") == (None, "t")
    assert target_table("ALTER TABLE t RENAME KEY i TO j") == (None, "t")


def test_a_leading_comment_cannot_hide_a_use_statement():
    """`/* hint */ USE other_db` must still be seen as naming other_db.

    `USE` switches the pooled connection's default schema, so a comment that hid
    the statement from the scope scan let a scoped session move itself to a
    schema outside its scope.
    """
    assert _use_schema("/* hint */ USE other_db") == "other_db"
    assert _use_schema("-- c\nUSE other_db") == "other_db"
    assert _use_schema("#x\nUSE other_db") == "other_db"
    assert _use_schema("/*a*/ -- b\n /*c*/ USE `odd name`") == "odd name"
    assert referenced_schemas("/* hint */ USE other_db") == {"other_db"}
    assert referenced_schemas("-- c\nUSE `other_db`") == {"other_db"}
    # Still not a USE statement.
    assert referenced_schemas("SELECT 1") == set()


def test_many_leading_comments_do_not_multiply_the_scan_cost():
    """The comment prefix is shared by every target pattern.

    Its repetition was ambiguous (each iteration may end with `\\s*` and the next
    may start with `\\s*`), so N comments meant exponentially many parses: 16
    comments cost >100 ms and 40 cost hours. Atomic grouping makes it linear;
    this bound is orders of magnitude above the linear cost, so it only fails on
    a real regression.
    """
    statement = "/*a*/" * 5000 + "SELECT 1"
    started = time.monotonic()
    assert target_table(statement) is None
    assert target_database(statement) is None
    assert referenced_schemas(statement) == set()
    assert time.monotonic() - started < 2.0


def test_a_dash_is_only_a_comment_after_whitespace():
    """MySQL needs whitespace after `--`; `--(` is two unary minus operators.

    Reading every `--` as a comment blanked text MySQL still executes, so a
    scoped connection could reach another schema through the hidden part.
    """
    assert referenced_schemas("SELECT 1--(SELECT COUNT(*) FROM other_db.users)") == {
        "other_db"
    }
    assert referenced_schemas("SELECT * FROM t--(SELECT 1)") == set()
    # A real comment is still ignored.
    assert referenced_schemas("SELECT 1 -- (SELECT COUNT(*) FROM other_db.t)") == set()
    assert referenced_schemas("SELECT 1 # (SELECT 1 FROM other_db.t)") == set()
    assert "other_db" in strip_comments_and_literals(
        "SELECT 1--(SELECT x FROM other_db.t)"
    )


def test_comments_cannot_separate_a_verb_from_its_name():
    """An inter-token comment used to hide the name a verb introduces.

    `USE` moves the pooled connection's default schema, and `DROP … IF EXISTS`
    puts an existence clause where the object name would be: both shapes hid a
    schema from the scan.
    """
    assert referenced_schemas("USE /*c*/ other_db") == {"other_db"}
    assert referenced_schemas("/*h*/ USE /*c*/ other_db") == {"other_db"}
    assert referenced_schemas("USE -- c\n  other_db") == {"other_db"}
    assert referenced_schemas("DROP VIEW IF EXISTS other_db.v") == {"other_db"}
    assert referenced_schemas("DROP TRIGGER IF EXISTS other_db.trg") == {"other_db"}
    assert referenced_schemas("DROP VIEW IF EXISTS v") == set()
    # Not a USE statement, and not an existence clause on a table reference.
    assert referenced_schemas("USEother") == set()
    assert _use_schema("USEother") is None
    assert referenced_schemas("SELECT * FROM t IF EXISTS") == set()
    assert referenced_schemas("SELECT * FROM app_db.t") == {"app_db"}


def test_referenced_schemas_follow_mysql_lexing():
    """Shapes where MySQL reads a table reference the scanner used to miss."""
    assert referenced_schemas("SELECT * FROM a STRAIGHT_JOIN other_db.b ON 1") == {
        "other_db"
    }
    assert referenced_schemas("SELECT * FROM (other_db.t)") == {"other_db"}
    # A quote inside a backtick identifier is part of the name, not a string:
    # reading it as one blanked the rest of the statement.
    assert referenced_schemas("SELECT * FROM `a'b`.t, other_db.u") == {
        "a'b",
        "other_db",
    }
    # …and none of them invent a schema.
    assert referenced_schemas("SELECT * FROM (SELECT 1) x") == set()
    assert referenced_schemas("SELECT * FROM t") == set()


def test_multi_table_delete_targets_win_over_the_from_tables():
    """MySQL deletes from the list before FROM, not from the source tables."""
    assert target_table("DELETE other_db.t1 FROM app_db.t1") == ("other_db", "t1")
    assert target_table("DELETE app_db.t1 FROM other_db.t1") == ("app_db", "t1")
    assert target_table("DELETE t1, t2 FROM t1 JOIN t2 ON 1") == (None, "t1")
