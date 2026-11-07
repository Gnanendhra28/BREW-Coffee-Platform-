# BREW Coffee Platform — Phase 6.5.2 Corrections Report
## Queue Fairness, Query Failures, Metrics Fidelity, Streaming Timeout & Cooperative Deadlines

### Executive Summary
Phase 6.5.2 resolves five critical architectural and operational findings in the background communication outbox processing system:
1. **Queue Fairness & Backlog Starvation Prevention**: Eliminated queue starvation where large backlogs of pending deliveries drowned out expired leases and due retries. Both in-memory and Firestore stores now concurrently query all three candidate groups and interleave them fairly using round-robin allocation up to the batch limit.
2. **Visible Query / Index Failures**: Removed fragile, unordered `limit(50)` fallback scans that hid eligible items behind arbitrary record offsets. Firestore candidate selection now strictly prefers configured composite indexed queries and throws clear, visible errors (`[OUTBOX_INDEX_QUERY_ERROR]`) if required composite indexes are missing or fail to execute.
3. **Exact Metrics Fidelity & Aggregation Failure Handling**: Removed misleading partial metrics where a 500-record snapshot was silently substituted as complete outbox statistics. Firestore metrics calculation now fails visibly (`[OUTBOX_METRICS_AGGREGATION_FAILED]`) on aggregation errors, and all metrics structures explicitly declare fidelity metadata (`fidelity: "exact" | "sampled"`, `isExact: boolean`).
4. **Response-Body Streaming Timeout**: Extended the Meta Cloud API request timeout to keep the `AbortController` and timer active until the entire response body stream (`response.text()`) has been completely read and parsed. Stalled or slow-streaming HTTP bodies now safely trigger retryable `504 Gateway Timeout` errors.
5. **Cooperative Execution Deadline Handling & Bounded Operations**: Clarified and hardened execution budget contracts. Since Node.js asynchronous promises cannot be forcefully pre-empted mid-flight, deadlines are checked cooperatively at cycle and delivery boundaries (with unstarted batch deliveries released back to `pending`), while all individual provider operations enforce strict bounded internal timeouts.

---

### Detailed Corrections

#### 1. Candidate Selection Queue Fairness
- **Previous Vulnerability**: In `FirestoreCommunicationOutboxRepository` and `InMemoryCommunicationOutboxRepository`, pending items were queried first up to the entire `batchSize`. When a large backlog of pending messages accumulated, pending deliveries consumed 100% of candidate slots, starving expired leases and due retries indefinitely.
- **Correction**:
  - `InMemoryCommunicationOutboxRepository`: Partitions deliveries into three candidate pools (`expiredLeases`, `dueRetries`, `pending`) and interleaves them using fair round-robin scheduling.
  - `FirestoreCommunicationOutboxRepository`: Runs three concurrent indexed queries for each candidate group:
    1. Expired leases: `status == "processing"` and `leaseExpiresAt <= now`
    2. Due retries: `status == "failed"` and `nextRetryAt <= now`
    3. Fresh pending deliveries: `status == "pending"`
  - Candidates are merged via round-robin round cycles (`[expired[i], retries[i], pending[i]]`) up to `limit`.

#### 2. Visible Query Failures (Elimination of Blind Scans)
- **Previous Vulnerability**: Catch blocks in `FirestoreCommunicationOutboxRepository` caught indexed query failures and fell back to unordered `limit(50)` scans across `status == "processing"` or `status == "failed"`. In high-volume systems, eligible deliveries beyond the first 50 arbitrary documents were permanently hidden.
- **Correction**:
  - Eliminated unordered scans.
  - Replaced catch blocks with explicit, visible errors:
    `[OUTBOX_INDEX_QUERY_ERROR] Configured indexed candidate query failed: ... Ensure composite indexes in firestore.indexes.json are deployed.`

#### 3. Metrics Fidelity & Explicit Sampling Metadata
- **Previous Vulnerability**: If Firestore count aggregations (`col.where(...).count().get()`) failed, `getMetrics()` caught the exception and silently executed `col.limit(500).get()`, returning partial counts as if they were authoritative outbox totals.
- **Correction**:
  - Updated `OutboxMetricsSummary` to include:
    ```typescript
    fidelity: "exact" | "sampled";
    isExact: boolean;
    sampleDetails?: {
      sampleSize: number;
      reason: string;
    };
    ```
  - In `FirestoreCommunicationOutboxRepository.getMetrics()`:
    - Successful count aggregations are tagged with `fidelity: "exact"` and `isExact: true`.
    - If count aggregation fails, throws visible `[OUTBOX_METRICS_AGGREGATION_FAILED]` instead of hiding the failure with a partial sample.
  - `computeOutboxMetricsFromRecords` accepts `MetricsCalculationOptions` to generate explicit sampled estimates when deliberately requested.

#### 4. Response-Body Streaming Timeout
- **Previous Vulnerability**: In `MetaWhatsAppCloudProvider`, `clearTimeout(timeoutId)` was called immediately after `await fetchFn(url, ...)`. The response body reading (`await response.json()`) was executed completely outside the timeout. If the body connection stalled or streamed data slowly, the worker hung indefinitely.
- **Correction**:
  - Moved `responseText = await response.text()` inside the `try` block before `clearTimeout(timeoutId)` in `finally`.
  - Body consumption hangs now abort via the `AbortController` and are caught as transport timeouts.
  - Throws `WhatsAppCloudApiError` with `statusCode: 504` and `isRetryable: true`.

#### 5. Cooperative Execution Deadline & Bounded Operations
- **Contract & Architecture Alignment**:
  - Clarified in code comments, JSDoc, and architecture documentation that Node.js does not allow hard preemption of in-flight asynchronous promises.
  - Deadlines are cooperatively enforced at cycle and delivery boundaries:
    - If remaining time is less than cycle headroom (`minCycleHeadroomMs`), the next cycle is not started.
    - If remaining time is less than delivery headroom (`minDeliveryHeadroomMs`), unstarted deliveries in the batch are safely released back to `pending`.
  - All underlying provider dispatches and network calls enforce bounded timeouts internally (e.g. `requestTimeoutMs`).

---

### Verification Summary

| Test Group | Scenario | Result |
|---|---|---|
| **1. Queue Fairness** | 1.1 In-Memory round-robin interleaving under 10-pending backlog | **PASSED** |
| **1. Queue Fairness** | 1.2 Firestore fair allocation across expired leases, due retries, pending | **PASSED** |
| **2. Query Failures** | 2.1 Visible `[OUTBOX_INDEX_QUERY_ERROR]` when index query fails | **PASSED** |
| **3. Metrics Fidelity** | 3.1 Exact fidelity metadata on successful aggregation (`isExact: true`) | **PASSED** |
| **3. Metrics Fidelity** | 3.2 Visible `[OUTBOX_METRICS_AGGREGATION_FAILED]` on count aggregation failure | **PASSED** |
| **3. Metrics Fidelity** | 3.3 Explicit distinction between exact and sampled calculations | **PASSED** |
| **4. Streaming Timeout** | 4.1 Body streaming stall after 200 OK headers aborts with 504 retryable | **PASSED** |
| **5. Bounded Operations** | 5.1 OutboxWorker releases unstarted claimed deliveries on budget expiration | **PASSED** |

- **Phase 6.5.2 Suite (`npm run test:p652`)**: **8/8 checks passed (100%)**
- **Phase 6.5.1 Suite (`npm run test:p651`)**: **9/9 checks passed (100%)**
- **Phase 6.5 Suite (`npm run test:p65`)**: **23/23 checks passed (100%)**
- **Phase 6.4.1 Suite (`npm run test:p641`)**: **28/28 checks passed (100%)**
- **Phase 6.4 Suite (`npm run test:p64`)**: **20/20 checks passed (100%)**
- **Phase 6.3.5 Suite (`npm run test:p635`)**: **18/18 checks passed (100%)**
- **Typecheck (`npm run typecheck`)**: **0 errors**
- **Lint (`npm run lint`)**: **0 errors**

---

### Invariant & Compliance Checklist
- [x] `VOICE_BOOKING_ENABLED=false` unconditionally preserved across all routes and code paths.
- [x] Zero real PSTN phone calls, carrier trunks, or paid voice telephony activated.
- [x] WhatsApp recipient allowlist strictly enforced with fail-closed safeguards.
- [x] No paid cloud infrastructure or billing resources required.
- [x] Git working tree remains completely unstaged: no `git add`, `git commit`, `git push`, or deployment.
