"""Shared fixtures for lagun tests."""
import pytest
import pytest_asyncio
import aiomysql
from httpx import AsyncClient, ASGITransport

import lagun.db.session_store as _store_mod
import lagun.db.pool as _pool_mod


@pytest.fixture(scope="session")
def mysql_container():
    from testcontainers.mysql import MySqlContainer
    with MySqlContainer("mysql:8.0") as c:
        yield c


@pytest.fixture(autouse=True)
def patch_db_path(tmp_path):
    """Redirect the session store SQLite DB to a fresh temp file per test.

    Function-scoped so tests never share SQLite state (prevents session leakage
    between tests like config-export tests and test_list_sessions_empty).
    """
    path = tmp_path / "lagun.db"
    original = _store_mod._DB_PATH
    _store_mod._DB_PATH = path
    yield path
    _store_mod._DB_PATH = original


@pytest.fixture(autouse=True)
def reset_pool_state():
    """Reset pool module globals before/after each test.

    Each test gets its own asyncio event loop (pytest-asyncio default).
    Clearing the lock and pool dict prevents 'Future attached to a different loop' errors.
    """
    _pool_mod._lock = None
    _pool_mod._pools.clear()
    yield
    _pool_mod._lock = None
    _pool_mod._pools.clear()


@pytest_asyncio.fixture
async def client():
    """Fresh HTTP client pointing at the FastAPI app."""
    from lagun.db.session_store import init_db
    await init_db()
    from lagun.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def session_id(client, mysql_container):
    """A saved session pointing at the test MySQL container, deleted after the test."""
    payload = {
        "name": "test-session",
        "host": mysql_container.get_container_host_ip(),
        "port": int(mysql_container.get_exposed_port(3306)),
        "username": "test",
        "password": "test",
    }
    r = await client.post("/api/v1/sessions", json=payload)
    assert r.status_code == 201
    sid = r.json()["id"]
    yield sid
    await client.delete(f"/api/v1/sessions/{sid}")


@pytest_asyncio.fixture
async def test_db(mysql_container):
    """Create a fresh `lagun_test` database with a seeded `users` table.

    Dropped after the test so each test gets a clean slate.
    """
    host = mysql_container.get_container_host_ip()
    port = int(mysql_container.get_exposed_port(3306))
    conn = await aiomysql.connect(host=host, port=port, user="root", password="test", autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute("CREATE DATABASE IF NOT EXISTS `lagun_test`")
            await cur.execute("GRANT ALL PRIVILEGES ON `lagun_test`.* TO 'test'@'%'")
            await cur.execute("USE `lagun_test`")
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id  INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    age  INT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            await cur.execute(
                "INSERT INTO users (name, age) VALUES (%s, %s), (%s, %s)",
                ("Alice", 30, "Bob", 25),
            )
    finally:
        conn.close()
    yield "lagun_test"
    conn = await aiomysql.connect(host=host, port=port, user="root", password="test", autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute("DROP DATABASE IF EXISTS `lagun_test`")
    finally:
        conn.close()
