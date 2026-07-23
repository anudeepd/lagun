"""Tests for the SQL classifier using shared fixtures."""

import json
from pathlib import Path

import pytest

from lagun.api.query import (
    _is_lock_wait_timeout,
    _strip_comments_and_literals,
    _validate_script_statements,
)
from lagun.api.sql_script import split_sql_script

FIXTURE_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "sql_classifier.json"
)


@pytest.fixture(scope="module")
def classifier_fixtures():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


@pytest.mark.parametrize(
    "case",
    [pytest.param(c, id=c["label"]) for c in json.load(open(FIXTURE_PATH))["allowed"]],
    scope="module",
)
def test_allowed_statements_pass_validation(case):
    statements = split_sql_script(case["sql"])
    result = _validate_script_statements(statements)
    assert result.ok is True, f"Expected allowed but got error: {result.error}"


@pytest.mark.parametrize(
    "case",
    [pytest.param(c, id=c["label"]) for c in json.load(open(FIXTURE_PATH))["rejected"]],
    scope="module",
)
def test_rejected_statements_fail_validation(case):
    statements = split_sql_script(case["sql"])
    result = _validate_script_statements(statements)
    assert result.ok is False, (
        f"Expected rejection for {case['label']} but validation passed"
    )
    assert result.error is not None
    assert result.error.code == case["expected_code"]


def test_split_handles_backslash_escaped_quotes():
    sql = "INSERT INTO users (name) VALUES ('it\\'s a test'); INSERT INTO users (name) VALUES ('ok')"
    statements = split_sql_script(sql)
    assert len(statements) == 2
    assert "it\\'s a test" in statements[0]
    assert statements[1].startswith("INSERT INTO users")


def test_split_preserves_double_quotes():
    sql = 'INSERT INTO users (name) VALUES ("it\'s fine"); SELECT 1'
    statements = split_sql_script(sql)
    assert len(statements) == 2
    assert '"it\'s fine"' in statements[0]


def test_split_does_not_split_inside_double_quoted_semicolons():
    sql = 'INSERT INTO users (name) VALUES ("a;b"); SELECT 1'
    statements = split_sql_script(sql)
    assert len(statements) == 2
    assert '"a;b"' in statements[0]


def test_split_backtick_identifiers_not_split():
    sql = "INSERT INTO `my;table` (name) VALUES ('a'); SELECT 1"
    statements = split_sql_script(sql)
    assert len(statements) == 2
    assert "`my;table`" in statements[0]


def test_strip_comments_and_literals_handles_backslash_escaped_quotes():
    sql = "INSERT INTO t (v) VALUES ('it\\'s a SELECT test')"
    result = _strip_comments_and_literals(sql)
    assert "SELECT" not in result
    assert "''" in result


def test_lock_wait_timeout_detection_by_errno():
    assert _is_lock_wait_timeout(
        Exception(1205, "Lock wait timeout exceeded; try restarting transaction")
    )


def test_lock_wait_timeout_detection_by_message():
    assert _is_lock_wait_timeout(
        Exception("Lock wait timeout exceeded; try restarting transaction")
    )
