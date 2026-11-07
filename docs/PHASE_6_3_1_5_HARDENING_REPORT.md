# BREW Coffee — Phase 6.3.1.5 Hardening Report
## Firestore Lookup Completeness & Missing-Ordering-Field Integrity

**Date:** November 1, 2026  
**Status:** Completed & Authoritatively Verified  
**Branch:** `main`  
**Git HEAD:** `dead10a7d84a188adb99f2ea9800fdfeae4bf9d5`  
**Environment Flag:** `VOICE_BOOKING_ENABLED=false` (Production Safety Gate Preserved)  
**Test Mode:** Deterministic High-Fidelity Simulator (No Firestore Emulator)

---

## 1. Executive Summary & Problem Addressed

During the architectural audit of Phase 6.3.1.4, a subtle but critical Firestore behavior was identified in phone-number lookups:

### The Missing `createdAt` Visibility Vulnerability
In Cloud Firestore, queries that order by an arbitrary field (e.g., `.where("phoneNumber", "==", phone).orderBy("createdAt", "desc")`) rely on a composite index on `(phoneNumber, createdAt)`.
**Firestore's indexing contract dictates that any document lacking the indexed/ordered field (`createdAt`) is silently excluded from the index and will NEVER be returned by the query.**

#### Consequences in Prior Implementation:
1. If a document was stored with a missing, null, or unindexed `createdAt` field, Firestore would silently hide it from `getByPhoneNumber()`.
2. The document would never reach application-level schema deserialization or integrity checks.
3. If this unindexed document was actually the newest customer interaction (or an active session), `getByPhoneNumber()` would silently return an older session or `null`, completely masking database corruption or loss of customer continuity.

Phase 6.3.1.5 resolves this vulnerability by decoupling Firestore collection traversal from `createdAt` indexing and implementing a complete, bounded document-ID cursor scan with authoritative in-memory sorting.

---

## 2. Architectural Analysis: Bounded Scan vs. Latest-Session Pointer

We evaluated two architectural strategies to address lookup completeness:

### Option A: Transactionally Maintained Latest-Session Pointer
- **Mechanism:** Maintain a dedicated pointer document per phone number (e.g. `phone_registry/{phoneNumber}`) that stores the `latestSessionId` and `activeSessionId`, updated atomically inside session transaction callbacks.
- **Trade-offs & Risks:**
  - *Dual-Document Contention:* Every conversation turn save would have to contend on both the session document and the phone pointer document, doubling transaction retries under concurrent turn traffic.
  - *Backfill & Migration Complexity:* Existing unindexed or historical sessions would require a complex background backfill to build pointers.
  - *Orphan Pointer Inconsistency:* A failure or divergence between pointer and session stores would introduce cross-document split-brain states.

### Option B: Bounded Document-ID Cursor Scan with In-Memory Sorting (Selected Strategy)
- **Mechanism:**
  - Traversal is ordered strictly by document ID using `FieldPath.documentId()`.
  - Every Firestore document has an internal document ID (`__name__`); it can **never** be missing.
  - No matching document can ever be excluded by Firestore's indexing rules.
  - All matching documents up to `maxScanBudget` (default `100`) are scanned, validated against strict timestamp and schema guardrails, and sorted in memory.
- **Why Selected:**
  - Minimal, safe, zero-migration change.
  - Guarantees 100% visibility of all documents matching `phoneNumber`.
  - Immediately detects and fails closed on missing/corrupted `createdAt` timestamps.
  - Preserves bounded read costs (capped at `maxScanBudget`).

---

## 3. Architecture & Implementation Specifications

### 3.1 Document-ID Ordering & Cursor Traversal
In `FirestoreVoiceSessionRepository.getByPhoneNumber()`:
```typescript
let baseQuery = db
  .collection(VOICE_BOOKING_COLLECTION)
  .where("phoneNumber", "==", trimmedPhone);

// Order by document ID for stable cursor pagination without omitting documents missing createdAt
if (typeof baseQuery.orderBy === "function") {
  baseQuery = baseQuery.orderBy(FieldPath.documentId(), "asc");
}
```
- Traversal orders by `FieldPath.documentId()`, which uses Firestore's built-in single-field indexing.
- Paginates in batches of 25 using `.limit(batchLimit)` and `.startAfter(lastDocSnapshot)`.

### 3.2 Strict Timestamp Validation (Zero Substitution)
Every encountered document is rigorously validated during traversal:
1. `createdAt` must be present, non-null, and a strictly valid ISO 8601 UTC string ending in `'Z'` (`isValidStrictIsoUtc`).
2. `updatedAt` must be present, non-null, and a strictly valid ISO 8601 UTC string ending in `'Z'`.
3. Firestore Timestamp objects (`{ toDate: () => Date }`) are safely normalized to strict ISO 8601 UTC strings.
4. If `createdAt` or `updatedAt` is missing, malformed, non-UTC, or invalid calendar date (e.g. Feb 31), `deserializeSessionFromFirestore` immediately fails closed, and `getByPhoneNumber` throws `VoiceSessionLookupIntegrityError`.
5. **No Substitution:** The repository **never** substitutes `updatedAt` or `Date.now()` for a missing or invalid `createdAt`.

### 3.3 Authoritative In-Memory Deterministic Sorting
Once all matching documents for the customer are retrieved within the scan budget:
```typescript
validSessions.sort((a, b) => {
  const timeA = Date.parse(a.createdAt);
  const timeB = Date.parse(b.createdAt);
  if (timeB !== timeA) return timeB - timeA; // Primary: createdAt descending
  return b.id.localeCompare(a.id);           // Tie-breaker: document ID descending
});
```
- **Default Lookup (`activeOnly: false`):** Returns `validSessions[0]` (the session with the latest `createdAt`, tie-broken by document ID descending).
- **Active Lookup (`activeOnly: true`):** Returns the first non-terminal session (`!isTerminalVoiceState(s.state) && !s.staffApprovalAudit`), or `null` if all sessions are terminal.

### 3.4 Bounded Scan Budget & Truncation Safety
- If the number of matching records exceeds `maxScanBudget` (default `100`), or if a post-budget probe query reveals additional records beyond the budget:
  ```typescript
  throw new IncompleteSessionLookupError(trimmedPhone, totalScanned);
  ```
- The repository will **never** return a false or premature "latest" session when records remain unscanned.

### 3.5 Firestore Index Simplification
Because phone lookups now order by `FieldPath.documentId()`, the query relies solely on Firestore's native single-field index for `phoneNumber` and `__name__`.
The composite index `(phoneNumber ASC, createdAt DESC)` defined in earlier phases is no longer utilized by application queries and can safely be decommissioned.

---

## 4. Verification Suite & Test Matrix

The Phase 6.3.1.5 verification suite (`scripts/verify-phase6-3-1-5-hardening.ts`) executes 11 comprehensive tests:

| Test | Objective | Result |
| :--- | :--- | :--- |
| **Test 1** | Newest matching document missing `createdAt` fails closed | **PASS** |
| **Test 2** | Matching document with malformed `createdAt` fails closed | **PASS** |
| **Test 3** | Matching document with valid Firestore Timestamp normalization succeeds | **PASS** |
| **Test 4** | Multi-page cursor scanning discovers corrupted document on page 2 and fails closed | **PASS** |
| **Test 5** | More records than scan budget fails closed with `IncompleteSessionLookupError` | **PASS** |
| **Test 6** | Latest session selection after complete scan returns newest session | **PASS** |
| **Test 7** | Terminal records bypassed in `activeOnly` mode to return valid older active session | **PASS** |
| **Test 8** | Corrupted record encountered during active scan triggers fail-closed error | **PASS** |
| **Test 9** | Equal timestamps: deterministic document-ID descending tie-breaker | **PASS** |
| **Test 10** | InMemory and Firestore complete contract parity | **PASS** |
| **Test 11** | No false latest result when the scan is incomplete | **PASS** |

### Emulator Status Disclosure
- **Deterministic Simulator:** 11/11 tests executed and passed against high-fidelity in-memory Cloud Firestore simulator.
- **Live Cloud Firestore Emulator:** Checked via `gcloud components list`. The component is NOT installed in the host workspace environment (`cloud-firestore-emulator: Not Installed`). Therefore, live emulator tests were not executed.

---

## 5. Full Regression Verification

| Suite | Command | Status |
| :--- | :--- | :--- |
| **Phase 6.3.1.5** | `npm run test:p6315` | **PASS (11/11 tests)** |
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

## 6. Summary of Modified Files

- `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts`: Refactored `getByPhoneNumber()` to use `FieldPath.documentId()` cursor pagination and in-memory sorting; enforced strict timestamp validation in `deserializeSessionFromFirestore()`.
- `src/lib/voiceBooking/repositories/sessionRepository.ts`: Mirrored all lookup, timestamp, and sorting semantics for 100% contract parity.
- `package.json`: Registered `"test:p6315"`.
- `scripts/verify-phase6-3-1-5-hardening.ts`: Comprehensive 11-test verification suite.
- `docs/PHASE_6_3_1_5_HARDENING_REPORT.md`: Authoritative hardening report.
