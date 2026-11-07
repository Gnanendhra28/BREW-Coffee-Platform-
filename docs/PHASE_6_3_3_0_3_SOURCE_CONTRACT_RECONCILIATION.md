# BREW Coffee Platform — Phase 6.3.3.0.3 Source-to-Contract Reconciliation
## Truthful Audit of Current Source State vs. Phase 6.3.3 Implementation Target

**Execution Timestamp**: 2026-11-02T16:30:00+05:30  
**Phase Target**: Phase 6.3.3.0.3 Documentation-Only Source Reconciliation  
**Document Status**: Final — Ready for Independent Review  
**Safety & Scope Boundary**: Strict Documentation Only; Exactly 0 Application Files Modified in `src/`; `VOICE_BOOKING_ENABLED=false` Enforced; Zero Telephony/WhatsApp Provider Invocations  

---

## 1. Executive Summary & Review Motivation

Following the independent review of Phase 6.3.3.0.2, this document provides an exhaustive, unambiguous reconciliation between:
1. **Current Implementation**: The exact, lines-of-code reality of the code in the repository today.
2. **Phase 6.3.3 Target**: The approved architectural contracts and implementation deliverables that must be authored during Phase 6.3.3.

**Key Reconciliation Finding**:  
The previous contract document described atomic session-plus-outbox persistence as a mandatory pattern, but the current source code still executes ordinary `repository.save()` at lines 488, 523, and 769 of `src/lib/voiceBooking/conversationEngine.ts`, and does not yet persist outbox records in `firestoreSessionRepository.ts` or `sessionRepository.ts`.

This document explicitly catalogues these existing gaps as **Phase 6.3.3 Implementation Deliverables**, verifies runtime validation rules for provider idempotency, formalizes error taxonomy in the policy engine, specifies the private test-boundary mechanism for feature flags, and establishes clean boundaries for the upcoming implementation phase.

---

## 2. Source-to-Target Architecture Reconciliation

| File & Location | Current Implementation (Today) | Phase 6.3.3 Target Contract (Deliverable) |
|---|---|---|
| `src/lib/voiceBooking/conversationEngine.ts:488` | **Calls ordinary `repository.save(validated, initialRevision)`** on cancellation fast-path. No outbox delivery record is created or passed. | Must construct a `booking_cancelled` delivery record and call `await repository.saveWithOutbox(validated, initialRevision, [cancelledDelivery])`. `save()` is barred here. |
| `src/lib/voiceBooking/conversationEngine.ts:523` | **Calls ordinary `repository.save(validated, initialRevision)`** on human-handoff fast-path. No outbox delivery record is created or passed. | Must construct a `booking_human_handoff` delivery record and call `await repository.saveWithOutbox(validated, initialRevision, [handoffDelivery])`. `save()` is barred here. |
| `src/lib/voiceBooking/conversationEngine.ts:769` | **Calls ordinary `repository.save(finalSession, initialRevision)`** regardless of whether `finalSession.state` entered a communication-triggering state (`awaiting_staff_approval`, `customer_declined`, etc.). | Must evaluate `finalSession.state`. If communication-triggering, construct outbox delivery record(s) and call `await repository.saveWithOutbox(finalSession, initialRevision, [deliveryRecord])`. `save()` is permitted **only** for intermediate states (`collecting_requirements`, `details_collected`, `quotation_presented`). |
| `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts:876-880` | **`atomicApproveBooking()` writes 4 documents**: `docRef` (session), `vanRequestRef`, `slotRef`, `dayRef`. It **does not** read or write any outbox delivery records. | Must extend the Firestore transaction to accept or derive `booking_confirmed` outbox delivery records. Inside transaction write phase: iterate `outboxDeliveries` and perform `transaction.set(db.collection("booking_communication_outbox").doc(d.id), d)`. All 5+ writes must commit atomically. |
| `src/lib/voiceBooking/repositories/sessionRepository.ts` | **`InMemoryVoiceSessionRepository` only manages `this.sessions` map**. Does not implement `saveWithOutbox()` or store outbox records in `atomicApproveBooking()`. | Must add `private outbox: Map<string, CommunicationDeliveryRecord>` and implement `saveWithOutbox()` with optimistic concurrency checks and atomic outbox insertion. `atomicApproveBooking()` must also atomically write to `this.outbox`. |
| `src/lib/voiceBooking/types.ts:358-374` | **`VoiceSessionRepository` interface only declares**: `getById`, `save`, `getByPhoneNumber`, `atomicApproveBooking`, and optional `getOfficialBooking`. | Must declare `saveWithOutbox(session: VoiceBookingSession, expectedRevision: number, outboxDeliveries: CommunicationDeliveryRecord[]): Promise<void>`. |

### Summary of Source Audit
> [!IMPORTANT]
> The supplied source does **NOT** yet implement `saveWithOutbox()`, outbox events, or atomic staff approval outbox persistence. These are future implementation requirements for Phase 6.3.3.

---

## 3. Complete Provider Idempotency Contract

### 3.1 Four Mandatory Code Locations for Additive `idempotencyKey`

To ensure provider-side deduplication operates end-to-end and survives runtime validation, Phase 6.3.3 must update all 4 locations in `src/lib/communication/`:

1. **`src/lib/communication/types.ts` (`VoiceSessionParams`)**:
   ```typescript
   export interface VoiceSessionParams {
     sessionId: string;
     phoneNumber: string;
     language: VoiceLanguage;
     enquiryId?: string;
     idempotencyKey?: string; // Additive: deliveryId for provider deduplication
     metadata?: Record<string, unknown>;
   }
   ```
2. **`src/lib/communication/types.ts` (`WhatsAppTemplateParams`)**:
   ```typescript
   export interface WhatsAppTemplateParams {
     to: string; // E.164
     templateName: string;
     language: string;
     components: WhatsAppTemplateComponent[];
     enquiryId?: string;
     idempotencyKey?: string; // Additive: deliveryId for provider deduplication
     metadata?: Record<string, unknown>;
   }
   ```
3. **`src/lib/communication/schemas.ts` (`VoiceSessionParamsSchema`)**:
   ```typescript
   export const VoiceSessionParamsSchema = z.object({
     sessionId: z.string().min(5),
     phoneNumber: PhoneNumberSchema,
     language: VoiceLanguageSchema,
     enquiryId: z.string().optional(),
     idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
     metadata: z.record(z.string(), z.unknown()).optional(),
   });
   ```
4. **`src/lib/communication/schemas.ts` (`WhatsAppTemplateParamsSchema`)**:
   ```typescript
   export const WhatsAppTemplateParamsSchema = z.object({
     to: PhoneNumberSchema,
     templateName: z.string().min(3),
     language: z.string().min(2),
     components: z.array(WhatsAppTemplateComponentSchema).default([]),
     enquiryId: z.string().optional(),
     idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
     metadata: z.record(z.string(), z.unknown()).optional(),
   });
   ```

### 3.2 Runtime Idempotency Semantics in Mock Providers

`MockWhatsAppProvider` and `MockVoiceProvider` currently maintain only a simple array (`dispatchedMessages` or `activeSessions`) and instantiate randomized IDs on every call. In Phase 6.3.3, each mock provider will maintain an in-memory cache:

```typescript
interface IdempotencyCacheEntry<TParams, TResult> {
  payloadHash: string;
  result: TResult;
  recordedAt: string;
}
```

#### Rules of Operation:
1. **Payload Fingerprinting**:
   - The provider computes a deterministic canonical fingerprint of the incoming request parameters (excluding metadata timestamps):
     - For WhatsApp: `hash(to + ":" + templateName + ":" + language + ":" + JSON.stringify(components))`
     - For Voice: `hash(sessionId + ":" + phoneNumber + ":" + language)`
2. **Identical Replay (Safe Deduplication)**:
   - If `idempotencyKey` is present and matches an existing cache entry with an **identical payload hash**:
     - The provider returns the cached `result` directly.
     - **No new message or call is appended** to `dispatchedMessages` or `activeSessions`.
     - Counters/metrics are **not** incremented.
3. **Conflicting Payload Replay (Fail Closed)**:
   - If `idempotencyKey` matches an existing entry but the payload hash **differs**:
     - The provider must **throw an explicit conflict exception**:
       `new Error("ProviderIdempotencyConflictError: Idempotency key '${params.idempotencyKey}' already used with conflicting payload.")`.
     - It must **never** overwrite the existing record or return mismatched delivery status.
4. **Deterministic Failure Injection**:
   - If failure simulation is activated (`simulateFailure: true`):
     - The failure triggers **before** any entry is cached in the idempotency store.
     - Subsequent retries with the same `idempotencyKey` will execute normally and cache their result once successful.

> [!NOTE]
> The current provider implementations (`src/lib/communication/providers/voiceProvider.ts` and `src/lib/communication/providers/whatsappProvider.ts`) do **NOT** yet implement this cache or accept `idempotencyKey`. This is a Phase 6.3.3 deliverable.

---

## 4. Policy Result Types Reconciliation

### 4.1 Comparison of Current Types vs. Phase 6.3.3 Target

#### Current Implementation (`src/lib/communication/types.ts` & `policy.ts`):
```typescript
// CURRENT
export type PolicyDecisionStatus = "allowed" | "blocked" | "requires_review";

export type PolicyReasonCode =
  | "FEATURE_DISABLED"
  | "INVALID_PHONE_NUMBER"
  | "DND_ACTIVE"
  | "CONSENT_MISSING"
  | "CONSENT_REVOKED"
  | "MARKETING_CONSENT_REQUIRED"
  | "OUTSIDE_CALLING_HOURS"
  | "REPOSITORY_INTEGRITY_MISMATCH"
  | "ALLOWED";

export interface PolicyEvaluationResult {
  status: PolicyDecisionStatus;
  reason: PolicyReasonCode;
  details: string;
  evaluatedAt: string;
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  phoneNumberMasked: string;
}
```

**Defect in Current Implementation**:
In `src/lib/communication/policy.ts` (lines 266–275 and 296–305), any exception thrown by `dndRepository` or `consentRepository` is caught and returned as:
```typescript
return {
  status: "blocked",
  reason: "REPOSITORY_INTEGRITY_MISMATCH",
  details: `Failed to retrieve DND records from repository: ${err instanceof Error ? err.message : String(err)}`,
  // ...
};
```
Because the status is `"blocked"`, an outbox processor cannot distinguish an authoritative refusal (e.g. customer opted out) from a transient Firestore network timeout. Consequently, a temporary database glitch would cause the outbox worker to permanently abandon retrying a customer update.

#### Phase 6.3.3 Target Outcome Contract:
```typescript
// TARGET
export type PolicyEvaluationOutcome =
  | {
      status: "allowed";
      reason: "ALLOWED";
      details: string;
      evaluatedAt: string;
      channel: CommunicationChannel;
      purpose: CommunicationPurpose;
      phoneNumberMasked: string;
    }
  | {
      status: "blocked";
      reason:
        | "CONSENT_MISSING"
        | "CONSENT_REVOKED"
        | "MARKETING_CONSENT_REQUIRED"
        | "DND_ACTIVE"
        | "OUTSIDE_CALLING_HOURS"
        | "INVALID_PHONE_NUMBER"
        | "FEATURE_DISABLED";
      details: string;
      evaluatedAt: string;
      channel: CommunicationChannel;
      purpose: CommunicationPurpose;
      phoneNumberMasked: string;
    }
  | {
      status: "error";
      reason: "INFRASTRUCTURE_FAILURE";
      details: string;
      isRetryable: true;
      evaluatedAt: string;
      channel: CommunicationChannel;
      purpose: CommunicationPurpose;
      phoneNumberMasked: string;
    };
```

### 4.2 Detailed Classification Taxonomy

1. **Genuinely Absent Consent Records (`hasActiveConsent === false`)**:
   - Status: `"blocked"`.
   - Reason: `"CONSENT_MISSING"`.
   - Semantics: Terminal policy refusal. Customer has not given consent. The outbox delivery is marked `"blocked"` and will not be retried.
2. **Repository Exceptions (Firestore Timeout, Network Reset, RPC Abort)**:
   - Status: `"error"`.
   - Reason: `"INFRASTRUCTURE_FAILURE"`.
   - `isRetryable`: `true`.
   - Semantics: Transient failure. The outbox delivery remains in `"failed"` state with incremented `attemptCount`. If `attemptCount < maxAttempts` (3), it will be retried in the next worker cycle with exponential backoff.
3. **Repository Phone-Identity Mismatches & Authoritative Corruption**:
   - Status: `"error"`.
   - Reason: `"INFRASTRUCTURE_FAILURE"`.
   - `isRetryable`: `true` (fails closed, triggers alert / quarantine if persistent).
   - Semantics: Internal data store corruption or misrouted query response. Must not be treated as a lawful consent denial.
4. **Error Sanitization & Security Hygiene**:
   - When constructing `details` for `status: "error"`, raw system error strings (`err.message`), stack traces, unmasked phone numbers, database connection strings, and credential secrets **must never be persisted** into the outbox delivery or audit records.
   - Example sanitized detail: `"Communication policy check encountered an internal repository infrastructure error during DND evaluation."`

---

## 5. Test-Only Feature Flag Boundary

### 5.1 Current Implementation vs. Target Injection

#### Current State:
In `src/lib/communication/policy.ts`:
```typescript
export interface PolicyEvaluationOptions {
  checkFeatureFlag?: boolean; // Defaults to true
}
```
Functions `evaluateCommunicationPolicy` and `orchestrateCommunicationPolicy` accept `options?: PolicyEvaluationOptions`.

#### Target Worker Boundary:
1. **Production Worker Execution**:
   - Outbox processing workers in production instantiate and run without test options.
   - Because `VOICE_BOOKING_ENABLED` is `false` in production environment configs, `isVoiceBookingEnabled()` returns `false`.
   - Policy evaluation returns `status: "blocked", reason: "FEATURE_DISABLED"`.
2. **Test-Only Harness Injection**:
   - Test suites (e.g. `tests/communicationOutbox.spec.ts`) pass `{ checkFeatureFlag: false }` directly into the worker constructor / options during test setup.
3. **Zero Public Bypass Exposure**:
   - No HTTP query parameter (`?skipFlag=true`), HTTP request header (`X-Bypass-Feature-Flag`), API request body field, or client-side JavaScript parameter shall ever be parsed or passed to `checkFeatureFlag`.
   - The override is strictly confined to in-process test fixtures.

---

## 6. Outbox Implementation Prerequisites (Gaps Catalogue)

To ensure complete transparency and prevent premature claims of compliance, the following components are catalogued as **unimplemented in current source** and are designated as **Phase 6.3.3 implementation deliverables**:

1. **Outbox Event & Delivery Schemas**:
   - Data models for `CommunicationOutboxRecord`, `CommunicationDeliveryRecord`, `DeliveryStatus`, and transition audit events.
2. **Firestore Outbox Collection & Operations**:
   - Implementation of outbox document storage under `booking_communication_outbox`.
3. **In-Memory Outbox Parity**:
   - Implementation of `this.outbox` storage in `InMemoryVoiceSessionRepository` for local testing.
4. **Atomic `saveWithOutbox()` in Repositories**:
   - Implementation of combined session and outbox persistence in both Firestore and in-memory repositories.
5. **Atomic Staff-Approval Outbox Writes**:
   - Inclusion of outbox delivery document sets inside the Firestore `atomicApproveBooking()` transaction.
6. **Worker Claims, Leases, Retries & Lease Recovery**:
   - Background worker loop that queries pending outbox deliveries, leases them with TTL, dispatches via mock providers, and updates statuses.
7. **Dispatch-Time Consent/DND Evaluation**:
   - Execution of `orchestrateCommunicationPolicy()` at the exact moment of delivery dispatch.
8. **Provider-Side Mock Idempotency**:
   - Cache implementation, fingerprinting, and replay logic in `MockWhatsAppProvider` and `MockVoiceProvider`.

---

## 7. Verification, Safety & Deliverables

### 7.1 Code & Repository Health
- **Modified files in `src/`**: Exactly **0 files**.
- **Modified Firestore security rules or indexes**: Exactly **0 files**.
- **TypeScript compilation (`npm run typecheck`)**: Passed with **0 errors**.
- **Linting (`npm run lint`)**: Passed with **0 errors**.
- **Working Tree**: Main branch clean, no staging (`git add`), no commits.

### 7.2 Review Archive
The review bundle [`phase6_3_3_0_3_review_bundle.zip`](file:///Users/gnanendhrajoy/Desktop/BREW/phase6_3_3_0_3_review_bundle.zip) has been compiled containing:
- `docs/PHASE_6_3_3_0_3_SOURCE_CONTRACT_RECONCILIATION.md`
- `docs/PHASE_6_3_3_0_2_FINAL_CONTRACT_CORRECTIONS.md`
- `docs/PHASE_6_3_3_0_1_ARCHITECTURE_CORRECTION.md`
- `docs/PHASE_6_3_3_0_COMMUNICATION_PREFLIGHT.md`
- Exact source code references in `src/lib/communication/`, `src/lib/voiceBooking/`, and the approval route.
