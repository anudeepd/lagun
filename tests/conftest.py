"""Shared fixtures for lagun tests."""

import asyncio
import getpass
import os
import shutil
import socket
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import aiomysql
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import lagun.db.crypto as _crypto_mod
import lagun.db.pool as _pool_mod
import lagun.db.session_store as _store_mod


@dataclass(frozen=True)
class MySQLServer:
    host: str
    port: int
    admin_user: str = "root"
    admin_password: str = ""


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _read_server_log(log_path: Path) -> str:
    try:
        return log_path.read_text(errors="replace")
    except OSError:
        return ""


async def _wait_for_mysql(
    server: MySQLServer, process: subprocess.Popen, log_path: Path
) -> None:
    deadline = time.monotonic() + 60
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                "Local MySQL test server exited during startup:\n"
                f"{_read_server_log(log_path)}"
            )
        try:
            connection = await aiomysql.connect(
                host=server.host,
                port=server.port,
                user=server.admin_user,
                password=server.admin_password,
                connect_timeout=1,
                autocommit=True,
            )
        except Exception as error:
            last_error = error
            await asyncio.sleep(0.2)
        else:
            connection.close()
            return
    raise RuntimeError(
        f"Timed out waiting for MySQL at {server.host}:{server.port}: {last_error}\n"
        f"{_read_server_log(log_path)}"
    )


@pytest_asyncio.fixture(scope="session")
async def mysql_server():
    """Use an isolated local server, or an explicitly configured test server.

    No container runtime is used. Install MariaDB/MySQL server binaries to have
    this fixture start a temporary private instance, or set LAGUN_TEST_MYSQL_HOST
    and the admin connection variables to use a dedicated test server.
    """
    host = os.getenv("LAGUN_TEST_MYSQL_HOST")
    if host:
        server = MySQLServer(
            host=host,
            port=int(os.getenv("LAGUN_TEST_MYSQL_PORT", "3306")),
            admin_user=os.getenv("LAGUN_TEST_MYSQL_ADMIN_USER", "root"),
            admin_password=os.getenv("LAGUN_TEST_MYSQL_ADMIN_PASSWORD", ""),
        )
        yield server
        return

    server_binary = shutil.which("mariadbd") or shutil.which("mysqld")
    if not server_binary:
        raise RuntimeError(
            "Backend integration tests need installed MariaDB/MySQL server "
            "binaries (mariadbd/mysqld), or LAGUN_TEST_MYSQL_HOST for a dedicated "
            "test server. Docker is not required."
        )

    version = subprocess.run(
        [server_binary, "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.lower()
    with tempfile.TemporaryDirectory(prefix="lagun-test-mysql-") as temporary:
        root = Path(temporary)
        data_dir = root / "data"
        log_path = root / "server.log"
        user = getpass.getuser()

        if "mariadb" in version:
            installer = shutil.which("mariadb-install-db") or shutil.which(
                "mysql_install_db"
            )
            if not installer:
                raise RuntimeError(
                    "MariaDB server found without mariadb-install-db/mysql_install_db."
                )
            initialize = [
                installer,
                "--no-defaults",
                f"--datadir={data_dir}",
                f"--user={user}",
                "--auth-root-authentication-method=normal",
            ]
        else:
            initialize = [
                server_binary,
                "--no-defaults",
                "--initialize-insecure",
                f"--datadir={data_dir}",
                f"--user={user}",
            ]
        initialized = subprocess.run(
            initialize,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if initialized.returncode:
            raise RuntimeError(
                "Could not initialize the temporary MySQL test database:\n"
                f"{initialized.stdout}{initialized.stderr}"
            )

        port = _free_port()
        server = MySQLServer(host="127.0.0.1", port=port)
        process: subprocess.Popen | None = None
        log_path.touch()
        try:
            process = subprocess.Popen(
                [
                    server_binary,
                    "--no-defaults",
                    f"--datadir={data_dir}",
                    f"--port={port}",
                    "--bind-address=127.0.0.1",
                    f"--socket={root / 'mysql.sock'}",
                    f"--pid-file={root / 'mysql.pid'}",
                    f"--log-error={log_path}",
                    f"--user={user}",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            await _wait_for_mysql(server, process, log_path)
            yield server
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


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
def patch_crypto_key_path(tmp_path):
    """Redirect credential encryption fallback key to the per-test temp dir."""
    original_path = _crypto_mod._FALLBACK_PATH
    original_fernet = _crypto_mod._fernet
    _crypto_mod._FALLBACK_PATH = tmp_path / "master.key"
    _crypto_mod._fernet = None
    yield
    _crypto_mod._FALLBACK_PATH = original_path
    _crypto_mod._fernet = original_fernet


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
async def keep_event_loop_awake():
    """Keep Python 3.13 test loops responsive to aiosqlite worker callbacks."""

    async def tick():
        while True:
            await asyncio.sleep(0.05)

    task = asyncio.create_task(tick())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest_asyncio.fixture
async def client(keep_event_loop_awake):
    """Fresh HTTP client pointing at the FastAPI app."""
    from lagun.db.session_store import init_db

    await init_db()
    from lagun.main import app

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def session_id(client, mysql_server):
    """A saved session pointing at the test MySQL server, deleted after the test."""
    payload = {
        "name": "test-session",
        "host": mysql_server.host,
        "port": mysql_server.port,
        "username": mysql_server.admin_user,
        "password": mysql_server.admin_password,
    }
    r = await client.post("/api/v1/sessions", json=payload)
    assert r.status_code == 201
    sid = r.json()["id"]
    yield sid
    await client.delete(f"/api/v1/sessions/{sid}")


@pytest.fixture
def mysql_database(mysql_server):
    """Create only new schemas and drop only schemas this context created."""
    @asynccontextmanager
    async def database(name):
        quoted = "`" + name.replace("`", "``") + "`"
        conn = await aiomysql.connect(
            host=mysql_server.host,
            port=mysql_server.port,
            user=mysql_server.admin_user,
            password=mysql_server.admin_password,
            autocommit=True,
        )
        try:
            async with conn.cursor() as cur:
                # Refuse collisions rather than seed and later drop user data.
                await cur.execute(f"CREATE DATABASE {quoted}")
            try:
                async with conn.cursor() as cur:
                    await cur.execute(f"USE {quoted}")
                yield conn
            finally:
                async with conn.cursor() as cur:
                    await cur.execute(f"DROP DATABASE {quoted}")
        finally:
            conn.close()

    return database


@pytest_asyncio.fixture
async def test_db(mysql_database):
    """Create a fresh seeded database, including cleanup on setup failure."""
    async with mysql_database("lagun_test") as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                CREATE TABLE users (
                    id  INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    age  INT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            await cur.execute(
                "INSERT INTO users (name, age) VALUES (%s, %s), (%s, %s)",
                ("Alice", 30, "Bob", 25),
            )
        yield "lagun_test"
