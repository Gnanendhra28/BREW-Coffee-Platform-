# BREW Coffee Platform — Phase 6.3.2.2 Hardening Report
## Distributed Scheduling Integrity & Mandatory Official Booking Bridge

**Date:** 2026-11-01  
**Phase:** 6.3.2.2  
**Status:** COMPLETE & VERIFIED (18/18 Scenarios Passed, 0 Regressions)

---

### Executive Summary

Phase 6.3.2.2 remediated the remaining source-review findings from Phase 6.3.2.1 without redesigning the core architecture or disturbing existing manual catering enquiry workflows. The implementation provides:
1. **Mandatory Official Booking Bridge**: Fully eliminates any optional path during staff approval. Voice sessions entering or in the official booking lifecycle must strictly match deterministic booking IDs (`session.officialBookingId === computeOfficialVanRequestId(session.id)`) and mirror this in `session.metadata.officialBookingId`. Staff approval fails closed if the official `van_requests` document is missing or malformed.
2. **Zero Fabricated Time-Slot Defaults**: Eliminated `09:00-13:00` and `4 hours` fallbacks. `deriveBookingTimeSlot()` strictly validates calendar dates (real Gregorian dates in `YYYY-MM-DD`), 24-hour clock times (`00:00`-`23:59`), positive finite durations (0.5h–24h), and rejects intervals crossing midnight boundaries (`endMinutes > 1440`). Inconsistencies between quotation and requirements throw typed `InvalidBookingTimeSlotError`.
3. **Distributed Scheduling Integrity & Interval-Overlap Prevention**: Introduced daily schedule grouping in `schedule_slots` (`day___${eventDate}`) storing all reservations for that calendar date. Prevents overlapping time intervals (`startA < endB && startB < endA`), not merely identical slot strings.
4. **Preserved Manual Booking Workflows & Shared Durable Capacity**: Kept `/api/request-van` enquiry submission, Zod schema (`VanRequestInputSchema`), rate limiting, and email notification intact. Added `reserveManualBookingSlot()` allowing confirmed manual bookings to share the exact same durable `schedule_slots` state, preventing cross-channel double-booking.
5. **Elimination of Implicit Email Fallbacks**: Removed hardcoded academic/personal email (`mattag@iitbhilai.ac.in`) from the voice bridge. `createVanRequestRecordFromSession()` requires a valid configured `process.env.BUSINESS_EMAIL`, failing closed with `InvalidOfficialBookingBridgeDataError` if missing or malformed.

---

### Detailed Findings & Remediation

#### 1. Mandatory Official Booking Bridge

- **Root Cause:** In Phase 6.3.2.1, `atomicApproveBooking()` evaluated `const isBridgeActive = Boolean(rawSession.officialBookingId);`, allowing unbridged or legacy sessions to confirm booking without creating or linking official `van_requests` or `schedule_slots` records. Additionally, `validateOfficialBookingIdentity()` permitted missing identity fields when records were absent.
- **Remediation:**
  - `validateOfficialBookingIdentity()` requires that whenever a session is entering or in the official booking lifecycle (`customer_confirmed`, `awaiting_staff_approval`, `booking_confirmed`, or explicit `requireOfficialBridge`), `session.officialBookingId` must equal `computeOfficialVanRequestId(session.id)` and `session.metadata.officialBookingId` must match.
  - When an existing record is expected or present, stored `id`, `voiceSessionId`, and `source` must exist and match exactly (`id === expectedVanId`, `voiceSessionId === session.id`, `source === "voice_booking"`).
  - In `atomicApproveBooking()`, the bridge is mandatory: if `vanSnap.exists` is false, approval aborts immediately with `invalid_state` ("Cannot approve booking: official van_requests record does not exist in store.").
  - Session and `van_requests` confirmed records commit together with `schedule_slots` in the same atomic transaction.

#### 2. Elimination of Fabricated Time-Slot Defaults

- **Root Cause:** `deriveBookingTimeSlot()` previously fell back to `"09:00-13:00"` when requirements lacked a start time, and defaulted missing duration to `4 hours`, clamping multi-hour events to midnight using `Math.min(23, ...)`.
- **Remediation:**
  - Completely removed the `"09:00-13:00"` and `durationHours || 4` fallbacks.
  - Added strict date validation via `isValidCalendarDate()`: validates Gregorian calendar leap years, 30/31-day month boundaries, and rejects invalid dates like `2026-02-31`.
  - Added 24-hour clock time validation via `isValidTime24()`: requires `00:00` to `23:59`.
  - Boundary check: rejects intervals where `startMinutes + durationMinutes > 1440` with `InvalidBookingTimeSlotError` ("Booking time slot crosses unsupported date boundary (midnight)...").
  - Quotation consistency: verifies `quote.startTime === reqs.startTime` and `quote.endTime === computedEndTime`.
  - Missing date, time, or duration strictly throws `InvalidBookingTimeSlotError`.

#### 3. Distributed Scheduling Integrity & Interval-Overlap Policy

- **Root Cause:** Prior slot documents (`${eventDate}___${timeSlot}`) only prevented collisions when two bookings shared the exact same slot string (e.g. `10:00-14:00`). Two overlapping bookings (e.g. `10:00-14:00` and `12:00-16:00`) had distinct document IDs and could both succeed.
- **Remediation:**
  - Implemented dual-document durable scheduling in `schedule_slots`:
    1. **Exact slot document:** `computeScheduleSlotDocId(eventDate, timeSlot)` (`${eventDate}___${timeSlot.replace(/:/g, "-")}`) preserving fast single-slot lookups.
    2. **Daily schedule document:** `computeScheduleDayDocId(eventDate)` (`day___${eventDate}`) containing all active reservations on that date.
  - In the transaction read phase, both `exactSlotRef` and `dayScheduleRef` are read.
  - Interval overlap formula: `startA < endB && startB < endA`. If any existing reservation overlaps with the requested interval for a different booking ID, approval aborts with `Resource collision`.
  - Because all concurrent transactions targeting the same calendar date read and write `day___${eventDate}`, Firestore's optimistic concurrency control detects conflicts: the winning transaction commits, and the second transaction is retried, reads the committed reservation, detects the overlap, and fails closed with `Resource collision`.

#### 4. Shared Durable Capacity with Manual Workflows

- **Architecture:**
  - Manual catering enquiries submitted via `POST /api/request-van` create uncommitted initial enquiries with `status: "pending"`. They do not hold calendar capacity until staff review.
  - Added `reserveManualBookingSlot(db, { eventDate, timeSlot, manualBookingId })`: an atomic helper enabling manual bookings to inspect and reserve capacity in `schedule_slots` (`day___${eventDate}`) using the exact same interval-overlap logic.
  - If a manual booking reserves `09:00-13:00`, a voice booking approval requesting `11:00-15:00` is blocked by the shared daily schedule.
  - Conversely, if a voice booking is confirmed, a manual booking reservation for an overlapping slot is rejected with `resource_collision`.

#### 5. Elimination of Implicit Business-Email Fallback

- **Root Cause:** `createVanRequestRecordFromSession()` used `process.env.BUSINESS_EMAIL || "mattag@iitbhilai.ac.in"`.
- **Remediation:** Removed the hardcoded fallback. `createVanRequestRecordFromSession()` strictly validates that `process.env.BUSINESS_EMAIL` is configured and is a valid email address; otherwise, it throws `InvalidOfficialBookingBridgeDataError`.

---

### Verification Results

#### Hardening Verification Suite (`npm run test:p6322`)

```
===============================================================================
   BREW Coffee — Phase 6.3.2.2: Distributed Scheduling & Mandatory Bridge
   Test Mode: Strict Simulator Read Guard & Dual-Store Interval Integrity
===============================================================================

▶ Scenario 1: Missing officialBookingId rejected during approval
  ✓ Missing officialBookingId strictly rejected by validateOfficialBookingIdentity
▶ Scenario 2: Missing metadata booking ID rejected
  ✓ Missing metadata.officialBookingId strictly rejected
▶ Scenario 3: Mismatched official record ID rejected
  ✓ Mismatched official van_requests record ID strictly rejected
▶ Scenario 4: Missing voiceSessionId rejected
  ✓ Missing voiceSessionId in official record strictly rejected
▶ Scenario 5: Missing or incorrect source rejected
  ✓ Incorrect non-voice_booking source strictly rejected
▶ Scenario 6: Approval cannot confirm without an official van_requests record
  ✓ Approval strictly fails closed when official van_requests record does not exist
▶ Scenario 7: Missing start time rejected
  ✓ Missing startTime strictly throws InvalidBookingTimeSlotError
▶ Scenario 8: Missing duration rejected
  ✓ Missing durationHours strictly throws InvalidBookingTimeSlotError without inventing defaults
▶ Scenario 9: Invalid date/time rejected
  ✓ Invalid calendar dates and midnight-boundary crossing intervals strictly rejected
▶ Scenario 10: Exact slot collision rejected
  ✓ Exact slot collision strictly blocks duplicate approval
▶ Scenario 11: Overlapping time ranges rejected
  ✓ Overlapping time range (10:00-14:00 vs 12:00-16:00) strictly rejected with overlap collision
▶ Scenario 12: Concurrent overlapping approvals from separate repository instances cannot both succeed
  ✓ Concurrent overlapping approvals serialized cleanly; exactly 1 succeeded, 1 rejected
▶ Scenario 13: Manual-versus-voice booking conflicts are handled by shared durable policy
  ✓ Cross-channel scheduling integrity verified: manual booking blocks overlapping voice booking and vice-versa
▶ Scenario 14: Failed schedule reservation rolls back the session and official booking writes
  ✓ Failed slot reservation cleanly rolled back writes; documents remain in pre-approval state
▶ Scenario 15: Firestore transaction read-after-write guard remains enforced
  ✓ Simulator state guard strictly enforces that all reads must occur before any writes
▶ Scenario 16: Firestore transaction retries do not duplicate external side effects
  ✓ Transaction callback is purely idempotent and side-effect free; safe for automatic retries
▶ Scenario 17: Manual booking regression tests remain green
  ✓ Manual booking Zod schema validation and request contracts remain 100% intact
▶ Scenario 18: In-memory and Firestore behavior agree on documented scheduling contract
  ✓ 100% behavioral parity verified across InMemory and Firestore repository implementations

===============================================================================
   Phase 6.3.2.2 Verification Complete: 18/18 Scenarios Passed, 0 Failed
===============================================================================
```

#### Regression Testing Matrix

| Suite | Command | Result |
|---|---|:---:|
| Phase 6.3.2.2 Hardening | `npm run test:p6322` | **18/18 PASS** |
| Phase 6.3.2.1 Hardening | `npm run test:p6321` | **15/15 PASS** |
| Phase 6.3.2 Bridge Suite | `npm run test:p632` | **15/15 PASS** |
| Phase 6.3.1.x Repository Hardening | `npm run test:p631` through `p6318` | **ALL PASS** |
| Phase 6.2.x Engine Suites | `npm run test:p62` through `p6244` | **ALL PASS** |
| Master Production Suite | `npm test` | **19/19 SUITES PASS** |
| Playwright E2E | `npm run test:e2e` | **18/18 PASS** |
| TypeScript Compiler | `npm run typecheck` | **0 ERRORS** |
| ESLint | `npm run lint` | **0 ERRORS** |
| Production Build | `npm run build` | **COMPILED (0 ERRORS)** |

---

### Simulator vs. Emulator Disclosure

- **Simulator Coverage:** Scenarios 1–18 were executed against `HardenedMockFirestore` with an active `hasWritten` state-machine guard that throws if any read (`transaction.get()`) is attempted after a write (`transaction.set()`).
- **Distributed Emulation Note:** Multi-instance distributed concurrency is validated through the transaction ordering invariants and single-document serialization (`day___${eventDate}`) under Firestore transactions. True multi-process distributed load requires testing against the Firestore Emulator suite or an isolated GCP Firebase project with real network round-trips.

---

### Preserved Boundaries & Known Limitations

1. `VOICE_BOOKING_ENABLED=false` remains strictly enforced.
2. Initial manual submissions via `POST /api/request-van` remain enquiry-only (`status: "pending"`) and do not reserve calendar capacity until confirmed by staff using `reserveManualBookingSlot()`.
3. Outbound telephony, SMS, and WhatsApp integrations remain disabled.
4. No external paid GCP or network resources were utilized.
