# BREW Coffee Platform — Phase 6.3.3.1 Hardening Report
## Targeted Outbox Reliability & Privacy Hardening

**Execution Timestamp**: 2026-11-02T17:25:00+05:30  
**Phase Target**: Phase 6.3.3.1 Outbox Reliability, Lease Protection & Privacy Hardening  
**Status**: Completed & Verified — Ready for Independent Review  
**Safety Status**: Zero Telephony/Meta API Invocations; `VOICE_BOOKING_ENABLED=false` Strictly Enforced  

---

## 1. Executive Summary

Phase 6.3.3.1 addresses the four critical findings from the independent Phase 6.3.3 source review. All corrections are narrowly scoped, additive, and preserve the existing Clean Architecture boundaries, deterministic IDs, and retry model.

### Key Remediations:
1. **Lease-Owner Protected Completion**:
   - Replaced unconditional `.set()` in outbox worker completion with mandatory conditional `updateClaimedDelivery()`.
   - Validates document existence, `status === 'processing'`, `claimOwner`, `claimedAt`, and active lease unexpired (`leaseExpiresAt > now`) under transaction lock.
   - Rejects stale worker updates with `StaleClaimError` without modifying the stored record.
2. **Provider Error Sanitization**:
   - Eliminated raw provider exception text (`providerErr.message`), stack traces, Bearer tokens, credentials, and raw phone numbers from persisted outbox records.
   - Persists only fixed sanitized error codes (`PROVIDER_DISPATCH_FAILED`, `PROVIDER_IDEMPOTENCY_CONFLICT`, `POLICY_INFRASTRUCTURE_FAILURE`, `SESSION_LOOKUP_FAILED`, `MAX_ATTEMPTS_EXCEEDED`) and safe metadata (`isRetryable`, `occurredAt`, `attempt`).
   - Suppresses logging of raw provider exception content.
3. **Fresh Dispatch-Time Policy Timestamps**:
   - Worker obtains a fresh timestamp (`this.getNow()`) immediately before each delivery in a batch.
   - Evaluates the 09:00–20:00 IST calling window and queries consent and DND repositories freshly per delivery.
4. **Documented In-Memory Idempotency Limitations**:
   - Fully documented that mock provider caches are in-memory Maps that do not survive process restarts or cross provider instances.
   - Confirmed that the transactional outbox provides at-least-once delivery, requiring real downstream providers to supply durable deduplication before production activation.

---

## 2. Changes Implemented & Architecture Mapping

| File Path | Nature of Change | Purpose |
|---|---|---|
| `src/lib/communication/errors.ts` | Modified | Added typed `StaleClaimError` (code: `STALE_CLAIM`). |
| `src/lib/communication/types.ts` | Modified | Added `ClaimContext` (`claimOwner`, `claimedAt`); updated `lastError` type with optional `code` and `attempt`. |
| `src/lib/communication/schemas.ts` | Modified | Updated `lastError` schema with optional `code` and `attempt` validations. |
| `src/lib/communication/outbox/outboxRepository.ts` | Modified | Added `updateClaimedDelivery()` to `CommunicationOutboxRepository` interface; implemented transactional verification in both `InMemoryCommunicationOutboxRepository` and `FirestoreCommunicationOutboxRepository`. |
| `src/lib/communication/outbox/outboxWorker.ts` | Modified | Switched all worker completion/failure paths to `safeUpdateClaimedDelivery()`; enforced fresh timestamps for each delivery; sanitized error persistence and logging. |
| `src/lib/communication/providers/voiceProvider.ts` | Modified | Documented in-memory idempotency limitations, process restart vulnerability, and at-least-once outbox boundary. |
| `src/lib/communication/providers/whatsappProvider.ts` | Modified | Documented in-memory idempotency limitations, process restart vulnerability, and at-least-once outbox boundary. |
| `scripts/verify-phase6-3-3-1-hardening.ts` | New file | 10 focused regression tests verifying lease expiration, stale worker rejections, error sanitization, fresh timestamps, and mock cache replacement. |

---

## 3. Lease-Owner Protected Completion Design

### Transactional Lease Verification Invariant

When `OutboxWorker` finishes evaluating policy or calling a provider (outside of transactions), it commits completion or failure via `updateClaimedDelivery(delivery, claimContext, now)`:

```mermaid
sequenceDiagram
    autonumber
    participant Worker as OutboxWorker (Worker A)
    participant Repo as FirestoreCommunicationOutboxRepository
    participant Tx as Firestore Transaction
    participant DB as Cloud Firestore

    Worker->>Repo: updateClaimedDelivery(delivery, { claimOwner, claimedAt }, now)
    Repo->>Tx: runTransaction()
    Note over Tx,DB: --- READ PHASE ---
    Tx->>DB: get(deliveryRef)
    Note over Tx: --- VALIDATION PHASE ---
    Tx->>Tx: Verify snap.exists === true
    Tx->>Tx: Verify snap.status === 'processing'
    Tx->>Tx: Verify snap.claimOwner === claimContext.claimOwner
    Tx->>Tx: Verify snap.claimedAt === claimContext.claimedAt
    Tx->>Tx: Verify snap.leaseExpiresAt > now (active lease unexpired)
    alt Verification Fails (Lease expired / Worker B reclaimed)
        Tx-->>Worker: Throw StaleClaimError (No write performed)
        Worker->>Worker: safeUpdateClaimedDelivery catches StaleClaimError -> return false
        Note over Worker: Outcome not counted as dispatched/failed; record untouched
    else Verification Passes
        Note over Tx,DB: --- WRITE PHASE ---
        Tx->>DB: set(deliveryRef, validatedDelivery)
        Tx-->>Worker: Resolve void (Success)
    end
```

### Stale Worker Protection Rules:
1. **No Stale Overwrite**: Worker A cannot overwrite Worker B's newer claim or completion once Worker A's lease expires.
2. **No False Dispatches**: If Worker A completes provider dispatch after its lease expired, it cannot mark the delivery `dispatched` in the repository.
3. **No False Failures**: If Worker A encounters an error after its lease expired, it cannot mark the delivery `failed` or `blocked`.
4. **Repository Consistency**: Both `InMemoryCommunicationOutboxRepository` and `FirestoreCommunicationOutboxRepository` enforce identical verification rules.

---

## 4. Provider Error Sanitization

The worker never persists raw provider exceptions. The `lastError` field is populated strictly with sanitized error codes:

| Scenario | Persisted `lastError.code` & `message` | `isRetryable` | Leaked Content Guard |
|---|---|---|---|
| Max attempts ceiling reached | `MAX_ATTEMPTS_EXCEEDED` | `false` | Zero provider or network error data persisted |
| Session not found / recipient missing | `SESSION_LOOKUP_FAILED` | `false` | Session ID masked; zero PII persisted |
| Session repo outage (transient) | `SESSION_LOOKUP_FAILED` | `true` | Database connection strings/exceptions suppressed |
| Policy orchestration unhandled / error | `POLICY_INFRASTRUCTURE_FAILURE` | `true` | Internal policy exception details suppressed |
| Idempotency conflict from provider | `PROVIDER_IDEMPOTENCY_CONFLICT` | `false` | Conflicting payload text suppressed |
| Provider network/HTTP 500 error | `PROVIDER_DISPATCH_FAILED` | `true` | Bearer tokens, URLs, phone numbers, stack traces suppressed |

---

## 5. Fresh Dispatch-Time Policy Timestamps

In `OutboxWorker.processCycle()`:
- Instead of capturing one `now` timestamp for the entire batch, `deliveryNow = this.getNow()` is sampled sequentially for each delivery in the batch.
- `policyTime = this.getNow()` is captured immediately before constructing `policyRequest`, ensuring:
  1. `currentTime` passed to `orchestrateCommunicationPolicy` reflects real dispatch time.
  2. The 09:00–20:00 IST calling window evaluates against the fresh timestamp.
  3. If a batch begins at 19:59 IST and crosses 20:00 IST during execution, subsequent voice deliveries are properly blocked with `OUTSIDE_CALLING_HOURS`.
  4. Customer consent records and DND suppression records are re-queried from repositories per delivery.

---

## 6. Provider Mock Idempotency Limitations

The in-memory provider idempotency caches in `MockVoiceProvider` and `MockWhatsAppProvider` have explicit documented boundaries:
1. **Instance Lifetime Only**: Deduplication operates strictly within the memory space of a single provider instance.
2. **No Persistence Across Restarts**: If the Node process restarts or the provider instance is replaced, the cache is lost.
3. **No Distributed Coordination**: Mock provider instances do not communicate with one another or coordinate through Redis/database locks.
4. **Outbox is At-Least-Once**: Downstream external providers may receive redeliveries if a worker crashes before recording completion.
5. **Production Requirement**: Real telephony and WhatsApp providers must separately implement external provider idempotency keys before production launch.

---

## 7. Verification Results

### 7.1 Focused Phase 6.3.3.1 Suite (`scripts/verify-phase6-3-3-1-hardening.ts`)
**Executed**: 10 / 10 tests passed (100% success).

```
================================================================================
   BREW Coffee Platform — Phase 6.3.3.1 Verification Suite
   Targeted Outbox Reliability & Privacy Hardening
================================================================================

--- 1. LEASE-OWNER PROTECTED COMPLETION ---
  ✓ 1. Worker A's lease expires and Worker B reclaims the delivery
  ✓ 2. Worker A cannot overwrite Worker B's newer claim or completion
  ✓ 3. A stale worker cannot mark a delivery dispatched
  ✓ 4. A stale worker cannot mark a delivery failed or blocked

--- 2. PRIVACY & PROVIDER ERROR SANITIZATION ---
  ✓ 5. Provider exceptions containing fake secrets and phone numbers are sanitized before persistence

--- 3. FRESH DISPATCH-TIME TIMESTAMPS & CALLING HOURS ---
  ✓ 6. Policy evaluation uses a fresh timestamp for each delivery in a batch
  ✓ 7. A batch crossing 20:00 IST blocks a later voice delivery

--- 4. DYNAMIC POLICY RE-EVALUATION & OUTAGE RESILIENCE ---
  ✓ 8. A consent revocation after enqueue but before dispatch blocks delivery
  ✓ 9. DND repository outage creates a retryable failure and never invokes the provider

--- 5. MOCK IDEMPOTENCY LIMITATIONS & DOCUMENTATION ---
  ✓ 10. Provider idempotency limitations after instance replacement are accurately tested and documented

================================================================================
   Phase 6.3.3.1 Hardening Summary: 10 / 10 tests passed (100% SUCCESS)
================================================================================
```

### 7.2 Regression Suite (`scripts/verify-phase6-3-3-outbox.ts`)
**Executed**: 21 / 21 tests passed (100% success). Zero regressions across atomicity, worker claiming, policy safety, idempotency, and privacy.

### 7.3 Static Analysis & Linter Verification
- **TypeScript**: `npm run typecheck` passed with 0 errors.
- **ESLint**: `npm run lint` passed with 0 errors (3 pre-existing non-blocking warnings in unrelated legacy scripts).

### 7.4 Test Execution Breakdown
- **Actually Executed**:
  - `scripts/verify-phase6-3-3-1-hardening.ts` (10 tests)
  - `scripts/verify-phase6-3-3-outbox.ts` (21 tests)
  - `npm run typecheck`
  - `npm run lint`
- **Inspected / Historical**:
  - `scripts/verify-phase6-3-2-3-hardening.ts`
  - `scripts/verify-phase6-3-2-2-hardening.ts`
  - `scripts/verify-phase6-3-1-firestore-repository.ts`

---

## 8. Boundaries & Next Steps

1. `VOICE_BOOKING_ENABLED=false` remains strictly enforced; zero live carrier calls or Meta Cloud API calls were made.
2. Durable Firestore consent and DND collections remain scheduled for Phase 6.4.
3. Review archive `phase6_3_3_1_review_bundle.zip` was submitted and reviewed.
4. Subsequent hardening in **Phase 6.3.3.2** (`docs/PHASE_6_3_3_2_WORKER_BOUNDARY_REPORT.md`) eliminated the worker options feature-flag bypass, added unique claim fencing tokens (`claimToken`) to protect against reused worker IDs on reclaimed leases, and restricted unconditional delivery updates from the public repository interface.

