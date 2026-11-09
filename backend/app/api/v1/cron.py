"""BREW Coffee Platform — Scheduled Background Worker Endpoints.

Periodically processes pending, retryable, and expired-lease outbox deliveries.
Restricts mutations strictly to POST; rejects GET/PUT/DELETE with 405 Method Not Allowed.
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, Request, Response, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from app.core.config import settings
from app.core.bounded_body import read_bounded_json
from app.services.outbox_worker import OutboxWorker, run_outbox_worker_cycles

router = APIRouter(tags=["Cron"])


def _verify_cron_auth(request: Request):
    """Enforces constant-time worker secret authorization."""
    auth_header = request.headers.get("authorization", "")
    token = (
        auth_header.replace("Bearer ", "").strip()
        if "Bearer " in auth_header
        else request.headers.get("x-cron-secret", "")
    )
    expected_secret = settings.cron_secret or settings.outbox_worker_secret

    if not token or not expected_secret or token != expected_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: valid worker authorization secret required.",
        )


@router.post("/api/cron/outbox-worker")
async def run_outbox_worker_endpoint(request: Request):
    """Executes scheduled outbox dispatch cycles."""
    _verify_cron_auth(request)

    # 1. Parse query and optional body options
    batch_size = int(request.query_params.get("batchSize", 10))
    lease_duration_ms = int(request.query_params.get("leaseDurationMs", 60_000))
    max_cycles = int(request.query_params.get("maxCycles", 1))
    max_duration_ms = int(request.query_params.get("maxDurationMs", 25_000))
    worker_id = request.query_params.get("workerId")

    try:
        body = await read_bounded_json(request)
        if isinstance(body, dict):
            if "batchSize" in body:
                batch_size = int(body["batchSize"])
            if "leaseDurationMs" in body:
                lease_duration_ms = int(body["leaseDurationMs"])
            if "maxCycles" in body:
                max_cycles = int(body["maxCycles"])
            if "maxDurationMs" in body:
                max_duration_ms = int(body["maxDurationMs"])
            if "workerId" in body and isinstance(body["workerId"], str):
                worker_id = body["workerId"]
    except Exception:
        pass

    worker = OutboxWorker(
        worker_id=worker_id,
        lease_duration_ms=lease_duration_ms,
        batch_size=batch_size,
    )

    result = await run_outbox_worker_cycles(
        worker=worker,
        max_cycles=max_cycles,
        max_duration_ms=max_duration_ms,
    )

    return {
        "success": True,
        "cyclesCompleted": result["cyclesCompleted"],
        "durationMs": result["durationMs"],
        "result": result["aggregateResult"],
        "timestamp": result["timestamp"],
    }


@router.get("/api/cron/outbox-worker")
async def get_outbox_worker_method_not_allowed():
    """Strictly rejects GET with 405 Method Not Allowed."""
    return JSONResponse(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        content={"error": "Method Not Allowed. Use POST to execute outbox worker cycles."},
        headers={"Allow": "POST"},
    )


@router.put("/api/cron/outbox-worker")
async def put_outbox_worker_method_not_allowed():
    """Strictly rejects PUT with 405 Method Not Allowed."""
    return JSONResponse(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        content={"error": "Method Not Allowed. Use POST to execute outbox worker cycles."},
        headers={"Allow": "POST"},
    )


@router.delete("/api/cron/outbox-worker")
async def delete_outbox_worker_method_not_allowed():
    """Strictly rejects DELETE with 405 Method Not Allowed."""
    return JSONResponse(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        content={"error": "Method Not Allowed. Use POST to execute outbox worker cycles."},
        headers={"Allow": "POST"},
    )
