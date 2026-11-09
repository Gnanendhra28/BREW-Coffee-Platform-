"""BREW Coffee Platform — Outbox Background Worker Service.

Transactional outbox processor with atomic claims, expired lease recovery,
dispatch policy checks, max attempt enforcement, and structured metrics.
"""

import time
import logging
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from app.core.config import settings
from app.domain.models.communication import CommunicationDeliveryRecord
from app.infrastructure.firebase.outbox_repo import (
    claim_eligible_deliveries,
    update_claimed_delivery,
    StaleClaimError,
)

logger = logging.getLogger(__name__)


class OutboxCycleResult(BaseModel):
    claimedCount: int = 0
    dispatchedCount: int = 0
    blockedCount: int = 0
    failedCount: int = 0
    permanentlyFailedCount: int = 0


class OutboxWorker:
    """Asynchronous worker executing cooperative outbox processing cycles."""

    def __init__(
        self,
        worker_id: Optional[str] = None,
        lease_duration_ms: int = 60_000,
        batch_size: int = 10,
        backoff_base_ms: int = 5_000,
    ):
        self.worker_id = worker_id or f"worker_{int(time.time() * 1000)}"
        # Clamping invariants matching TypeScript
        self.lease_duration_ms = min(max(5_000, lease_duration_ms), 300_000)
        self.batch_size = min(max(1, batch_size), 50)
        self.backoff_base_ms = min(max(1_000, backoff_base_ms), 60_000)

    async def process_single_delivery(
        self,
        delivery: CommunicationDeliveryRecord,
        now: datetime,
    ) -> str:
        """Processes an individual claimed delivery through safety and channel policies."""
        now_iso = now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        claim_context = {
            "claimOwner": delivery.claimOwner or self.worker_id,
            "claimToken": delivery.claimToken,
            "claimedAt": delivery.claimedAt,
        }

        # 1. Enforce max attempt ceiling
        if delivery.attemptCount >= delivery.maxAttempts:
            delivery.status = "permanently_failed"
            delivery.lastError = "MAX_ATTEMPTS_EXCEEDED"
            delivery.claimOwner = None
            delivery.claimToken = None
            delivery.leaseExpiresAt = None
            delivery.updatedAt = now_iso
            try:
                await update_claimed_delivery(delivery, claim_context, now)
                return "permanently_failed"
            except StaleClaimError:
                return "stale_claim_lost"

        # 2. Voice Channel Feature Flag Guard
        if delivery.channel == "voice":
            if not settings.voice_booking_enabled:
                delivery.status = "blocked"
                delivery.lastError = "VOICE_BOOKING_DISABLED"
                delivery.claimOwner = None
                delivery.claimToken = None
                delivery.leaseExpiresAt = None
                delivery.updatedAt = now_iso
                try:
                    await update_claimed_delivery(delivery, claim_context, now)
                    return "blocked"
                except StaleClaimError:
                    return "stale_claim_lost"

        # 3. WhatsApp / Communication Channel Dispatch
        delivery.attemptCount += 1
        delivery.lastAttemptAt = now_iso

        # Safe simulation mode (guarantees zero real notifications during testing)
        delivery.status = "delivered"
        delivery.providerResult = {
            "providerMessageId": f"wamid.mock_{delivery.id}",
            "simulated": True,
            "deliveredAt": now_iso,
        }
        delivery.claimOwner = None
        delivery.claimToken = None
        delivery.leaseExpiresAt = None
        delivery.updatedAt = now_iso

        try:
            await update_claimed_delivery(delivery, claim_context, now)
            return "dispatched"
        except StaleClaimError:
            return "stale_claim_lost"

    async def process_cycle(self, now: Optional[datetime] = None) -> OutboxCycleResult:
        """Executes a single processing cycle of claiming and dispatching deliveries."""
        current_time = now or datetime.now(timezone.utc)
        result = OutboxCycleResult()

        claimed = await claim_eligible_deliveries(
            worker_id=self.worker_id,
            lease_duration_ms=self.lease_duration_ms,
            limit=self.batch_size,
            now=current_time,
        )

        result.claimedCount = len(claimed)

        for delivery in claimed:
            outcome = await self.process_single_delivery(delivery, current_time)
            if outcome == "dispatched":
                result.dispatchedCount += 1
            elif outcome == "blocked":
                result.blockedCount += 1
            elif outcome == "failed":
                result.failedCount += 1
            elif outcome == "permanently_failed":
                result.permanentlyFailedCount += 1

        return result


async def run_outbox_worker_cycles(
    worker: OutboxWorker,
    max_cycles: int = 1,
    max_duration_ms: int = 25_000,
) -> Dict[str, Any]:
    """Runs worker cycles cooperatively respecting deadline budgets."""
    start_time = time.time()
    clamped_cycles = min(max(1, max_cycles), 5)
    cycles_completed = 0

    aggregate = {
        "claimed": 0,
        "dispatched": 0,
        "blocked": 0,
        "failed": 0,
        "permanently_failed": 0,
    }

    for _ in range(clamped_cycles):
        if (time.time() - start_time) * 1000 >= max_duration_ms:
            break

        cycle_res = await worker.process_cycle()
        cycles_completed += 1
        aggregate["claimed"] += cycle_res.claimedCount
        aggregate["dispatched"] += cycle_res.dispatchedCount
        aggregate["blocked"] += cycle_res.blockedCount
        aggregate["failed"] += cycle_res.failedCount
        aggregate["permanently_failed"] += cycle_res.permanentlyFailedCount

    duration_ms = int((time.time() - start_time) * 1000)

    return {
        "cyclesCompleted": cycles_completed,
        "durationMs": duration_ms,
        "aggregateResult": aggregate,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
