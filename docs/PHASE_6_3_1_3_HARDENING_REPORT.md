# BREW Coffee — Phase 6.3.1.3 Hardening Report
## CAS Retry Safety, Strict Revision Validation & Complete Phone Lookup

**Date:** November 1, 2026  
**Status:** Completed & Authoritatively Verified  
**Branch:** `main`  
**Git HEAD:** `dead10a7d84a188adb99f2ea9800fdfeae4bf9d5`  
**Environment Flag:** `VOICE_BOOKING_ENABLED=false` (Production Safety Gate Preserved)  
**Test Mode:** Deterministic High-Fidelity Simulator (No Firestore Emulator)

---

## 1. Executive Summary & Findings Addressed

Following the independent architectural review of Phase 6.3.1.2, three critical persistence and concurrency vulnerabilities were identified in `FirestoreVoiceSessionRepository` and `InMemoryVoiceSessionRepository`:

1. **Transaction Callback Mutation & Retry Instability:**
   In Firestore `runTransaction()` callbacks, Firestore may execute the callback multiple times if contention occurs. In earlier code, `session.revision` could be mutated inside the callback, or the expected revision could be re-derived from a mutated object. If a transaction retried after a partial failure, it would compare against the mutated revision instead of the original revision read by the caller, potentially allowing race conditions or corrupting retry safety.

2. **Ambiguous Create vs. Update Semantics:**
   When `expectedRevision` was undefined, an attempt to save a document that already existed would silently overwrite it as an initial creation. Concurrent create requests could overwrite one another, violating atomic create guarantees. Furthermore, malformed revisions (such as negative numbers, `NaN`, non-integers, strings, booleans, or objects) were not strictly validated, risking store corruption.

3. **Lookup False Negatives from Static Query Windowing:**
   `getByPhoneNumber()` retrieved documents with a static limit (`.limit(20)`). When a customer accumulated more than 20 historical sessions (e.g. past terminal interactions), `activeOnly: true` queries could fail to observe an active session if it was preceded by terminal records, returning a false negative `null`.

Phase 6.3.1.3 resolves each of these vulnerabilities with mathematical precision and fail-closed security.

---

## 2. Architectural Hardening Specifications

### 2.1 Immutable Expected Revision & Zero Transaction Callback Mutation
In `FirestoreVoiceSessionRepository.save()`:
- The expected revision is resolved and locked into an immutable local constant **before** `runTransaction()` is called:
  ```typescript
  const immutableExpectedRevision = expectedRevision !== undefined ? expectedRevision : session.revision;
  ```
- **No In-Callback Mutation:** The caller-provided `session` object is never modified inside the transaction callback.
- **Atomic Revision Update:** Only after `runTransaction()` successfully resolves and commits to Firestore is the caller's `session.revision` updated to `nextRevision`.
- If the transaction retries due to Firestore server contention, every attempt evaluates against the exact same `immutableExpectedRevision`. If a competing worker committed an update in the interim, the retry immediately fails closed with `OptimisticConcurrencyConflictError`.

### 2.2 Explicit Create vs. Update Semantics
A strict boundary is enforced between session creation and session updates:
- **Create Operation (`expectedRevision === undefined`):**
  - If the document already exists in Firestore, the operation is strictly rejected:
    ```typescript
    if (existingDoc.exists) {
      throw new OptimisticConcurrencyConflictError(
        `Optimistic concurrency conflict on session '${session.id}': cannot create session; document already exists in store. Concurrent create rejected.`
      );
    }
    ```
  - This prevents concurrent workers from silently overwriting freshly created sessions.
- **Update Operation (`expectedRevision !== undefined`):**
  - If the document does not exist and `immutableExpectedRevision > 1`, the update fails closed with `OptimisticConcurrencyConflictError` ("cannot update session; document does not exist in store").
  - An uncreated document is only allowed to initialize at revision 1 if `immutableExpectedRevision === undefined || immutableExpectedRevision <= 1`.

### 2.3 Strict Revision Validation & Malformed Value Rejection
Both `FirestoreVoiceSessionRepository` and `InMemoryVoiceSessionRepository` employ the centralized `validateStoredRevision(rawRevision, sessionId)` validator:
- **Valid Types:** Positive integers $\ge 1$ (`1, 2, 3, ...`).
- **Genuinely Missing Revisions (`undefined`):** Baselines to `1` for backwards-compatible legacy migration.
- **Strictly Rejected Malformed Revisions (Fail-Closed):**
  - `null`
  - String numbers (`"1"`, `"2"`)
  - Fractional/float numbers (`1.5`, `2.7`)
  - Zero (`0`)
  - Negative integers (`-1`, `-5`)
  - `NaN`
  - `Infinity` and `-Infinity`
  - Booleans (`true`, `false`)
  - Objects (`{}`, `{ revision: 1 }`)
  - Arrays (`[]`, `[1]`)
Any encounter with a malformed revision during `save()`, `deserializeSessionFromFirestore()`, or `atomicApproveBooking()` immediately throws a descriptive `Error` and halts processing.

### 2.4 Documented Legacy Migration Policy
Sessions created prior to concurrency controls lack the `revision` field:
1. Genuinely omitted (`undefined`) revisions are normalized to baseline `1`.
2. To update a legacy document, the caller must assert `expectedRevision: 1`.
3. The transactional write atomically writes the session and backfills `revision: 2`.
4. Any caller attempting to assert `expectedRevision > 1` on an unmigrated document fails closed with `OptimisticConcurrencyConflictError`.

### 2.5 Complete Bounded Phone Lookup & False-Negative Elimination
In `getByPhoneNumber(phone, options)`:
- **Default Lookup (`activeOnly: false`):**
  - Queries Firestore ordered by `createdAt` descending with `.limit(1)`.
  - Applies in-memory document ID descending tie-breaker (`b.id.localeCompare(a.id)`) if multiple sessions share identical timestamps.
- **Active Only Lookup (`activeOnly: true`):**
  - Eliminates false negatives by executing cursor-based pagination with `startAfter()`.
  - Paginates in batches of 20 up to `maxScanBudget` (default `100`, configurable via `options.maxScanBudget`).
  - Scans past historical terminal sessions (`booking_confirmed`, `customer_declined`, `human_handoff`, `cancelled`, `failed`) until the latest active session is discovered.
- **Fail-Closed Budget Exhaustion (`IncompleteSessionLookupError`):**
  - If `maxScanBudget` is reached without finding an active session, but more documents remain in Firestore, the repository throws `IncompleteSessionLookupError`:
    ```typescript
    throw new IncompleteSessionLookupError(
      `Session lookup for phone '${phone}' exceeded scan budget (${budget} documents) without resolving an active session. Additional records exist. Failing closed to prevent false negatives.`
    );
    ```
  - The repository will **never** return a false negative `null` when an active session might exist beyond the scan window.
  - If all records in Firestore are scanned and none is active, it safely and accurately returns `null`.

### 2.6 Full Contract Parity
`InMemoryVoiceSessionRepository` and `FirestoreVoiceSessionRepository` share 100% identical validation logic, CAS checks, create-only enforcement, monotonic revision increments, and bounded lookup pagination with `IncompleteSessionLookupError`.

---

## 3. Verification Suite & Test Matrix

The Phase 6.3.1.3 verification suite (`scripts/verify-phase6-3-1-3-hardening.ts`) runs 10 deterministic adversarial tests:

| Test | Objective | Result |
| :--- | :--- | :--- |
| **Test 1** | Expected revision immutable across Firestore transaction retries | **PASS** |
| **Test 2** | Caller session object NOT mutated inside transaction callback | **PASS** |
| **Test 3** | Concurrent create attempts cannot overwrite one another (Create-only) | **PASS** |
| **Test 4** | Strict rejection of all 11 malformed revision values | **PASS** |
| **Test 5** | Missing legacy revision migrates only through documented policy | **PASS** |
| **Test 6** | More than 20 matching sessions finds latest session correctly | **PASS** |
| **Test 7** | Terminal records ahead of older active session (> 20 terminal records) | **PASS** |
| **Test 8** | Truncated scan budget fails closed with `IncompleteSessionLookupError` | **PASS** |
| **Test 9** | Equal timestamps have deterministic ordering via document ID tie-breaker | **PASS** |
| **Test 10** | InMemory vs Firestore complete contract parity | **PASS** |

### Test Mode Transparency
All tests were executed against a high-fidelity deterministic simulator (`MockFirestoreStore`) modeling Firestore's transactional lifecycle, optimistic locking, contention retries, and pagination cursors. Testing was not conducted against the Google Cloud Firestore Emulator.

---

## 4. Full Regression Verification

In addition to Phase 6.3.1.3, the entire BREW Coffee test suite was verified without regression:
- **Phase 6.3.1.2 Suite:** 10/10 scenarios passed.
- **Phase 6.3.1.1 Suite:** 12/12 tests passed.
- **Phase 6.3.1 Suite:** 24/24 tests passed.
- **Phase 6.2.4.4 Suite:** 15/15 tests passed.
- **Phase 6.2.4.3 Suite:** 18/18 tests passed.
- **Phase 6.2.4.2 Suite:** 18/18 tests passed.
- **Phase 6.2.4.1 Suite:** 14/14 tests passed.
- **Phase 6.2.4 Suite:** 18/18 tests passed.
- **Phase 6.2.3 Suite:** 19/19 tests passed.
- **Phase 6.2.2 Suite:** 14/14 tests passed.
- **Phase 6.2.1 Suite:** 16/16 tests passed.
- **Phase 6.2 Engine:** 88/88 tests passed.
- **Phase 6.1 Communication:** 39/39 tests passed.
- **TypeScript Typecheck:** `tsc --noEmit` passed with 0 errors.
- **ESLint:** 0 errors (3 legacy unused variable warnings).

---

## 5. Summary of Modified Files

- `src/lib/voiceBooking/types.ts`: Added `IncompleteSessionLookupError` and `maxScanBudget?: number`.
- `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts`: Added `validateStoredRevision`, immutable expected revision capture, create-only semantics, retry-safe transaction callbacks, and bounded pagination phone lookup.
- `src/lib/voiceBooking/repositories/sessionRepository.ts`: Mirrored all hardening updates for 100% contract parity.
- `package.json`: Registered `"test:p6313"`.
- `scripts/verify-phase6-3-1-3-hardening.ts`: Comprehensive 10-scenario verification suite.
- `scripts/verify-phase6-3-1-1-remediation.ts`: Updated legacy test callers to pass revision.
- `scripts/verify-phase6-3-1-firestore-repository.ts`: Updated legacy test callers to pass revision.
- `scripts/verify-phase6-2-3-hardening.ts`: Updated legacy test callers to pass revision.
- `scripts/verify-phase6-2-2-hardening.ts`: Updated legacy test callers to pass revision.
- `docs/PHASE_6_3_1_3_HARDENING_REPORT.md`: Authoritative hardening report.
