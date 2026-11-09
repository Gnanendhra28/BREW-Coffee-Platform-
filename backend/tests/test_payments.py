"""Tests for Payment APIs (/api/payments/create-order & /api/payments/verify)."""

import pytest
import hmac
import hashlib
from app.core.config import settings


@pytest.mark.asyncio
async def test_price_tampering_blocked(client):
    res = await client.post(
        "/api/payments/create-order",
        json={
            "items": [{"id": "c-1", "quantity": 2}],
            "amount": 1.0,  # Client tampering: ₹1 instead of real price
        },
    )
    assert res.status_code == 400
    assert "tampering" in res.json()["error"].lower()


@pytest.mark.asyncio
async def test_unknown_product_id_rejected(client):
    res = await client.post(
        "/api/payments/create-order",
        json={"items": [{"id": "unknown-item-999", "quantity": 1}]},
    )
    assert res.status_code == 400
    assert "Unknown product ID" in res.json()["error"]


@pytest.mark.asyncio
async def test_invalid_promo_code_rejected(client):
    res = await client.post(
        "/api/payments/create-order",
        json={
            "items": [{"id": "c-1", "quantity": 1}],
            "promoCode": "HACK99",
        },
    )
    assert res.status_code == 400
    assert "Invalid or unrecognized promo code" in res.json()["error"]


@pytest.mark.asyncio
async def test_valid_order_creation_and_authoritative_calculation(client):
    # 2x Affogato (2x ₹240 = ₹480) with 10% promo (BREW10) = ₹432 + 5% GST (₹22) = ₹454
    res = await client.post(
        "/api/payments/create-order",
        json={
            "items": [{"id": "c-1", "quantity": 2}],
            "promoCode": "BREW10",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert "orderId" in data
    assert "razorpayOrderId" in data
    assert data["amount"] == 45400 or data["amountInPaise"] == 45400


@pytest.mark.asyncio
async def test_forged_razorpay_signature_rejected(client):
    res = await client.post(
        "/api/payments/verify",
        json={
            "razorpay_order_id": "order_test_123",
            "razorpay_payment_id": "pay_test_456",
            "razorpay_signature": "forged_invalid_signature_hex",
        },
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_valid_signature_and_replay_protection(client):
    order_id = "order_test_valid_999"
    payment_id = "pay_test_valid_888"
    key_secret = settings.razorpay_key_secret.encode("utf-8")
    valid_sig = hmac.new(key_secret, f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()

    # 1. First verification: succeeds
    res1 = await client.post(
        "/api/payments/verify",
        json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": valid_sig,
        },
    )
    assert res1.status_code == 200
    assert res1.json()["verified"] is True

    # 2. Replay with identical payment ID: detected safely
    res2 = await client.post(
        "/api/payments/verify",
        json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": valid_sig,
        },
    )
    assert res2.status_code == 200
    assert res2.json()["alreadyProcessed"] is True
