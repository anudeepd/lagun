"""Server-managed LDAP connection profiles loaded from YAML."""
import json
import os
from pathlib import Path

import aiosqlite
import yaml

from lagun.db.crypto import encrypt_password
from lagun.db import session_store


async def sync_connections_config(path: str | None) -> None:
    """Upsert managed profiles and their allowed LDAP users from a YAML file."""
    if not path:
        return
    with Path(path).open(encoding="utf-8") as f:
        payload = yaml.safe_load(f) or {}
    entries = payload.get("connections", [])
    if not isinstance(entries, list):
        raise ValueError("connections.yaml: 'connections' must be a list")

    async with aiosqlite.connect(session_store._DB_PATH) as db:
        for entry in entries:
            key = entry.get("id")
            users = entry.get("allowed_users", [])
            password_env = entry.get("password_env")
            if not isinstance(key, str) or not key or not isinstance(users, list) or not password_env:
                raise ValueError("each connection needs id, password_env, and allowed_users")
            selected_databases = entry.get("selected_databases", [])
            if selected_databases is None:
                selected_databases = []
            if not isinstance(selected_databases, list) or not all(isinstance(db, str) and db for db in selected_databases):
                raise ValueError("selected_databases must be a list of database names")
            password = os.getenv(password_env)
            if password is None:
                raise ValueError(f"environment variable {password_env!r} is not set")
            async with db.execute("SELECT id FROM sessions WHERE config_key=?", (key,)) as cur:
                row = await cur.fetchone()
            values = (entry.get("name", key), entry.get("host", "localhost"), int(entry.get("port", 3306)),
                      entry.get("username", ""), encrypt_password(password), entry.get("default_db"),
                      int(entry.get("query_limit", 100)), int(bool(entry.get("ssl_enabled", False))), int(bool(entry.get("default", False))),
                      json.dumps(selected_databases), key)
            if row:
                session_id = row[0]
                await db.execute(
                    "UPDATE sessions SET name=?, host=?, port=?, username=?, password_enc=?, default_db=?, query_limit=?, ssl_enabled=?, is_default=?, selected_databases=?, managed=1 WHERE id=?",
                    (*values[:-1], session_id),
                )
            else:
                import uuid
                from datetime import datetime, timezone
                session_id = str(uuid.uuid4())
                now = datetime.now(timezone.utc).isoformat()
                await db.execute(
                    "INSERT INTO sessions (id,name,host,port,username,password_enc,default_db,query_limit,ssl_enabled,is_default,created_at,updated_at,selected_databases,managed,config_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
                    (session_id, *values[:-2], now, now, values[-2], key),
                )
            await db.execute("DELETE FROM shared_session_access WHERE session_id=?", (session_id,))
            await db.executemany(
                "INSERT INTO shared_session_access (session_id, username) VALUES (?, ?)",
                [(session_id, user) for user in users if isinstance(user, str) and user],
            )
        await db.commit()
