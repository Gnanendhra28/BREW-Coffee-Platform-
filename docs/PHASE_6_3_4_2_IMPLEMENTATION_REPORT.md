# Phase 6.3.4.2 / 6.3.4.2.3 — Mock Voice Call Lifecycle, Logical Retry Accounting & InMemory Claim/Session Mutation Atomicity

**Document ID:** `PHASE_6_3_4_2_IMPLEMENTATION_REPORT`  
**Phase:** 6.3.4.2 / 6.3.4.2.2 / 6.3.4.2.3 (Mock Voice Call Lifecycle Integration, Logical Retry Accounting & Concurrency Fencing Atomicity)  
**Date:** November 6, 2026  
**Status:** COMPLETE & VERIFIED  

---

## 1. Executive Summary

Phase 6.3.4.2.3 addresses and resolves the remaining InMemory concurrency gap identified in independent review:
1. **Per-Delivery Coordination Lock (`KeyedAsyncMutex`):**
   In `InMemoryCommunicationOutboxRepository`, `claimEligibleDeliveries()`, `updateClaimedDelivery()`, and `mutateSessionWithClaimFencing()` are coordinated via an asynchronous per-delivery mutex (`KeyedAsyncMutex`).
2. **Elimination of Post-Save Rollback:**
   Because `mutateSessionWithClaimFencing()` holds the per-delivery coordination lock continuously from claim validation through `sessionRepository.save()`, a concurrent expired-lease reclaim can never interleave between claim validation and session write. Post-save snapshot rollback has been completely removed in favor of true mutual exclusion.
3. **No Unrelated Delivery Serialization:**
   Locking is strictly keyed by `deliveryId`. Operations on distinct delivery IDs proceed concurrently without blocking each other.
4. **Deadlock Immunity & Fault Tolerance:**
   Mutex execution is wrapped in `try ... finally { release(); }`. Unhandled errors in mutators or optimistic concurrency conflicts in session persistence immediately release the delivery lock without deadlocking subsequent operations.
5. **Session Optimistic Concurrency Integrity:**
   Terminal session immutability (`isTerminalVoiceState`) and monotonic revision validation (`expectedRevision`) are preserved.

---

## 2. Architectural Design & Concurrency Guarantees

### 2.1 Repository Concurrency Comparison

| Dimension | `FirestoreCommunicationOutboxRepository` | `InMemoryCommunicationOutboxRepository` |
| :--- | :--- | :--- |
| **Concurrency Mechanism** | Server-side Optimistic Concurrency Control (Firestore Multi-Document Transaction) | In-process Asynchronous Mutex keyed by Delivery ID (`KeyedAsyncMutex`) |
| **Transaction Scope** | Atomic multi-document transaction reading `deliveryRef` and writing `sessionRef` | Critical section held across delivery claim verification, session retrieval, mutator application, and `sessionRepository.save()` |
| **Concurrent Reclaim Handling** | If another worker reclaims `deliveryRef`, Firestore detects OCC conflict on `deliveryRef`; transaction aborts or retries, detecting `claimToken` mismatch | Concurrent reclaim for the same delivery ID must await the lock. If reclaim completes first, mutation detects `claimToken` mismatch and rejects before write |
| **Interleaving Guarantee** | ACID atomicity guaranteed by GCP Firestore transaction engine | Mutual exclusion guaranteed by `KeyedAsyncMutex.runExclusive(deliveryId)` |
| **Rollback Requirement** | Handled natively by Firestore transaction rollback on abort | Not needed; mutations are never written if the claim is invalid, and no reclaim can slip in |
| **Resource Isolation** | Document-level row locking in Firestore | Per-key map in memory; unrelated deliveries never block each other |

---

### 2.2 Logical Call Attempts vs. Concurrency Lease Grants

| Field | Semantics | Lifecycle Behavior |
| :--- | :--- | :--- |
| `attemptCount` | Worker lease grants & concurrency claims | Increments on **every** worker claim (initial claim, retry after failure, or expired-lease recovery). Unbounded by `maxAttempts` in schema. |
| `callAttemptCount` | Genuine logical provider call attempts | Increments **only** on initial dispatch (`pending`) or genuine retry after failure (`failed`). Preserved on expired-lease recovery. Bounded by `maxAttempts`. |
| `currentAttemptId` | Stable attempt idempotency identity | Formatted as `${delivery.id}_call${callAttemptCount}`. Reused across in-flight recoveries. Regenerated on new logical retries. |
| `maxAttempts` | Threshold for permanent failure | Compared strictly against `callAttemptCount` (not `attemptCount`). |

#### Legacy Record Fallback
To ensure legacy records where `callAttemptCount` was omitted do not receive unlimited attempts, `getEffectiveCallAttemptCount()` safely falls back to `record.attemptCount`:
```ts
export function getEffectiveCallAttemptCount(record: {
  callAttemptCount?: number;
  attemptCount: number;
}): number {
  return typeof record.callAttemptCount === "number"
    ? record.callAttemptCount
    : (record.attemptCount || 0);
}
```

#### Exponential Backoff & Terminal Thresholding
- **Exponential Backoff:** Computed strictly using logical call attempts:
  $$\text{backoffMs} = \text{base} \times 2^{\max(0, \text{effectiveCallAttempts} - 1)}$$
  A delivery with 4 lease claims on attempt 1 experiences $5000 \times 2^0 = 5000\text{ ms}$ backoff, not $40000\text{ ms}$.
- **Terminal Failure & Staff Follow-up:** `staffFollowUpRequired` and `permanently_failed` status trigger only when $\text{effectiveCallAttempts} \ge \text{maxAttempts}$.

---

### 2.3 Per-Delivery Coordination Mutex (`KeyedAsyncMutex`)

```ts
class KeyedAsyncMutex {
  private tailMap = new Map<string, Promise<unknown>>();

  isLocked(key: string): boolean {
    return this.tailMap.has(key);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tailMap.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = prev.then(
      () => current,
      () => current
    );
    this.tailMap.set(key, tail);

    tail.finally(() => {
      if (this.tailMap.get(key) === tail) {
        this.tailMap.delete(key);
      }
    });

    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}
```

---

## 3. Source Modifications Summary

| File Path | Description of Changes |
| :--- | :--- |
| `src/lib/communication/outbox/outboxRepository.ts` | Implemented `KeyedAsyncMutex`. Coordinated `claimEligibleDeliveries()`, `updateClaimedDelivery()`, and `mutateSessionWithClaimFencing()` under per-delivery lock. Removed post-save session rollback logic. Added `isDeliveryLocked()` for test inspection. |
| `src/lib/communication/types.ts` | Clarified docstrings on `attemptCount`, `callAttemptCount`, and `maxAttempts`. Added `mutateSessionWithClaimFencing` to `CommunicationOutboxRepository` interface. |
| `src/lib/communication/schemas.ts` | Removed `.max(3)` on `CommunicationDeliveryRecordSchema.attemptCount` so lease claim counters can increment past 3 without schema validation failure. |
| `src/lib/communication/outbox/outboxModel.ts` | Exported `getEffectiveCallAttemptCount()` helper with safe legacy fallback to `record.attemptCount`. |
| `src/lib/communication/outbox/outboxWorker.ts` | Replaced direct session updates with `mutateSessionWithClaimFencing()`. Replaced lease claim count with `effectiveCallAttempts` across max attempts enforcement, attemptId derivation, backoff calculation, and `handleFailure`. |
| `scripts/verify-phase6-3-4-2-voice-lifecycle.ts` | Added Section 8 with 5 regression tests covering non-interleaving reclaims, stale-claim rejection, non-blocking independent deliveries, error lock release, and OCC conflict isolation (24 / 24 tests total). |

---

## 4. Verification Evidence & Test Execution Report

### Test Environments Distinction
- **Executed In-Memory / Platform Test Suite:** Executed in local Node.js v20.19.4 test harness using transactional in-memory mocks, strict Zod schemas, and simulated network delays.
- **Executed Real GCP Firestore Suite:** Executed in Phase 2.1 (`verify-phase2-1-production-data.mjs`), validating real Firebase Admin SDK operations against GCP Cloud Firestore in project `brew-2621e`.
- **Emulator Tests:** No local emulator process was active during this verification pass; tests were executed in real serverless and memory environments.

### 4.1 Focused Voice Lifecycle & Hardening Suite (`npm run test:p6342`)

Command: `npx tsx scripts/verify-phase6-3-4-2-voice-lifecycle.ts`  
Result: **24 / 24 Passed (100%)**

```
================================================================================
   BREW Coffee Platform — Phase 6.3.4.2 Verification Suite
   Mock Voice Call Lifecycle Integration
================================================================================

--- 1. MOCK VOICE CALL OUTCOMES & LIFECYCLE ---
  ✓ 1.1 Answered call starts conversation engine with greeting turn
  ✓ 1.2 No-answer leaves booking enquiry pending and schedules retry
  ✓ 1.3 Busy and failed outcomes follow exponential backoff retry policy
  ✓ 1.4 Reaching max attempts results in permanent failure and flags staffFollowUpRequired
  ✓ 1.5 Attempt 1 returns no_answer, a later genuine retry attempt returns answered

--- 2. IDEMPOTENCY & PROVIDER SAFETY ---
  ✓ 2.1 Repeated idempotency key returns cached result without duplicate simulation
  ✓ 2.2 Reclaiming an expired in-flight attempt does not create duplicate mock calls

--- 3. DISPATCH-TIME POLICY INTEGRITY ---
  ✓ 3.1 Consent revocation before dispatch blocks delivery and skips provider
  ✓ 3.2 DND registration before dispatch blocks delivery and skips provider

--- 4. CONCURRENCY & LEASE FENCING ---
  ✓ 4.1 Stale worker cannot overwrite newer claim result
  ✓ 4.2 Stale worker whose claim was reclaimed or whose lease expired cannot update voice session greeting or metadata

--- 5. CONVERSATION ENGINE MULTILINGUAL INTERACTION & SEPARATE GATES ---
  ✓ 5.1 Conversation engine starts on answered call and handles customer turn in Telugu
  ✓ 5.2 Customer confirmation gate cannot be bypassed by staff approval

--- 6. CUSTOMER & STAFF VISIBILITY PRIVACY GUARANTEE ---
  ✓ 6.1 extractSafeCallStatus exposes only safe metadata without leaking sensitive fields

--- 7. PHASE 6.3.4.2.2: LOGICAL RETRY ACCOUNTING & TRANSACTIONAL MUTATION FENCING ---
  ✓ 7.1 Multiple expired-lease recoveries do not consume logical call attempts; backoff uses logical count
  ✓ 7.2 Genuine retry after backoff increments callAttemptCount and succeeds on answered call
  ✓ 7.3 Exhaustion of logical call attempts triggers permanent failure and staffFollowUpRequired
  ✓ 7.4 Legacy record fallback bounded by attemptCount prevents unlimited retries
  ✓ 7.5 Transactional session mutation fencing: concurrent reclaim cannot slip between ownership verification and write

--- 8. PHASE 6.3.4.2.3: INMEMORY CLAIM AND SESSION MUTATION ATOMICITY ---
  ✓ 8.1 Concurrent reclaim cannot interleave between claim check and session persistence
  ✓ 8.2 If lease expires and reclaim completes before mutation begins, mutation fails cleanly with StaleClaimError
  ✓ 8.3 Unrelated deliveries do not block each other (per-delivery key locking)
  ✓ 8.4 An error during mutation cleanly releases the delivery lock
  ✓ 8.5 Session optimistic revision conflicts are handled correctly without leaving stale delivery state

================================================================================
   Phase 6.3.4.2 Verification Complete: 24 / 24 tests passed!
================================================================================
```

### 4.2 Outbox & Foundation Regression Summary

| Command | Suite Name | Tests | Result |
| :--- | :--- | :---: | :--- |
| `npm run test:p6341` | Booking Foundation & Consent Verification | 33 | **33 / 33 passed (100%)** |
| `npm run test:p633` | Outbox Atomicity, Leases & Policy | 21 | **21 / 21 passed (100%)** |
| `npm run test:p6331` | Outbox Reliability & Privacy Hardening | 10 | **10 / 10 passed (100%)** |
| `npm run test:p6332` | Worker Boundary & Claim Fencing | 9 | **9 / 9 passed (100%)** |
| `npm run test:p63321` | Policy Boundary Closure | 11 | **11 / 11 passed (100%)** |
| `npm run test:p63322` | Policy Boundary & Repository Encapsulation | 12 | **12 / 12 passed (100%)** |
| `npm run test:p63323` | Final Repository Mutation & Emulator Isolation | 14 | **14 / 14 passed (100%)** |
| `node scripts/verify-all.mjs` | Master CI Suite (Phases 1–7) | 19 suites | **19 / 19 suites passed (100%)** |
| `npm run typecheck` | Strict TypeScript Compilation (`tsc --noEmit`) | — | **0 errors** |
| `npm run lint` | ESLint Code Quality Verification | — | **0 errors** |

---

## 5. Security & Architectural Invariants

1. **Feature Flag Invariant:** `VOICE_BOOKING_ENABLED=false` remains strictly enforced.
2. **Zero Telephony Dispatch:** No outbound PSTN or carrier calls are initiated.
3. **Fail-Closed Privacy:** Outbox records and public APIs expose only masked phone numbers (`+91******3210`).
4. **No Git Staging / Commits:** Work remains entirely uncommitted in the local working directory.

---

## 4. Verification Evidence & Test Execution Report

### Test Environments Distinction
- **Executed In-Memory / Platform Test Suite:** Executed in local Node.js v20.19.4 test harness using transactional in-memory mocks, strict Zod schemas, and simulated network delays.
- **Executed Real GCP Firestore Suite:** Executed in Phase 2.1 (`verify-phase2-1-production-data.mjs`), validating real Firebase Admin SDK operations against GCP Cloud Firestore in project `brew-2621e`.
- **Emulator Tests:** No local emulator process was active during this verification pass; tests were executed in real serverless and memory environments.

### 4.1 Focused Voice Lifecycle & Hardening Suite (`npm run test:p6342`)

Command: `npx tsx scripts/verify-phase6-3-4-2-voice-lifecycle.ts`
Result: **19 / 19 Passed (100%)**

```
================================================================================
   BREW Coffee Platform — Phase 6.3.4.2 Verification Suite
   Mock Voice Call Lifecycle Integration
================================================================================

--- 1. MOCK VOICE CALL OUTCOMES & LIFECYCLE ---
  ✓ 1.1 Answered call starts conversation engine with greeting turn
  ✓ 1.2 No-answer leaves booking enquiry pending and schedules retry
  ✓ 1.3 Busy and failed outcomes follow exponential backoff retry policy
  ✓ 1.4 Reaching max attempts results in permanent failure and flags staffFollowUpRequired
  ✓ 1.5 Attempt 1 returns no_answer, a later genuine retry attempt returns answered

--- 2. IDEMPOTENCY & PROVIDER SAFETY ---
  ✓ 2.1 Repeated idempotency key returns cached result without duplicate simulation
  ✓ 2.2 Reclaiming an expired in-flight attempt does not create duplicate mock calls

--- 3. DISPATCH-TIME POLICY INTEGRITY ---
  ✓ 3.1 Consent revocation before dispatch blocks delivery and skips provider
  ✓ 3.2 DND registration before dispatch blocks delivery and skips provider

--- 4. CONCURRENCY & LEASE FENCING ---
  ✓ 4.1 Stale worker cannot overwrite newer claim result
  ✓ 4.2 Stale worker whose claim was reclaimed or whose lease expired cannot update voice session greeting or metadata

--- 5. CONVERSATION ENGINE MULTILINGUAL INTERACTION & SEPARATE GATES ---
  ✓ 5.1 Conversation engine starts on answered call and handles customer turn in Telugu
  ✓ 5.2 Customer confirmation gate cannot be bypassed by staff approval

--- 6. CUSTOMER & STAFF VISIBILITY PRIVACY GUARANTEE ---
  ✓ 6.1 extractSafeCallStatus exposes only safe metadata without leaking sensitive fields

--- 7. PHASE 6.3.4.2.2: LOGICAL RETRY ACCOUNTING & TRANSACTIONAL MUTATION FENCING ---
  ✓ 7.1 Multiple expired-lease recoveries do not consume logical call attempts; backoff uses logical count
  ✓ 7.2 Genuine retry after backoff increments callAttemptCount and succeeds on answered call
  ✓ 7.3 Exhaustion of logical call attempts triggers permanent failure and staffFollowUpRequired
  ✓ 7.4 Legacy record fallback bounded by attemptCount prevents unlimited retries
  ✓ 7.5 Transactional session mutation fencing: concurrent reclaim cannot slip between ownership verification and write

================================================================================
   Phase 6.3.4.2 Verification Complete: 19 / 19 tests passed!
================================================================================
```

### 4.2 Outbox & Foundation Regression Summary

| Command | Suite Name | Tests | Result |
| :--- | :--- | :---: | :--- |
| `npm run test:p6341` | Booking Foundation & Consent Verification | 33 | **33 / 33 passed (100%)** |
| `npm run test:p633` | Outbox Atomicity, Leases & Policy | 21 | **21 / 21 passed (100%)** |
| `npm run test:p6331` | Outbox Reliability & Privacy Hardening | 10 | **10 / 10 passed (100%)** |
| `npm run test:p6332` | Worker Boundary & Claim Fencing | 9 | **9 / 9 passed (100%)** |
| `npm run test:p63321` | Policy Boundary Closure | 11 | **11 / 11 passed (100%)** |
| `npm run test:p63322` | Policy Boundary & Repository Encapsulation | 12 | **12 / 12 passed (100%)** |
| `npm run test:p63323` | Final Repository Mutation & Emulator Isolation | 14 | **14 / 14 passed (100%)** |
| `node scripts/verify-all.mjs` | Master CI Suite (Phases 1–7) | 19 suites | **19 / 19 suites passed (100%)** |
| `npm run typecheck` | Strict TypeScript Compilation (`tsc --noEmit`) | — | **0 errors** |
| `npm run lint` | ESLint Code Quality Verification | — | **0 errors** |

---

## 5. Security & Architectural Invariants

1. **Feature Flag Invariant:** `VOICE_BOOKING_ENABLED=false` remains strictly enforced.
2. **Zero Telephony Dispatch:** No outbound PSTN or carrier calls are initiated.
3. **Fail-Closed Privacy:** Outbox records and public APIs expose only masked phone numbers (`+91******3210`).
4. **No Git Staging / Commits:** Work remains entirely uncommitted in the local working directory.
