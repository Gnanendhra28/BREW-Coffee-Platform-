# BREW Coffee Platform — Phase 6.6.1.1 Implementation Report
## Voice Initiation Idempotency & Safe Recovery Review

**Date**: November 6, 2026  
**Status**: Completed & Verified  
**Branch**: `main` (Working Tree Only; Zero Commits / Staging)

---

### Executive Summary

In **Phase 6.6.1.1**, we inspected the end-to-end outbox-to-carrier initiation flow, identified critical edge cases surrounding network timeouts, worker crashes, and concurrent claims, and implemented robust idempotency and safe recovery controls.

The primary objective was to **strictly prevent duplicate outbound phone calls to customers**. When calling external telephony APIs (e.g. Exotel, PSTN gateways), network connections may drop or time out *after* the carrier has already received the request and started dialing the customer. In this phase, we added durable initiation state tracking (`in_flight`, `accepted`, `uncertain`, `rejected`), blocked automated redials on uncertain outcomes, enforced atomic `providerCallId` uniqueness, and preserved conflicting terminal events for reconciliation without corrupting authoritative call history.

---

### Failure Scenarios & Duplicate Call Prevention Mechanics

```mermaid
flowchart TD
    A["Outbox Worker Claims Delivery"] --> B["Check Existing Attempt Record"]
    B -->|initiationState == 'accepted'| C["Already Accepted by Carrier<br/>Complete Delivery as 'dispatched'<br/>DO NOT REDIAL"]
    B -->|initiationState == 'uncertain'| D["Outcome Uncertain (Timeout/Crash)<br/>Quarantine Delivery (status: permanently_failed)<br/>DO NOT REDIAL (Wait for Webhook)"]
    B -->|initiationState == 'in_flight' && Lease Active| E["Another Worker In-Flight<br/>Abort Duplicate Dispatch"]
    B -->|New Attempt / No In-Flight Conflict| F["Create/Mark Attempt 'in_flight'<br/>Attach claimOwner & leaseExpiresAt"]
    F --> G["Dispatch Carrier API Request<br/>(startSession)"]
    G -->|Carrier Returns 200 OK with providerCallId| H["markInitiationAccepted<br/>Attach providerCallId atomically<br/>Complete Delivery 'dispatched'"]
    G -->|Network Timeout / Drop (Outcome Uncertain)| I["markInitiationUncertain<br/>Quarantine Delivery<br/>Set staffFollowUpRequired: true<br/>BLOCK AUTOMATED REDIAL"]
    G -->|Definitive Rejection (4xx / Invalid Number)| J["markInitiationRejected<br/>Mark status 'failed'<br/>Safe Retry or Permanent Failure"]
```

#### 1. Timeout-After-Acceptance / Lost Response (Uncertainty & No Redial)
- **Failure Scenario**: The worker dispatches an outbound call request to the carrier API. The carrier accepts the request and begins dialing the customer on the PSTN. However, the application network socket drops, resets (`ECONNRESET`), or times out (`ETIMEDOUT` / `AbortError` after 10s) before receiving the HTTP response headers.
- **Vulnerability**: If the worker merely treats this as a retryable error and another worker reclaims the delivery, a second API call would dial the customer a second time, resulting in annoying and non-compliant duplicate phone calls.
- **Prevention**:
  - When a timeout or network error occurs during `voiceProvider.startSession`, the attempt is immediately marked `initiationState: "uncertain"` with reason `"PROVIDER_TIMEOUT"`.
  - The outbox delivery is updated to `status: "permanently_failed"` with `nextRetryAt: null` and `isRetryable: false`.
  - Session metadata records `callAttemptStatus: "uncertain"` and flags `staffFollowUpRequired: true`.
  - Subsequent worker cycles skip the delivery. **Automated redial is strictly blocked.**

#### 2. Worker Crash Mid-Flight & Recovery Without Redialing
- **Failure Scenario**: Worker A creates the attempt record in `in_flight`, dispatches the carrier request, and receives HTTP 200 with `providerCallId`. However, before Worker A can update the outbox delivery or release its claim lease, the Node.js process crashes (e.g. SIGTERM/OOM on Render).
- **Prevention**:
  - Worker A previously recorded `initiationState: "accepted"` or attached `providerCallId` via atomic transaction.
  - When Worker A's lease expires (after 60 seconds), Worker B reclaims the delivery.
  - Worker B checks the attempt record and finds `initiationState: "accepted"` with `providerCallId`.
  - Worker B marks the outbox delivery as `dispatched` using the existing carrier call ID and releases the claim **without making another provider API call**.

#### 3. Concurrent Worker Protection & Initiation Lease Fencing
- **Failure Scenario**: Due to delayed network execution, Worker A's delivery lease is close to expiring while Worker A is still in-flight. Worker B reclaims the delivery.
- **Prevention**:
  - The attempt record in `voice_call_attempts` tracks `initiationState: "in_flight"`, `claimOwner`, and `leaseExpiresAt`.
  - When Worker B inspects the attempt, it detects that Worker A is actively in-flight under an unexpired initiation lease.
  - Worker B immediately aborts dispatch (`stale_claim_lost`) to prevent overlapping carrier calls.

#### 4. Provider Call ID Uniqueness & Atomic Collision Rejection
- **Failure Scenario**: A carrier bug, malicious payload, or synthetic simulation attempts to map an already-assigned `providerCallId` to a different internal attempt record.
- **Prevention**:
  - In `FirestoreVoiceCallAttemptRepository.attachProviderCallId` and `createAttempt`, the atomic transaction performs a mandatory read on `voice_call_provider_mappings/<providerCallId>`.
  - If a mapping already exists pointing to a different `attemptId`, the transaction immediately aborts with `Provider call ID conflict: '<providerCallId>' is already mapped to attempt '<existingId>'. Duplicate providerCallIds are forbidden.`
  - In `InMemoryVoiceCallAttemptRepository`, a reverse lookup map enforces the identical uniqueness constraint.

#### 5. Terminal State Conflict Preservation for Reconciliation
- **Failure Scenario**: A call completed successfully after 4 minutes (`completed`, `durationSeconds: 240`). A delayed or duplicate carrier webhook subsequently arrives claiming the call was `busy` or `failed`.
- **Prevention**:
  - The monotonic rank evaluator (`evaluateStatusUpdate`) flags this as `terminal_conflict`.
  - The authoritative primary status (`completed`) and duration (240s) are **preserved and never overwritten**.
  - Rather than silently dropping the conflicting event, the conflict is structured as a `TerminalConflictRecord` (`conflictingStatus`, `receivedAt`, `reason`) and persisted on the attempt record in `attempt.terminalConflict` for staff auditing and reconciliation.

#### 6. Webhook Recovery from Uncertain State
- **Recovery Flow**: If an attempt was marked `initiationState: "uncertain"` due to an API timeout, but the carrier actually placed the call, the carrier eventually sends an asynchronous status webhook (`ringing` or `answered`).
- **Resolution**:
  - When the carrier webhook arrives with `providerCallId`, `attachProviderCallId` links the provider ID to the attempt and transitions `initiationState` from `"uncertain"` to `"accepted"`.
  - Subsequent webhooks advance the attempt forward (`ringing` $\to$ `answered` $\to$ `completed`), seamlessly recovering the uncertain attempt.

---

### Exact Source Code Changes

1. **`src/lib/communication/voice/types.ts`**:
   - Added `VoiceCallInitiationState` (`pending` | `in_flight` | `accepted` | `uncertain` | `rejected`).
   - Added `TerminalConflictRecord` interface.
   - Extended `VoiceCallAttemptRecord` with `initiationState`, `claimOwner`, `claimToken`, `leaseExpiresAt`, `uncertainAt`, `uncertainReason`, and `terminalConflict`.
   - Extended `CreateVoiceCallAttemptParams` to include initiation ownership fields.
   - Added `markInitiationAccepted`, `markInitiationUncertain`, and `markInitiationRejected` to `VoiceCallAttemptRepository`.

2. **`src/lib/communication/voice/schemas.ts`**:
   - Added `VoiceCallInitiationStateSchema` and `TerminalConflictRecordSchema`.
   - Updated `VoiceCallAttemptRecordSchema` and `CreateVoiceCallAttemptParamsSchema`.

3. **`src/lib/communication/voice/callAttemptRepository.ts`**:
   - `evaluateStatusUpdate`: Constructs and attaches `terminalConflict` on the attempt record when conflicting terminal events arrive.
   - `InMemoryVoiceCallAttemptRepository`:
     - Added strict `providerCallId` collision checks in `createAttempt` and `attachProviderCallId`.
     - Implemented `markInitiationAccepted`, `markInitiationUncertain`, and `markInitiationRejected`.
     - Persists attempt when `outcome === "terminal_conflict"`.
   - `FirestoreVoiceCallAttemptRepository`:
     - Added atomic transaction read-then-write on `voice_call_provider_mappings` to reject duplicate provider call IDs.
     - Implemented `markInitiationAccepted`, `markInitiationUncertain`, and `markInitiationRejected`.
     - Persists `terminalConflict` inside transaction on conflict events.

4. **`src/lib/communication/outbox/outboxWorker.ts`**:
   - Before invoking provider API: checks existing attempt state. If `accepted`, completes outbox delivery immediately without calling carrier. If `uncertain`, blocks redial and marks delivery `permanently_failed`. If `in_flight` by another worker, aborts dispatch.
   - Marks attempt `in_flight` with claim ownership before carrier call.
   - Wraps `voiceProvider.startSession` in try/catch: on timeout or network error, marks attempt `uncertain`, updates delivery to `permanently_failed` with `nextRetryAt: null`, and flags `staffFollowUpRequired: true`.
   - On successful response, marks initiation `accepted`.

---

### Verification Suite & Test Results

A dedicated verification suite was created in `scripts/verify-phase6-6-1-1-voice-initiation-idempotency.ts` (`npm run test:p6611`):

| Check | Test Description | Result | Details |
|---|---|---|---|
| **1.1** | Network Timeout & Uncertainty | **PASSED** | API timeout marks attempt `uncertain`, delivery `permanently_failed`; subsequent worker cycle skips delivery with 0 redial attempts |
| **2.1** | Worker Crash Recovery | **PASSED** | Worker crashes after carrier acceptance; recovering worker reclaims delivery and marks `dispatched` using existing providerCallId without redialing |
| **3.1** | Concurrent Worker Protection | **PASSED** | Second worker detects active in-flight initiation lease and aborts; 0 duplicate calls dispatched |
| **4.1** | ProviderCallId Collision (In-Memory) | **PASSED** | Second attempt attempting to map existing `providerCallId` throws conflict error |
| **4.2** | ProviderCallId Collision (Firestore) | **PASSED** | Atomic transaction checks mapping doc and rejects duplicate provider call IDs |
| **5.1** | Terminal Conflict Preservation | **PASSED** | Completed attempt receives delayed `failed` event; primary status preserved and conflict recorded in `terminalConflict` |
| **6.1** | Webhook Recovery | **PASSED** | Uncertain attempt is recovered by incoming carrier status webhook, transitioning to `accepted` and advancing to `answered` |

**Verification Score**: 7/7 checks passed (100% SUCCESS).

#### Full Platform Regression Suite
```bash
npm run test:p6611  # 7/7 passed (SUCCESS)
npm run test:p661   # 10/10 passed (SUCCESS)
npm run test:p655   # 8/8 passed (SUCCESS)
npm run test:p654   # 5/5 passed (SUCCESS)
npm run test:p653   # 6/6 passed (SUCCESS)
npm run test:p652   # 11/11 passed (SUCCESS)
npm run test:p651   # 9/9 passed (SUCCESS)
npm run test:p65    # 23/23 passed (SUCCESS)
npm run test:p635   # 18/18 passed (SUCCESS)
npm run test:p6342  # 24/24 passed (SUCCESS)
npm run typecheck   # 0 errors
npm run lint        # 0 errors / 0 warnings in platform code
```

---

### Invariants & Zero-Cost Constraints

1. **Feature Flag**: `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
2. **Zero Paid Infrastructure**: No Exotel, Azure, Twilio, or live carrier accounts or billing activated.
3. **Quotation Integrity**: HMAC-SHA256 signature using `BREW_QUOTATION_SECRET` strictly preserved.
4. **Git Hygiene**: Clean working directory; zero files staged, committed, or pushed (`git status`).
