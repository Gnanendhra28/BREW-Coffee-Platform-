"""Tests for Session & Authentication API (/api/auth/session)."""

import pytest


@pytest.mark.asyncio
async def test_unauthenticated_session(client):
    res = await client.get("/api/auth/session")
    assert res.status_code == 200
    assert res.json() == {"authenticated": False, "user": None}


@pytest.mark.asyncio
async def test_valid_barista_pin_authentication(client):
    res = await client.post("/api/auth/session", json={"action": "staff_pin", "pin": "2026"})
    assert res.status_code == 200
    data = res.json()
    assert data["authenticated"] is True
    assert data["user"]["role"] == "barista"
    assert "set-cookie" in res.headers or "brew_session" in str(res.cookies)


@pytest.mark.asyncio
async def test_invalid_staff_pin_rejected(client):
    res = await client.post("/api/auth/session", json={"action": "staff_pin", "pin": "0000"})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_privilege_escalation_blocked(client):
    res = await client.post("/api/auth/session", json={"role": "barista", "user": {"uid": "attacker", "role": "barista"}})
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_logout_session(client):
    login_res = await client.post("/api/auth/session", json={"action": "staff_pin", "pin": "2026"})
    assert login_res.status_code == 200

    cookie_val = login_res.cookies.get("brew_session")
    logout_res = await client.post(
        "/api/auth/session",
        json={"action": "logout"},
        cookies={"brew_session": cookie_val} if cookie_val else {},
    )
    assert logout_res.status_code == 200
