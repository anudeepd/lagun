"""Unit tests for lagun/db/utils.py."""

import pytest

from lagun.db.utils import (
    quote_ident,
    validate_engine,
    validate_index_type,
    validate_charset,
    validate_collation,
    validate_col_type,
    escape_value,
    escape_string_literal,
    format_default_clause,
    SYSTEM_DBS,
)


# ---------------------------------------------------------------------------
# quote_ident
# ---------------------------------------------------------------------------


def test_quote_ident_simple():
    assert quote_ident("users") == "`users`"


def test_quote_ident_with_dollar():
    assert quote_ident("col$name") == "`col$name`"


def test_quote_ident_rejects_hyphen():
    with pytest.raises(ValueError):
        quote_ident("my-table")


def test_quote_ident_rejects_space():
    with pytest.raises(ValueError):
        quote_ident("my table")


def test_quote_ident_rejects_semicolon():
    with pytest.raises(ValueError):
        quote_ident("users; DROP TABLE users--")


def test_quote_ident_rejects_backtick():
    with pytest.raises(ValueError):
        quote_ident("`users`")


# ---------------------------------------------------------------------------
# validate_engine
# ---------------------------------------------------------------------------


def test_validate_engine_innodb():
    assert validate_engine("InnoDB") == "InnoDB"


def test_validate_engine_case_insensitive():
    assert validate_engine("innodb") == "InnoDB"
    assert validate_engine("MYISAM") == "MyISAM"


def test_validate_engine_rejects_unknown():
    with pytest.raises(ValueError):
        validate_engine("NotAnEngine")


# ---------------------------------------------------------------------------
# validate_index_type
# ---------------------------------------------------------------------------


def test_validate_index_type_btree():
    assert validate_index_type("BTREE") == "BTREE"


def test_validate_index_type_case_insensitive():
    assert validate_index_type("btree") == "BTREE"
    assert validate_index_type("Hash") == "HASH"


def test_validate_index_type_rejects_unknown():
    with pytest.raises(ValueError):
        validate_index_type("BADTYPE")


# ---------------------------------------------------------------------------
# validate_charset / validate_collation
# ---------------------------------------------------------------------------


def test_validate_charset_valid():
    assert validate_charset("utf8mb4") == "utf8mb4"
    assert validate_charset("latin1") == "latin1"


def test_validate_charset_rejects_special_chars():
    with pytest.raises(ValueError):
        validate_charset("utf8mb4; DROP TABLE")


def test_validate_collation_valid():
    assert validate_collation("utf8mb4_unicode_ci") == "utf8mb4_unicode_ci"


# ---------------------------------------------------------------------------
# validate_col_type
# ---------------------------------------------------------------------------


def test_validate_col_type_simple():
    assert validate_col_type("INT") == "INT"
    assert validate_col_type("VARCHAR(255)") == "VARCHAR(255)"
    assert validate_col_type("DECIMAL(10,2)") == "DECIMAL(10,2)"
    assert validate_col_type("INT UNSIGNED") == "INT UNSIGNED"


def test_validate_col_type_rejects_semicolon():
    with pytest.raises(ValueError):
        validate_col_type("INT; DROP TABLE users")


def test_validate_col_type_rejects_sql_keywords():
    with pytest.raises(ValueError):
        validate_col_type("INT SELECT")
    with pytest.raises(ValueError):
        validate_col_type("VARCHAR(255) DROP")


def test_validate_col_type_rejects_quotes():
    with pytest.raises(ValueError):
        validate_col_type("VARCHAR('bad')")


# ---------------------------------------------------------------------------
# escape_value
# ---------------------------------------------------------------------------


def test_escape_value_none():
    assert escape_value(None) == "NULL"


def test_escape_value_bool():
    assert escape_value(True) == "1"
    assert escape_value(False) == "0"


def test_escape_value_int():
    assert escape_value(42) == "42"


def test_escape_value_float():
    assert escape_value(3.14) == "3.14"


def test_escape_value_string():
    assert escape_value("hello") == "'hello'"


def test_escape_value_string_with_single_quote():
    assert escape_value("it's") == "'it''s'"


def test_escape_value_string_with_multiple_quotes():
    assert escape_value("it's a 'test'") == "'it''s a ''test'''"


def test_escape_value_binary_uses_lossless_hex_literal():
    assert escape_value(b"\x00\xffabc") == "0x00ff616263"


def test_escape_value_backslashes_use_sql_mode_independent_hex_literal():
    assert escape_value(r"C:\new") == "0x433a5c6e6577"


def test_escape_value_rejects_non_finite_floats():
    with pytest.raises(ValueError, match="non-finite"):
        escape_value(float("nan"))


# ---------------------------------------------------------------------------
# escape_string_literal
# ---------------------------------------------------------------------------


def test_escape_string_literal_simple():
    assert escape_string_literal("hello") == "hello"


def test_escape_string_literal_escapes_single_quotes():
    assert escape_string_literal("it's") == "it''s"


def test_escape_string_literal_rejects_semicolon():
    with pytest.raises(ValueError):
        escape_string_literal("bad; value")


def test_escape_string_literal_rejects_double_dash():
    with pytest.raises(ValueError):
        escape_string_literal("-- comment")


def test_format_default_clause_preserves_temporal_expression():
    assert format_default_clause("CURRENT_TIMESTAMP") == " DEFAULT CURRENT_TIMESTAMP"
    assert (
        format_default_clause("CURRENT_TIMESTAMP(6)") == " DEFAULT CURRENT_TIMESTAMP(6)"
    )


def test_format_default_clause_quotes_string_literal():
    assert format_default_clause("pending") == " DEFAULT 'pending'"


def test_format_default_clause_forces_literal_mode():
    assert format_default_clause("NULL", literal=True) == " DEFAULT 'NULL'"
    assert (
        format_default_clause("CURRENT_TIMESTAMP", literal=True)
        == " DEFAULT 'CURRENT_TIMESTAMP'"
    )


def test_format_default_clause_preserves_null():
    assert format_default_clause("NULL") == " DEFAULT NULL"


def test_format_default_clause_parenthesizes_supported_expressions():
    assert format_default_clause("CURRENT_DATE") == " DEFAULT (CURRENT_DATE)"
    assert format_default_clause("CURRENT_TIME") == " DEFAULT (CURRENT_TIME)"
    assert format_default_clause("UUID()") == " DEFAULT (UUID())"
    assert format_default_clause("RAND()") == " DEFAULT (RAND())"


def test_format_default_clause_quotes_unallowlisted_functions():
    assert format_default_clause("NOW()") == " DEFAULT 'NOW()'"


# ---------------------------------------------------------------------------
# SYSTEM_DBS
# ---------------------------------------------------------------------------


def test_system_dbs_contains_known_entries():
    assert "information_schema" in SYSTEM_DBS
    assert "performance_schema" in SYSTEM_DBS
    assert "mysql" in SYSTEM_DBS
    assert "sys" in SYSTEM_DBS
