# BREW Coffee Platform — Phase 6.6.1 Implementation Report
## Durable Voice Call Attempt Foundation & Asynchronous Lifecycle

**Date**: November 6, 2026  
**Status**: Completed & Verified  
**Branch**: `main` (Working Tree Only; Zero Commits / Staging)

---

### Executive Summary

In **Phase 6.6.1**, we implemented the provider-independent architectural foundation for asynchronous outbound voice call lifecycle tracking. This completely decouples the short-lived background outbox delivery worker from the long-lived, multi-minute PSTN phone call, resolving the fundamental architectural tension between a 60-second outbox worker lease and multi-minute carrier call sessions.

Every outbound voice call attempt is now durably tracked through internal attempt IDs in Firestore, linked to provider-assigned call identifiers, and guarded by monotonic state ranking and terminal immutability to handle duplicate, delayed, out-of-order, or conflicting carrier webhooks cleanly and safely.

---

### Key Architectural Implementations

#### 1. Durable Call Attempt Data Model (`voice_call_attempts`)
- **Internal Identifier**: `id` format `att_<deliveryId>_<attemptNumber>`.
- **Pre-Request Creation**: The attempt record is created in Firestore **before** the outbound carrier API request is dispatched, with `providerCallId: null`. This guarantees attempt visibility even if carrier connectivity drops mid-request.
- **Provider ID Attachment**: Once the carrier returns acceptance (`providerCallId`), an atomic transaction attaches the provider call ID and creates a secondary mapping record in `voice_call_provider_mappings` for $O(1)$ indexed lookup.
- **Data Model Fields**:
  - `id`: Internal unique attempt ID (`att_...`).
  - `deliveryId`: Reference to outbox delivery (`del_...`).
  - `sessionId`: Reference to voice booking session (`vbs_...`).
  - `provider`: Telephony provider name (e.g., `exotel`, `mock-async-exotel`).
  - `providerCallId`: Carrier-assigned call SID / UUID.
  - `status`: Lifecycle status (`initiated` | `ringing` | `answered` | `in_progress` | `completed` | `busy` | `no_answer` | `failed` | `cancelled`).
  - `isTerminal`: Boolean flag indicating if call outcome is final.
  - `phoneNumberMasked`: E.164 masked recipient number for PII safety.
  - `initiatedAt`, `ringingAt`, `answeredAt`, `endedAt`: ISO 8601 UTC timestamps.
  - `durationSeconds`: Logical call duration computed upon termination.
  - `errorCode`, `errorMessage`: Safe provider error metadata.

#### 2. Monotonic State Ranking & Webhook Ordering
Telephony carrier webhooks across cellular networks (PSTN / SIP) frequently arrive out-of-order due to network retries, carrier latency, or multi-region routing. To guarantee state integrity:
- **Monotonic State Ranks**:
  - `initiated`: Rank 1
  - `ringing`: Rank 2
  - `answered`: Rank 3
  - `in_progress`: Rank 4
  - Terminal states (`completed`, `busy`, `no_answer`, `failed`, `cancelled`): Rank 5
- **Out-of-Order Handling**: If a delayed webhook arrives with a lower or equal non-terminal rank (e.g. `ringing` arriving after `answered` or `completed`), `evaluateStatusUpdate` marks it as `out_of_order_ignored` and leaves the active record untouched.
- **Terminal Immutability & Conflict Fencing**: Once a call attempt reaches any terminal state (Rank 5), it is permanently immutable:
  - Repeated identical terminal events return `idempotent_duplicate`.
  - Conflicting terminal events (e.g., `busy` arriving after `completed`) return `terminal_conflict` without corrupting the authoritative outcome or duration.

#### 3. Decoupled Asynchronous Outbox Worker
- **Immediate Lease Clearance**: For asynchronous providers (`isAsynchronous: true` or status `initiated` without immediate call outcome), carrier acceptance completes the outbox delivery immediately:
  - `delivery.status = "dispatched"`
  - `delivery.claimOwner = null`
  - `delivery.leaseExpiresAt = null`
- **Zero Lease Contention**: The outbox worker cycle completes in under 2 seconds, releasing the delivery claim and leaving the long-lived call to be managed by status webhooks and WebSocket streaming sessions.
- **Session Metadata Projection**: The authoritative session metadata is updated with `callAttemptStatus: "initiated"` and `providerCallId` for operational visibility without altering the session's conversational state machine.
- **Backward Compatibility**: Synchronous mock providers continue to be supported; if an immediate outcome is returned (`answered`, `busy`, `no_answer`), the attempt record and session state update synchronously.

---

### Verification & Test Suite Summary

A dedicated verification suite was implemented in `scripts/verify-phase6-6-1-call-attempt-foundation.ts` and registered in `package.json` under `npm run test:p661`.

| Check | Category | Result | Description |
|---|---|---|---|
| **1.1** | Pre-Request Attempt Creation | **PASSED** | Attempt created before provider API call with `providerCallId=null` |
| **1.2** | Attaching Provider Call ID | **PASSED** | Provider ID attached post-acceptance; indexed for $O(1)$ lookup |
| **1.3** | Provider ID Idempotency | **PASSED** | Reattaching same ID is idempotent; conflicting ID throws error |
| **2.1** | Idempotent Duplicate Creation | **PASSED** | `createAttempt` with existing internal ID returns record without mutation |
| **3.1** | Monotonic State Advancement | **PASSED** | Full lifecycle advances forward with recorded timestamps and duration |
| **4.1** | Out-of-Order Resolution | **PASSED** | Delayed `ringing` arriving after `answered` / `completed` is ignored |
| **5.1** | Terminal Conflict Rejection | **PASSED** | Terminal `completed` rejects conflicting `failed` / `busy` as `terminal_conflict` |
| **5.2** | Terminal Idempotent Duplicate | **PASSED** | Repeated identical terminal event returns `idempotent_duplicate` |
| **6.1** | Firestore Transaction Integration | **PASSED** | Firestore atomic transaction writes attempt and provider mapping |
| **7.1** | Asynchronous Outbox Dispatch | **PASSED** | Outbox delivery marked `dispatched` and lease cleared immediately (< 2s) |

**Result**: 10/10 checks passed (100% SUCCESS).

---

### Full Regression Suite Results

All platform regression test suites were executed sequentially:
- **Phase 6.5.5** (Fail-Closed Distributed Cursor): **8/8 PASSED**
- **Phase 6.5.4** (Distributed Rotation & Queue Fairness): **5/5 PASSED**
- **Phase 6.5.3** (True Rotating Queue Fairness & Metrics Fidelity): **6/6 PASSED**
- **Phase 6.5.2** (Candidate Selection & Timeout Hardening): **11/11 PASSED**
- **Phase 6.5.1** (Option Propagation & Worker Constraints): **9/9 PASSED**
- **Phase 6.5** (Background Worker, Lease Recovery & Metrics): **23/23 PASSED**
- **Phase 6.3.5** (End-to-End Voice Booking Integration Demo): **18/18 PASSED**
- **Phase 6.3.4.2** (Voice Lifecycle & Concurrency Fencing): **24/24 PASSED**
- **TypeScript Static Typecheck** (`tsc --noEmit`): **Zero errors**
- **ESLint Quality Audit** (`eslint`): **Zero errors / warnings**

---

### Invariants & Zero-Cost Policy Enforcement

1. **Feature Flag**: `VOICE_BOOKING_ENABLED=false` unconditionally enforced across all production entry points.
2. **Zero Paid Telephony**: Zero Exotel or Azure accounts, credits, phone numbers, or outbound PSTN minutes activated.
3. **Quotation Integrity**: HMAC-SHA256 authenticated quotation integrity using `BREW_QUOTATION_SECRET` strictly preserved.
4. **Staff Approval Gate**: Mandatory manual review for high-value bookings ($> 200$ guests / custom requirements) strictly preserved.
5. **Git Hygiene**: Clean working directory; zero files staged or committed.
