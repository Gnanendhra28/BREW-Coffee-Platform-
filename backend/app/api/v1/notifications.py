"""BREW Coffee Platform — Push Notifications & Hardware Buzzer Endpoints."""

from typing import Dict, Any, List
from fastapi import APIRouter, Request, HTTPException, status
from app.core.security import verify_session_token, get_staff_pins
from app.core.bounded_body import read_bounded_json
from app.services.realtime_broadcaster import broadcast_event

router = APIRouter(tags=["Notifications"])

_subscriptions: Dict[str, List[Dict[str, Any]]] = {}


@router.post("/api/notifications/subscribe")
async def subscribe_pager_endpoint(request: Request):
    """Registers web push subscription for order readiness pager."""
    body = await read_bounded_json(request)
    order_id = body.get("orderId")
    if not order_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing required orderId.",
        )

    subs = _subscriptions.setdefault(order_id, [])
    subs.append(body.get("subscription", {}))

    return {"success": True, "count": len(subs)}


@router.post("/api/notifications/trigger")
async def trigger_buzzer_endpoint(request: Request):
    """Triggers hardware buzzer alert on customer pager and live screens."""
    token = request.cookies.get("brew_session")
    staff_pin_header = request.headers.get("x-staff-pin")
    barista_pin, fleet_admin_pin = get_staff_pins()

    is_authorized = False
    if staff_pin_header and (staff_pin_header in (barista_pin, fleet_admin_pin)):
        is_authorized = True
    elif token:
        payload = verify_session_token(token)
        if payload and payload.role in ("barista", "fleet_admin", "admin"):
            is_authorized = True

    if not is_authorized:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Verified barista or fleet_admin staff authorization required to trigger hardware buzzer.",
        )

    body = await read_bounded_json(request)
    order_id = body.get("orderId")
    order_number = body.get("orderNumber") or "Order"
    van_location = body.get("vanLocationName") or "Van Window 1"

    if not order_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing required orderId.",
        )

    # Broadcast buzzer pulse to client screens via SSE
    broadcast_event("ORDER_STATUS_CHANGED", {
        "orderId": order_id,
        "orderNumber": order_number,
        "status": "ready",
        "vanLocationName": van_location,
        "buzzerAlert": {
            "vibrate": [500, 250, 500, 250, 500],
            "sound": "gentle_chime",
            "message": f"☕ Order #{order_number} is ready for pickup!",
        },
    })

    return {
        "success": True,
        "dispatched": True,
        "notifiedClients": 1,
        "orderId": order_id,
        "subscribersCount": 1,
        "vibrationPattern": [300, 100, 300, 100, 600],
    }
