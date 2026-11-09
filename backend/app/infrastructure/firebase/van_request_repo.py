"""BREW Coffee Platform — Van Request (Catering Enquiry) Repository."""

import time
from typing import Dict, Any, List, Optional
from .client import get_firestore_client

_mem_van_requests: Dict[str, Dict[str, Any]] = {}
_mem_idempotency_store: Dict[str, Dict[str, Any]] = {}
VAN_REQUESTS_COLLECTION = "van_requests"


async def save_van_request(enquiry_id: str, data: Dict[str, Any]) -> None:
    """Saves catering enquiry in memory and Cloud Firestore."""
    _mem_van_requests[enquiry_id] = data
    db = get_firestore_client()
    if db is not None:
        try:
            db.collection(VAN_REQUESTS_COLLECTION).document(enquiry_id).set(data)
        except Exception:
            pass


async def get_van_requests() -> List[Dict[str, Any]]:
    """Retrieves all van requests for staff inspection."""
    db = get_firestore_client()
    if db is not None:
        try:
            docs = db.collection(VAN_REQUESTS_COLLECTION).stream()
            results = []
            for d in docs:
                item = d.to_dict()
                _mem_van_requests[d.id] = item
                results.append(item)
            if results:
                return results
        except Exception:
            pass

    return list(_mem_van_requests.values())


def get_idempotency_record(key: str) -> Optional[Dict[str, Any]]:
    """Retrieves in-memory idempotency record."""
    return _mem_idempotency_store.get(key)


def set_idempotency_record(key: str, record: Dict[str, Any]) -> None:
    """Stores in-memory idempotency record."""
    _mem_idempotency_store[key] = record
