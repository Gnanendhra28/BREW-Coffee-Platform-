"""BREW Coffee Platform — Webhook Handlers (Razorpay, WhatsApp, Exotel)."""

import json
import hmac
import hashlib
from typing import Optional
from fastapi import APIRouter, Request, HTTPException, status, Header, Query
from app.core.config import settings
from app.core.bounded_body import read_bounded_bytes
from app.services.payment_service import verify_webhook_signature
from app.infrastructure.firebase.payment_repo import is_webhook_id_processed, mark_webhook_id_processed

router = APIRouter(tags=["Webhooks"])


@router.post("/api/webhooks/razorpay")
async def razorpay_webhook_endpoint(
    request: Request,
    x_razorpay_signature: Optional[str] = Header(None, alias="x-razorpay-signature"),
):
    """Handles verified Razorpay payment capture and order status webhooks."""
    raw_body = await read_bounded_bytes(request)

    if not x_razorpay_signature:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing x-razorpay-signature webhook header",
        )

    is_valid = await verify_webhook_signature(raw_body, x_razorpay_signature)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid webhook signature",
        )

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Malformed webhook JSON payload",
        )

    event_id = payload.get("id") or payload.get("event_id") or f"evt_{hashlib.sha256(raw_body).hexdigest()[:24]}"

    payment_entity = payload.get("payload", {}).get("payment", {}).get("entity", {})
    payment_id = payment_entity.get("id") or ""
    order_id = payment_entity.get("order_id") or ""
    notes = payment_entity.get("notes") or {}
    internal_order_id = notes.get("internalOrderId") or order_id
    amount_in_paise = payment_entity.get("amount") or 0
    currency = payment_entity.get("currency") or "INR"

    from app.infrastructure.firebase.payment_repo import get_payment_order, mark_payment_verified

    effective_order_id = internal_order_id or order_id
    if effective_order_id:
        existing_order = await get_payment_order(effective_order_id)
        if existing_order:
            if existing_order.amountInPaise != amount_in_paise:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Payment amount mismatch! Expected: ₹{existing_order.amountInPaise / 100}, Received: ₹{amount_in_paise / 100}",
                )

    if await is_webhook_id_processed(event_id):
        return {"status": "ok", "received": True, "processed": True, "alreadyProcessed": True, "eventId": event_id}

    await mark_webhook_id_processed(event_id, {
        "event": payload.get("event", "payment.captured"),
        "orderId": order_id,
        "paymentId": payment_id,
        "amountInPaise": amount_in_paise,
        "currency": currency,
        "payload": payload,
    })

    if payment_id and effective_order_id:
        await mark_payment_verified(payment_id, effective_order_id)

    return {"status": "ok", "received": True, "processed": True, "eventId": event_id}


@router.get("/api/webhooks/whatsapp")
async def verify_whatsapp_webhook_endpoint(
    hub_mode: Optional[str] = Query(None, alias="hub.mode"),
    hub_verify_token: Optional[str] = Query(None, alias="hub.verify_token"),
    hub_challenge: Optional[str] = Query(None, alias="hub.challenge"),
):
    """Meta WhatsApp Webhook Verification Challenge."""
    verify_token = settings.meta_whatsapp_verify_token or "brew_meta_verify_token_2026"

    if hub_mode == "subscribe" and hub_verify_token == verify_token:
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(hub_challenge or "")

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Verification token mismatch",
    )


@router.post("/api/webhooks/whatsapp")
async def whatsapp_status_webhook_endpoint(
    request: Request,
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
):
    """Meta WhatsApp delivery status callback."""
    raw_body = await read_bounded_bytes(request)

    if settings.meta_whatsapp_app_secret and x_hub_signature_256:
        secret = settings.meta_whatsapp_app_secret.encode("utf-8")
        expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, x_hub_signature_256):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Meta signature mismatch",
            )

    return {"status": "ok", "received": True}


@router.post("/api/webhooks/voice/exotel/status")
async def exotel_voice_status_webhook_endpoint(request: Request):
    """Exotel outbound call status callbacks."""
    content_type = request.headers.get("content-type", "")
    raw_body = await read_bounded_bytes(request)

    params = {}
    if "application/json" in content_type:
        try:
            params = json.loads(raw_body.decode("utf-8"))
        except Exception:
            pass
    else:
        # Form-urlencoded
        import urllib.parse
        parsed = urllib.parse.parse_qs(raw_body.decode("utf-8"))
        params = {k: v[0] if v else "" for k, v in parsed.items()}

    call_sid = params.get("CallSid") or params.get("Sid")
    call_status = params.get("Status")
    event_type = params.get("EventType")
    custom_field = params.get("CustomField")

    if not call_sid or not call_status:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing CallSid or Status in Exotel callback.",
        )

    # Validate EventType and Status semantic consistency
    if event_type == "terminal" and call_status in ("ringing", "in-progress"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Contradictory Exotel event: terminal event with non-terminal status.",
        )

    return {
        "status": "ok",
        "callSid": call_sid,
        "callStatus": call_status,
        "outcome": "acknowledged",
    }
