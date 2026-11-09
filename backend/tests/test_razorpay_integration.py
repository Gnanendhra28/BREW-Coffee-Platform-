"""Tests for Razorpay Order Creation with Strict Test-Mode Invariants."""

from unittest.mock import patch, AsyncMock
import pytest
import httpx

from app.core.config import settings


@pytest.mark.asyncio
async def test_razorpay_live_keys_strictly_prohibited(client, monkeypatch):
    """Safety guardrail: rejects live Razorpay keys (rzp_live_) with HTTP 403 Forbidden."""
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_live_forbidden_key_12345")

    res = await client.post(
        "/api/payments/create-order",
        json={
            "items": [{"id": "c-1", "quantity": 2}],
            "promoCode": "BREW10",
            "amount": 454.0,  # 2x 240 - 10% + 5% GST = 454
        },
    )

    assert res.status_code == 403
    data = res.json()
    error_msg = data.get("error") or data.get("detail", "")
    assert "Live Razorpay transactions are strictly prohibited" in error_msg


@pytest.mark.asyncio
async def test_razorpay_test_order_creation_success(client, monkeypatch):
    """Verifies successful Razorpay test order creation via mocked HTTP API."""
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_test_valid_key_67890")
    monkeypatch.setattr(settings, "razorpay_key_secret", "rzp_test_secret_abcde")

    mock_rzp_response = {
        "id": "order_EKwxwAgIt458s6",
        "entity": "order",
        "amount": 45400,
        "amount_paid": 0,
        "amount_due": 45400,
        "currency": "INR",
        "receipt": "rcpt_mock_123",
        "status": "created",
        "attempts": 0,
    }

    mock_resp = httpx.Response(
        status_code=201,
        json=mock_rzp_response,
        headers={"content-type": "application/json"},
        request=httpx.Request("POST", "https://api.razorpay.com/v1/orders"),
    )

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_resp
    mock_http_client.__aenter__.return_value = mock_http_client
    mock_http_client.__aexit__.return_value = None

    with patch("app.services.payment_service.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/payments/create-order",
            json={
                "items": [{"id": "c-1", "quantity": 2}],
                "promoCode": "BREW10",
                "amount": 454.0,
                "customerName": "Test Guest",
                "customerPhone": "+919876543210",
            },
        )

        assert res.status_code == 200
        data = res.json()
        assert data["success"] is True
        assert data["razorpayOrderId"] == "order_EKwxwAgIt458s6"
        assert data["amount"] == 45400 or data["amountInPaise"] == 45400
        assert data["amountInPaise"] == 45400
        assert data["keyId"] == "rzp_test_valid_key_67890"

        # Verify outgoing HTTP request parameters
        assert mock_http_client.post.called
        call_kwargs = mock_http_client.post.call_args.kwargs
        assert call_kwargs["json"]["amount"] == 45400
        assert call_kwargs["json"]["currency"] == "INR"
        assert "Basic " in call_kwargs["headers"]["Authorization"]


@pytest.mark.asyncio
async def test_razorpay_order_creation_error_fallback(client, monkeypatch):
    """Verifies that invalid/unauthorized test keys trigger simulation fallback in dev mode."""
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_test_placeholder_unauthorized")
    monkeypatch.setattr(settings, "razorpay_key_secret", "dummy_secret")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "allow_local_fallback", True)

    mock_err_resp = httpx.Response(
        status_code=401,
        json={"error": {"code": "BAD_REQUEST_ERROR", "description": "The id provided does not exist"}},
        headers={"content-type": "application/json"},
        request=httpx.Request("POST", "https://api.razorpay.com/v1/orders"),
    )

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_err_resp
    mock_http_client.__aenter__.return_value = mock_http_client
    mock_http_client.__aexit__.return_value = None

    with patch("app.services.payment_service.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/payments/create-order",
            json={
                "items": [{"id": "c-1", "quantity": 2}],
                "promoCode": "BREW10",
                "amount": 454.0,
            },
        )

        assert res.status_code == 200
        data = res.json()
        assert data["success"] is True
        # Falls back safely to simulation order test ID
        assert data["razorpayOrderId"].startswith("order_test_")
