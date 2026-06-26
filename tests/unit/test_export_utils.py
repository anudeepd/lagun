import pytest

from lagun.api.export import _target_table_label, _target_table_sql


def test_target_table_sql_omits_schema_by_default():
    assert _target_table_sql("my_db", "users") == "`users`"


def test_target_table_sql_includes_schema_when_requested():
    assert _target_table_sql("my_db", "users", include_schema=True) == "`my_db`.`users`"


def test_target_table_sql_rejects_invalid_identifiers():
    with pytest.raises(ValueError):
        _target_table_sql("my_db", "we`ird", include_schema=True)


def test_target_table_label_matches_schema_option():
    assert _target_table_label("my_db", "users") == "users"
    assert _target_table_label("my_db", "users", include_schema=True) == "my_db.users"
