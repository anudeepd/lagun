from io import StringIO

import pytest

from lagun.api.sql_script import SqlScriptError, iter_sql_statements, split_sql_script


def test_split_quoted_semicolons_and_backticks():
    sql = "SELECT 'a;b', \"c;d\", `e;f`; SELECT 2"
    assert split_sql_script(sql) == ["SELECT 'a;b', \"c;d\", `e;f`", "SELECT 2"]


def test_comments_and_executable_comments():
    statements = list(
        iter_sql_statements(
            StringIO("-- note\n# note\n/* note */; /*!40101 SET @x=1 */; SELECT 1;")
        )
    )
    assert [item.sql for item in statements] == ["/*!40101 SET @x=1 */", "SELECT 1"]


def test_custom_delimiter_and_reset():
    sql = "DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n SELECT 1;\nEND$$\nDELIMITER ;\nSELECT 2;"
    statements = list(iter_sql_statements(StringIO(sql)))
    assert len(statements) == 2
    assert statements[0].sql.startswith("CREATE PROCEDURE p()")
    assert "SELECT 1;" in statements[0].sql
    assert statements[0].line == 2
    assert statements[1].sql == "SELECT 2"
    assert statements[1].line == 7


def test_parser_reports_unterminated_string():
    with pytest.raises(SqlScriptError, match="unterminated quoted"):
        list(iter_sql_statements(StringIO("SELECT 'unterminated")))


def test_parser_reports_unterminated_comment():
    with pytest.raises(SqlScriptError, match="unterminated block comment"):
        list(iter_sql_statements(StringIO("SELECT 1 /* unterminated")))


class ChunkedText:
    def __init__(self, *chunks: str):
        self._chunks = iter(chunks)

    def read(self, _size: int) -> str:
        return next(self._chunks, "")


def test_parser_skips_final_default_delimiter_directive():
    assert list(iter_sql_statements(StringIO("DELIMITER ;"))) == []


def test_parser_preserves_comment_markers_across_reads():
    statements = list(
        iter_sql_statements(ChunkedText("SELECT 1 /", "* hidden; still; */ SELECT 2;"))
    )
    assert [item.sql for item in statements] == [
        "SELECT 1 /* hidden; still; */ SELECT 2"
    ]


def test_parser_accepts_final_delimiter_directive_without_newline():
    sql = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;"
    statements = list(iter_sql_statements(StringIO(sql)))
    assert len(statements) == 1
    assert statements[0].sql.startswith("CREATE PROCEDURE")


def test_parser_enforces_statement_byte_limit(monkeypatch):
    monkeypatch.setenv("LAGUN_IMPORT_MAX_STATEMENT_BYTES", "8")
    with pytest.raises(SqlScriptError, match="exceeds 8 bytes"):
        list(iter_sql_statements(StringIO("SELECT 123456789")))
