# BREW Coffee Platform — Phase 6.3.3.0 Preflight Investigation
## Booking Communication Lifecycle Integration — Architectural Preflight & Outbox Design

**Execution Timestamp**: 2026-11-02T16:05:00+05:30 (Revised 2026-11-02T16:20:00+05:30 via Phase 6.3.3.0.1)  
**Phase Target**: Phase 6.3.3.0 Preflight Investigation (Read-Only)  
**Status**: Investigation Complete — Preflight Revised & Reconciled  
**Safety Status**: Zero Code Changes Applied, `VOICE_BOOKING_ENABLED=false` Strictly Enforced  
**Reference**: See [PHASE_6_3_3_0_1_ARCHITECTURE_CORRECTION.md](file:///Users/gnanendhrajoy/Desktop/BREW/docs/PHASE_6_3_3_0_1_ARCHITECTURE_CORRECTION.md) for full formal specification.

---

## 1. Executive Summary

This preflight investigation examines the integration of the BREW voice booking lifecycle with the Phase 6.1 communication foundation.

The goal is to design an additive, mock-first communication event pipeline where voice booking lifecycle transitions (customer confirmation, staff approval, cancellation, decline, and human handoff) create durable, policy-validated communication events for the customer without:
1. Making real external calls (WhatsApp Meta Graph API or PSTN voice calls).
2. Performing provider calls inside database transaction callbacks.
3. Leaking customer PII into diagnostic audit records or outbox documents.
4. Sending premature booking-confirmed notices before authoritative staff approval.
5. Incurring duplicate dispatches across transaction retries or replayed requests.

---

## 2. Existing Communication Interfaces & Provider Contracts

### 2.1 Communication Channels & Purposes (`src/lib/communication/types.ts`)
- **Channels**:
  - `"voice"`: Automated voice call notifications.
  - `"whatsapp"`: Template-based WhatsApp messages.
- **Purposes**:
  - `"voice_booking"`: Voice-initiated catering booking flows.
  - `"transactional_update"`: Post-approval booking status updates, schedule confirmations, or cancellation receipts.
  - `"marketing"`: Strictly unbundled marketing messages (prohibited in voice booking flows).

### 2.2 Provider Contracts & Mock Implementations
- **Voice Provider Interface (`VoiceProvider`)**:
  - `startSession(params: VoiceSessionParams): Promise<VoiceSessionResult>`
  - `getStatus(sessionId: string): Promise<VoiceSessionStatusResult>`
  - `endSession(sessionId: string, reason?: string): Promise<VoiceSessionEndResult>`
  - Implementation: `MockVoiceProvider` (`src/lib/communication/providers/voiceProvider.ts`)
    - Uses deterministic simulated statuses: `simulated_initiated`, `simulated_ringing`, `simulated_in_progress`, `simulated_completed`, `simulated_failed`.
    - Supports test-controlled failure injection via `setSimulateFailure()`.
    - Zero real network or telephony calls.
- **WhatsApp Provider Interface (`WhatsAppProvider`)**:
  - `sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult>`
  - `getMessageStatus(messageId: string): Promise<WhatsAppMessageStatusResult>`
  - Implementation: `MockWhatsAppProvider` (`src/lib/communication/providers/whatsappProvider.ts`)
    - Uses deterministic simulated statuses: `simulated_accepted`, `simulated_sent`, `simulated_delivered`, `simulated_read`, `simulated_failed`.
    - Validates components against `WhatsAppTemplateParamsSchema`.
    - Supports test-controlled failure injection via `setSimulateFailure()`.
    - Zero real Meta Graph API calls.

---

## 3. Existing Consent and DND Enforcement

### 3.1 Unbundled Consent Model (`src/lib/communication/consent.ts`)
- **Rule of Independence**: Voice consent does **not** imply or grant WhatsApp consent; WhatsApp consent does **not** imply or grant Voice consent.
- **Consent Event Model (`ConsentRecord`)**:
  - Explicit grant/revocation event history keyed by `(phoneNumber, channel, purpose)`.
  - Timestamped in strict ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).
  - Active consent is evaluated by taking the latest chronological record for that tuple (`hasActiveConsent()`).
  - Revocations immediately invalidate active consent.

### 3.2 Multi-Scope Do-Not-Contact Suppression (`src/lib/communication/dnd.ts`)
- **Scopes**:
  - `"all"`: Suppresses all outbound communication across all channels.
  - `"voice"`: Suppresses voice communication only.
  - `"whatsapp"`: Suppresses WhatsApp communication only.
- **Privacy Hardening**:
  - Diagnostic DND audit events (`DndAuditEvent`) log only masked phone numbers (`maskPhoneNumber()`, e.g. `+91******3210`).
  - Raw phone numbers are never stored in diagnostic logs.

### 3.3 Communication Policy Engine (`src/lib/communication/policy.ts`)
- Evaluates communication requests in a strict hierarchy:
  1. **Feature Flag**: `isVoiceBookingEnabled()` / `process.env.VOICE_BOOKING_ENABLED === "true"`. (Blocked with `FEATURE_DISABLED` if false).
  2. **Phone Normalization**: Canonical E.164 validation via `normalizePhoneNumber()`.
  3. **DND Suppression**: Evaluates active scopes; blocks with `DND_ACTIVE` if channel is suppressed.
  4. **Consent Verification**: Evaluates active grant record; blocks with `CONSENT_MISSING` or `CONSENT_REVOKED` if missing or revoked.
  5. **Calling Hours**: Restricts voice calls to `09:00 - 20:00 IST` (`Asia/Kolkata` timezone).
- The policy evaluation is purely functional (`evaluateCommunicationPolicy`) and separates policy determination from provider dispatch.

---

## 4. Booking Lifecycle Events & Authoritative Transition Points

The voice booking engine enforces a 13-state lifecycle (`VoiceBookingState`). The table below maps state transitions to their authoritative triggers and identifies appropriate customer communication events:

| Transition / State | Authoritative Location | Description | Appropriate Communication Event | Default Channel |
|---|---|---|---|---|
| Customer Confirms Quote -> `awaiting_staff_approval` | `processConversationTurn()` in `src/lib/voiceBooking/conversationEngine.ts` (L679–688) | Customer accepts quotation; session held for staff review. Official `van_requests` created as `pending`. | `booking_awaiting_staff_approval` | `whatsapp` |
| Staff Approves Booking -> `booking_confirmed` | `FirestoreVoiceSessionRepository.atomicApproveBooking()` & `approveBookingByStaff()` (L851–923) | Staff executes atomic approval in Firestore transaction. `van_requests` becomes `confirmed`, slot reserved. | `booking_confirmed` | `whatsapp` (primary) + optional `voice` |
| Customer Declines Quote -> `customer_declined` | `processConversationTurn()` (L692) | Customer rejects quotation; no staff action needed. | `booking_declined` | `whatsapp` |
| Customer Cancels Booking -> `cancelled` | `processConversationTurn()` (L476) | Customer requests explicit cancellation at any stage. | `booking_cancelled` | `whatsapp` |
| Human Handoff Triggered -> `human_handoff` | `processConversationTurn()` (L528) | High frustration, repeated misunderstanding, or explicit request for human staff. | `booking_human_handoff` | `whatsapp` |
| Staff Approval Rejected / Collides | `atomicApproveBooking()` transaction error return | Overlapping slot collision or validation failure; transaction rolls back. | *No communication dispatched* (Staff handles resolution; customer not told booking is confirmed). | None |

> [!NOTE]
> **Event Reconciliation**: In the initial draft, `booking_enquiry_received` was proposed. Review identified that in voice booking, requirements gathering is an interactive dialogue; an official enquiry exists only when the customer confirms details. `booking_enquiry_received` has been removed to avoid duplicate or premature notifications.

> [!IMPORTANT]
> **Premature Confirmation Prevention**: A customer confirmation turn (`awaiting_customer_confirmation` -> `awaiting_staff_approval`) must **NEVER** dispatch a `booking_confirmed` message. It may only dispatch `booking_awaiting_staff_approval` (acknowledging receipt of request). The final `booking_confirmed` notification is strictly gated upon successful commit of `atomicApproveBooking()`.

---

## 5. Durable Outbox, Atomic Persistence & Identity Separation

### 5.1 Separation of Lifecycle Identity vs. Channel Delivery Identity
A high-level lifecycle transition (`BookingLifecycleEvent`) must be separated from individual channel delivery attempts (`OutboxDeliveryRecord`):
- **Lifecycle Event ID**: `evt_${type}_${sessionId}_rev${targetRevision}`
- **Channel Delivery ID**: `del_${lifecycleEventId}_${channel}`
If `booking_confirmed` produces both WhatsApp and Voice notifications, two independent delivery documents are persisted in `booking_communication_outbox` with separate claim leases and audit trails.

### 5.2 Atomic Transaction Boundary
Outbox delivery records are **never** written as an asynchronous side effect after a transaction. They are written **atomically inside the exact same database transaction** that updates the session:
1. **Approval Transaction**: In `atomicApproveBooking()`, the session, official `van_requests` record, schedule slots, and outbox delivery records commit together.
2. **Turn Transitions**: In `saveWithOutbox()`, session state updates and outbox deliveries commit together.
3. **Transaction Retries**: Retries in Firestore only re-run the transactional writes. Because delivery IDs are deterministic, no duplicate records are generated.
4. **Provider Isolation**: External mock providers are **never** called inside transaction callbacks.

### 5.3 Outbox Worker Claim Protocol & At-Least-Once Semantics
An independent worker process dispatches deliveries:
1. **6-State Lifecycle**: `pending` -> `processing` -> `dispatched` | `blocked` | `failed` | `permanently_failed`.
2. **Atomic Lease**: Worker claims a record with `claimOwner`, `claimedAt`, and `leaseExpiresAt` (e.g. 60 seconds). Expired leases are recovered if `attemptCount < maxAttempts`.
3. **Policy Re-Evaluation at Dispatch Time**: Active consent and DND are evaluated immediately prior to calling the provider to honor real-time opt-outs.
4. **At-Least-Once Disclosure**: The outbox pattern guarantees **at-least-once dispatch**. To achieve end-to-end exactly-once delivery, downstream providers must support client-provided idempotency keys using `deliveryId`.

---

## 6. Privacy & PII Minimization

1. **Zero Raw Contact Information in Outbox**:
   - Outbox documents do not store raw phone numbers.
   - Documents store `sessionId`, `officialBookingId`, and `phoneNumberMasked` (+91******3210).
   - The worker resolves the raw phone number from the session document in-memory at dispatch time and immediately discards it.
2. **Zero Secrets or Stack Traces**:
   - Error messages stored in `lastError` are sanitized strings without stack traces or authentication headers.

---

## 7. Architectural Gaps & Mitigation Plan

| Identified Gap | Analysis | Mitigation in Phase 6.3.3 |
|---|---|---|
| **Firestore Outbox Collection Rules** | `firestore.rules` currently does not list `booking_communication_outbox`. Client access must be denied. | Specification: `match /booking_communication_outbox/{deliveryId} { allow read, write: if false; }`. (Applied during implementation). |
| **Consent & DND Storage in Tests** | Phase 6.1 provided `InMemoryConsentRepository` and `InMemoryDndRepository`. In multi-instance or Firestore testing, policy checks need consistent records. | Maintain clean repository interfaces; inject consent and DND repositories into the outbox dispatcher for testing all consent, DND, and calling-hour branches. |
| **Transaction Retry Safety** | Re-running transaction callbacks must not produce multiple outbox records. | Using deterministic document IDs (`del_${eventId}_${channel}`) ensures `transaction.set()` is idempotent within the database. |
| **Independent In-Memory Repository Parity** | `InMemoryVoiceSessionRepository` must provide matching outbox behavior for local testing. | Implement in-memory outbox tracking in `InMemoryVoiceSessionRepository` mirroring the Firestore outbox contract. |

---

## 8. Data Models

```typescript
export type BookingCommunicationEventType =
  | "booking_awaiting_staff_approval"
  | "booking_confirmed"
  | "booking_declined"
  | "booking_cancelled"
  | "booking_human_handoff";

export type OutboxDeliveryStatus =
  | "pending"
  | "processing"
  | "dispatched"
  | "blocked"
  | "failed"
  | "permanently_failed";

export interface OutboxDeliveryRecord {
  id: string; // del_${eventId}_${channel}
  eventId: string;
  sessionId: string;
  officialBookingId: string;
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  eventType: BookingCommunicationEventType;
  language: VoiceLanguage;
  phoneNumberMasked: string; // +91******3210
  sessionRevision: number;
  status: OutboxDeliveryStatus;
  claimOwner: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  dispatchedAt: string | null;
  providerName: string | null;
  providerCallId?: string;
  providerMessageId?: string;
  policyResult?: {
    status: PolicyDecisionStatus;
    reason: PolicyReasonCode;
    evaluatedAt: string;
  };
  lastError?: {
    message: string;
    code?: string;
    failedAt: string;
    isRetryable: boolean;
  };
  createdAt: string;
  updatedAt: string;
}
```

---

## 9. Next Steps for Implementation (Pending User Approval)

Upon approval of this revised preflight document and architecture correction:
1. Define typed event models and schemas in `src/lib/communication/bookingEvents.ts`.
2. Implement durable communication outbox repository with atomic transaction integration in `FirestoreVoiceSessionRepository` and `InMemoryVoiceSessionRepository`.
3. Add `saveWithOutbox()` and update `atomicApproveBooking()` to commit outbox delivery records atomically.
4. Implement outbox worker claim and dispatch protocol with dispatch-time policy orchestration.
5. Create comprehensive test suite `scripts/verify-phase6-3-3-communication.ts` covering all 15 required scenarios.
6. Author implementation report `docs/PHASE_6_3_3_IMPLEMENTATION_REPORT.md` and package review bundle.
