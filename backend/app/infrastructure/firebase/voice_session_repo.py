"""BREW Coffee Platform — Voice Booking Session Repository."""

from typing import Dict, Any, List, Optional
from app.domain.models.voice_booking import VoiceBookingSession
from .client import get_firestore_client

_mem_voice_sessions: Dict[str, VoiceBookingSession] = {}
VOICE_SESSIONS_COLLECTION = "voice_booking_sessions"


class ConcurrencyConflictError(Exception):
    """Raised when an update encounters a stale session revision."""
    pass


async def save_voice_session(session: VoiceBookingSession, expected_revision: Optional[int] = None) -> None:
    """Saves session enforcing optimistic concurrency control on revision."""
    current = _mem_voice_sessions.get(session.id)
    if current is not None and expected_revision is not None:
        if current.revision != expected_revision:
            raise ConcurrencyConflictError(
                f"Concurrency conflict: expected revision {expected_revision}, but current is {current.revision}."
            )

    session.revision += 1
    _mem_voice_sessions[session.id] = session

    db = get_firestore_client()
    if db is not None:
        try:
            doc_ref = db.collection(VOICE_SESSIONS_COLLECTION).document(session.id)
            doc_data = session.model_dump()
            doc_ref.set(doc_data)
        except Exception:
            pass


async def get_voice_session_by_id(session_id: str) -> Optional[VoiceBookingSession]:
    """Retrieves session by ID."""
    if session_id in _mem_voice_sessions:
        return _mem_voice_sessions[session_id]

    db = get_firestore_client()
    if db is not None:
        try:
            doc = db.collection(VOICE_SESSIONS_COLLECTION).document(session_id).get()
            if doc.exists:
                session = VoiceBookingSession(**doc.to_dict())
                _mem_voice_sessions[session.id] = session
                return session
        except Exception:
            pass

    return None


async def get_all_voice_sessions() -> List[VoiceBookingSession]:
    """Retrieves all sessions for staff dashboard review."""
    db = get_firestore_client()
    if db is not None:
        try:
            docs = db.collection(VOICE_SESSIONS_COLLECTION).stream()
            results = []
            for d in docs:
                s = VoiceBookingSession(**d.to_dict())
                _mem_voice_sessions[s.id] = s
                results.append(s)
            if results:
                return results
        except Exception:
            pass

    return list(_mem_voice_sessions.values())
