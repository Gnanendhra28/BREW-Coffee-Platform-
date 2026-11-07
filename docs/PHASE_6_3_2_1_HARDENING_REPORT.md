# BREW Coffee Platform — Phase 6.3.2.1 Hardening Report
## Firestore Transaction Ordering, Booking Integrity & Slot Reservation Hardening

**Date:** November 1, 2026  
**Status:** Completed & Fully Verified  
**Branch:** `main` (Zero staged/committed git changes)  
**Verification Suite:** `scripts/verify-phase6-3-2-1-hardening.ts` (15/15 Scenarios Passed)  

---

## 1. Executive Summary

Phase 6.3.2.1 remediates five critical vulnerabilities identified during independent source review of Phase 6.3.2:

1. **Firestore Transaction Read Ordering:** In `FirestoreVoiceSessionRepository.save()`, `transaction.set()` was invoked before reading `van_requests` (`transaction.get()`), violating Cloud Firestore's invariant that all reads must precede any writes.
2. **Silent Collection Failure Bypasses:** Multiple `try/catch` blocks silently swallowed `"Unexpected collection in mock"`, allowing collection errors to be ignored rather than failing closed.
3. **Official Booking Identity Invariants:** Client-supplied or mismatched official booking IDs were not strictly validated, risking forged enquiry linkages and ownership mismatches.
4. **Fabricated Booking Data Defaults:** In `createVanRequestRecordFromSession()`, missing fields were defaulted to synthetic placeholder strings (e.g. `"50 guests"`, `"TBD"` location), risking corrupted production enquiries.
5. **Slot Reservation Race Conditions & Distributed Atomicity:** Slot reservation previously relied on process-local JavaScript `Map` operations outside the Firestore transaction, risking multi-instance double-bookings in serverless/container environments.

All five areas have been hardened without altering the underlying architecture, without modifying manual booking workflows, and strictly adhering to the `VOICE_BOOKING_ENABLED=false` safety gate.

---

## 2. Root Cause Analysis & Technical Remediation

### 2.1 Firestore Transaction Read-Before-Write Strict Ordering
- **Defect:** In `FirestoreVoiceSessionRepository.save()`, `transaction.set(docRef, serialized)` was executed, followed by `await transaction.get(vanRequestRef)`. In production Cloud Firestore, calling `transaction.get()` after any `transaction.set()` throws an unrecoverable exception (`Firestore transactions require all reads to be executed before all writes`).
- **Remediation:** Both `FirestoreVoiceSessionRepository.save()` and `FirestoreVoiceSessionRepository.atomicApproveBooking()` now enforce strict two-phase execution:
  1. **Read Phase:** All documents (`docRef`, `vanRequestRef`, and `slotRef`) are read first using `await transaction.get()`.
  2. **Validation & Computation Phase:** Documents are deserialized, revisions checked (CAS), identities verified, and records constructed.
  3. **Write Phase:** All writes (`transaction.set()`) execute sequentially after all reads have concluded.
- **Simulator Guard:** Added a state machine guard in the test simulator (`hasWritten` flag). Any `transaction.get()` called after a `transaction.set()` immediately throws `Firestore transaction read-after-write violation: all reads must occur before any writes.`

### 2.2 Removal of Silent Collection Failure Bypasses
- **Defect:** Catch blocks checked `err.message.includes("Unexpected collection in mock")` and continued silently, allowing corrupted or missing collection handlers to pass without persistence.
- **Remediation:** Removed all exception-swallowing blocks in `save()`, `atomicApproveBooking()`, and `getOfficialBooking()`. If any collection is inaccessible or throws, the repository immediately fails closed. The mock test simulators were updated to explicitly support `voice_booking_sessions`, `van_requests`, and `schedule_slots`.

### 2.3 Strict Official Booking Identity Invariants
- **Defect:** A caller could pass arbitrary `officialBookingId` strings or link to mismatched `van_requests` records.
- **Remediation:** Created `validateOfficialBookingIdentity(session, existingRecord)`:
  - Requires `session.officialBookingId === computeOfficialVanRequestId(session.id)`.
  - Requires `session.metadata.officialBookingId === session.officialBookingId` (when defined).
  - Validates existing `van_requests` record:
    - Document ID matches `computeOfficialVanRequestId(session.id)`.
    - `existingRecord.voiceSessionId === session.id`.
    - `existingRecord.source === "voice_booking"`.
  - Violations immediately throw typed error `InvalidOfficialBookingBridgeDataError`.
  - Applied uniformly in both `FirestoreVoiceSessionRepository` and `InMemoryVoiceSessionRepository`.

### 2.4 Elimination of Fabricated Booking Data Defaults
- **Defect:** `createVanRequestRecordFromSession()` used fallbacks:
  `crowdSize: reqs.guestCount ? \`${reqs.guestCount} guests\` : "50 guests"`, `location: reqs.venueAddress || "TBD"`, `eventDate: reqs.eventDate || ""`.
- **Remediation:** All placeholder defaults have been removed. The bridge strictly validates against `VanRequestInputSchema` prerequisites:
  - Valid non-empty phone contact.
  - `guestCount` must be an integer between 10 and 1000.
  - `venueAddress` must be non-empty and at least 3 characters.
  - `eventDate` must be a valid `YYYY-MM-DD` calendar date string.
  - `session.quotation` must be a valid non-null object.
  - If any prerequisite is missing or malformed, the method throws `InvalidOfficialBookingBridgeDataError`.

### 2.5 Distributed Atomicity for Slot Reservations
- **Defect:** `policy.ts` stored reservations in an ephemeral process-local `RESERVED_SCHEDULE_SLOTS` `Map`, which does not synchronize across distributed Cloud Run / container instances.
- **Remediation:** Introduced the durable `schedule_slots` Firestore collection:
  - Document ID: `computeScheduleSlotDocId(eventDate, timeSlot)` -> `${eventDate}___${timeSlot.replace(/:/g, "-")}`.
  - Read inside the transaction read phase: `await transaction.get(slotRef)`.
  - Collision check: if `slotSnap.exists` and `slotSnap.data().bookingId !== vanRequestId`, the transaction aborts with error `invalid_state` (`Resource collision: The date slot ... is already booked`).
  - Committed atomically in the transaction write phase: `transaction.set(slotRef, slotReservationRecord)`.
  - `InMemoryVoiceSessionRepository` mirrors this behavior with an internal `scheduleSlots: Map<string, Record<string, unknown>>` while maintaining policy synchronization.

---

## 3. Verification Test Matrix (15/15 Scenarios)

The test suite `scripts/verify-phase6-3-2-1-hardening.ts` was authored and registered under `"test:p6321"` in `package.json`:

| Scenario | Objective | Status |
| :--- | :--- | :---: |
| **Scenario 1** | Firestore transaction read ordering: `transaction.get()` called after `transaction.set()` throws in simulator | **PASS** |
| **Scenario 2** | Valid approval commits session, `van_requests`, and slot reservation together | **PASS** |
| **Scenario 3** | In-memory repository performs atomic slot reservation without race conditions | **PASS** |
| **Scenario 4** | Fabricated crowd size (`"50 guests"`) is rejected when requirements are missing | **PASS** |
| **Scenario 5** | Fabricated location (`"TBD"`) is rejected when requirements are missing | **PASS** |
| **Scenario 6** | Missing event date fails validation | **PASS** |
| **Scenario 7** | Missing quotation fails validation | **PASS** |
| **Scenario 8** | Official booking ID matching requirement: arbitrary client ID is rejected | **PASS** |
| **Scenario 9** | Mismatched document ID in `van_requests` is rejected | **PASS** |
| **Scenario 10** | Mismatched `voiceSessionId` in `van_requests` is rejected | **PASS** |
| **Scenario 11** | Conflicting ownership/source metadata is rejected | **PASS** |
| **Scenario 12** | Slot conflict in `schedule_slots` prevents approval | **PASS** |
| **Scenario 13** | Failed slot reservation rolls back all writes | **PASS** |
| **Scenario 14** | Manual booking via existing `/api/request-van` continues to work | **PASS** |
| **Scenario 15** | Parity between in-memory and Firestore implementations | **PASS** |

---

## 4. Full Regression Results

All verification suites across the platform continue to pass with zero regressions:

1. **Phase 6.3.2.1 Hardening Suite:** `npm run test:p6321` -> 15/15 scenarios passed.
2. **Phase 6.3.2 Bridge Suite:** `npm run test:p632` -> 15/15 scenarios passed.
3. **Phase 6.3.1.x Suites:**
   - `test:p631` (24/24 passed)
   - `test:p6311` (12/12 passed)
   - `test:p6312` (10/10 passed)
   - `test:p6313` (10/10 passed)
   - `test:p6314` (8/8 passed)
   - `test:p6315` (10/10 passed)
   - `test:p6316` (15/15 passed)
   - `test:p6317` (10/10 passed)
   - `test:p6318` (14/14 passed)
4. **Phase 6.2.x Suites:**
   - `test:p62` (88/88 passed)
   - `test:p621` (45/45 passed)
   - `test:p622` (38/38 passed)
   - `test:p623` (59/59 passed)
   - `test:p624` (58/58 passed)
   - `test:p6241` (14/14 passed)
   - `test:p6242` (28/28 passed)
   - `test:p6243` (18/18 passed)
   - `test:p6244` (15/15 passed)
5. **Master Production CI Suite (`npm test`):** All 19/19 suites passed.
6. **Playwright E2E (`npm run test:e2e`):** All 18/18 tests passed.
7. **TypeScript (`npm run typecheck`):** 0 errors.
8. **ESLint (`npm run lint`):** 0 errors.
9. **Next.js Production Build (`npm run build`):** Compiled standalone binary successfully.

---

## 5. Security & Isolation Compliance

- `VOICE_BOOKING_ENABLED=false` strictly preserved.
- Zero git commits or staging operations (`git add` not invoked).
- No external communications (telephony, WhatsApp, email) executed.
- Cloud Firestore security rules strictly maintained (server-only write boundary).
- Manual van request endpoint `/api/request-van` remains intact and fully functional.
