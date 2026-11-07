# BREW Coffee — Phase 6.3.1.4 Hardening Report
## Deleted-Session Resurrection Prevention & Fail-Closed Lookup Integrity

**Date:** November 1, 2026  
**Status:** Completed & Authoritatively Verified  
**Branch:** `main`  
**Git HEAD:** `dead10a7d84a188adb99f2ea9800fdfeae4bf9d5`  
**Environment Flag:** `VOICE_BOOKING_ENABLED=false` (Production Safety Gate Preserved)  
**Test Mode:** Deterministic High-Fidelity Simulator (No Firestore Emulator)

---

## 1. Executive Summary & Findings Addressed

Following the independent architectural review of Phase 6.3.1.3, two critical edge-case vulnerabilities were identified in `FirestoreVoiceSessionRepository` and `InMemoryVoiceSessionRepository`:

1. **Deleted-Session Resurrection via Stale Updates:**
   In Phase 6.3.1.3, if a stored session was deleted from Firestore (or in-memory store) and an in-flight conversation turn or stale worker attempted to update it with `expectedRevision: 1`, the repository allowed recreation because it treated `expectedRevision <= 1` as an initial creation. This permitted stale writes to resurrect deleted sessions and re-insert them into the database.

2. **Silent Failure & Inappropriate Fallbacks in Phone Lookups:**
   In Phase 6.3.1.3, `getByPhoneNumber()` silently caught and discarded documents that failed schema deserialization or document identity checks (`catch { // Skip corrupted documents }`). If the newest document for a customer was corrupted, default lookup would silently return an older session as the "latest", presenting an inaccurate customer state. Similarly, active lookup would skip over corrupted documents as if they were valid terminal sessions, potentially discovering an obsolete active session.

Phase 6.3.1.4 completely resolves these vulnerabilities with strict fail-closed integrity contracts.

---

## 2. Architecture & Contract Specifications

### 2.1 Strict Create vs. Update Semantics & Resurrection Prevention
In both `FirestoreVoiceSessionRepository.save()` and `InMemoryVoiceSessionRepository.save()`:

```typescript
// Immutable expected revision captured before runTransaction
const immutableExpectedRevision: number | undefined = expectedRevision;
const isCreateOperation = immutableExpectedRevision === undefined;

if (!existingDoc.exists) {
  // If the document does not exist and expectedRevision is defined, reject the operation
  // with OptimisticConcurrencyConflictError, regardless of whether expectedRevision is 1 or higher.
  if (!isCreateOperation) {
    throw new OptimisticConcurrencyConflictError(
      `Cannot update session '${sessionId}': document does not exist in store. Expected revision was ${immutableExpectedRevision}. Stale update on missing or deleted session rejected.`
    );
  }
  // Only an explicit create operation (expectedRevision === undefined) may create a missing document.
  committedRevision = 1;
  const serialized = serializeSessionForFirestore({ ...session, revision: 1 });
  transaction.set(docRef, serialized);
  return;
}

if (isCreateOperation) {
  // Explicit create-only semantics: reject duplicate creation
  throw new OptimisticConcurrencyConflictError(
    `Cannot create session '${sessionId}': document already exists in store. Concurrent create rejected.`
  );
}
```

#### Guarantees:
- **No Resurrection of Deleted Sessions:** Once a session document is deleted, any attempt to save with an `expectedRevision` ($\ge 1$) throws `OptimisticConcurrencyConflictError`. The document is never recreated.
- **Explicit Create-Only:** Only calls with `expectedRevision === undefined` can create missing documents.
- **Duplicate Create Rejection:** If `expectedRevision === undefined` is called on a document that already exists, it is rejected with `OptimisticConcurrencyConflictError`.
- **Zero In-Transaction Mutation:** Callers' session objects are never mutated inside Firestore transaction callbacks.

### 2.2 Fail-Closed Phone Lookup Integrity & Diagnostics
Introduced the `VoiceSessionLookupIntegrityError` domain error in `src/lib/voiceBooking/types.ts`:

```typescript
export class VoiceSessionLookupIntegrityError extends Error {
  public readonly maskedPhoneNumber: string;
  public readonly documentId: string;
  public readonly reason: string;

  constructor(maskedPhoneNumber: string, documentId: string, reason: string) {
    super(
      `Lookup integrity violation for phone '${maskedPhoneNumber}' on document '${documentId}': ${reason}. Failing closed to prevent corrupted or inconsistent session recovery.`
    );
    this.name = "VoiceSessionLookupIntegrityError";
    this.maskedPhoneNumber = maskedPhoneNumber;
    this.documentId = documentId;
    this.reason = reason;
    Object.setPrototypeOf(this, VoiceSessionLookupIntegrityError.prototype);
  }
}
```

#### Masking and Diagnostics Policy:
- **Strict Data Redaction:** All error messages, logs, and diagnostic properties mask the customer phone number (e.g. `+91****3210`).
- **Safe Identifiers:** Diagnostics identify the problematic Firestore document ID (`docSnap.id`) and the exact validation failure reason without logging sensitive session payload contents.
- **Caller Handling:** Callers encountering `VoiceSessionLookupIntegrityError` fail closed, halting conversation recovery rather than proceeding with corrupted, altered, or legacy data.

### 2.3 Default Lookup (`activeOnly: false` or omitted)
- **Single-Result Query:** Executes a native Firestore-side query ordered by `createdAt` descending with a hard `.limit(1)`:
  ```typescript
  const snapshot = await baseQuery.orderBy("createdAt", "desc").limit(1).get();
  ```
- **Validation:** Inspects the single retrieved document:
  1. Verifies raw document payload is a non-null object.
  2. Verifies document identity: stored payload `id` must strictly match Firestore document ID `docSnap.id`.
  3. Deserializes and validates through `deserializeSessionFromFirestore()` and `VoiceBookingSessionSchema`.
- **Fail-Closed on Corruption:** If the newest record is corrupted, malformed, or has an identity mismatch, `getByPhoneNumber` throws `VoiceSessionLookupIntegrityError`. It **never** falls back to an older record.

### 2.4 Active Lookup (`activeOnly: true`)
- **Ordered Cursor Pagination:** Paginates through Firestore in batches of up to 25 using `orderBy("createdAt", "desc")` and `startAfter(lastDocSnapshot)` up to `maxScanBudget` (default `100`).
- **Strict Sequence Processing:**
  1. Each document is validated for document identity and schema compliance.
  2. If a corrupted document is encountered, lookup immediately throws `VoiceSessionLookupIntegrityError`. It **never** treats a corrupted document as a terminal session to skip past.
  3. If the document is valid and terminal (`isTerminalVoiceState(session.state)` or audited), lookup continues past it.
  4. If the document is valid and active, it is immediately returned.
- **Budget Exhaustion:** If `maxScanBudget` is reached without finding an active session and additional records exist, throws `IncompleteSessionLookupError(trimmedPhone, totalScanned)`.

### 2.5 100% Contract Parity
`InMemoryVoiceSessionRepository` and `FirestoreVoiceSessionRepository` enforce identical:
- Resurrection prevention on deleted sessions.
- Create-only checks on duplicate creation.
- Fail-closed lookup integrity with `VoiceSessionLookupIntegrityError`.
- Terminal session bypassing and bounded budget scanning with `IncompleteSessionLookupError`.

---

## 3. Verification Suite & Test Matrix

The Phase 6.3.1.4 verification suite (`scripts/verify-phase6-3-1-4-hardening.ts`) runs 10 deterministic tests:

| Test | Objective | Result |
| :--- | :--- | :--- |
| **Test 1** | Deleted document + expected revision 1 fails closed (no resurrection) | **PASS** |
| **Test 2** | Deleted document + expected revision > 1 fails closed (no resurrection) | **PASS** |
| **Test 3** | Explicit create on missing document succeeds at revision 1 | **PASS** |
| **Test 4** | Duplicate create against existing document fails closed | **PASS** |
| **Test 5** | Newest matching document malformed in default lookup fails closed | **PASS** |
| **Test 6** | Newest matching document has identity mismatch in default lookup | **PASS** |
| **Test 7** | Malformed document encountered during active lookup fails closed | **PASS** |
| **Test 8** | Valid terminal sessions are still skipped correctly in active lookup | **PASS** |
| **Test 9** | Scan budget exhaustion still returns `IncompleteSessionLookupError` | **PASS** |
| **Test 10** | InMemory vs Firestore complete contract parity | **PASS** |

### Test Mode Transparency
All tests were executed against a deterministic, high-fidelity in-memory simulator (`MockFirestoreStore`) modeling Cloud Firestore's native `runTransaction`, optimistic CAS retries, and pagination cursors. Testing was not performed against the live Google Cloud Firestore Emulator.

---

## 4. Full Regression Verification

| Suite | Command | Status |
| :--- | :--- | :--- |
| **Phase 6.3.1.4** | `npm run test:p6314` | **PASS (10/10 tests)** |
| **Phase 6.3.1.3** | `npm run test:p6313` | **PASS (10/10 tests)** |
| **Phase 6.3.1.2** | `npm run test:p6312` | **PASS (10/10 tests)** |
| **Phase 6.3.1.1** | `npm run test:p6311` | **PASS (12/12 tests)** |
| **Phase 6.3.1** | `npm run test:p631` | **PASS (24/24 tests)** |
| **Phase 6.2.4.4** | `npm run test:p6244` | **PASS (15/15 tests)** |
| **Phase 6.2.4.3** | `npm run test:p6243` | **PASS (18/18 tests)** |
| **Phase 6.2.4.2** | `npm run test:p6242` | **PASS (18/18 tests)** |
| **Phase 6.2.4.1** | `npm run test:p6241` | **PASS (14/14 tests)** |
| **Phase 6.2.4** | `npm run test:p624` | **PASS (18/18 tests)** |
| **Phase 6.2.3** | `npm run test:p623` | **PASS (19/19 tests)** |
| **Phase 6.2.2** | `npm run test:p622` | **PASS (14/14 tests)** |
| **Phase 6.2.1** | `npm run test:p621` | **PASS (16/16 tests)** |
| **Phase 6.2 Engine** | `npm run test:p62` | **PASS (88/88 tests)** |
| **Phase 6.1 Communication** | `npm run test:p61` | **PASS (39/39 tests)** |
| **TypeScript Typecheck** | `npm run typecheck` | **PASS (0 errors)** |
| **ESLint** | `npm run lint` | **PASS (0 errors, 3 legacy warnings)** |
| **Platform Unit/Integration** | `npm test` | **PASS (19/19 suites)** |
| **Playwright E2E** | `npm run test:e2e` | **PASS (18/18 tests)** |
| **Production Build** | `npm run build` | **PASS (Static & Standalone generated)** |

---

## 5. Summary of Modified Files

- `src/lib/voiceBooking/types.ts`: Added `VoiceSessionLookupIntegrityError` class and `maskVoicePhoneNumber` utility.
- `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts`: Enforced resurrection prevention on missing/deleted documents across all `expectedRevision` values; upgraded `getByPhoneNumber` to single-result default lookup and fail-closed integrity checks on both default and active lookup paths.
- `src/lib/voiceBooking/repositories/sessionRepository.ts`: Mirrored all hardening updates and added `deleteSession()` for testing parity.
- `package.json`: Registered `"test:p6314"`.
- `scripts/verify-phase6-3-1-4-hardening.ts`: Comprehensive 10-test verification suite.
- `scripts/verify-phase6-3-1-1-remediation.ts`: Explicitly created sessions via `save()` before turn processing and enabled `orderBy` in mock query builder.
- `scripts/verify-phase6-3-1-2-hardening.ts`: Added document ID descending tie-breaker in mock query executor.
- `docs/PHASE_6_3_1_4_HARDENING_REPORT.md`: Authoritative hardening report.
