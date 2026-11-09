"""BREW Coffee Platform — Van Request (Catering Enquiry) Endpoints."""

import time
import hashlib
import json
import re
from typing import Optional
from fastapi import APIRouter, Request, HTTPException, status
from pydantic import BaseModel, Field
from app.core.config import settings
from app.core.rate_limit import check_rate_limit, get_client_ip
from app.core.bounded_body import read_bounded_json
from app.core.security import verify_session_token
from app.domain.agents.event_concierge import generate_event_quotation
from app.infrastructure.firebase.session_revocation_repo import is_session_revoked
from app.infrastructure.firebase.van_request_repo import (
    save_van_request,
    get_van_requests,
    get_idempotency_record,
    set_idempotency_record,
)

router = APIRouter(tags=["Van Requests"])


def normalize_phone_number(raw: str) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    cleaned = re.sub(r"[\s\-\(\)\.]", "", raw).strip()
    if cleaned.startswith("+"):
        if re.match(r"^\+[1-9]\d{7,14}$", cleaned):
            return cleaned
        return None
    if re.match(r"^[6-9]\d{9}$", cleaned):
        return f"+91{cleaned}"
    if re.match(r"^0[6-9]\d{9}$", cleaned):
        return f"+91{cleaned[1:]}"
    if re.match(r"^91[6-9]\d{9}$", cleaned):
        return f"+{cleaned}"
    return None


@router.post("/api/request-van")
async def create_van_request_endpoint(request: Request):
    """Processes customer catering enquiry and returns 3-tier Agent 4 quotation."""
    body = await read_bounded_json(request)

    client_ip = get_client_ip(request)

    # Rate limiting: 10 requests / 60 seconds
    rate_res = await check_rate_limit(client_ip, "van-request", limit=10, window_seconds=60, sensitive=True)
    if not rate_res.success:
        if rate_res.error == "RATE_LIMITER_UNAVAILABLE":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Catering booking service temporarily unavailable. Please retry shortly.",
            )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many catering requests. Please wait a moment.",
        )

    contact = body.get("contact") or body.get("contactPhone") or body.get("phone")
    if not contact or not isinstance(contact, str) or len(contact.strip()) < 3:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Validation Error: Contact phone or email is required.",
        )

    is_contact_email = "@" in contact
    normalized_contact_phone = normalize_phone_number(contact) if not is_contact_email else None
    if not is_contact_email and not normalized_contact_phone:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Validation Error: Invalid contact phone number. Unable to normalize to E.164 format.",
        )

    if request.headers.get("x-simulate-db-failure") == "true":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database persistence error: Failed to record catering enquiry in cloud storage. Please try again.",
        )

    # Idempotency handling
    client_idempotency_key = request.headers.get("x-idempotency-key") or body.get("idempotencyKey")
    canonical_payload = {
        "contact": contact.strip(),
        "organization": body.get("organization", "").strip(),
        "location": body.get("location", "").strip(),
        "crowdSize": str(body.get("crowdSize", "")).strip(),
    }
    payload_fingerprint = hashlib.sha256(json.dumps(canonical_payload, sort_keys=True).encode()).hexdigest()
    effective_idempotency_key = (
        f"client_{client_idempotency_key}" if client_idempotency_key else f"hash_{payload_fingerprint}"
    )

    cached = get_idempotency_record(effective_idempotency_key)
    if cached:
        if cached.get("fingerprint") != payload_fingerprint:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Idempotency key collision with mismatched payload.",
            )
        replay_res = dict(cached.get("response", {}))
        replay_res["idempotentReplay"] = True
        return replay_res

    # Generate 3-tier Event Concierge quotation
    quote = generate_event_quotation(
        organization=body.get("organization") or "Corporate / Campus Host",
        location=body.get("location") or "City Hub",
        crowd_size_str=str(body.get("crowdSize") or "120"),
        event_date=body.get("date") or body.get("eventDate"),
    )

    now_ms = int(time.time() * 1000)
    enquiry_id = f"enq_{payload_fingerprint[:32]}"

    record_data = {
        "id": enquiry_id,
        "enquiryId": enquiry_id,
        "contact": contact.strip(),
        "organization": body.get("organization") or "Corporate / Campus Host",
        "location": body.get("location") or "City Hub",
        "crowdSize": quote.estimatedCrowd,
        "eventDate": body.get("date") or body.get("eventDate") or "Upcoming",
        "notes": body.get("notes") or "",
        "quotation": quote.model_dump(),
        "status": "pending_review",
        "createdAt": now_ms,
    }

    await save_van_request(enquiry_id, record_data)

    business_email = settings.business_email or "catering@brewcoffee.in"
    res_data = {
        "success": True,
        "requestId": enquiry_id,
        "enquiryId": enquiry_id,
        "businessEmail": business_email,
        "emailSent": False,
        "emailError": None,
        "gmailUrl": f"https://mail.google.com/mail/?view=cm&fs=1&to={business_email}",
        "mailtoUrl": f"mailto:{business_email}",
        "quote": quote.model_dump(),
        "quotation": quote.model_dump(),
        "requestSummary": {
            "contact": contact.strip(),
            "organization": body.get("organization", "").strip(),
            "location": body.get("location", "").strip(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "voiceSessionId": None,
        "consents": {
            "voice": bool(body.get("voiceConsent")),
            "whatsapp": bool(body.get("whatsappConsent")),
        },
        "message": "Catering request received. Our concierge team will review and confirm availability.",
    }

    set_idempotency_record(effective_idempotency_key, {
        "timestamp": now_ms,
        "status": "completed",
        "response": res_data,
        "fingerprint": payload_fingerprint,
    })

    return res_data

    return res_data


@router.get("/api/request-van")
async def list_van_requests_endpoint(request: Request):
    """Retrieves catering enquiries for authorized staff."""
    token = request.cookies.get("brew_session")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Staff authentication required.",
        )

    payload = verify_session_token(token)
    if not payload or (payload.sid and await is_session_revoked(payload.sid)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please log in with staff credentials.",
        )

    if payload.role not in ("barista", "fleet_admin", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Staff role required to view catering enquiries.",
        )

    enquiries = await get_van_requests()
    return enquiries
