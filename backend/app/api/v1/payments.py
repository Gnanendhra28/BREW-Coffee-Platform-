"""BREW Coffee Platform — Payments API Router."""

from fastapi import APIRouter, Request, HTTPException, status
from app.core.rate_limit import check_rate_limit, get_client_ip
from app.core.bounded_body import read_bounded_json
from app.domain.models.order import CreateOrderInput, VerifyPaymentInput
from app.services.payment_service import create_payment_order, verify_payment_signature

router = APIRouter(tags=["Payments"])


@router.post("/api/payments/create-order")
async def handle_create_order(request: Request):
    """Creates a server-authoritative payment order and Razorpay order ID."""
    client_ip = get_client_ip(request)

    # Rate limiting: 20 attempts / 60 seconds
    rate_res = await check_rate_limit(client_ip, "create-payment-order", limit=20, window_seconds=60, sensitive=True)
    if not rate_res.success:
        if rate_res.error == "RATE_LIMITER_UNAVAILABLE":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Payment order service temporarily unavailable. Please retry shortly.",
            )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many payment order attempts. Please slow down.",
        )

    raw_body = await read_bounded_json(request)
    try:
        input_data = CreateOrderInput(**raw_body)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Validation Error: {str(e)}",
        )

    return await create_payment_order(input_data)


@router.post("/api/payments/verify")
async def handle_verify_payment(request: Request):
    """Cryptographically verifies Razorpay payment signature."""
    raw_body = await read_bounded_json(request)

    order_id = raw_body.get("razorpay_order_id")
    payment_id = raw_body.get("razorpay_payment_id")
    signature = raw_body.get("razorpay_signature")

    if not order_id or not isinstance(order_id, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing or invalid razorpay_order_id",
        )
    if not payment_id or not isinstance(payment_id, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing or invalid razorpay_payment_id",
        )
    if not signature or not isinstance(signature, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing razorpay_signature for verification.",
        )

    input_data = VerifyPaymentInput(
        razorpay_order_id=order_id,
        razorpay_payment_id=payment_id,
        razorpay_signature=signature,
    )

    return await verify_payment_signature(input_data)
