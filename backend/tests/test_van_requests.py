"""Tests for Van Requests & Catering Concierge (/api/request-van)."""

import pytest


@pytest.mark.asyncio
async def test_missing_contact_rejected(client):
    res = await client.post("/api/request-van", json={"organization": "Acme"})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_valid_catering_request_generates_quote(client):
    res = await client.post(
        "/api/request-van",
        json={
            "contact": "events@acme.corp",
            "organization": "Acme Corp",
            "location": "Cyber Gateway, HITEC City",
            "crowdSize": 150,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert "enquiryId" in data
    assert "quote" in data
    assert len(data["quote"]["tiers"]) == 3


@pytest.mark.asyncio
async def test_idempotency_and_key_collision(client):
    payload1 = {
        "contact": "idemp@brew.in",
        "organization": "Org A",
        "location": "Loc A",
        "crowdSize": 100,
        "idempotencyKey": "idem_key_test_123",
    }
    res1 = await client.post("/api/request-van", json=payload1)
    assert res1.status_code == 200
    enquiry_id = res1.json()["enquiryId"]

    # Re-submit identical: safe replay
    res2 = await client.post("/api/request-van", json=payload1)
    assert res2.status_code == 200
    assert res2.json()["enquiryId"] == enquiry_id
    assert res2.json().get("idempotentReplay") is True

    # Collision with mismatched payload: 409 Conflict
    payload_mismatch = {
        "contact": "different@brew.in",
        "organization": "Org B",
        "location": "Loc B",
        "crowdSize": 200,
        "idempotencyKey": "idem_key_test_123",
    }
    res3 = await client.post("/api/request-van", json=payload_mismatch)
    assert res3.status_code == 409


@pytest.mark.asyncio
async def test_staff_access_control(client):
    # Unauthenticated GET: 401
    res_unauth = await client.get("/api/request-van")
    assert res_unauth.status_code == 401

    # Authenticate as barista
    login_res = await client.post("/api/auth/session", json={"action": "staff_pin", "pin": "2026"})
    cookie_val = login_res.cookies.get("brew_session")

    # Staff GET: 200 with list
    res_staff = await client.get(
        "/api/request-van",
        cookies={"brew_session": cookie_val} if cookie_val else {},
    )
    assert res_staff.status_code == 200
    assert isinstance(res_staff.json(), list)
