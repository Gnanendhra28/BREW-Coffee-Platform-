"""BREW Coffee Platform — Session Token & Cryptographic Security.

Implements exact binary and JSON compatibility with Next.js authTokens.ts:
- 2-part HMAC-SHA256 token format: `${encodedPayload}.${encodedSignature}`
- Constant-time PIN and secret comparisons (`hmac.compare_digest`)
- Timing-safe staff verification against BARISTA_PIN and FLEET_ADMIN_PIN
"""

import base64
import hmac
import hashlib
import json
import time
from typing import Optional, Literal
from pydantic import BaseModel
from .config import settings

UserRole = Literal["customer", "barista", "fleet_admin", "admin"]
VALID_USER_ROLES = {"customer", "barista", "fleet_admin", "admin"}
PRIVILEGED_STAFF_ROLES = {"barista", "fleet_admin", "admin"}

SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7  # 7 days


class SessionPayload(BaseModel):
    uid: str
    email: Optional[str] = None
    displayName: Optional[str] = None
    role: UserRole
    issuedAt: int
    expiresAt: int
    sid: Optional[str] = None


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def base64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def get_staff_pins() -> tuple[str, str]:
    """Returns (barista_pin, fleet_admin_pin) with production default checks."""
    is_prod = settings.is_production
    barista = settings.barista_pin
    fleet_admin = settings.fleet_admin_pin

    if is_prod:
        safe_barista = barista if barista != "2026" else ""
        safe_fleet = fleet_admin if fleet_admin != "7788" else ""
        return safe_barista, safe_fleet

    return barista or "2026", fleet_admin or "7788"


def verify_staff_pin(submitted_pin: str, expected_pin: str) -> bool:
    """Constant-time PIN comparison to prevent timing attacks."""
    if not submitted_pin or not expected_pin:
        return False
    return hmac.compare_digest(submitted_pin.encode("utf-8"), expected_pin.encode("utf-8"))


def create_session_token(
    uid: str,
    email: Optional[str] = None,
    display_name: Optional[str] = None,
    role: UserRole = "customer",
    sid: Optional[str] = None,
) -> str:
    """Creates a 2-part HMAC-SHA256 signed session token wire-compatible with Next.js."""
    now_ms = int(time.time() * 1000)
    effective_sid = sid or f"sess_{now_ms}_{hashlib.sha256(f'{uid}:{now_ms}'.encode()).hexdigest()[:14]}"

    payload = {
        "uid": uid,
        "email": email,
        "displayName": display_name,
        "role": role,
        "issuedAt": now_ms,
        "expiresAt": now_ms + SESSION_MAX_AGE_MS,
        "sid": effective_sid,
    }

    payload_json = json.dumps(payload, separators=(",", ":"))
    encoded_payload = base64url_encode(payload_json.encode("utf-8"))

    secret_key = settings.auth_secret.encode("utf-8")
    signature = hmac.new(secret_key, encoded_payload.encode("utf-8"), hashlib.sha256).digest()
    encoded_sig = base64url_encode(signature)

    return f"{encoded_payload}.{encoded_sig}"


def verify_session_token(token: str) -> Optional[SessionPayload]:
    """Verifies HMAC signature, structural invariants, and expiration of session token."""
    if not token or "." not in token:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None

    encoded_payload, encoded_sig = parts[0], parts[1]

    try:
        secret_key = settings.auth_secret.encode("utf-8")
        expected_sig = hmac.new(secret_key, encoded_payload.encode("utf-8"), hashlib.sha256).digest()
        actual_sig = base64url_decode(encoded_sig)

        if not hmac.compare_digest(expected_sig, actual_sig):
            return None

        payload_bytes = base64url_decode(encoded_payload)
        data = json.loads(payload_bytes.decode("utf-8"))

        if not isinstance(data, dict):
            return None

        uid = data.get("uid")
        role = data.get("role")
        expires_at = data.get("expiresAt")
        sid = data.get("sid")

        if not uid or not isinstance(uid, str) or not uid.strip():
            return None

        if role not in VALID_USER_ROLES:
            return None

        now_ms = int(time.time() * 1000)
        if not isinstance(expires_at, (int, float)) or now_ms > expires_at:
            return None

        if role in PRIVILEGED_STAFF_ROLES:
            if not sid or not isinstance(sid, str) or not sid.strip():
                return None

        return SessionPayload(
            uid=uid,
            email=data.get("email"),
            displayName=data.get("displayName"),
            role=role,
            issuedAt=data.get("issuedAt", now_ms),
            expiresAt=int(expires_at),
            sid=sid,
        )
    except Exception:
        return None
