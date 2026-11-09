"""BREW Coffee Platform — Payment Domain Service.

Authoritative price calculation, discount enforcement, GST computation,
Razorpay order creation with test-mode enforcement, and HMAC signature verification.
"""

import base64
import time
import hmac
import hashlib
import logging
from typing import Dict, Any, Tuple, List
import httpx
from fastapi import HTTPException, status

from app.core.config import settings
from app.domain.models.menu import MENU_MAP, MenuItem
from app.domain.models.order import (
    CreateOrderInput,
    VerifyPaymentInput,
    StoredPaymentOrder,
    StoredPaymentItem,
)
from app.infrastructure.firebase.payment_repo import (
    save_payment_order,
    get_payment_order_by_id,
    mark_payment_verified,
    is_payment_id_processed,
)

logger = logging.getLogger(__name__)


def calculate_order_pricing(
    input_data: CreateOrderInput,
) -> Tuple[float, float, float, float, float, str, List[StoredPaymentItem]]:
    """Authoritative server-side price calculation with discount and anti-tampering guards."""
    subtotal = 0.0
    validated_items: List[StoredPaymentItem] = []

    for item in input_data.items:
        menu_item = MENU_MAP.get(item.id)
        if not menu_item:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown product ID: '{item.id}'. Product not found in authoritative menu catalog.",
            )
        if item.quantity <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid item quantity: {item.quantity} for item '{item.id}'. Quantity must be >= 1.",
            )

        subtotal += menu_item.price * item.quantity
        validated_items.append(
            StoredPaymentItem(
                id=menu_item.id,
                name=menu_item.name,
                price=menu_item.price,
                quantity=item.quantity,
            )
        )

    # Member discount (10%)
    member_discount = round(subtotal * 0.1) if input_data.isMember else 0.0

    # Promo discount
    promo_discount = 0.0
    promo_type = ""
    if input_data.promoCode:
        code = input_data.promoCode.strip().upper()
        if code in ("BREW10", "WELCOME"):
            promo_discount = round(subtotal * 0.1)
            promo_type = "10_PERCENT_OFF"
        elif code.startswith("BREWCARE"):
            promo_discount = min(subtotal, 50.0)
            promo_type = "GUEST_RECOVERY_50"
        elif code == "FREEDEL":
            promo_discount = 0.0
            promo_type = "FREE_DELIVERY"
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid or unrecognized promo code: '{input_data.promoCode}'. Available codes: BREW10, WELCOME, or valid BREWCARE recovery vouchers.",
            )

    # Delivery & Tax
    is_delivery_free = (
        bool(input_data.isMember)
        or subtotal >= 399
        or promo_type == "FREE_DELIVERY"
        or promo_discount > 0
    )
    delivery_fee = 0.0 if is_delivery_free else 49.0

    taxable_amount = max(0.0, subtotal - member_discount - promo_discount)
    estimated_tax = round(taxable_amount * 0.05)  # 5% GST
    server_total = max(0.0, taxable_amount + estimated_tax + delivery_fee)

    # Anti-tampering check
    if input_data.amount is not None:
        if abs(input_data.amount - server_total) > 1.0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Price tampering detected: client submitted amount (₹{input_data.amount}) does not match server-calculated total (₹{server_total}).",
            )

    total_discount = member_discount + promo_discount
    return (
        subtotal,
        total_discount,
        estimated_tax,
        delivery_fee,
        server_total,
        promo_type,
        validated_items,
    )


async def create_payment_order(input_data: CreateOrderInput) -> Dict[str, Any]:
    """Creates internal order and associated Razorpay test order.
    
    Strictly prohibits live-mode transactions (rejects rzp_live_ keys).
    """
    subtotal, discount, tax, delivery, total, promo_type, validated_items = (
        calculate_order_pricing(input_data)
    )
    amount_in_paise = int(round(total * 100))

    now_ms = int(time.time() * 1000)
    internal_id = f"ord_{now_ms}_{hashlib.sha256(f'{total}:{now_ms}'.encode()).hexdigest()[:5]}"
    effective_receipt = input_data.receipt or f"rcpt_{now_ms}"
    customer_name = input_data.customerName or "Sanctuary Guest"
    van_location = input_data.vanLocationName or "HITEC City — Cyber Towers (Hyderabad)"

    key_id = settings.razorpay_key_id
    key_secret = settings.razorpay_key_secret

    # Safety invariant: Reject live-mode credentials
    if key_id and key_id.startswith("rzp_live_"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Live Razorpay transactions are strictly prohibited. Only rzp_test_ keys are permitted.",
        )

    razorpay_order_id = f"order_test_{now_ms}_{hashlib.sha256(f'{internal_id}'.encode()).hexdigest()[:5]}"

    # Outbound async HTTP call to Razorpay API in test mode
    if key_id and key_id.startswith("rzp_test_") and key_secret:
        try:
            auth_header = (
                "Basic "
                + base64.b64encode(f"{key_id}:{key_secret}".encode()).decode("utf-8")
            )
            rzp_payload = {
                "amount": amount_in_paise,
                "currency": "INR",
                "receipt": effective_receipt,
                "payment_capture": 1,
                "notes": {
                    "internalOrderId": internal_id,
                    "customerName": customer_name,
                    "customerPhone": input_data.customerPhone or "N/A",
                    "vanLocation": van_location,
                    "itemCount": len(validated_items),
                },
            }

            async with httpx.AsyncClient(timeout=10.0) as client:
                rzp_res = await client.post(
                    "https://api.razorpay.com/v1/orders",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": auth_header,
                    },
                    json=rzp_payload,
                )

                if rzp_res.status_code in (200, 201):
                    rzp_data = rzp_res.json()
                    razorpay_order_id = rzp_data.get("id", razorpay_order_id)
                else:
                    error_data = rzp_res.json() if rzp_res.headers.get("content-type", "").startswith("application/json") else {}
                    logger.warning(f"Razorpay API rejected request: {error_data}")
                    if settings.allow_local_fallback and not settings.is_production:
                        # Simulation fallback for development / placeholder test keys
                        razorpay_order_id = f"order_test_{now_ms}_{hashlib.sha256(f'{internal_id}'.encode()).hexdigest()[:5]}"
                    else:
                        err_desc = error_data.get("error", {}).get("description", "Failed to create Razorpay order")
                        raise HTTPException(
                            status_code=rzp_res.status_code,
                            detail=f"Razorpay gateway error: {err_desc}",
                        )
        except HTTPException:
            raise
        except Exception as err:
            logger.warning(f"Razorpay order creation connection error, falling back to test id: {err}")
            if not (settings.allow_local_fallback and not settings.is_production):
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Payment gateway communication failure: {str(err)}",
                )

    order = StoredPaymentOrder(
        orderId=internal_id,
        customerReference=customer_name,
        customerName=customer_name,
        customerPhone=input_data.customerPhone,
        items=validated_items,
        subtotal=subtotal,
        discountAmount=discount,
        appliedPromotion=promo_type or None,
        taxAmount=tax,
        deliveryFee=delivery,
        finalTotal=total,
        amountInPaise=amount_in_paise,
        currency="INR",
        receipt=effective_receipt,
        razorpayOrderId=razorpay_order_id,
        paymentStatus="pending",
        orderStatus="pending",
        createdAt=now_ms,
        updatedAt=now_ms,
        vanLocationName=van_location,
    )

    await save_payment_order(order)

    return {
        "success": True,
        "orderId": razorpay_order_id,
        "internalOrderId": order.orderId,
        "razorpayOrderId": razorpay_order_id,
        "amount": amount_in_paise,
        "finalTotal": total,
        "amountInPaise": amount_in_paise,
        "currency": "INR",
        "keyId": key_id,
        "breakdown": {
            "subtotal": subtotal,
            "discount": discount,
            "tax": tax,
            "deliveryFee": delivery,
            "total": total,
            "finalTotal": total,
        },
    }


async def verify_payment_signature(input_data: VerifyPaymentInput) -> Dict[str, Any]:
    """Verifies Razorpay HMAC signature and marks payment verified."""
    if await is_payment_id_processed(input_data.razorpay_payment_id):
        return {
            "success": True,
            "verified": True,
            "alreadyProcessed": True,
            "message": "Payment has already been durably recorded and processed.",
        }

    secret = settings.razorpay_key_secret
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server payment secret configuration error.",
        )

    # Cryptographic HMAC verification: sha256(orderId + "|" + paymentId, secret)
    payload = f"{input_data.razorpay_order_id}|{input_data.razorpay_payment_id}".encode("utf-8")
    expected_sig = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected_sig, input_data.razorpay_signature):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cryptographic signature verification failed",
        )

    await mark_payment_verified(
        input_data.razorpay_payment_id,
        input_data.razorpay_order_id,
        input_data.customerReference or "Guest",
    )

    return {
        "success": True,
        "verified": True,
        "message": "Payment verified and recorded successfully.",
        "paymentId": input_data.razorpay_payment_id,
        "orderId": input_data.razorpay_order_id,
    }


async def verify_webhook_signature(raw_body: bytes, signature: str) -> bool:
    """Verifies Razorpay webhook HMAC-SHA256 signature."""
    secret = settings.razorpay_webhook_secret
    if not secret:
        return False
    expected_sig = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected_sig, signature)

