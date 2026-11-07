# Phase 6.5.4 — Distributed Queue Rotation & Multi-Repository Instance Fairness Report

## Executive Summary
In Phase 6.5.4, we completed the implementation of distributed, persistent candidate-group queue rotation for the BREW communication outbox. Prior to this phase, queue rotation was tracked in-memory within individual repository instances. In distributed or serverless deployments (such as Google Cloud Functions, Cloud Run, or Render where multiple worker processes run or container instances recycle), repository instances had isolated local rotation counters, which risked cursor reset and uncoordinated candidate selection across instances.

Phase 6.5.4 introduces shared, persistent Firestore transaction-backed cursor advancement on a dedicated control document (`_rotation_cursor`). When multiple independent repository instances or concurrent worker invocations select eligible deliveries, they read and advance this atomic cursor. This guarantees fair candidate group prioritization across:
1. **Expired Leases** (Group 0)
2. **Due Retries** (Group 1)
3. **Pending Deliveries** (Group 2)

Even with small batch sizes (`batchSize = 1, 2, 3`) and sustained backlogs across all groups, no group suffers starvation. Furthermore, concurrent worker invocations cannot overwrite or lose cursor advancements, and in-memory test mocks remain simple and lightweight.

---

## Key Changes & Architecture

### 1. Shared Persistent Cursor Document (`_rotation_cursor`)
- Document Path: `booking_communication_outbox/_rotation_cursor`
- Schema:
  ```typescript
  {
    cursor: number; // 0, 1, or 2
    updatedAt: string; // ISO 8601 timestamp
  }
  ```
- **Atomic Advancement (`getAndAdvanceRotationCursor`)**:
  Executes an atomic Firestore transaction (`db.runTransaction`) that reads the current cursor value, advances it `(current + 1) % 3`, writes the updated cursor with `{ merge: true }`, and returns the prior cursor value to designate the starting priority group for candidate selection.
- **Fail-Safe Fallback**:
  If running in a constrained or non-standard environment without active transaction capabilities, it safely falls back to local instance rotation without crashing.

### 2. Multi-Repository Instance Candidate Selection
When `claimEligibleDeliveries` is invoked on any `FirestoreCommunicationOutboxRepository` instance:
1. It retrieves the shared cursor atomically via `getAndAdvanceRotationCursor(db)`.
2. It orders the candidate queries starting from `startGroup`:
   - `startGroup = 0`: [Expired Leases, Due Retries, Pending Deliveries]
   - `startGroup = 1`: [Due Retries, Pending Deliveries, Expired Leases]
   - `startGroup = 2`: [Pending Deliveries, Expired Leases, Due Retries]
3. It performs fair batch allocation across the prioritized groups up to `batchSize`.
4. It claims candidates using atomic document transactions and claim-token fencing (`claimToken`).

### 3. Lightweight In-Memory Rotation
- `InMemoryCommunicationOutboxRepository` retains a simple `#rotationOffset` private counter that advances `(#rotationOffset + 1) % 3` on each claim cycle.
- Local tests and in-memory developer workflows remain zero-dependency, ultra-fast, and simple.

### 4. Metrics Fidelity Unchanged
- Exact counts from Firestore aggregations (`count()` aggregation queries) remain strictly tracked.
- Bounded samples (such as oldest pending age, failure reason tallies, and stale lease inspection) are marked with per-component fidelity metadata (`"exact"` vs `"sampled"`).
- Aggregate metrics responses never overstate precision.

---

## Verification & Test Results

The dedicated verification suite (`scripts/verify-phase6-5-4-distributed-rotation.ts`) exercises two independently constructed repository instances backed by a shared mock Firestore with ACID transaction serialization:

1. **Two Independent Repositories with Batch Size 1**:
   - `repoA` claims Group 0 (expired lease).
   - `repoB` claims Group 1 (due retry).
   - `repoA` claims Group 2 (pending delivery).
   - `repoB` wraps around to Group 0 (expired lease).
   - Verified that neither repository starves any group despite isolated object instances.

2. **Two Independent Repositories with Batch Sizes 2 & 3**:
   - `batchSize = 2`: Successive invocations across independent repositories balance candidate allocations across groups without starving any backlog.
   - `batchSize = 3`: Successive invocations rotate the primary candidate bucket, ensuring full queue fairness.

3. **Concurrent Claims & Cursor Integrity**:
   - Two worker instances claiming concurrently serialize their cursor transactions.
   - Both advance the cursor without overwriting or losing state.
   - Claim-token fencing ensures neither worker claims the same delivery.

4. **In-Memory Simplicity**:
   - `InMemoryCommunicationOutboxRepository` continues to rotate predictably in local tests without external dependencies.

---

## Safety & Policy Guardrails
- `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
- Zero voice calls or PSTN telephony.
- WhatsApp recipient allowlist enforced with fail-closed checks.
- No paid cloud services or billing dependencies introduced.
- Working tree remains completely unstaged.
