"""BREW Coffee Platform — Session Revocation Repository."""

import time
from typing import Set
from .client import get_firestore_client

_mem_revoked_sessions: Set[str] = set()
REVOCATION_COLLECTION = "revoked_sessions"


async def revoke_session(sid: str, role: str, expires_at: int) -> None:
    """Durably marks a session ID as revoked."""
    _mem_revoked_sessions.add(sid)
    db = get_firestore_client()
    if db is not None:
        try:
            db.collection(REVOCATION_COLLECTION).document(sid).set({
                "sid": sid,
                "role": role,
                "expiresAt": expires_at,
                "revokedAt": int(time.time() * 1000),
            })
        except Exception:
            pass


async def is_session_revoked(sid: str) -> bool:
    """Checks if a session ID has been revoked."""
    if sid in _mem_revoked_sessions:
        return True
    db = get_firestore_client()
    if db is not None:
        try:
            doc = db.collection(REVOCATION_COLLECTION).document(sid).get()
            if doc.exists:
                _mem_revoked_sessions.add(sid)
                return True
        except Exception:
            pass
    return False
