"""Safety guarantees for disposable local and external test databases."""

import aiomysql
import pytest


async def test_database_collision_preserves_existing_data(mysql_database):
    async with mysql_database("lagun_fixture_collision") as conn:
        async with conn.cursor() as cur:
            await cur.execute("CREATE TABLE sentinel (value INT)")
            await cur.execute("INSERT INTO sentinel VALUES (42)")
        with pytest.raises(aiomysql.ProgrammingError) as error:
            async with mysql_database("lagun_fixture_collision"):
                pytest.fail("An existing database must not be reused")
        assert error.value.args[0] == 1007
        async with conn.cursor() as cur:
            await cur.execute("SELECT value FROM sentinel")
            assert await cur.fetchall() == ((42,),)


async def test_database_is_removed_after_setup_failure(mysql_database):
    with pytest.raises(RuntimeError, match="seed failed"):
        async with mysql_database("lagun_fixture_failed_setup") as conn:
            async with conn.cursor() as cur:
                await cur.execute("CREATE TABLE partially_seeded (value INT)")
            raise RuntimeError("seed failed")
    # Recreating the same name proves cleanup also ran before a fixture yielded.
    async with mysql_database("lagun_fixture_failed_setup") as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT TABLE_NAME FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA=DATABASE()"
            )
            assert await cur.fetchall() == ()
