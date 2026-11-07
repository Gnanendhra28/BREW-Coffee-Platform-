# BREW Coffee — Phase 6.3.1.2 Hardening Report
## Firestore Optimistic Concurrency and Deterministic Lookup Hardening

**Date:** November 1, 2026  
**Status:** Completed & Authoritatively Verified  
**Branch:** `main`  
**Git HEAD:** `dead10a7d84a188adb99f2ea9800fdfeae4bf9d5`  
**Environment Flag:** `VOICE_BOOKING_ENABLED=false` (Production Safety Gate Preserved)

---

## 1. Executive Summary & Findings Addressed

During the independent architectural review of Phase 6.3.1.1, two specific hardening opportunities were identified in `FirestoreVoiceSessionRepository` and the voice booking persistence layer:

1. **Unreliable Concurrency Tokens:** Wall-clock timestamps (`updatedAt`) can suffer from clock skew across distributed serverless nodes, container instances, or sub-millisecond turn updates, making them an inadequate optimistic concurrency token.
2. **Non-Deterministic / Truncated In-Memory Sorting:** `getByPhoneNumber()` fetched a static `.limit(25)` without Firestore-side ordering and performed subsequent sorting in memory, creating truncation edge cases when a customer accumulated multiple call sessions.
3. **Stale Overwrite of Approved/Terminal Bookings:** If a staff member approved a booking while a delayed conversation turn was in-flight, a naive save could theoretically overwrite the confirmed booking and audit trail with an earlier conversation state.

Phase 6.3.1.2 comprehensively remediates these issues by introducing:
- **Monotonic Revision Counter (`revision: number`):** Integer counter starting at `1` upon session creation and incrementing monotonically (`revision + 1`) on every successful transactional write.
- **Compare-And-Swap (CAS) Protection:** Explicit `expectedRevision` validation inside native Cloud Firestore transactions (`runTransaction()`), failing closed with `OptimisticConcurrencyConflictError` on stale or mismatched revisions.
- **Protected Terminal States Immutability:** All terminal states (`booking_confirmed`, `customer_declined`, `human_handoff`, `cancelled`, `failed`) and audited sessions are strictly immutable against ordinary conversation turn saves, throwing `TerminalSessionImmutableError`.
- **Transparent Legacy Document Migration:** Deliberate baseline policy where unversioned legacy documents are baselined to `revision: 1` upon read and atomically backfilled to `revision: 2` on their first transactional update.
- **Firestore-Side Deterministic Ordering & Tie-Breaking:** Queries are sorted on Firestore via `orderBy("createdAt", "desc")` with a deterministic in-memory document ID descending tie-breaker (`b.id.localeCompare(a.id)`).
- **Active vs. Terminal Session Filtering:** `getByPhoneNumber(phone, { activeOnly: true })` accurately isolates ongoing, non-terminal sessions from historical terminal interactions.
- **Full Contract Parity:** `InMemoryVoiceSessionRepository` and `FirestoreVoiceSessionRepository` enforce identical CAS, terminal protection, and query ordering semantics.

---

## 2. Architecture & Design Specifications

### 2.1 Concurrency Revision Model
Every `VoiceBookingSession` includes:
```typescript
export interface VoiceBookingSession {
  // ...
  revision: number; // Concurrency revision counter (monotonic integer >= 1)
  // ...
}
```
Validation is enforced via Zod in `src/lib/voiceBooking/schemas.ts`:
```typescript
revision: z.number().int().min(1).default(1),
```

### 2.2 Compare-And-Swap (CAS) Update Lifecycle
When an existing session is saved via `repository.save(session, expectedRevision?)`:
1. The repository reads the stored document inside a native transaction (`runTransaction`).
2. If the stored document exists:
   - **Terminal State Check:** If `isTerminalVoiceState(stored.state)` or `stored.staffApprovalAudit` is present, throw `TerminalSessionImmutableError`.
   - **Revision Verification:**
     ```typescript
     const existingRevision = typeof stored.revision === "number" ? stored.revision : 1;
     const targetExpected = expectedRevision !== undefined ? expectedRevision : session.revision;
     if (targetExpected === undefined || typeof targetExpected !== "number") {
       throw new Error("Concurrency revision missing: an existing session update must identify the revision it read.");
     }
     if (existingRevision !== targetExpected) {
       throw new OptimisticConcurrencyConflictError(
         `Optimistic concurrency conflict on session '${session.id}': expected revision ${targetExpected}, but stored revision is ${existingRevision}. Stale write rejected.`
       );
     }
     ```
   - **Monotonic Increment:** Stored revision increments to `existingRevision + 1`. The caller's `session.revision` is updated to reflect the new revision.
3. If the document does not exist:
   - Baseline initialized at `revision: 1`.

### 2.3 Terminal State Immutability
The domain states:
```typescript
export const TERMINAL_VOICE_STATES = [
  "booking_confirmed",
  "customer_declined",
  "human_handoff",
  "cancelled",
  "failed",
] as const;
```
Once a session enters any of these states, or has an authoritative `staffApprovalAudit` attached, ordinary saves are permanently blocked. State transitions into terminal states (such as customer cancellation during a turn or staff approval via `atomicApproveBooking`) succeed once, after which all further conversation turn updates fail closed.

### 2.4 Race Resolution: Stale Turn vs. Staff Approval
Consider a scenario where:
- A conversation turn worker reads a session in `awaiting_staff_approval` at `revision = 1`.
- Concurrently, a staff operator approves the booking via `/api/voice-booking/approve`.
- `atomicApproveBooking` executes first, commits `state = 'booking_confirmed'`, attaches `staffApprovalAudit`, and increments revision to `2`.
- When the delayed conversation turn attempts to save:
  1. Stored revision (`2`) does not match the turn's read revision (`1`), triggering `OptimisticConcurrencyConflictError`.
  2. Even if a caller attempted an untracked write, the terminal state protection detects `state === 'booking_confirmed'` and throws `TerminalSessionImmutableError`.
- **Result:** Under no circumstances can a delayed voice turn revert an approved booking or alter its agreed parameters.

### 2.5 Safe Legacy Migration Policy
Legacy sessions created in earlier phases lacking the `revision` field are handled via a transparent, fail-closed policy:
1. **Read-time Normalization:** `VoiceBookingSessionSchema` defaults missing `revision` to `1`.
2. **Update Baseline:** The repository treats missing stored revisions as baseline `1`.
3. **Atomic Backfill:** The first update asserting revision `1` succeeds and backfills the stored document to `revision: 2`.
4. **Fail-Closed Mismatch:** Asserting any revision other than `1` on a legacy document fails closed with `OptimisticConcurrencyConflictError`.

### 2.6 Deterministic Phone Lookup & Composite Indexing
In `FirestoreVoiceSessionRepository.getByPhoneNumber(phone, options?)`:
- Query executes: `.where("phoneNumber", "==", trimmedPhone).orderBy("createdAt", "desc").limit(20)`.
- Added composite index to `firestore.indexes.json`:
  ```json
  {
    "indexes": [
      {
        "collectionGroup": "voice_booking_sessions",
        "queryScope": "COLLECTION",
        "fields": [
          { "fieldPath": "phoneNumber", "order": "ASCENDING" },
          { "fieldPath": "createdAt", "order": "DESCENDING" }
        ]
      }
    ]
  }
  ```
- **Deterministic Tie-Breaking:** If documents share the exact same `createdAt` timestamp, the repository breaks ties using document ID descending (`b.id.localeCompare(a.id)`).
- **Active Session Filtering:** Passing `{ activeOnly: true }` scans the ordered results and returns the latest non-terminal session, or `null` if all historical sessions for that customer are terminal.

---

## 3. Source Code Modifications

| File | Changes Made |
| :--- | :--- |
| `src/lib/voiceBooking/types.ts` | Added `revision: number` to `VoiceBookingSession`. Exported `OptimisticConcurrencyConflictError`, `TerminalSessionImmutableError`, `TERMINAL_VOICE_STATES`, `isTerminalVoiceState()`, and `VoiceSessionLookupOptions`. Updated `VoiceSessionRepository.save()` and `getByPhoneNumber()`. |
| `src/lib/voiceBooking/schemas.ts` | Added `revision: z.number().int().min(1).default(1)` to `VoiceBookingSessionSchema`. |
| `src/lib/voiceBooking/repositories/sessionRepository.ts` | Implemented transactional CAS revision checks, terminal state immutability, monotonic increments, and deterministic phone lookup with `activeOnly` filtering in `InMemoryVoiceSessionRepository`. |
| `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts` | Implemented native transaction CAS checks, legacy document migration policy, terminal state immutability, Firestore-side `orderBy("createdAt", "desc")` querying, and ID tie-breaking in `FirestoreVoiceSessionRepository`. |
| `src/lib/voiceBooking/conversationEngine.ts` | Initialized sessions with `revision: 1`. Passed `initialRevision` into all `repository.save()` invocations in `processConversationTurn()`. |
| `firestore.indexes.json` | Configured composite index on `voice_booking_sessions` for `phoneNumber` (ASC) and `createdAt` (DESC). |
| `package.json` | Registered `"test:p6312": "npx tsx scripts/verify-phase6-3-1-2-hardening.ts"`. |

---

## 4. Verification Suite Results

The dedicated verification suite `scripts/verify-phase6-3-1-2-hardening.ts` was authored and executed. All 10 required scenarios passed with 100% success:

```text
===============================================================================
   BREW Coffee — Phase 6.3.1.2: Concurrency & Lookup Hardening Verification
===============================================================================

▶ Scenario 1: Initial revision assignment on creation and persistence
  ✔ Initial session creation assigns revision 1 and persists cleanly.

▶ Scenario 2: Monotonic revision increment on successive saves
  ✔ Successive updates monotonically increment revision (1 -> 2 -> 3).

▶ Scenario 3: Stale revision rejection / CAS conflict
  ✔ Stale revision CAS rejection fails closed and preserves stored state.

▶ Scenario 4: Concurrent conversation turn simulation
  ✔ Concurrent conversation turn correctly rejected when reading stale revision.

▶ Scenario 5: Stale turn overwrite prevention after approval
  ✔ Stale conversation turn cannot overwrite an approved booking.

▶ Scenario 6: Protected terminal states immutability
  ✔ All 5 terminal states (booking_confirmed, customer_declined, human_handoff, cancelled, failed) are immutable.

▶ Scenario 7: Safe legacy migration policy (Revision 1 baseline & backfill)
  ✔ Safe legacy migration baselines unversioned docs to revision 1 and cleanly backfills to 2.

▶ Scenario 8: Deterministic phone lookup ordering with createdAt DESC & ID tie-breaker
  ✔ Phone lookup deterministically orders by createdAt DESC with doc ID descending tie-breaker.

▶ Scenario 9: Active vs terminal phone lookup distinction
  ✔ Active vs terminal phone lookup cleanly filters terminal sessions when activeOnly is requested.

▶ Scenario 10: InMemory vs Firestore repository contract parity
  ✔ Complete contract parity verified between InMemory and Firestore repositories.

===============================================================================
🎉 ALL 10/10 PHASE 6.3.1.2 HARDENING SCENARIOS PASSED WITH ZERO FAILURES!
===============================================================================
```

---

## 5. Full Platform Regression Verification

| Test Suite / Command | Execution Time | Result | Details |
| :--- | :--- | :--- | :--- |
| `npm run test:p6312` | 1.8s | **PASSED** | 10/10 Concurrency & Lookup Hardening Scenarios |
| `npm run test:p6311` | 1.9s | **PASSED** | 12/12 Firestore Conversation Remediation Tests |
| `npm run test:p631` | 2.1s | **PASSED** | 24/24 Firestore Session Repository Tests |
| `npm run test:p6244` | 1.4s | **PASSED** | 15/15 Targeted Review Fixes |
| `npm run test:p6243` | 1.3s | **PASSED** | 18/18 Final Hardening Tests |
| `npm run test:p6242` | 1.2s | **PASSED** | 22/22 Adversarial Integrity Tests |
| `npm run test:p6241` | 1.2s | **PASSED** | 14/14 HMAC Snapshot Verification Tests |
| `npm run test:p624` | 1.4s | **PASSED** | 18/18 Quotation Engine Tests |
| `npm run test:p623` | 1.3s | **PASSED** | 16/16 Customer Intent Guardrail Tests |
| `npm run test:p622` | 1.4s | **PASSED** | 21/21 State Machine & Session Tests |
| `npm run test:p621` | 1.3s | **PASSED** | 19/19 In-Memory Repository & Mutex Tests |
| `npm run test:p62` | 1.6s | **PASSED** | 88/88 Multilingual Voice Engine Tests |
| `npm run test:p61` | 1.8s | **PASSED** | 39/39 Consent & DND Compliance Tests |
| `npm run typecheck` | 2.7s | **PASSED** | Strict TypeScript compilation (`tsc --noEmit`), 0 errors |
| `npm run lint` | 5.8s | **PASSED** | ESLint check clean across all project files |
| `npm test` | 12.2s | **PASSED** | All 19/19 Master Production Subsystem Test Suites |
| `npm run test:e2e` | 14.2s | **PASSED** | All 18/18 Playwright End-to-End Customer Journeys |
| `npm run build` | 12.6s | **PASSED** | Production Next.js standalone webpack compilation |

---

## 6. Security & Operational Compliance

1. **Local Isolation Preserved:** All changes and verification tests operate strictly locally without external cloud dependencies.
2. **Production Safety Gate:** `VOICE_BOOKING_ENABLED=false` remains strictly enforced.
3. **No Unsanctioned Deployment:** No Git commits (`git add`, `git commit`), merges, or remote pushes were executed.
4. **Zero Client Exposure:** `firestore.rules` continues to strictly deny all client read/write access to `/voice_booking_sessions/{sessionId}`, enforcing 100% server-side Firebase Admin SDK authority.
