"""Tests for GET /api/health."""

import pytest


@pytest.mark.asyncio
async def test_healthcheck_returns_200(client):
    res = await client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] in ("healthy", "degraded")
    assert "checks" in data
    assert "realtimeStore" in data["checks"]
    assert "fleetOperations" in data["checks"]
    assert data["checks"]["fleetOperations"]["activeVans"] == 3
