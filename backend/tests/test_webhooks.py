"""Tests for Webhooks (/api/webhooks/*)."""

import pytest
import hmac
import hashlib
import json
from app.core.config import settings


@pytest.mark.asyncio
async def test_razorpay_webhook_verification(client):
    payload = json.dumps({"event": "payment.captured", "id": "evt_test_razorpay_101"}).encode()
    secret = settings.razorpay_webhook_secret.encode("utf-8")
    sig = hmac.new(secret, payload, hashlib.sha256).hexdigest()

    # Unsigned rejected
    res_unsigned = await client.post("/api/webhooks/razorpay", content=payload)
    assert res_unsigned.status_code == 400

    # Signed accepted
    res_signed = await client.post(
        "/api/webhooks/razorpay",
        content=payload,
        headers={"x-razorpay-signature": sig},
    )
    assert res_signed.status_code == 200
    assert res_signed.json()["processed"] is True


@pytest.mark.asyncio
async def test_whatsapp_webhook_verification(client):
    res = await client.get(
        "/api/webhooks/whatsapp",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": "brew_meta_verify_token_2026",
            "hub.challenge": "challenge_code_999",
        },
    )
    assert res.status_code == 200
    assert res.text == "challenge_code_999"


@pytest.mark.asyncio
async def test_exotel_webhook_status_ack(client):
    res = await client.post(
        "/api/webhooks/voice/exotel/status",
        json={
            "CallSid": "call_exo_test_999",
            "Status": "in-progress",
            "EventType": "answered",
        },
    )
    assert res.status_code == 200
    assert res.json()["outcome"] == "acknowledged"
