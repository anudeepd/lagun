"""Per-statement scope checks for MySQL dump imports.

A dump can name its own target schema, so checking only the configured database
is not enough: `USE other_db` or a qualified `INSERT INTO other_db.t` would reach
a schema the connection is not allowed to touch.
"""

from lagun.api.import_data import _out_of_scope_schema

SCOPE = frozenset({"app_db"})


def test_qualified_statement_outside_the_scope_is_rejected():
    assert (
        _out_of_scope_schema("INSERT INTO other_db.t VALUES (1)", SCOPE) == "other_db"
    )
    assert _out_of_scope_schema("UPDATE other_db.t SET a = 1", SCOPE) == "other_db"
    assert (
        _out_of_scope_schema("DELETE FROM other_db.t WHERE id = 1", SCOPE) == "other_db"
    )


def test_use_statement_outside_the_scope_is_rejected():
    assert _out_of_scope_schema("USE other_db", SCOPE) == "other_db"
    assert _out_of_scope_schema("USE `other_db`", SCOPE) == "other_db"
    # A leading comment must not hide it.
    assert _out_of_scope_schema("/* dump */ USE other_db", SCOPE) == "other_db"


def test_in_scope_and_unqualified_statements_pass():
    assert _out_of_scope_schema("INSERT INTO app_db.t VALUES (1)", SCOPE) is None
    assert _out_of_scope_schema("INSERT INTO t VALUES (1)", SCOPE) is None
    assert _out_of_scope_schema("USE app_db", SCOPE) is None
    assert _out_of_scope_schema("CREATE TABLE t (id INT)", SCOPE) is None


def test_unrestricted_connections_skip_the_check_entirely():
    assert _out_of_scope_schema("INSERT INTO other_db.t VALUES (1)", None) is None
    assert _out_of_scope_schema("USE other_db", None) is None


def test_use_inside_a_string_is_not_a_use_statement():
    assert _out_of_scope_schema("INSERT INTO t VALUES ('USE other_db')", SCOPE) is None


def test_every_write_form_a_dump_can_use_is_resolved():
    """REPLACE, the DDL family, aliased UPDATE and multi-table DELETE all name a schema."""
    for statement in (
        "REPLACE INTO other_db.t VALUES (1)",
        "CREATE TABLE other_db.t (id INT)",
        "ALTER TABLE other_db.t ADD COLUMN c INT",
        "DROP TABLE other_db.t",
        "TRUNCATE TABLE other_db.t",
        "RENAME TABLE a TO other_db.t",
        "CREATE INDEX i ON other_db.t (c)",
        "UPDATE other_db.t AS x SET a = 1",
        "DELETE x FROM other_db.t x JOIN y ON 1",
        "/*!50000 DELETE */ FROM other_db.t WHERE id = 1",
    ):
        assert _out_of_scope_schema(statement, SCOPE) == "other_db", statement


def test_dynamic_sql_is_refused_for_a_scoped_connection():
    """The target of PREPARE/EXECUTE/CALL cannot be checked before it runs."""
    from lagun.api.import_data import _uninspectable_statement

    for statement in (
        "PREPARE s FROM @sql",
        "EXECUTE s",
        "DEALLOCATE PREPARE s",
        "CALL other_db.proc()",
        "/*!50000 EXECUTE */ s",
    ):
        assert _uninspectable_statement(statement, SCOPE) is True, statement
    assert _uninspectable_statement("INSERT INTO t VALUES (1)", SCOPE) is False
    # An unrestricted connection keeps accepting dumps as before.
    assert _uninspectable_statement("PREPARE s FROM @sql", None) is False
