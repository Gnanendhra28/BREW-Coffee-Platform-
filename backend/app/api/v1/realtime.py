"""BREW Coffee Platform — Real-Time SSE Stream & Internal Events."""

import time
from fastapi import APIRouter, Request, HTTPException, status
from fastapi.responses import StreamingResponse
from app.core.security import verify_session_token
from app.core.bounded_body import read_bounded_json
from app.services.realtime_broadcaster import subscribe_sse, broadcast_event

router = APIRouter(tags=["Realtime"])


STAFF_ONLY_EVENT_TYPES = {
    "ORDER_STATUS_CHANGED",
    "INVENTORY_CHANGED",
    "LOCATION_CHANGED",
    "FUTURE_STOPS_CHANGED",
    "FLASH_DEAL_CHANGED",
}

ALLOWED_EVENT_TYPES = [
    "ORDER_CREATED",
    "ORDER_STATUS_CHANGED",
    "INVENTORY_CHANGED",
    "LOCATION_CHANGED",
    "FUTURE_STOPS_CHANGED",
    "CURBSIDE_SIGNAL",
    "FLASH_DEAL_CHANGED",
]


@router.get("/api/realtime/stream")
async def realtime_sse_endpoint():
    """Server-Sent Events (SSE) live telemetry stream."""
    return StreamingResponse(
        subscribe_sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/api/realtime/events")
async def realtime_event_publish_endpoint(request: Request):
    """Staff endpoint to publish internal real-time operational events."""
    body = await read_bounded_json(request)
    event_type = body.get("type")
    event_payload = body.get("payload")

    if not event_type or not isinstance(event_type, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing or invalid event 'type' parameter.",
        )

    if event_type == "INITIAL_SYNC":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="INITIAL_SYNC is an internal system event and cannot be emitted by clients.",
        )

    if event_type not in ALLOWED_EVENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported event type: '{event_type}'. Allowed types: {', '.join(ALLOWED_EVENT_TYPES)}",
        )

    if event_type in STAFF_ONLY_EVENT_TYPES:
        token = request.cookies.get("brew_session")
        if not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Unauthorized: Emitting staff event '{event_type}' requires valid staff session authentication.",
            )

        payload = verify_session_token(token)
        if not payload or payload.role not in ("barista", "fleet_admin"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Forbidden: Emitting staff event '{event_type}' requires barista or fleet_admin role.",
            )

    broadcast_event(event_type, event_payload)

    return {
        "success": True,
        "broadcastedAt": int(time.time() * 1000),
    }
