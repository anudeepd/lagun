"""Server-managed LDAP connection profiles loaded from YAML."""

import json
import logging
import os
from pathlib import Path

import yaml

from lagun.db.crypto import encrypt_password
from lagun.db import session_store

_log = logging.getLogger(__name__)


async def sync_connections_config(path: str | None) -> None:
    """Upsert managed profiles and their allowed LDAP users from a YAML file."""
    if not path:
        return
    with Path(path).open(encoding="utf-8") as f:
        payload = yaml.safe_load(f) or {}
    entries = payload.get("connections", [])
    if not isinstance(entries, list):
        raise ValueError("connections.yaml: 'connections' must be a list")

    async with session_store._connect() as db:
        for entry in entries:
            key = entry.get("id")
            users = entry.get("allowed_users", [])
            password_env = entry.get("password_env")
            if (
                not isinstance(key, str)
                or not key
                or not isinstance(users, list)
                or not password_env
            ):
                raise ValueError(
                    "each connection needs id, password_env, and allowed_users"
                )
            selected_databases = entry.get("selected_databases", [])
            if selected_databases is None:
                selected_databases = []
            if not isinstance(selected_databases, list) or not all(
                isinstance(db, str) and db for db in selected_databases
            ):
                raise ValueError("selected_databases must be a list of database names")
            if not selected_databases:
                # Documented as "all non-system schemas", but an operator who
                # omitted the key should not have to guess that they just granted
                # every schema the shared account can reach.
                _log.warning(
                    "connections.yaml: connection %r has no selected_databases "
                    "allowlist, so every non-system schema it can reach is "
                    "available to its users",
                    key,
                )
            password = os.getenv(password_env)
            if password is None:
                raise ValueError(f"environment variable {password_env!r} is not set")
            async with db.execute(
                "SELECT id, selected_databases FROM sessions WHERE config_key=?", (key,)
            ) as cur:
                row = await cur.fetchone()
            name = entry.get("name", key)
            host = entry.get("host", "localhost")
            port = int(entry.get("port", 3306))
            username = entry.get("username", "")
            encrypted = encrypt_password(password)
            default_db = entry.get("default_db")
            query_limit = int(entry.get("query_limit", 100))
            ssl_enabled = int(bool(entry.get("ssl_enabled", False)))
            is_default = int(bool(entry.get("default", False)))
            ceiling = json.dumps(selected_databases)
            if row:
                session_id = row[0]
                # The administrator's list is a ceiling, so a narrowing that the
                # user made earlier is kept only while it stays inside it.
                chosen = json.loads(row[1] or "[]")
                narrowed = (
                    [db for db in chosen if db in selected_databases]
                    if selected_databases
                    else chosen
                )
                await db.execute(
                    "UPDATE sessions SET name=?, host=?, port=?, username=?, password_enc=?, "
                    "default_db=?, query_limit=?, ssl_enabled=?, is_default=?, "
                    "selected_databases=?, managed_selected_databases=?, managed=1 WHERE id=?",
                    (
                        name,
                        host,
                        port,
                        username,
                        encrypted,
                        default_db,
                        query_limit,
                        ssl_enabled,
                        is_default,
                        json.dumps(narrowed),
                        ceiling,
                        session_id,
                    ),
                )
            else:
                import uuid
                from datetime import datetime, timezone

                session_id = str(uuid.uuid4())
                now = datetime.now(timezone.utc).isoformat()
                await db.execute(
                    "INSERT INTO sessions (id,name,host,port,username,password_enc,default_db,"
                    "query_limit,ssl_enabled,is_default,created_at,updated_at,selected_databases,"
                    "managed_selected_databases,managed,config_key) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
                    (
                        session_id,
                        name,
                        host,
                        port,
                        username,
                        encrypted,
                        default_db,
                        query_limit,
                        ssl_enabled,
                        is_default,
                        now,
                        now,
                        json.dumps([]),
                        ceiling,
                        key,
                    ),
                )
            await db.execute(
                "DELETE FROM shared_session_access WHERE session_id=?", (session_id,)
            )
            await db.executemany(
                "INSERT INTO shared_session_access (session_id, username) VALUES (?, ?)",
                [
                    (session_id, user)
                    for user in users
                    if isinstance(user, str) and user
                ],
            )
        await db.commit()
