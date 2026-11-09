"""BREW Coffee Platform — Session & Authentication Endpoints."""

import time
import os
import hashlib
from typing import Optional, Dict, Any
from fastapi import APIRouter, Request, Response, HTTPException, status
from pydantic import BaseModel
from app.core.config import settings
from app.core.security import (
    create_session_token,
    verify_session_token,
    get_staff_pins,
    verify_staff_pin,
    UserRole,
)
from app.core.rate_limit import check_rate_limit, get_client_ip
from app.core.bounded_body import read_bounded_json
from app.infrastructure.firebase.session_revocation_repo import is_session_revoked, revoke_session

router = APIRouter(tags=["Auth"])
COOKIE_NAME = "brew_session"


@router.get("/api/auth/session")
async def get_session(request: Request, response: Response):
    """Retrieves current session state from cookie."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return {"authenticated": False, "user": None}

    payload = verify_session_token(token)
    if not payload:
        response.delete_cookie(COOKIE_NAME)
        return {"authenticated": False, "user": None}

    if payload.sid and await is_session_revoked(payload.sid):
        response.delete_cookie(COOKIE_NAME)
        return {"authenticated": False, "user": None}

    return {
        "authenticated": True,
        "user": {
            "uid": payload.uid,
            "email": payload.email,
            "displayName": payload.displayName,
            "role": payload.role,
        },
    }


@router.post("/api/auth/session")
async def post_session(request: Request, response: Response):
    """Authenticates staff via PIN or establishes guest session."""
    body = await read_bounded_json(request)
    client_ip = get_client_ip(request)

    # Rate limiting: max 15 requests / 60 seconds
    rate_res = await check_rate_limit(client_ip, "auth-session", limit=15, window_seconds=60, sensitive=True)
    if not rate_res.success:
        if rate_res.error == "RATE_LIMITER_UNAVAILABLE":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authentication rate limiting service temporarily unavailable. Please retry shortly.",
            )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many authentication attempts. Please wait a moment.",
        )

    action = body.get("action")
    pin = body.get("pin")
    role = body.get("role")
    user = body.get("user") or {}

    determined_role: UserRole = "customer"
    final_user = {
        "uid": user.get("uid") or f"usr-{int(time.time() * 1000)}",
        "displayName": user.get("displayName") or "Sanctuary Guest",
        "email": user.get("email"),
    }

    barista_pin, fleet_admin_pin = get_staff_pins()
    is_test_env = (
        os.environ.get("BREW_TEST_SUITE") == "true"
        or os.environ.get("PLAYWRIGHT_TEST") == "true"
        or bool(os.environ.get("TEST_BARISTA_PIN"))
    )
    test_barista_pin = os.environ.get("TEST_BARISTA_PIN") if is_test_env else None

    # Handle PIN submission
    if isinstance(pin, str):
        if fleet_admin_pin and verify_staff_pin(pin, fleet_admin_pin):
            determined_role = "fleet_admin"
            final_user["displayName"] = "Fleet Ops Dispatcher"
            final_user["email"] = "fleet@brewcoffee.in"
        elif barista_pin and verify_staff_pin(pin, barista_pin):
            determined_role = "barista"
            final_user["displayName"] = "Artisan Barista Crew"
            final_user["email"] = "barista@brewcoffee.in"
        elif test_barista_pin and verify_staff_pin(pin, test_barista_pin):
            determined_role = "barista"
            final_user["displayName"] = "Test Barista Crew"
            final_user["email"] = "test-barista@brewcoffee.in"
        else:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid staff PIN. Access denied.",
            )
    elif action == "staff_pin" and not pin:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing required staff PIN parameter.",
        )

    # Privilege escalation defense: Reject client-submitted staff roles
    user_nested_role = user.get("role")
    if (role in ("barista", "fleet_admin", "admin") or user_nested_role in ("barista", "fleet_admin", "admin")) and not pin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Privilege escalation rejected: staff roles strictly require physical PIN authentication.",
        )

    if action == "logout":
        token = request.cookies.get(COOKIE_NAME)
        if token:
            payload = verify_session_token(token)
            if payload and payload.sid:
                await revoke_session(payload.sid, payload.role, payload.expiresAt)
        response.delete_cookie(COOKIE_NAME)
        return {"success": True, "message": "Logged out successfully"}

    # Issue session token
    now_ms = int(time.time() * 1000)
    sid = f"sid_{now_ms}_{hashlib.sha256(f'{final_user['uid']}:{now_ms}'.encode()).hexdigest()[:10]}" if determined_role != "customer" else None

    session_token = create_session_token(
        uid=final_user["uid"],
        email=final_user["email"],
        display_name=final_user["displayName"],
        role=determined_role,
        sid=sid,
    )

    response.set_cookie(
        key=COOKIE_NAME,
        value=session_token,
        max_age=7 * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.is_production,
    )

    return {
        "success": True,
        "authenticated": True,
        "user": {
            "uid": final_user["uid"],
            "email": final_user["email"],
            "displayName": final_user["displayName"],
            "role": determined_role,
        },
    }


@router.delete("/api/auth/session")
async def delete_session(request: Request, response: Response):
    """Logs out and revokes active session."""
    token = request.cookies.get(COOKIE_NAME)
    if token:
        payload = verify_session_token(token)
        if payload and payload.sid:
            await revoke_session(payload.sid, payload.role, payload.expiresAt)
    response.delete_cookie(COOKIE_NAME)
    return {"success": True, "message": "Logged out successfully"}
