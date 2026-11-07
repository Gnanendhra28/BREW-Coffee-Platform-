# BREW Coffee Platform — Phase 6.6.1.2 Implementation Report
## Expired Initiation Recovery & Webhook Correlation

**Date**: 2026-11-06  
**Status**: COMPLETE & VERIFIED (7/7 tests passing)  
**Safety Invariants**:
- `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
- Zero paid telephony or cloud carrier charges incurred.
- HMAC-SHA256 quotation integrity and staff approval gates strictly maintained.
- Zero git staging, commits, pushes, or deployments performed.

---

### Executive Summary

In Phase 6.6.1.1, we introduced `initiationState` tracking (`"pending" | "in_flight" | "accepted" | "uncertain" | "rejected"`), terminal state conflict preservation, and pre-request deduplication. However, an inspection of carrier failure modes revealed an edge case:
If a worker crashed while an initiation was `in_flight` and *before* carrier acceptance could be persisted to Firestore, the initiation lease would eventually expire. When a subsequent worker reclaimed the delivery, it saw an expired lease and would re-invoke `voiceProvider.startSession()`, potentially placing a duplicate phone call to the customer.

Phase 6.6.1.2 completely resolves this vulnerability by implementing:
1. **Atomic Expired-Lease Recovery (`recoverExpiredInitiation`)**:
   - When an `in_flight` initiation lease expires without persisted provider acceptance or rejection, it is atomically transitioned to `"uncertain"`.
   - In Firestore, this uses transaction CAS fencing (`existing.initiationState === "in_flight" && existing.leaseExpiresAt <= now`) ensuring that concurrent worker recovery races are serialized—exactly one worker performs the transition, while concurrent callers receive `null`.
2. **Strict Automated Redial Quarantine**:
   - Outbox deliveries referencing an expired or uncertain initiation are immediately quarantined to `permanently_failed` with `nextRetryAt: null` and `isRetryable: false`.
   - The associated booking session is updated with `callAttemptStatus: "uncertain"` and `staffFollowUpRequired: true`.
3. **Provider-Independent Webhook Correlation (`correlateWebhookByAttemptId`)**:
   - When an asynchronous carrier webhook arrives carrying the internal `attemptId` (conveyed via carrier custom field or idempotency key), the repository correlates the webhook even if `providerCallId` was never persisted before the worker crash.
   - Strictly validates `sessionId` and `provider` to prevent correlation hijacking or spoofing.
   - Atomically records the `providerCallId -> attemptId` mapping document in `voice_call_provider_mappings`.
   - Recovers `initiationState` from `"in_flight"` or `"uncertain"` to `"accepted"`.
   - Advances lifecycle status via monotonic rank evaluation (`evaluateStatusUpdate`).

---

### Architecture & Contract Implementations

#### 1. Repository Interface Additions (`src/lib/communication/voice/types.ts`)
```typescript
export interface CorrelateWebhookParams {
  attemptId: string;
  providerCallId: string;
  provider: string;
  sessionId: string;
  status: VoiceCallAttemptStatus;
  timestamp?: string; // Strict ISO 8601 UTC
  durationSeconds?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  rawProviderMetadata?: Record<string, unknown>;
}

export interface VoiceCallAttemptRepository {
  // ...
  recoverExpiredInitiation(
    id: string,
    now: Date,
    reason?: string
  ): Promise<VoiceCallAttemptRecord | null>;

  correlateWebhookByAttemptId(
    params: CorrelateWebhookParams
  ): Promise<VoiceCallAttemptUpdateResult>;
}
```

#### 2. Atomic Transition & Collision Guarding (`src/lib/communication/voice/callAttemptRepository.ts`)
- `recoverExpiredInitiation`:
  - Validates `initiationState === "in_flight"`, `!providerCallId`, and `leaseExpiresAt <= now`.
  - Atomically sets `initiationState = "uncertain"`, `errorCode = "EXPIRED_INITIATION_LEASE"`, and clears claim lease fields.
  - Implemented for both `InMemoryVoiceCallAttemptRepository` and `FirestoreVoiceCallAttemptRepository` (using `db.runTransaction`).
- `correlateWebhookByAttemptId`:
  - Validates `existing.sessionId === params.sessionId` (rejects session mismatch with error).
  - Validates `existing.provider === params.provider` (rejects provider mismatch with error).
  - Validates `providerCallId` uniqueness against `voice_call_provider_mappings` (rejects collisions).
  - Sets `initiationState = "accepted"`, attaches `providerCallId`, and evaluates state transition via `evaluateStatusUpdate`.

#### 3. Outbox Worker Expired-Lease Fencing (`src/lib/communication/outbox/outboxWorker.ts`)
```typescript
// Case C: Attempt is currently in_flight
if (existingAttempt.initiationState === "in_flight") {
  const isLeaseActive =
    existingAttempt.leaseExpiresAt &&
    new Date(existingAttempt.leaseExpiresAt).getTime() > dispatchTime.getTime();

  if (isLeaseActive) {
    if (existingAttempt.claimOwner && existingAttempt.claimOwner !== this.options.workerId) {
      return "stale_claim_lost";
    }
  } else {
    // The in-flight lease has expired without persisted provider acceptance or rejection!
    await this.dependencies.callAttemptRepository.recoverExpiredInitiation(
      internalAttemptId,
      dispatchTime,
      "Initiation lease expired without persisted outcome; quarantined to uncertain"
    );

    delivery.status = "permanently_failed";
    delivery.nextRetryAt = null;
    delivery.lastError = {
      code: "EXPIRED_INITIATION_LEASE",
      message: "In-flight initiation claim expired without persisted provider outcome. Quarantined to uncertain to prevent duplicate calls.",
      isRetryable: false,
      occurredAt: dispatchIso,
      attempt: effectiveCallAttempts,
    };
    // ... update session with callAttemptStatus: "uncertain", staffFollowUpRequired: true
    return updated ? "permanently_failed" : "stale_claim_lost";
  }
}
```

---

### Verification Results

Test Suite: `scripts/verify-phase6-6-1-2-expired-initiation-recovery.ts` (`npm run test:p6612`):
- `1.1 Webhook correlation by attemptId recovers attempt when providerCallId was never persisted prior to crash`: **PASSED**
- `2.1 Expired in-flight initiation lease is atomically recovered to uncertain, blocking automated redial`: **PASSED**
- `3.1 Concurrent workers recovering same expired attempt: exactly one transaction succeeds`: **PASSED**
- `4.1 Webhook correlation succeeds and creates provider mapping when none existed`: **PASSED**
- `5.1 Webhook correlation strictly rejects mismatched sessionId`: **PASSED**
- `6.1 Webhook correlation strictly rejects mismatched provider`: **PASSED**
- `7.1 Webhook correlation rejects providerCallId already mapped to another attempt`: **PASSED**

**Regression Suites**:
- `npm run test:p6611`: **7/7 PASSED**
- `npm run test:p661`: **10/10 PASSED**
- `npm run test:p655`: **8/8 PASSED**
- `npm run test:p654`: **5/5 PASSED**
- `npm run test:p653`: **6/6 PASSED**
- `npm run test:p652`: **12/12 PASSED**
- `npm run test:p651`: **11/11 PASSED**
- `npm run test:p65`: **23/23 PASSED**
- `npm run test:p635`: **18/18 PASSED**
- `npm run test:p6342`: **24/24 PASSED**
- `npm run typecheck`: **PASSED (0 errors)**
- `npm run lint`: **PASSED (0 errors)**
