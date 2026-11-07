# BREW Coffee Platform — Phase 6.5.3 Final Corrections Report
## True Rotating Queue Fairness & Accurate Metrics Fidelity

### Executive Summary
Phase 6.5.3 addresses the final two review findings concerning candidate queue fairness and metrics fidelity in the communication outbox subsystem:
1. **True Rotating Queue Fairness**:
   - Outbox repositories now advance a starting candidate group offset across successive batches:
     - Group 0: Expired leases (`processing` with `leaseExpiresAt <= now`)
     - Group 1: Due retries (`failed` with `nextRetryAt <= now`)
     - Group 2: Fresh pending deliveries (`pending`)
   - Even with batch sizes of 1 and 2, every eligible candidate group is guaranteed periodic service under sustained backlogs in other groups, completely eliminating starvation.
   - Atomic transactions, mutex claiming, and claim-token fencing remain fully preserved.
2. **Accurate Metrics Fidelity**:
   - Aggregate Firestore document counts (`counts.pending`, `counts.total`, and `channelBreakdown`) remain exact aggregations (`.count().get()`).
   - Bounded projection queries for `staleLeases` (limit 250), `oldestPendingAge` (limit 50), and `failureReasons` (limit 100) are explicitly labeled as `fidelity: "sampled"` with `isExact: false`.
   - The overall response strictly enforces that `isExact` is false and `fidelity` is `"sampled"` whenever any component is sampled, ensuring the response never overstates accuracy.
   - Comprehensive per-metric fidelity metadata is exposed under `components`.

---

### Detailed Corrections

#### 1. True Rotating Queue Fairness Across Successive Batches
- **Starvation Problem with Static Head Priority**:
  - In fixed-order interleaving, batches always prioritized group 0 (expired leases).
  - With a batch size of 1, if expired leases continuously arrived or existed, due retries and pending deliveries would never be claimed.
  - With a batch size of 2, if expired leases and due retries both had backlogs, pending deliveries would never be claimed.
- **Correction in `InMemoryCommunicationOutboxRepository` & `FirestoreCommunicationOutboxRepository`**:
  - Maintained an internal batch rotation offset:
    `const startGroup = this.rotationOffset % 3;`
    `this.rotationOffset = (this.rotationOffset + 1) % 3;`
  - Reordered candidate buckets per batch:
    `[baseBuckets[startGroup], baseBuckets[(startGroup + 1) % 3], baseBuckets[(startGroup + 2) % 3]]`
  - Interleaves candidates in round-robin fashion starting from the rotated group.
- **Behavior Under Sustained Backlog (5 expired, 5 due retries, 5 pending)**:
  - **Batch Size 1**:
    - Batch 1 (start 0): Claims expired lease.
    - Batch 2 (start 1): Claims due retry.
    - Batch 3 (start 2): Claims pending delivery.
    - Batch 4 (start 0): Claims expired lease.
    - Batch 5 (start 1): Claims due retry.
    - Batch 6 (start 2): Claims pending delivery.
    - Every group is serviced in turn. Zero permanent starvation.
  - **Batch Size 2**:
    - Batch 1 (start 0): Claims `[expired, retry]`.
    - Batch 2 (start 1): Claims `[retry, pending]`.
    - Batch 3 (start 2): Claims `[pending, expired]`.
    - In 3 batches, all three groups receive exactly 2 claims each.
  - **Batch Size 3**:
    - All 3 groups receive 1 item per batch, with rotating primary selection.

#### 2. Accurate Metrics Fidelity & Component-Level Transparency
- **Problem**:
  - Previous implementations returned `fidelity: "exact"` and `isExact: true` for the whole response even though `staleLeases`, `oldestPendingAge`, and `failureReasons` were calculated from bounded slice queries (limits 250, 50, and 100).
- **Correction**:
  - Added `MetricComponentFidelity` and `OutboxMetricsFidelityBreakdown` interfaces.
  - In `FirestoreCommunicationOutboxRepository.getMetrics()`:
    - `counts`: `fidelity: "exact"`, `isExact: true` (Firestore aggregation).
    - `channelBreakdown`: `fidelity: "exact"`, `isExact: true` (Firestore aggregation).
    - `staleLeases`: `fidelity: "sampled"`, `isExact: false` (sampleLimit: 250).
    - `oldestPendingAge`: `fidelity: "sampled"`, `isExact: false` (sampleLimit: 50).
    - `failureReasons`: `fidelity: "sampled"`, `isExact: false` (sampleLimit: 100).
  - Overall response:
    - `fidelity: "sampled"`
    - `isExact: false`
    - `sampleDetails.sampledComponents: ["staleLeases", "oldestPendingAge", "failureReasons"]`
  - In `computeOutboxMetricsFromRecords`:
    - Evaluates all component fidelities; if any component is sampled, overall `isExact` is false and `fidelity` is `"sampled"`.
    - The response never overstates accuracy.

---

### Verification Summary

| Test Group | Scenario | Result |
|---|---|---|
| **1. Rotating Fairness (Batch 1)** | 1.1 Successive batches rotate through expired, retry, pending (zero starvation) | **PASSED** |
| **2. Rotating Fairness (Batch 2)** | 2.1 Successive batches rotate [exp, ret], [ret, pen], [pen, exp] | **PASSED** |
| **3. Rotating Fairness (Batch 3)** | 3.1 All candidate groups balanced with rotating primary group | **PASSED** |
| **4. Firestore Rotating & Fencing** | 4.1 Firestore claims rotate across groups and preserve claim tokens/leases | **PASSED** |
| **5. Accurate Metrics Fidelity** | 5.1 Firestore getMetrics preserves exact counts & marks bounded samples | **PASSED** |
| **5. Accurate Metrics Fidelity** | 5.2 computeOutboxMetricsFromRecords never overstates accuracy | **PASSED** |

- **Phase 6.5.3 Suite (`npm run test:p653`)**: **6/6 checks passed (100%)**
- **Phase 6.5.2 Suite (`npm run test:p652`)**: **8/8 checks passed (100%)**
- **Phase 6.5.1 Suite (`npm run test:p651`)**: **9/9 checks passed (100%)**
- **Phase 6.5 Suite (`npm run test:p65`)**: **23/23 checks passed (100%)**
- **Phase 6.4.1 Suite (`npm run test:p641`)**: **28/28 checks passed (100%)**
- **Phase 6.4 Suite (`npm run test:p64`)**: **20/20 checks passed (100%)**
- **Phase 6.3.5 Suite (`npm run test:p635`)**: **18/18 checks passed (100%)**
- **TypeScript Typecheck (`npm run typecheck`)**: **0 errors**
- **ESLint (`npm run lint`)**: **0 errors**

---

### Invariant & Compliance Checklist
- [x] `VOICE_BOOKING_ENABLED=false` unconditionally preserved across all routes and code paths.
- [x] Zero real PSTN phone calls, carrier trunks, or paid voice telephony activated.
- [x] WhatsApp recipient allowlist strictly enforced with fail-closed safeguards.
- [x] No paid cloud infrastructure or billing resources required.
- [x] Git working tree remains completely unstaged: no `git add`, `git commit`, `git push`, or deployment.
