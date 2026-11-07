# BREW Coffee Platform — Phase 6.3.3.0.1 Architecture Correction
## Communication Outbox Architecture, Atomic Persistence & Delivery Engine Specification

**Execution Timestamp**: 2026-11-02T16:20:00+05:30  
**Phase Target**: Phase 6.3.3.0.1 Architectural Correction (Read-Only)  
**Status**: Architecture Finalized — Ready for Review  
**Safety Status**: Zero Code Changes Applied, `VOICE_BOOKING_ENABLED=false` Strictly Enforced  

---

## 1. Executive Summary & Review Findings Addressed

This architecture correction document addresses the findings from the independent source review of the Phase 6.3.3.0 preflight design.

### Key Corrections Delivered:
1. **Atomic Lifecycle Transition & Outbox Persistence**:
   - Replaced post-commit event generation with a mandatory transactional repository contract where the updated voice booking session and its corresponding communication outbox records are written atomically in the **same transaction**.
   - For `booking_confirmed`, outbox records are committed in the existing atomic staff approval transaction alongside the session, official `van_requests` document, and schedule slot documents.
   - For other transitions (`awaiting_staff_approval`, `customer_declined`, `cancelled`, `human_handoff`), an atomic session-plus-outbox repository contract is established.
2. **Separation of Lifecycle Event vs. Channel Delivery Identity**:
   - Decoupled high-level lifecycle events (`BookingLifecycleEvent`) from individual channel deliveries (`OutboxDeliveryRecord`).
   - If `booking_confirmed` produces both a WhatsApp message and a Voice call, two distinct, independently tracked delivery records are persisted with deterministic IDs.
3. **Atomic Worker Lease & Realistic Distributed Delivery Semantics**:
   - Designed a robust 6-state outbox worker claim contract (`pending`, `processing`, `dispatched`, `blocked`, `failed`, `permanently_failed`) using atomic leases (`claimOwner`, `claimedAt`, `leaseExpiresAt`).
   - Evaluated the provider-accepted/worker-crashed scenario and established deterministic provider idempotency keys.
   - Formally documented that outbox queues guarantee **at-least-once dispatch**, and that end-to-end exactly-once delivery requires downstream provider-side idempotency.
4. **Authoritative Consent & DND Boundary**:
   - Defined the production persistence requirements for durable Firestore consent and DND repositories.
   - Required policy re-evaluation at **dispatch time** (not enqueue time) to respect real-time consent revocations and DND registrations.
   - Identified durable Firestore consent/DND storage as an explicit prerequisite for production dispatch.
5. **PII Minimization**:
   - Removed raw phone numbers from the outbox data model. The outbox retains only `sessionId`, `officialBookingId`, and `phoneNumberMasked`. Canonical contact details are resolved server-side from the session document immediately before dispatch.
6. **Reconciled Event Scope**:
   - Removed `booking_enquiry_received` because it lacks an authoritative lifecycle trigger in the voice booking flow. The scope is finalized to the 5 valid state transitions.

---

## 2. Event Model: Lifecycle Events vs. Channel Deliveries

```
+-------------------------------------------------------------------------+
|                        BookingLifecycleEvent                            |
|  - id: evt_conf_vbs_123_rev3_appr_456                                   |
|  - eventType: booking_confirmed                                         |
|  - sessionId: vbs_123                                                   |
|  - targetRevision: 3                                                    |
|  - triggeredAt: 2026-11-02T16:00:00.000Z                                |
+-------------------------------------------------------------------------+
                                     |
               +---------------------+---------------------+
               |                                           |
               v                                           v
+-----------------------------+             +-----------------------------+
|    OutboxDeliveryRecord     |             |    OutboxDeliveryRecord     |
| - id: del_..._whatsapp      |             | - id: del_..._voice         |
| - channel: whatsapp         |             | - channel: voice            |
| - status: pending           |             | - status: pending           |
| - idempotencyKey: del_...   |             | - idempotencyKey: del_...   |
+-----------------------------+             +-----------------------------+
```

### 2.1 Reconciled Lifecycle Events
The five authoritative booking lifecycle events:
1. `booking_awaiting_staff_approval`: Triggered when customer confirms quotation; held for staff review.
2. `booking_confirmed`: Triggered when staff executes atomic approval in Firestore transaction.
3. `booking_declined`: Triggered when customer rejects quotation.
4. `booking_cancelled`: Triggered when customer or staff explicitly cancels booking.
5. `booking_human_handoff`: Triggered when session escalates to human staff.

*(Note: `booking_enquiry_received` has been removed. In voice booking, gathering requirements is an interactive negotiation. An official enquiry is established only when the customer confirms details, which is covered by `booking_awaiting_staff_approval`).*

### 2.2 Deterministic Identity Generation
All IDs are strictly deterministic functions of stable session fields, preventing duplication across replayed API requests and transaction retries:

| Lifecycle Event Type | Lifecycle Event ID (`eventId`) | Channel Delivery ID (`deliveryId`) |
|---|---|---|
| `booking_awaiting_staff_approval` | `evt_ack_${sessionId}_rev${targetRevision}` | `del_${eventId}_whatsapp` |
| `booking_confirmed` | `evt_conf_${sessionId}_rev${targetRevision}_${staffApprovalId}` | `del_${eventId}_whatsapp`<br>`del_${eventId}_voice` |
| `booking_declined` | `evt_decl_${sessionId}_rev${targetRevision}` | `del_${eventId}_whatsapp` |
| `booking_cancelled` | `evt_canc_${sessionId}_rev${targetRevision}` | `del_${eventId}_whatsapp` |
| `booking_human_handoff` | `evt_hand_${sessionId}_rev${targetRevision}` | `del_${eventId}_whatsapp` |

---

## 3. Atomic Repository Contracts

### 3.1 Mandatory Atomic Session-Plus-Outbox Persistence
To prevent race conditions, orphaned events, or lost notifications, outbox records must be staged and committed inside the exact same database transaction that updates the session.

#### Interface Extension for `VoiceSessionRepository`:
```typescript
export interface AtomicSessionTransitionOptions {
  expectedRevision: number;
  outboxDeliveries?: OutboxDeliveryRecord[];
}

export interface VoiceSessionRepository {
  // Existing methods preserved...
  
  /**
   * Atomically saves session update and stages outbox delivery records in a single transaction.
   * If outboxDeliveries is omitted or empty, updates session alone.
   * Enforces strict read-before-write ordering in Firestore.
   */
  saveWithOutbox(
    session: VoiceBookingSession,
    expectedRevision: number,
    outboxDeliveries?: OutboxDeliveryRecord[]
  ): Promise<void>;

  /**
   * Atomically approves booking and stages confirmed outbox delivery records.
   * Updates session, official van_requests, schedule slots, and outbox in ONE transaction.
   */
  atomicApproveBooking(
    sessionId: string,
    authContext: StaffAuthorizationContext,
    transitionFn: (session: VoiceBookingSession, auth: StaffAuthorizationContext) => VoiceBookingSession,
    outboxDeliveries?: OutboxDeliveryRecord[]
  ): Promise<ApprovalTransactionResult>;
}
```

### 3.2 Firestore Transaction Read/Write Phases
In `FirestoreVoiceSessionRepository`:

```
========================= TRANSACTION BOUNDARY =========================
1. READ PHASE (ALL READS PRECEDING ALL WRITES):
   a. transaction.get(sessionRef)
   b. transaction.get(vanRequestRef)   [if official bridge active]
   c. transaction.get(slotRef)         [if approval]
   d. transaction.get(dayRef)          [if approval]
   e. transaction.get(deliveryRef_i)   [for each staged outbox delivery]

2. VALIDATION & IDENTITY INTEGRITY:
   a. Verify document existence & session revision token (CAS check)
   b. Validate official van_requests identity & quotation HMAC
   c. Validate slot collision & daily interval non-overlap [if approval]
   d. Check if deliveryRef_i already exists (idempotent no-op on re-approval)

3. WRITE PHASE:
   a. transaction.set(sessionRef, serializedSession)
   b. transaction.set(vanRequestRef, confirmedOrPendingVanRequest)
   c. transaction.set(slotRef, slotReservationRecord)         [if approval]
   d. transaction.set(dayRef, dayScheduleRecord)             [if approval]
   e. transaction.set(deliveryRef_i, deliveryRecord_i)        [for each new delivery]
========================================================================
```

### 3.3 Transaction Retry Safety
If concurrent document modification triggers a Firestore transaction retry:
- The entire transaction callback re-executes.
- Reads re-inspect updated document states.
- Because `deliveryId` is derived deterministically from `(sessionId, targetRevision, channel)`, the re-attempt writes to the exact same document ID.
- **Crucially: No external provider is ever called inside this transaction.**

---

## 4. PII-Minimized Outbox Data Model

The outbox document avoids duplicating raw customer phone numbers. PII is minimized:

```typescript
export type OutboxDeliveryStatus =
  | "pending"             // Enqueued by booking transaction, ready for claim
  | "processing"          // Leased by an active worker
  | "dispatched"          // Successfully accepted by external provider (Terminal success)
  | "blocked"             // Policy engine suppressed delivery (DND/Consent/CallingHours) (Terminal)
  | "failed"              // Transient error; eligible for retry if attemptCount < maxAttempts
  | "permanently_failed"; // Exceeded retry budget or unrecoverable error (Terminal failure)

export interface OutboxDeliveryRecord {
  /** Deterministic Delivery ID: del_${eventId}_${channel} */
  id: string;

  /** Stable parent lifecycle event ID */
  eventId: string;

  /** Associated Voice Booking Session ID */
  sessionId: string;

  /** Associated Official Booking ID (enq_voice_${sessionId}) */
  officialBookingId: string;

  /** Communication Channel: "whatsapp" | "voice" */
  channel: CommunicationChannel;

  /** Communication Purpose: "transactional_update" | "voice_booking" */
  purpose: CommunicationPurpose;

  /** Event Type triggering this delivery */
  eventType: BookingCommunicationEventType;

  /** Customer's selected language: "en" | "hi" | "te" */
  language: VoiceLanguage;

  /** Masked phone number for safe diagnostic display (+91******3210) */
  phoneNumberMasked: string;

  /** Monotonic revision of the session when this delivery was generated */
  sessionRevision: number;

  /** Current delivery lifecycle status */
  status: OutboxDeliveryStatus;

  /** Worker claim metadata */
  claimOwner: string | null;
  claimedAt: string | null;      // ISO 8601 UTC
  leaseExpiresAt: string | null; // ISO 8601 UTC

  /** Retry budget & tracking */
  attemptCount: number;
  maxAttempts: number;          // Default: 3
  lastAttemptAt: string | null;  // ISO 8601 UTC

  /** Provider dispatch confirmation */
  dispatchedAt: string | null;   // ISO 8601 UTC
  providerName: string | null;
  providerCallId?: string;       // Voice provider call identifier
  providerMessageId?: string;    // WhatsApp provider message identifier

  /** Policy evaluation snapshot */
  policyResult?: {
    status: PolicyDecisionStatus;
    reason: PolicyReasonCode;
    evaluatedAt: string;
  };

  /** Sanitized error diagnostic (zero PII, zero stack traces) */
  lastError?: {
    message: string;
    code?: string;
    failedAt: string;
    isRetryable: boolean;
  };

  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}
```

---

## 5. Worker Claims, Lease Management & Delivery Semantics

```
                     +-------------+
                     |   pending   |
                     +-------------+
                            |
                     (worker claims)
                            v
                     +-------------+
     +-------------->| processing  |--------------+
     |               +-------------+              |
(lease expires              |                     |
 & retries left)    (provider call)         (policy blocks)
     |                      v                     |
+---------+         +--------------+              v
| failed  |         |  dispatched  |         +---------+
+---------+         +--------------+         | blocked |
     |                                       +---------+
(max attempts
  exceeded)
     v
+--------------------+
| permanently_failed |
+--------------------+
```

### 5.1 Atomic Claim Protocol
A worker claims a delivery record using an atomic Firestore transaction:
1. Query eligibility:
   - `status == "pending"` OR
   - `status == "failed" && attemptCount < maxAttempts` OR
   - `status == "processing" && leaseExpiresAt < nowUtc` (expired lease recovery)
2. In transaction:
   - Read `deliveryRef`.
   - Verify eligibility still holds.
   - Set:
     - `status = "processing"`
     - `claimOwner = workerInstanceId` (e.g. `worker_srv1_pid42_17936142`)
     - `claimedAt = nowUtc`
     - `leaseExpiresAt = nowPlus60SecondsUtc`
     - `attemptCount = attemptCount + 1`
     - `lastAttemptAt = nowUtc`

### 5.2 Dispatch & Policy Re-Evaluation Boundary
After securing the lease, the worker executes dispatch:
1. **Resolve Contact Reference**: Loads `VoiceBookingSession` from repository to obtain raw E.164 phone number.
2. **Authoritative Policy Evaluation**:
   - Calls `orchestrateCommunicationPolicy()` immediately before provider invocation.
   - Evaluates active consent records and active DND scopes as of **current execution time**.
   - If customer revoked consent or registered DND between enqueue and dispatch:
     - Mark delivery `status = "blocked"`, reason = `CONSENT_REVOKED` or `DND_ACTIVE`.
     - Release lease and record policy audit. Zero provider calls made.
3. **Provider Dispatch (Outside DB Transaction)**:
   - Invoke `mockWhatsAppProvider.sendTemplate()` or `mockVoiceProvider.startSession()`.
   - On success: Update Firestore delivery document to `status = "dispatched"`, record `providerMessageId` / `providerCallId`.
   - On transient failure (HTTP 500, timeout, simulated network error):
     - Update to `status = "failed"`, `isRetryable = true`.
     - If `attemptCount >= maxAttempts` (3), transition to `status = "permanently_failed"`.
   - On permanent failure (invalid phone schema, unrecognized template):
     - Update immediately to `status = "permanently_failed"`, `isRetryable = false`.

### 5.3 Distributed Systems Edge Case: Crash After Provider Acceptance
**Scenario**: Worker calls provider -> Provider accepts message -> Worker process crashes before writing `status = "dispatched"` to Firestore.
- When `leaseExpiresAt` elapses, a recovery worker claims the expired lease.
- Because the worker passes the deterministic `deliveryId` as the provider's idempotency key:
  - If the provider supports idempotency (like the mock provider or Meta Graph API with client mutation tokens), it recognizes the duplicate key and returns the existing message ID without sending a duplicate message.
- **Architectural Truth**: An outbox queue guarantees **at-least-once dispatch**. End-to-end exactly-once delivery is impossible without provider-side idempotent deduplication.

---

## 6. Consent & DND Production Persistence Requirements

### 6.1 Status of Existing Repositories
In Phase 6.1, `InMemoryConsentRepository` and `InMemoryDndRepository` were developed for unit testing. In-memory storage is process-local and lost on restart.

### 6.2 Production Requirements for Phase 6.4 (Prerequisites)
Before enabling `VOICE_BOOKING_ENABLED=true` in production:
1. **Durable Firestore Consent Repository (`FirestoreConsentRepository`)**:
   - Collection: `customer_consent_records`
   - Key: `${phoneNumber}___${channel}___${purpose}___${timestamp}`
   - Query: `where("phoneNumber", "==", phone).where("channel", "==", ch).where("purpose", "==", pur).orderBy("timestamp", "desc").limit(1)`
2. **Durable Firestore DND Repository (`FirestoreDndRepository`)**:
   - Collection: `dnd_suppression_records`
   - Key: `${phoneNumber}___${scope}`
3. **Fail-Closed Gate**:
   - If the consent or DND repository returns an error or is unreachable, the outbox worker **must fail closed**. It cannot assume consent exists. The delivery must remain in `failed` status for subsequent retry.
4. **Mock Operation for Phase 6.3.3**:
   - Phase 6.3.3 will use mock providers and test-isolated repository instances. Production Firestore consent/DND deployment remains deferred to Phase 6.4.

---

## 7. Security Specification for Firestore Rules

Add to the server-authoritative section of `firestore.rules`:

```
// Booking Communication Outbox: Server-Authoritative Queue
match /booking_communication_outbox/{deliveryId} {
  allow read, write: if false;
}
```

*Note: Per strict boundaries, no changes will be made to `firestore.rules` during this read-only architectural phase. The rule will be applied during Phase 6.3.3 implementation.*

---

## 8. Summary of Reconciled Design Decisions

| Architectural Area | Original Proposal (Preflight) | Corrected Architecture (Phase 6.3.3.0.1) |
|---|---|---|
| **Outbox Persistence Timing** | Post-commit side-effect hook | **Atomic transaction**: session update + outbox delivery records committed in same transaction. |
| **Delivery Identity** | Single ID per lifecycle event | **Decoupled**: Lifecycle event ID (`eventId`) vs. Channel delivery ID (`deliveryId`). WhatsApp and voice have independent records. |
| **Worker Concurrency** | Basic retry loop | **Atomic lease claim protocol** with `claimOwner`, `claimedAt`, and `leaseExpiresAt`. Expired-lease recovery. |
| **Delivery Guarantee** | "Idempotent delivery" | **At-least-once dispatch** + provider-side deterministic deduplication. |
| **PII in Outbox Records** | Stored raw E.164 phone number | **PII-minimized**: Stored `phoneNumberMasked`, resolved raw phone server-side at dispatch time. |
| **Event Scope** | 6 events including `booking_enquiry_received` | **5 authoritative events**: `booking_enquiry_received` removed as premature. |
| **Consent Evaluation Timing** | At time of booking creation | **At time of dispatch**: re-evaluates active consent and DND immediately before provider call. |
