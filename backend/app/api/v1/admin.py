"""BREW Coffee Platform — Admin Operations & Outbox Metrics Endpoints."""

import time
from fastapi import APIRouter, Request, HTTPException, status
from app.core.security import verify_session_token
from app.core.config import settings
from app.infrastructure.firebase.outbox_repo import get_outbox_telemetry_metrics
from .voice_booking import approve_voice_booking_endpoint, reject_voice_booking_endpoint

router = APIRouter(tags=["Admin"])


@router.post("/api/admin/voice-bookings/approve")
async def admin_approve_voice_booking(request: Request):
    """Admin alias for voice booking approval."""
    return await approve_voice_booking_endpoint(request)


@router.post("/api/admin/voice-bookings/reject")
async def admin_reject_voice_booking(request: Request):
    """Admin alias for voice booking rejection."""
    return await reject_voice_booking_endpoint(request)


@router.get("/api/admin/outbox/metrics")
async def get_outbox_metrics_endpoint(request: Request):
    """Operational monitoring endpoint for communication outbox telemetry."""
    # Worker auth via CRON_SECRET or staff session
    auth_header = request.headers.get("authorization", "")
    cron_token = auth_header.replace("Bearer ", "").strip() if "Bearer " in auth_header else request.headers.get("x-cron-secret", "")

    token = request.cookies.get("brew_session")
    is_authorized = False

    if cron_token and cron_token == settings.cron_secret:
        is_authorized = True
    elif token:
        payload = verify_session_token(token)
        if payload and payload.role in ("barista", "fleet_admin", "admin"):
            is_authorized = True

    if not is_authorized:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: valid staff session or worker authorization secret required.",
        )

    telemetry = await get_outbox_telemetry_metrics()

    return {
        "success": True,
        "metrics": {
            "countsByStatus": telemetry["countsByStatus"],
            "staleLeases": telemetry["staleLeases"],
            "oldestPendingAgeMs": 0,
            "failureBreakdown": {},
        },
    }
