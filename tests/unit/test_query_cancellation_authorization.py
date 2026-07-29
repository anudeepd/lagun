"""Authorization tests for normal-query cancellation."""

import pytest
from starlette.requests import Request

from lagun.api import query


def _request(username: str | None = None) -> Request:
    request = Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "DELETE",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("test", 80),
            "root_path": "",
        }
    )
    if username is not None:
        request.state.user = username
    return request


@pytest.fixture(autouse=True)
def reset_query_cancellation_state():
    query._active_queries.clear()
    query._active_query_executions.clear()
    query._cancelled_query_executions.clear()
    yield
    query._active_queries.clear()
    query._active_query_executions.clear()
    query._cancelled_query_executions.clear()


async def _register(
    session_id: str, execution_id: str, thread_id: int, owner_username: str | None
) -> tuple[str, str]:
    key = await query._begin_query_execution(session_id, execution_id, owner_username)
    assert key is not None
    await query._register_query_thread(session_id, key, thread_id, owner_username)
    return key


async def test_ldap_session_wide_cancellation_only_kills_callers_queries(
    monkeypatch,
):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    alice_key = await _register("shared", "alice-query", 101, "alice")
    bob_key = await _register("shared", "bob-query", 202, "bob")
    killed: list[tuple[str, list[int]]] = []

    async def record_kills(session_id: str, thread_ids: list[int]) -> None:
        killed.append((session_id, thread_ids))

    monkeypatch.setattr(query, "_kill_query_threads", record_kills)

    result = await query.kill_query("shared", _request("alice"))

    assert result == {"ok": True}
    assert killed == [("shared", [101])]
    assert alice_key in query._cancelled_query_executions
    assert bob_key not in query._cancelled_query_executions


async def test_ldap_execution_cancellation_rejects_another_users_query(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    bob_key = await _register("shared", "bob-query", 202, "bob")
    killed: list[int] = []

    async def record_kills(_session_id: str, thread_ids: list[int]) -> None:
        killed.extend(thread_ids)

    monkeypatch.setattr(query, "_kill_query_threads", record_kills)

    result = await query.kill_query_execution("shared", "bob-query", _request("alice"))

    assert result == {"ok": True}
    assert killed == []
    assert bob_key not in query._cancelled_query_executions


async def test_ldap_execution_cancellation_allows_query_owner(monkeypatch):
    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "/etc/lagun/ldap.yaml")
    bob_key = await _register("shared", "bob-query", 202, "bob")
    killed: list[int] = []

    async def record_kills(_session_id: str, thread_ids: list[int]) -> None:
        killed.extend(thread_ids)

    monkeypatch.setattr(query, "_kill_query_threads", record_kills)

    result = await query.kill_query_execution("shared", "bob-query", _request("bob"))

    assert result == {"ok": True}
    assert killed == [202]
    assert bob_key in query._cancelled_query_executions


async def test_single_user_session_wide_cancellation_remains_session_wide(monkeypatch):
    monkeypatch.delenv("LAGUN_LDAP_CONFIG", raising=False)
    first_key = await _register("local", "first-query", 101, None)
    second_key = await _register("local", "second-query", 202, None)
    killed: list[tuple[str, list[int]]] = []

    async def record_kills(session_id: str, thread_ids: list[int]) -> None:
        killed.append((session_id, thread_ids))

    monkeypatch.setattr(query, "_kill_query_threads", record_kills)

    result = await query.kill_query("local", _request())

    assert result == {"ok": True}
    assert killed == [("local", [101, 202])]
    assert {first_key, second_key} <= query._cancelled_query_executions
