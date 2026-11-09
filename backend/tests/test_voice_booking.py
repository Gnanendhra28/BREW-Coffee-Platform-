"""Tests for Voice Booking APIs (/api/voice-booking/*)."""

import pytest


@pytest.mark.asyncio
async def test_voice_booking_lifecycle(client):
    # 1. Create new session
    res_init = await client.post("/api/voice-booking/session", json={"language": "hi"})
    assert res_init.status_code == 200
    session_id = res_init.json()["sessionId"]
    assert "नमस्ते" in res_init.json()["session"]["conversationHistory"][0]["content"]

    # 2. Customer chat turn
    res_turn = await client.post(
        "/api/voice-booking/chat",
        json={"sessionId": session_id, "message": "We have 150 guests coming for a corporate celebration."},
    )
    assert res_turn.status_code == 200
    turn_data = res_turn.json()
    assert turn_data["session"]["requirements"]["guestCount"] == 150
    assert turn_data["session"]["quotation"] is not None

    # 3. Customer confirms
    res_confirm = await client.post(
        "/api/voice-booking/chat",
        json={"sessionId": session_id, "message": "Yes, please confirm and proceed with this!"},
    )
    assert res_confirm.status_code == 200
    assert res_confirm.json()["session"]["state"] == "customer_confirmed"

    # 4. Staff approval (restricted)
    res_appr_unauth = await client.post("/api/voice-booking/approve", json={"sessionId": session_id})
    assert res_appr_unauth.status_code == 401

    login_res = await client.post("/api/auth/session", json={"action": "staff_pin", "pin": "2026"})
    cookie_val = login_res.cookies.get("brew_session")

    res_appr = await client.post(
        "/api/voice-booking/approve",
        json={"sessionId": session_id},
        cookies={"brew_session": cookie_val} if cookie_val else {},
    )
    assert res_appr.status_code == 200
    assert "officialBookingId" in res_appr.json()
