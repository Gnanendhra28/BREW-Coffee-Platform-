"""Tests for Outbox Background Worker, Atomic Claims, and Lifecycle Guarantees."""

import asyncio
from datetime import datetime, timezone, timedelta
import pytest

from app.core.config import settings
from app.domain.models.communication import CommunicationDeliveryRecord
from app.infrastructure.firebase.outbox_repo import (
    save_delivery,
    get_delivery_by_id,
    claim_eligible_deliveries,
    update_claimed_delivery,
    reset_mem_outbox,
    StaleClaimError,
)
from app.services.outbox_worker import OutboxWorker, run_outbox_worker_cycles


@pytest.fixture(autouse=True)
def clean_outbox():
    reset_mem_outbox()
    yield
    reset_mem_outbox()


@pytest.mark.asyncio
async def test_atomic_claim_pending_delivery():
    """Verifies that eligible pending deliveries are claimed with owner, token, and lease."""
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    delivery = CommunicationDeliveryRecord(
        id="del_pending_001",
        channel="whatsapp",
        purpose="booking_confirmation",
        sessionId="vbs_test_001",
        recipientPhoneMasked="+91******3210",
        status="pending",
        scheduledAt=now_iso,
        createdAt=now_iso,
        updatedAt=now_iso,
    )
    await save_delivery(delivery)

    worker = OutboxWorker(worker_id="worker_alpha", lease_duration_ms=60_000, batch_size=10)
    claimed = await claim_eligible_deliveries(
        worker_id=worker.worker_id,
        lease_duration_ms=worker.lease_duration_ms,
        limit=worker.batch_size,
        now=now,
    )

    assert len(claimed) == 1
    assert claimed[0].id == "del_pending_001"
    assert claimed[0].status == "processing"
    assert claimed[0].claimOwner == "worker_alpha"
    assert claimed[0].claimToken is not None
    assert claimed[0].leaseExpiresAt is not None


@pytest.mark.asyncio
async def test_expired_lease_recovery():
    """Verifies that a delivery stuck in 'processing' whose lease expired is recovered."""
    now = datetime.now(timezone.utc)
    expired_time = (now - timedelta(minutes=5)).isoformat()

    stale_delivery = CommunicationDeliveryRecord(
        id="del_stale_002",
        channel="whatsapp",
        purpose="booking_confirmation",
        sessionId="vbs_test_002",
        recipientPhoneMasked="+91******3210",
        status="processing",
        claimOwner="crashed_worker_dead",
        claimToken="old_token_xyz",
        claimedAt=expired_time,
        leaseExpiresAt=expired_time,  # Expired in past!
        scheduledAt=expired_time,
        createdAt=expired_time,
        updatedAt=expired_time,
    )
    await save_delivery(stale_delivery)

    # New healthy worker claims the expired item
    worker_beta = OutboxWorker(worker_id="worker_beta", lease_duration_ms=60_000)
    claimed = await claim_eligible_deliveries(
        worker_id=worker_beta.worker_id,
        lease_duration_ms=worker_beta.lease_duration_ms,
        limit=10,
        now=now,
    )

    assert len(claimed) == 1
    assert claimed[0].id == "del_stale_002"
    assert claimed[0].claimOwner == "worker_beta"
    assert claimed[0].claimToken != "old_token_xyz"


@pytest.mark.asyncio
async def test_concurrent_worker_claim_partitioning():
    """Verifies that two concurrent workers claiming the same batch never claim duplicates."""
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # Create 4 pending deliveries
    for i in range(4):
        d = CommunicationDeliveryRecord(
            id=f"del_multi_{i}",
            channel="whatsapp",
            purpose="booking_confirmation",
            sessionId=f"vbs_test_{i}",
            recipientPhoneMasked="+91******3210",
            status="pending",
            scheduledAt=now_iso,
            createdAt=now_iso,
            updatedAt=now_iso,
        )
        await save_delivery(d)

    worker_1 = OutboxWorker(worker_id="worker_1", batch_size=2)
    worker_2 = OutboxWorker(worker_id="worker_2", batch_size=2)

    # Concurrently claim deliveries
    claims_1, claims_2 = await asyncio.gather(
        claim_eligible_deliveries(worker_1.worker_id, limit=2, now=now),
        claim_eligible_deliveries(worker_2.worker_id, limit=2, now=now),
    )

    ids_1 = {d.id for d in claims_1}
    ids_2 = {d.id for d in claims_2}

    # Strict disjoint partitioning: zero intersection between the two workers
    assert len(ids_1.intersection(ids_2)) == 0
    assert len(ids_1) == 2
    assert len(ids_2) == 2


@pytest.mark.asyncio
async def test_stale_claim_update_rejection():
    """Verifies that StaleClaimError is raised if an expired or superseded worker attempts an update."""
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    delivery = CommunicationDeliveryRecord(
        id="del_fencing_003",
        channel="whatsapp",
        purpose="booking_confirmation",
        sessionId="vbs_test_003",
        recipientPhoneMasked="+91******3210",
        status="pending",
        scheduledAt=now_iso,
        createdAt=now_iso,
        updatedAt=now_iso,
    )
    await save_delivery(delivery)

    worker = OutboxWorker(worker_id="worker_gamma")
    claimed_list = await claim_eligible_deliveries(worker.worker_id, now=now)
    claimed = claimed_list[0]

    # Stale claim token should be rejected
    forged_context = {
        "claimOwner": worker.worker_id,
        "claimToken": "invalid_forged_token",
        "claimedAt": claimed.claimedAt,
    }

    with pytest.raises(StaleClaimError):
        await update_claimed_delivery(claimed, forged_context, now)


@pytest.mark.asyncio
async def test_max_attempts_ceiling_permanently_failed():
    """Verifies that deliveries exceeding maxAttempts transition to permanently_failed."""
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    delivery = CommunicationDeliveryRecord(
        id="del_exhausted_004",
        channel="whatsapp",
        purpose="booking_confirmation",
        sessionId="vbs_test_004",
        recipientPhoneMasked="+91******3210",
        status="pending",
        attemptCount=3,  # Reached maxAttempts
        maxAttempts=3,
        scheduledAt=now_iso,
        createdAt=now_iso,
        updatedAt=now_iso,
    )
    await save_delivery(delivery)

    worker = OutboxWorker(worker_id="worker_delta")
    cycle_res = await worker.process_cycle(now=now)

    assert cycle_res.claimedCount == 1
    assert cycle_res.permanentlyFailedCount == 1
    assert cycle_res.dispatchedCount == 0

    saved = await get_delivery_by_id("del_exhausted_004")
    assert saved.status == "permanently_failed"
    assert saved.lastError == "MAX_ATTEMPTS_EXCEEDED"


@pytest.mark.asyncio
async def test_voice_channel_disabled_blocks_delivery(monkeypatch):
    """Verifies that voice channel deliveries are blocked when VOICE_BOOKING_ENABLED=False."""
    monkeypatch.setattr(settings, "voice_booking_enabled", False)

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    delivery = CommunicationDeliveryRecord(
        id="del_voice_005",
        channel="voice",
        purpose="booking_confirmation",
        sessionId="vbs_test_005",
        recipientPhoneMasked="+91******3210",
        status="pending",
        scheduledAt=now_iso,
        createdAt=now_iso,
        updatedAt=now_iso,
    )
    await save_delivery(delivery)

    worker = OutboxWorker(worker_id="worker_voice_tester")
    cycle_res = await worker.process_cycle(now=now)

    assert cycle_res.claimedCount == 1
    assert cycle_res.blockedCount == 1

    saved = await get_delivery_by_id("del_voice_005")
    assert saved.status == "blocked"
    assert saved.lastError == "VOICE_BOOKING_DISABLED"


@pytest.mark.asyncio
async def test_cron_outbox_endpoint_methods_and_auth(client):
    """Verifies HTTP 405 on GET/PUT/DELETE and 401/200 on POST with secret."""
    # 1. GET, PUT, DELETE must return 405 Method Not Allowed
    res_get = await client.get("/api/cron/outbox-worker")
    assert res_get.status_code == 405
    assert res_get.headers.get("Allow") == "POST"

    res_put = await client.put("/api/cron/outbox-worker")
    assert res_put.status_code == 405
    assert res_put.headers.get("Allow") == "POST"

    res_delete = await client.delete("/api/cron/outbox-worker")
    assert res_delete.status_code == 405
    assert res_delete.headers.get("Allow") == "POST"

    # 2. Unauthenticated POST must return 401
    res_post_unauth = await client.post("/api/cron/outbox-worker")
    assert res_post_unauth.status_code == 401

    # 3. Authenticated POST executes worker cycles and returns metrics
    valid_secret = settings.cron_secret
    res_post_auth = await client.post(
        "/api/cron/outbox-worker",
        headers={"Authorization": f"Bearer {valid_secret}"},
        json={"batchSize": 5, "maxCycles": 1},
    )

    assert res_post_auth.status_code == 200
    data = res_post_auth.json()
    assert data["success"] is True
    assert data["cyclesCompleted"] == 1
    assert "result" in data
    assert "claimed" in data["result"]
