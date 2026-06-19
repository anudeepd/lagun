"""Cache policy for frontend deployment updates."""

import pytest
from starlette.requests import Request
from starlette.responses import Response


@pytest.mark.asyncio
async def test_spa_shell_revalidates_and_hashed_assets_are_immutable():
    from lagun.main import _static, add_app_security_headers, spa_fallback

    assert _static is not None
    shell = await spa_fallback("")
    request = Request({"type": "http", "path": "/assets/index-hash.js", "headers": []})

    async def asset_response(_request):
        return Response()

    bundled_asset = await add_app_security_headers(request, asset_response)

    assert shell.headers["cache-control"] == "no-cache, must-revalidate"
    assert bundled_asset.headers["cache-control"] == "public, max-age=31536000, immutable"
