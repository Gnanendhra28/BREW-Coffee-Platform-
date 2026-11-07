# BREW Coffee Platform — Phase 6.3.3.0.2 Final Contract Corrections
## Outbox Provider Idempotency, Error Classification, Test Boundaries & Transition Coverage

**Execution Timestamp**: 2026-11-02T16:25:00+05:30  
**Phase Target**: Phase 6.3.3.0.2 Final Contract Corrections (Read-Only)  
**Status**: Contract Corrections Finalized — Ready for Review  
**Safety Status**: Zero Application Code Changes Applied, `VOICE_BOOKING_ENABLED=false` Strictly Enforced  

---

## 1. Executive Summary & Review Findings Addressed

This document establishes the final contract corrections for Phase 6.3.3 before implementation:
1. **Additive Provider Idempotency Contract**:
   - Upgrades `VoiceSessionParams` and `WhatsAppTemplateParams` to accept an optional `idempotencyKey?: string`.
   - Requires `MockWhatsAppProvider` and `MockVoiceProvider` to deduplicate repeated calls with the same key, returning the original result without generating extra simulated messages/calls.
   - Requires safe conflict rejection (throwing an error) if a key is reused with materially conflicting parameters.
2. **Distinct Policy Evaluation Outcomes**:
   - Refactors `orchestrateCommunicationPolicy()` to strictly separate **terminal policy blocks** (`CONSENT_MISSING`, `CONSENT_REVOKED`, `DND_ACTIVE`, `OUTSIDE_CALLING_HOURS`, `INVALID_PHONE_NUMBER`, `FEATURE_DISABLED`) from **retryable infrastructure failures** (database timeout, repository unavailable, data integrity corruption).
   - Eliminates the previous defect where transient repository errors were mapped to `REPOSITORY_INTEGRITY_MISMATCH` with `status: "blocked"`, which permanently aborted retries.
3. **Feature Flag & Mock-Only Test Boundaries**:
   - Enforces that `VOICE_BOOKING_ENABLED=false` remains strictly active in production.
   - Confines flag overrides to test harness options (`checkFeatureFlag: false`), with zero exposure via HTTP query parameters, headers, or client bodies.
4. **Authoritative Channel & Purpose Matrix**:
   - Formally maps each lifecycle event to its exact `(channel, purpose)` tuple. All booking status updates use `purpose = "transactional_update"`.
   - Reaffirms that voice consent never satisfies WhatsApp, WhatsApp consent never satisfies voice, and marketing consent never satisfies transactional updates.
5. **Exhaustive Lifecycle Transition Coverage**:
   - Audits all four production code locations in `conversationEngine.ts` and `firestoreSessionRepository.ts` where sessions are saved.
   - Enforces that every communication-producing state transition uses atomic session-plus-outbox persistence (`saveWithOutbox` or `atomicApproveBooking`).

---

## 2. Provider-Side Mock Idempotency Contract

### 2.1 Interface Additions (`src/lib/communication/types.ts`)
The provider parameter interfaces are extended additively:

```typescript
export interface VoiceSessionParams {
  sessionId: string;
  phoneNumber: string;
  language: VoiceLanguage;
  enquiryId?: string;
  idempotencyKey?: string; // Additive delivery idempotency key (deliveryId)
  metadata?: Record<string, unknown>;
}

export interface WhatsAppTemplateParams {
  to: string; // E.164
  templateName: string;
  language: string;
  components: WhatsAppTemplateComponent[];
  enquiryId?: string;
  idempotencyKey?: string; // Additive delivery idempotency key (deliveryId)
  metadata?: Record<string, unknown>;
}
```

### 2.2 Mock Provider Deduplication & Conflict Semantics
Both `MockWhatsAppProvider` and `MockVoiceProvider` must implement an internal idempotency cache:

```typescript
interface IdempotencyEntry<TParams, TResult> {
  params: TParams;
  result: TResult;
  recordedAt: string;
}
```

#### Processing Rules:
1. **Idempotency Key Check**:
   - When `sendTemplate(params)` or `startSession(params)` is invoked, check if `params.idempotencyKey` exists in `idempotencyStore`.
2. **Identical Replay**:
   - If `idempotencyKey` is present and incoming parameters match the stored parameters:
     - Return the cached `result` immediately.
     - **Do not** add an entry to `dispatchedMessages` or `activeSessions`.
     - **Do not** increment message or call counters.
3. **Payload Mismatch Conflict**:
   - If `idempotencyKey` is present but incoming parameters differ materially (e.g. different recipient phone number, different template name, or different language):
     - **Fail closed**: throw `new Error("Idempotency conflict: key '${params.idempotencyKey}' already used with different payload.")`.
     - Never silently return an unrelated result.
4. **Deterministic Failure Injection**:
   - If `simulateFailure` is active:
     - Failure occurs on the initial call before any result is stored.
     - The idempotency entry is only stored upon successful execution.

---

## 3. Policy Evaluation: Terminal Block vs. Retryable Infrastructure Error

### 3.1 Outcome Classification
The return contract of `orchestrateCommunicationPolicy()` must distinguish policy decisions from infrastructure errors:

```typescript
export type PolicyEvaluationOutcome =
  | {
      status: "allowed";
      reason: "ALLOWED";
      details: string;
      channel: CommunicationChannel;
      purpose: CommunicationPurpose;
      phoneNumberMasked: string;
      evaluatedAt: string;
    }
  | {
      status: "blocked";
      reason:
        | "CONSENT_MISSING"
        | "CONSENT_REVOKED"
        | "DND_ACTIVE"
        | "OUTSIDE_CALLING_HOURS"
        | "INVALID_PHONE_NUMBER"
        | "FEATURE_DISABLED";
      details: string;
      channel: CommunicationChannel;
      purpose: CommunicationPurpose;
      phoneNumberMasked: string;
      evaluatedAt: string;
    }
  | {
      status: "error";
      reason: "INFRASTRUCTURE_FAILURE";
      details: string;
      isRetryable: true;
      channel: CommunicationChannel;
      purpose: CommunicationPurpose;
      phoneNumberMasked: string;
      evaluatedAt: string;
    };
```

### 3.2 Handling by Outbox Worker
- **Terminal Block (`status: "blocked"`)**:
  - Outbox document is updated to `status = "blocked"` with `policyResult`.
  - The delivery is terminal; no further attempts are scheduled.
  - A genuinely absent consent record (`hasActiveConsent === false`) is a terminal policy block (`CONSENT_MISSING`), **not** an error.
- **Retryable Infrastructure Error (`status: "error"`)**:
  - If `dndRepository` or `consentRepository` throws an unhandled exception (database network timeout, Firestore outage) or returns phone mismatch corruption:
    - Return `status: "error"`, `reason: "INFRASTRUCTURE_FAILURE"`, `isRetryable: true`.
  - Outbox document is updated to `status = "failed"`, `attemptCount = attemptCount + 1`, and `lastError = { message, isRetryable: true }`.
  - If `attemptCount < maxAttempts` (3), the worker leaves the delivery eligible for subsequent retry.
  - If `attemptCount >= maxAttempts`, the worker marks it `status = "permanently_failed"`.

---

## 4. Feature Flag & Mock Execution Boundary

1. **Strict Production Enforcement**:
   - `VOICE_BOOKING_ENABLED=false` remains enforced.
   - Any production dispatch worker invoking `orchestrateCommunicationPolicy()` without test options will be blocked with `status: "blocked", reason: "FEATURE_DISABLED"`.
2. **Test Boundary Isolation**:
   - Tests may inject `{ checkFeatureFlag: false }` into the worker options to test mock provider dispatch.
   - No HTTP query parameter, header, or client body is permitted to disable the feature flag check.
3. **Simulation Labeling**:
   - All results from `MockVoiceProvider` and `MockWhatsAppProvider` have `isSimulated: true` and `providerMode: "mock"`.
   - Real telephony carrier adapters or Meta WhatsApp Cloud API credentials remain strictly prohibited.

---

## 5. Channel and Purpose Mapping

All booking lifecycle notifications represent transactional updates. Marketing messages are strictly prohibited.

| Event Type | Channel | Purpose | Required Consent Tuple | DND Scope | Calling Hours Window |
|---|---|---|---|---|---|
| `booking_awaiting_staff_approval` | `whatsapp` | `transactional_update` | `(phone, "whatsapp", "transactional_update")` | `whatsapp` or `all` | None |
| `booking_confirmed` | `whatsapp` | `transactional_update` | `(phone, "whatsapp", "transactional_update")` | `whatsapp` or `all` | None |
| `booking_confirmed` | `voice` | `transactional_update` | `(phone, "voice", "transactional_update")` | `voice` or `all` | 09:00–20:00 IST |
| `booking_declined` | `whatsapp` | `transactional_update` | `(phone, "whatsapp", "transactional_update")` | `whatsapp` or `all` | None |
| `booking_cancelled` | `whatsapp` | `transactional_update` | `(phone, "whatsapp", "transactional_update")` | `whatsapp` or `all` | None |
| `booking_human_handoff` | `whatsapp` | `transactional_update` | `(phone, "whatsapp", "transactional_update")` | `whatsapp` or `all` | None |

#### Independence Rules:
- Voice consent **never** satisfies WhatsApp delivery.
- WhatsApp consent **never** satisfies Voice delivery.
- Marketing consent (`purpose: "marketing"`) **never** satisfies transactional updates.
- If `booking_confirmed` triggers both WhatsApp and Voice, each channel delivery document is evaluated independently against its own tuple. If Voice is blocked by calling hours, WhatsApp still dispatches.

---

## 6. Complete Lifecycle Transition Coverage (Phase 6.3.3 Target Contract)

> [!IMPORTANT]
> **Source State vs Target Architecture**: In the current codebase, lines 488, 523, and 769 of `conversationEngine.ts` still call `repository.save()`. The transition to `repository.saveWithOutbox()` and atomic outbox writes in `atomicApproveBooking()` represents the required target contract to be implemented in Phase 6.3.3. See [PHASE_6_3_3_0_3_SOURCE_CONTRACT_RECONCILIATION.md](file:///Users/gnanendhrajoy/Desktop/BREW/docs/PHASE_6_3_3_0_3_SOURCE_CONTRACT_RECONCILIATION.md) for the exhaustive source reconciliation.

During Phase 6.3.3 implementation, every production location where session state changes to a communication-producing state must be refactored to use the atomic session-plus-outbox repository operation:

### 6.1 `src/lib/voiceBooking/conversationEngine.ts`
1. **Immediate Cancellation Fast-Path (L470–489)**:
   - State becomes `"cancelled"`.
   - Construct `booking_cancelled` delivery record.
   - Call `await repository.saveWithOutbox(validated, initialRevision, [cancelledDelivery])`.
   - Ordinary `save()` is strictly prohibited here.
2. **Immediate Human Handoff Fast-Path (L505–525)**:
   - State becomes `"human_handoff"`.
   - Construct `booking_human_handoff` delivery record.
   - Call `await repository.saveWithOutbox(validated, initialRevision, [handoffDelivery])`.
   - Ordinary `save()` is strictly prohibited here.
3. **Turn Completion Transition (L767–770)**:
   - If `finalSession.state` is `"awaiting_staff_approval"`, `"customer_declined"`, `"cancelled"`, or `"human_handoff"`:
     - Construct corresponding delivery record.
     - Call `await repository.saveWithOutbox(finalSession, initialRevision, [deliveryRecord])`.
   - Ordinary `save()` is ONLY permitted for non-communication intermediate turns (`collecting_requirements`, `details_collected`, `quotation_presented`).

### 6.2 `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts`
4. **Staff Approval (`atomicApproveBooking`)**:
   - Construct `booking_confirmed` delivery records (WhatsApp and/or Voice).
   - In transaction read phase: Read delivery refs.
   - In transaction write phase:
     ```typescript
     transaction.set(sessionRef, serializedApprovedSession);
     transaction.set(vanRequestRef, confirmedVanRequest);
     transaction.set(slotRef, slotReservationRecord);
     transaction.set(dayRef, dayScheduleRecord);
     for (const delivery of outboxDeliveries) {
       transaction.set(db.collection(OUTBOX_COLLECTION).doc(delivery.id), delivery);
     }
     ```
   - All writes commit together atomically.

---

## 7. Remaining Production Prerequisites (Deferred to Phase 6.4)

1. **Durable Firestore Consent Repository (`FirestoreConsentRepository`)**:
   - Backed by `customer_consent_records` collection.
2. **Durable Firestore DND Repository (`FirestoreDndRepository`)**:
   - Backed by `dnd_suppression_records` collection.
3. **Outbox Collection Rule**:
   - Add `match /booking_communication_outbox/{deliveryId} { allow read, write: if false; }` to `firestore.rules`.
4. **Phase 6.3.3 Execution Boundary**:
   - Phase 6.3.3 implementation will use mock providers, simulated Firestore instances, and test seams. Live production telephony and Meta Graph API integrations remain strictly deferred.
