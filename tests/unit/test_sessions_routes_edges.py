from types import SimpleNamespace

import pytest
from starlette.requests import Request

from lagun.api import sessions as sessions_api
from lagun.models.session import SessionUpdate


def _request(username: str = "alice") -> Request:
    request = Request({"type": "http", "method": "DELETE", "path": "/", "headers": []})
    request.state.user = username
    return request


async def test_delete_hides_a_managed_session_for_the_current_user(monkeypatch):
    hidden = []

    async def managed(_session_id):
        return True

    async def hide(session_id, username):
        hidden.append((session_id, username))

    async def delete(_session_id):
        raise AssertionError("a managed session must not be deleted")

    monkeypatch.setenv("LAGUN_LDAP_CONFIG", "ldap.yaml")
    monkeypatch.setattr(sessions_api.session_store, "is_managed_session", managed)
    monkeypatch.setattr(sessions_api.session_store, "hide_shared_session", hide)
    monkeypatch.setattr(sessions_api.session_store, "delete_session", delete)

    await sessions_api.delete_session("shared", _request())

    assert hidden == [("shared", "alice")]


@pytest.mark.asyncio
async def test_managed_session_update_without_selected_databases_stays_open(
    monkeypatch,
):
    managed = SimpleNamespace(managed=True)
    updated = SimpleNamespace(id="shared")

    async def get(_session_id):
        return managed

    async def update(_session_id, _data):
        return updated

    async def close(_session_id):
        raise AssertionError("no credential field changed")

    monkeypatch.setattr(sessions_api.session_store, "get_session", get)
    monkeypatch.setattr(sessions_api.session_store, "update_session", update)
    monkeypatch.setattr(sessions_api.pool_mod, "close_pool", close)

    result = await sessions_api.update_session("shared", SessionUpdate())

    assert result is updated
