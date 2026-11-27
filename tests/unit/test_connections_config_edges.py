import json

import pytest

from lagun.db import connections_config, session_store


def write_config(tmp_path, body: str):
    path = tmp_path / "connections.yaml"
    path.write_text(body, encoding="utf-8")
    return path


@pytest.mark.asyncio
async def test_sync_connections_config_none_is_a_no_op():
    await connections_config.sync_connections_config(None)


@pytest.mark.asyncio
async def test_sync_connections_config_rejects_invalid_shapes(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_SHARED_PASSWORD", "secret")
    with pytest.raises(ValueError, match="must be a list"):
        await connections_config.sync_connections_config(
            str(write_config(tmp_path, "connections: nope\n"))
        )
    with pytest.raises(ValueError, match="each connection needs"):
        await connections_config.sync_connections_config(
            str(write_config(tmp_path, "connections:\n  - name: missing\n"))
        )
    with pytest.raises(ValueError, match="selected_databases"):
        await connections_config.sync_connections_config(
            str(
                write_config(
                    tmp_path,
                    "connections:\n"
                    "  - id: bad\n"
                    "    password_env: TEST_SHARED_PASSWORD\n"
                    "    allowed_users: [alice]\n"
                    "    selected_databases: nope\n",
                )
            )
        )
    with pytest.raises(ValueError, match="not set"):
        await connections_config.sync_connections_config(
            str(
                write_config(
                    tmp_path,
                    "connections:\n"
                    "  - id: bad\n"
                    "    password_env: TEST_MISSING_PASSWORD\n"
                    "    allowed_users: [alice]\n",
                )
            )
        )


@pytest.mark.asyncio
async def test_sync_connections_config_inserts_and_updates_managed_rows(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.setenv("TEST_SHARED_PASSWORD", "secret")
    path = write_config(
        tmp_path,
        "connections:\n"
        "  - id: shared\n"
        "    name: Shared\n"
        "    username: reader\n"
        "    password_env: TEST_SHARED_PASSWORD\n"
        "    allowed_users: [alice, bob, 7]\n",
    )
    await session_store.init_db()
    await connections_config.sync_connections_config(str(path))

    sessions = await session_store.list_sessions_for_user("alice")
    assert len(sessions) == 1
    session_id = sessions[0].id
    assert sessions[0].managed is True
    assert "no selected_databases allowlist" in caplog.text

    async with session_store._connect() as db:
        await db.execute(
            "UPDATE sessions SET selected_databases=? WHERE id=?",
            (json.dumps(["app", "other"]), session_id),
        )
        await db.commit()

    path.write_text(
        "connections:\n"
        "  - id: shared\n"
        "    name: Shared Renamed\n"
        "    username: reader\n"
        "    password_env: TEST_SHARED_PASSWORD\n"
        "    allowed_users: [alice]\n"
        "    selected_databases: [app]\n",
        encoding="utf-8",
    )
    await connections_config.sync_connections_config(str(path))

    updated = await session_store.get_session(session_id)
    assert updated is not None
    assert updated.name == "Shared Renamed"
    assert updated.managed_selected_databases == ["app"]
    assert updated.selected_databases == ["app"]
