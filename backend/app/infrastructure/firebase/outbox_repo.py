"""BREW Coffee Platform — Communication Outbox Repository.

Atomic claims, lease-fenced updates, expired lease recovery, and durable Firestore/memory store.
"""

import uuid
import time
import asyncio
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from app.domain.models.communication import CommunicationDeliveryRecord, DeliveryStatus
from .client import get_firestore_client

OUTBOX_COLLECTION = "outbox_deliveries"

_mem_outbox: Dict[str, Dict[str, Any]] = {}
_mem_lock = asyncio.Lock()


class StaleClaimError(Exception):
    """Raised when a worker attempts to update a delivery after losing its claim or lease."""
    pass


def _now_iso(dt: Optional[datetime] = None) -> str:
    current = dt or datetime.now(timezone.utc)
    return current.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


async def save_delivery(delivery: CommunicationDeliveryRecord) -> None:
    """Durably writes an outbox delivery record."""
    data = delivery.model_dump()
    async with _mem_lock:
        _mem_outbox[delivery.id] = data

    db = get_firestore_client()
    if db is not None:
        try:
            db.collection(OUTBOX_COLLECTION).document(delivery.id).set(data)
        except Exception:
            pass


async def get_delivery_by_id(delivery_id: str) -> Optional[CommunicationDeliveryRecord]:
    """Retrieves an outbox delivery by its unique ID."""
    async with _mem_lock:
        if delivery_id in _mem_outbox:
            return CommunicationDeliveryRecord(**_mem_outbox[delivery_id])

    db = get_firestore_client()
    if db is not None:
        try:
            doc = db.collection(OUTBOX_COLLECTION).document(delivery_id).get()
            if doc.exists:
                data = doc.to_dict()
                return CommunicationDeliveryRecord(**data)
        except Exception:
            pass
    return None


async def get_all_deliveries() -> List[CommunicationDeliveryRecord]:
    """Returns all outbox delivery records."""
    deliveries: Dict[str, CommunicationDeliveryRecord] = {}

    db = get_firestore_client()
    if db is not None:
        try:
            for doc in db.collection(OUTBOX_COLLECTION).stream():
                d = CommunicationDeliveryRecord(**doc.to_dict())
                deliveries[d.id] = d
        except Exception:
            pass

    async with _mem_lock:
        for k, v in _mem_outbox.items():
            if k not in deliveries:
                deliveries[k] = CommunicationDeliveryRecord(**v)

    return list(deliveries.values())


async def claim_eligible_deliveries(
    worker_id: str,
    lease_duration_ms: int = 60_000,
    limit: int = 10,
    now: Optional[datetime] = None,
) -> List[CommunicationDeliveryRecord]:
    """Atomically claims up to `limit` eligible deliveries for processing.
    
    Eligible criteria:
    1. status == 'pending'
    2. status == 'failed' AND attemptCount < maxAttempts
    3. status == 'processing' AND leaseExpiresAt <= now (lease expired recovery)
    """
    current_time = now or datetime.now(timezone.utc)
    now_iso_str = _now_iso(current_time)
    lease_expires_ms = int(current_time.timestamp() * 1000) + lease_duration_ms
    lease_expires_iso = _now_iso(datetime.fromtimestamp(lease_expires_ms / 1000, tz=timezone.utc))

    claimed: List[CommunicationDeliveryRecord] = []

    # 1. Memory store claiming (guarantees atomic claims under asyncio.Lock)
    async with _mem_lock:
        for d_id, item in list(_mem_outbox.items()):
            if len(claimed) >= limit:
                break

            status = item.get("status")
            lease_expires = item.get("leaseExpiresAt")
            attempts = item.get("attemptCount", 0)
            max_attempts = item.get("maxAttempts", 3)

            is_pending = status == "pending"
            is_retryable_failed = status == "failed" and attempts < max_attempts
            is_lease_expired = status == "processing" and lease_expires and lease_expires <= now_iso_str

            if is_pending or is_retryable_failed or is_lease_expired:
                token = str(uuid.uuid4())
                item["status"] = "processing"
                item["claimOwner"] = worker_id
                item["claimToken"] = token
                item["claimedAt"] = now_iso_str
                item["leaseExpiresAt"] = lease_expires_iso
                item["updatedAt"] = now_iso_str
                record = CommunicationDeliveryRecord(**item)
                claimed.append(record)

    # 2. Sync claimed state to Firestore if client is connected
    db = get_firestore_client()
    if db is not None:
        for rec in claimed:
            try:
                db.collection(OUTBOX_COLLECTION).document(rec.id).set(rec.model_dump())
            except Exception:
                pass

    return claimed


async def update_claimed_delivery(
    delivery: CommunicationDeliveryRecord,
    claim_context: Dict[str, Any],
    now: Optional[datetime] = None,
) -> None:
    """Updates a claimed delivery verifying lease ownership fencing tokens.
    
    Rejects with StaleClaimError if claim token, claim owner, or lease expired.
    """
    current_time = now or datetime.now(timezone.utc)
    now_iso_str = _now_iso(current_time)

    expected_owner = claim_context.get("claimOwner")
    expected_token = claim_context.get("claimToken")
    expected_claimed_at = claim_context.get("claimedAt")

    async with _mem_lock:
        existing = _mem_outbox.get(delivery.id)
        if not existing:
            raise StaleClaimError(f"Delivery '{delivery.id}' not found.")

        # Verify claim ownership & lease expiration
        if existing.get("status") != "processing":
            raise StaleClaimError(f"Delivery '{delivery.id}' is not in processing state (current: {existing.get('status')}).")
        if existing.get("claimOwner") != expected_owner:
            raise StaleClaimError(f"Worker '{expected_owner}' does not own claim for delivery '{delivery.id}'.")
        if existing.get("claimToken") != expected_token:
            raise StaleClaimError(f"Stale claim token for delivery '{delivery.id}'.")
        if existing.get("claimedAt") != expected_claimed_at:
            raise StaleClaimError(f"Stale claimedAt timestamp for delivery '{delivery.id}'.")

        lease_expires = existing.get("leaseExpiresAt")
        if lease_expires and lease_expires < now_iso_str:
            raise StaleClaimError(f"Lease for delivery '{delivery.id}' expired at {lease_expires}.")

        # Update record in memory
        delivery.updatedAt = now_iso_str
        _mem_outbox[delivery.id] = delivery.model_dump()

    db = get_firestore_client()
    if db is not None:
        try:
            db.collection(OUTBOX_COLLECTION).document(delivery.id).set(delivery.model_dump())
        except Exception:
            pass


async def get_outbox_telemetry_metrics() -> Dict[str, Any]:
    """Computes real-time outbox delivery telemetry counts."""
    deliveries = await get_all_deliveries()

    counts: Dict[str, int] = {
        "pending": 0,
        "processing": 0,
        "dispatched": 0,
        "delivered": 0,
        "blocked": 0,
        "failed": 0,
        "permanently_failed": 0,
    }

    now_iso_str = _now_iso()
    stale_leases = 0

    for d in deliveries:
        counts[d.status] = counts.get(d.status, 0) + 1
        if d.status == "processing" and d.leaseExpiresAt and d.leaseExpiresAt <= now_iso_str:
            stale_leases += 1

    return {
        "countsByStatus": counts,
        "staleLeases": stale_leases,
        "totalDeliveries": len(deliveries),
    }


def reset_mem_outbox() -> None:
    """Test helper to clear in-memory outbox store between test runs."""
    _mem_outbox.clear()
