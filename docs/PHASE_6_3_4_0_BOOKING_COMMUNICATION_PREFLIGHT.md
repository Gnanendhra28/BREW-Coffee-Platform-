# Phase 6.3.4.0 — Automatic Booking Communication Integration Preflight
## Preflight Investigation & Additive Architectural Integration Plan

**Document ID:** `PHASE_6_3_4_0_BOOKING_COMMUNICATION_PREFLIGHT`  
**Phase:** 6.3.4.0 (Preflight & Architecture Investigation)  
**Date:** November 2, 2026  
**Status:** READY FOR REVIEW  

---

## 1. Investigation Answers with Exact Source References

### 1. Where is a new booking request persisted?
- **Cloud Firestore (Authoritative):**
  - Collection: `van_requests` (`src/lib/voiceBooking/vanRequestBridge.ts:20`)
  - Document Path: `van_requests/{requestId}` where `requestId = enq_${payloadFingerprint.slice(0, 32)}` (`src/app/api/request-van/route.ts:438, 469`)
  - Transaction Write: Inside `adminDb.runTransaction()` at `src/app/api/request-van/route.ts:472-479`.
- **Local Filesystem Fallback (Non-Production Only):**
  - Path: `src/data/van_requests.json` (`src/app/api/request-van/route.ts:544-550`)
  - Only active when Firebase Admin is unavailable and `process.env.ALLOW_LOCAL_FALLBACK === "true"`.

---

### 2. What is the safest point to enqueue a communication event?
- **The Safest Point:** Inside the existing Firestore transaction at `src/app/api/request-van/route.ts:472-479`.
- **Why:** In this transaction, `transaction.get(docRef)` checks if the enquiry document already exists. If `snap.exists` is false, `transaction.set()` persists the new enquiry. Enqueueing the `booking_awaiting_staff_approval` delivery record to `booking_communication_outbox` inside this same transaction guarantees that the outbox event is only written if the booking itself is durably committed.

---

### 3. Can the booking persistence and outbox event be written atomically using the existing Firestore transaction?
- **Yes.** Firestore transactions support atomic multi-document writes across multiple collections (`van_requests`, `voice_booking_sessions`, and `booking_communication_outbox`).
- **Transaction Flow:**
  1. `docRef = adminDb.collection("van_requests").doc(requestId)`
  2. `sessionRef = adminDb.collection("voice_booking_sessions").doc(sessionId)`
  3. `outboxRef = adminDb.collection("booking_communication_outbox").doc(deliveryId)`
  4. Reads: `await transaction.get(docRef)`, `await transaction.get(sessionRef)`, `await transaction.get(outboxRef)`
  5. If `snap.exists`: return existing booking without mutating outbox.
  6. Writes:
     - `transaction.set(docRef, requestRecord)`
     - `transaction.set(sessionRef, sessionRecord)`
     - `transaction.set(outboxRef, deliveryRecord)`
  All document reads precede all writes, strictly honoring Firestore's read-before-write transaction contract.

---

### 4. How will a duplicate booking submission avoid duplicate communication?
- **Tier 1 (Payload Fingerprint & In-Flight Lock):**
  `src/app/api/request-van/route.ts:149-197`: Computes canonical SHA-256 fingerprint from `contact`, `organization`, `location`, `eventDate`, and `crowdSize`. If a request is already `pending` or `completed` in `idempotencyStore`, the duplicate is rejected or returned immediately.
- **Tier 2 (Transaction Existence Check):**
  `src/app/api/request-van/route.ts:473-476`: `snap = await transaction.get(docRef)`. If `snap.exists`, the transaction returns `{ exists: true, data: snap.data() }` and **skips** creating outbox delivery records.
- **Tier 3 (Deterministic Outbox Document Key):**
  `src/lib/communication/outbox/outboxModel.ts:34-39`: Delivery ID is deterministic: `del_{eventId}_{channel}`. Even if a write is replayed, Firestore `.set()` on the same document key prevents duplicate document creation.
- **Tier 4 (Provider-Side Idempotency):**
  `src/lib/communication/outbox/outboxWorker.ts:327, 357`: Worker passes `idempotencyKey: delivery.id` to provider. `MockWhatsAppProvider` and `MockVoiceProvider` cache fingerprints and return cached responses on repeat invocations (`src/lib/communication/providers/whatsappProvider.ts:47-55`).

---

### 5. How is the customer's phone number resolved without storing an unmasked number in the outbox?
- **Outbox Storage (Masked Only):**
  `src/lib/communication/types.ts:319` and `src/lib/communication/outbox/outboxModel.ts:87, 117` store only `phoneNumberMasked: maskPhoneNumber(phone)` (e.g. `+91 98765 *****`) in the `booking_communication_outbox` document. The raw phone number is **never** written to the outbox collection.
- **Worker Dynamic Resolution:**
  `src/lib/communication/outbox/outboxWorker.ts:198-220`: When processing a claimed delivery, `OutboxWorker` reads `delivery.sessionId` and calls:
  `const session = await this.dependencies.sessionRepository.getById(delivery.sessionId);`
  The raw phone number is resolved dynamically from the authoritative voice booking session at the moment of dispatch.

---

### 6. How are voice and WhatsApp consent checked independently?
- **Strict Channel Separation in Domain Model:**
  `src/lib/communication/types.ts:14-16` defines channels as `"whatsapp" | "voice"` and purposes as `"transactional_update" | "marketing"`.
- **Channel-Scoped Consent Queries:**
  `src/lib/communication/consent.ts:40-60` (`hasActiveConsent`) filters consent events strictly by `record.channel === channel && record.purpose === purpose`. WhatsApp transactional consent grants do not satisfy voice calls, and voice consent grants do not satisfy WhatsApp messages.
- **Channel-Scoped DND Rules:**
  `src/lib/communication/dnd.ts:28-45` (`isChannelBlockedByDndScopes`) evaluates whether active DND scopes match `"all"` or the specific `channel`.
- **Calling-Hour Restrictions (Voice Only):**
  `src/lib/communication/policy.ts:187-200` restricts voice calls to `09:00 - 20:00 IST` (`isWithinCallingHours`), whereas WhatsApp messages are not subjected to voice calling-hour cutoffs.

---

### 7. What happens if consent storage is unavailable?
- **Policy Engine Fail-Closed Error:**
  `src/lib/communication/policy.ts:295-309`: If `consentRepository.findByPhone()` throws an exception, `orchestrateCommunicationPolicy()` catches it and returns:
  `{ status: "error", reason: "INFRASTRUCTURE_FAILURE", isRetryable: true }`.
- **Worker Handling & Provider Protection:**
  `src/lib/communication/outbox/outboxWorker.ts:280-294`: When policy status is `"error"`, the worker does **not** invoke the provider.
- **Retry Scheduling:**
  `src/lib/communication/outbox/outboxWorker.ts:410-450`: The worker calls `handleFailure()` which:
  1. Increments `attemptCount`.
  2. Computes exponential backoff: `nextRetryAt = now + (backoffBaseMs * 2^(attempt - 1))`.
  3. Sets `status: "failed"`.
  4. Releases the lease (`claimOwner: null`, `claimToken: null`, `leaseExpiresAt: null`).
  Zero messages or calls are dispatched while consent storage is degraded.

---

### 8. How does the worker get triggered automatically after an event is persisted?
- **Dual Trigger Strategy:**
  1. **Immediate In-Process Wakeup (Low Latency):**
     Immediately after the Firestore transaction successfully commits in `POST /api/request-van`, the route handler triggers a non-blocking worker execution:
     ```typescript
     // Non-blocking background cycle
     outboxWorker.processCycle().catch((err) => {
       console.error("Non-fatal: post-enquiry outbox processing error:", err);
     });
     ```
     Because this runs asynchronously after the transaction commit, failures in the worker do not fail the HTTP request or delay the customer's response.
  2. **Durable Periodic Poller / Cron (Resilience):**
     A background interval or cloud cron endpoint (`/api/cron/process-outbox`) triggers `outboxWorker.processCycle()` periodically (e.g. every 1-5 minutes).

---

### 9. What happens when the worker is unavailable or the application instance sleeps?
- **Persistence Guarantees Safety:**
  The delivery record is already durably committed to `booking_communication_outbox` with `status: "pending"`.
- **Recovery on Startup:**
  When the application starts, wakes up, or scales up, the next call to `outboxWorker.processCycle()` executes `claimEligibleDeliveries()`.
  `src/lib/communication/outbox/outboxRepository.ts:82-91` queries all records where `status === "pending"`. The pending deliveries are immediately claimed and processed.
- No events are lost across process restarts, deployments, or serverless cold starts.

---

### 10. How will retries and expired leases recover pending communication?
- **Expired Lease Recovery:**
  `src/lib/communication/outbox/outboxRepository.ts:87-90`: If a worker crashed or experienced a network partition while holding a claim, its lease expires when `record.leaseExpiresAt <= nowTime`. Any active worker can reclaim the delivery, incrementing `attemptCount` and assigning a new unique `claimToken`.
- **Retryable Failure Recovery:**
  `src/lib/communication/outbox/outboxRepository.ts:83-86`: Deliveries with `status === "failed"` whose `attemptCount < maxAttempts` (3) and whose `nextRetryAt <= nowTime` are eligible for reclamation.
- **Poison Pill Quarantine:**
  Deliveries that reach `maxAttempts` (3) transition to `status: "permanently_failed"` (`src/lib/communication/outbox/outboxWorker.ts:180-195`) and are excluded from future claim cycles.

---

### 11. How will a voice booking session be created and associated with the original booking request?
- **Canonical ID Derivation:**
  `src/lib/voiceBooking/vanRequestBridge.ts:38-46` specifies the relationship:
  `vanRequestId = computeOfficialVanRequestId(voiceSessionId)` (`enq_voice_${voiceSessionId}`).
  Conversely, for a web enquiry created via `POST /api/request-van`:
  `vanRequestId = requestId` (`enq_${hash}`).
  `sessionId = vbs_${requestId}`.
- **Session Record Attributes:**
  A `VoiceBookingSession` record is constructed with:
  - `id`: `vbs_${requestId}`
  - `phoneNumber`: Customer's normalized E.164 phone number
  - `language`: `"en"` (or detected preference)
  - `state`: `"awaiting_staff_approval"`
  - `requirements`: Structured requirements mapped from `eventDate`, `crowdSize`, `location`, `organization`
  - `quotation`: AI instant quotation generated via `generateEventQuotation()`
  - `quotationSnapshot`: Frozen snapshot of material requirement fields
  - `officialBookingId`: `requestId`
  - `revision`: 1
- **Cross-Referencing:**
  The `van_requests` document stores `voiceSessionId: sessionId`, and the `voice_booking_sessions` document stores `officialBookingId: requestId`.

---

### 12. How can the existing booking and staff approval flows remain unchanged?
- **Web Booking Flow (`/api/request-van`):**
  Request body schema (`VanRequestInputSchema`), validation, pricing engine (`generateEventQuotation`), SMTP notification, and response JSON structure remain completely identical. The outbox persistence is added directly into the existing Firestore transaction.
- **Staff Approval Flow (`/api/voice-booking/approve`):**
  The approval route (`src/app/api/voice-booking/approve/route.ts`) calls `approveBookingByStaff()`. In `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts:830-1045`, `atomicApproveBooking` **already**:
  1. Validates staff authorization and state (`awaiting_staff_approval`).
  2. Updates `van_requests` record to `"confirmed"`.
  3. Updates `schedule_slots` and daily schedule documents.
  4. Generates and atomically writes `booking_confirmed` outbox delivery records for WhatsApp and Voice.
  **Conclusion:** The staff approval flow is already fully implemented and requires zero breaking changes.

---

## 2. Minimal Additive Implementation Proposal

### Files Required to Change
1. `src/app/api/request-van/route.ts`:
   - Import `createOutboxDeliveriesForTransition` from `src/lib/communication`.
   - In `adminDb.runTransaction()`:
     - Check if customer contact is an E.164 phone number.
     - If phone number is valid, generate linked `VoiceBookingSession` in `awaiting_staff_approval` state and associated outbox deliveries.
     - Perform all `transaction.get()` operations (van request, session, outbox).
     - If not exists, perform `transaction.set()` for van request, session, and outbox delivery.
   - Post-commit: trigger asynchronous, non-blocking `processOutboxCycle()`.
2. `src/lib/voiceBooking/sessionBridge.ts` (or helper in `vanRequestBridge.ts`):
   - Helper function `createVoiceSessionFromVanRequest(vanRequest)` to reliably construct a valid `VoiceBookingSession` from incoming catering enquiry data without code duplication.

### Event Types & IDs
- **Event Type:** `booking_awaiting_staff_approval`
- **Channel:** `whatsapp`
- **Event ID:** `evt_booking_awaiting_staff_approval_vbs_${requestId}_r1`
- **Delivery ID:** `del_evt_booking_awaiting_staff_approval_vbs_${requestId}_r1_whatsapp`

### Safety & Guardrails
- If contact is an email (not a phone number), email dispatch is handled by existing SMTP; outbox telephony/WhatsApp delivery is bypassed cleanly.
- `VOICE_BOOKING_ENABLED=false` ensures that in production environments, outbox worker cycles record `policyResult.reason = "FEATURE_DISABLED"` without making outbound calls until approved in Phase 6.4.
- All unit and integration tests use `MockWhatsAppProvider` and `MockVoiceProvider`.
