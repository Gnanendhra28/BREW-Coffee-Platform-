# Phase 6.5.1 Corrections Report: Background Worker & Outbox Concurrency

**Date**: 2026-11-06  
**Status**: Completed & Verified  
**Suite**: `verify-phase6-5-1-corrections.ts` (9/9 checks passed), `verify-phase6-5-background-worker.ts` (23/23 checks passed)  
**TypeScript**: Passed (`tsc --noEmit`, 0 errors)  
**Linter**: Passed (`eslint`, 0 errors)

---

## 1. Executive Summary

Phase 6.5.1 resolves the five targeted background worker and outbox concurrency issues identified in the independent review of Phase 6.5:
1. **Worker Option Propagation & Clamping**: `batchSize` (clamped to `[1, 50]`, default 10) and `leaseDurationMs` (clamped to `[5000, 300000]`, default 60000) are validated and clamped prior to worker construction, ensuring the constructed `OutboxWorker` receives and enforces authoritative values.
2. **GET Rejection with 405 Method Not Allowed**: `/api/cron/outbox-worker` now exclusively accepts `POST` requests for worker execution. `GET`, `PUT`, and `DELETE` requests are rejected with `405 Method Not Allowed` and `Allow: POST` header without querying or mutating outbox state or dispatching messages.
3. **Enforced Execution-Time Budget & Bounded Provider Timeouts**:
   - The 25-second execution budget ceiling is strictly enforced.
   - Cycle loop checks remaining time against cycle headroom (`minCycleHeadroomMs: 3000ms`); cycles are aborted before claiming if insufficient time remains.
   - Delivery loop checks remaining time against delivery headroom (`minDeliveryHeadroomMs: 2000ms`); if remaining budget is exceeded, subsequent deliveries in the batch are not started.
   - Any claimed deliveries not processed within the time budget are cooperatively released back to `pending` with cleared claim locks, avoiding lease-expiry lockouts.
   - `MetaWhatsAppCloudProvider` enforces bounded operation timeouts via `AbortController` (default 10s, configurable), throwing retryable `504` errors on timeout.
4. **Scalable Bounded Metrics Computation (Zero PII)**: Replaced full-collection `collection.get()` in `FirestoreCommunicationOutboxRepository.getMetrics()` with parallel Firestore `.count().get()` aggregations (0 document body downloads) and bounded projections (`select("leaseExpiresAt").limit(250)` for stale leases, `select("createdAt").limit(50)` for oldest pending, and `select("lastError.code").limit(100)` for failure reasons). Zero customer phone numbers, names, or message bodies are fetched or returned.
5. **Candidate Starvation Prevention**: Partitioned Firestore candidate selection in `claimEligibleDeliveries()` into independent queries (`pending`, expired `processing` leases, and due `failed` retries) backed by composite indexes in `firestore.indexes.json`. Active leases and future retry backoffs can never starve pending or due deliveries.

---

## 2. Issues Corrected & Implementation Details

### 2.1 Option Propagation & Validation
- **Location**: [`src/app/api/cron/outbox-worker/route.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/app/api/cron/outbox-worker/route.ts), [`src/lib/communication/outbox/outboxWorker.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/outbox/outboxWorker.ts)
- **Problem**: Previously, `createStandardOutboxWorker()` was called with empty default options `{}` before query parameters or body payload were parsed, causing custom `batchSize` and `leaseDurationMs` to be ignored during worker construction.
- **Fix**: Options are parsed, validated, and clamped before resolving the database or creating the worker. `createStandardOutboxWorker` forwards the clamped options directly into `new OutboxWorker(dependencies, clampedOptions)`. `OutboxWorker` constructor enforces invariant clamps (`batchSize` [1, 50], `leaseDurationMs` [5000, 300000], `backoffBaseMs` [1000, 60000]) and exposes `getOptions()`.

### 2.2 Rejection of Safe HTTP Methods (GET 405)
- **Location**: [`src/app/api/cron/outbox-worker/route.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/app/api/cron/outbox-worker/route.ts)
- **Problem**: Previously, both `GET` and `POST` invoked `handleWorkerRequest`, allowing safe HTTP GET requests to claim and mutate delivery records.
- **Fix**: `GET`, `PUT`, and `DELETE` handlers return `405 Method Not Allowed` with `{ Allow: "POST" }` headers immediately, ensuring zero outbox state changes or provider dispatches occur on safe HTTP methods.

### 2.3 Meaningful Execution-Time Budget & Provider Timeouts
- **Location**: [`src/lib/communication/outbox/outboxService.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/outbox/outboxService.ts), [`src/lib/communication/outbox/outboxWorker.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/outbox/outboxWorker.ts), [`src/lib/communication/providers/metaWhatsAppProvider.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/providers/metaWhatsAppProvider.ts)
- **Problem**: `runOutboxWorkerCycles` checked elapsed time only between cycles, but individual cycles could claim large batches and run unbounded, while individual provider HTTP calls lacked timeout protection.
- **Fix**:
  - `runOutboxWorkerCycles` computes `deadlineMs = startTime + maxDurationMs` (clamped between 1,000ms and 25,000ms).
  - Before starting a cycle, checks if `deadlineMs - Date.now() < minCycleHeadroomMs` (default 3,000ms) and breaks early.
  - Passes `deadlineMs` and `minDeliveryHeadroomMs` (default 2,000ms) to `worker.processCycle()`.
  - In `OutboxWorker.processCycle`, checks remaining headroom before starting each delivery. If insufficient time remains, aborts the loop and invokes `releaseClaimedDelivery` for all remaining unstarted deliveries in the batch, returning them to `pending` with cleared claim locks.
  - `MetaWhatsAppCloudProvider` wraps `fetchFn` in an `AbortController` bounded by `requestTimeoutMs` (default 10,000ms). Aborted timeouts throw `WhatsAppCloudApiError` with `statusCode: 504` and `isRetryable: true`.

### 2.4 Scalable Bounded Metrics Computation (Zero PII)
- **Location**: [`src/lib/communication/outbox/outboxRepository.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/outbox/outboxRepository.ts), [`src/app/api/admin/outbox/metrics/route.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/app/api/admin/outbox/metrics/route.ts)
- **Problem**: `FirestoreCommunicationOutboxRepository.getMetrics()` performed an unbounded `collection.get()`, fetching all document bodies and customer PII into server memory.
- **Fix**:
  - Replaced full-collection fetch with 8 parallel `.count().get()` aggregations for delivery statuses and channel distribution.
  - Stale lease count evaluates only active `processing` deliveries with projection `select("leaseExpiresAt").limit(250)`.
  - Oldest pending calculation evaluates only `pending` deliveries with projection `select("createdAt").limit(50)`.
  - Failure reasons breakdown reads only `select("lastError.code").limit(100)`.
  - Zero recipient telephone numbers, names, or message bodies are fetched, transferred, or exposed.

### 2.5 Candidate Starvation Prevention
- **Location**: [`src/lib/communication/outbox/outboxRepository.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/outbox/outboxRepository.ts), [`firestore.indexes.json`](file:///Users/gnanendhrajoy/Desktop/BREW/firestore.indexes.json)
- **Problem**: `claimEligibleDeliveries` performed a single query `where("status", "in", ["pending", "processing", "failed"]).limit(limit * 3)`. If the first `limit * 3` documents returned were active leases (`leaseExpiresAt > now`) or not-yet-due retries (`nextRetryAt > now`), zero deliveries were claimed and all subsequent eligible pending deliveries were starved indefinitely.
- **Fix**:
  - Partitioned candidate selection into 3 independent queries:
    1. `where("status", "==", "pending").limit(limit)` — always eligible, never starved.
    2. Expired lease query: `where("status", "==", "processing").where("leaseExpiresAt", "<=", nowIso)` (with in-memory fallback if index is building).
    3. Due retry query: `where("status", "==", "failed").where("nextRetryAt", "<=", nowIso)` (with in-memory fallback if index is building).
  - Added composite indexes `(status, leaseExpiresAt)` and `(status, nextRetryAt)` to `firestore.indexes.json`.

---

## 3. Verification Suite & Results

### Suite: `verify-phase6-5-1-corrections.ts` (9/9 passed)

```
================================================================================
   BREW Coffee Platform — Phase 6.5.1 Corrections Verification Suite
   Option Propagation, GET 405, Time Budget, Scalable Metrics, Starvation
================================================================================

--- 1. OPTION PROPAGATION & WORKER CONSTRUCTION ---
  ✓ 1.1 OutboxWorker constructor clamps batchSize to [1, 50] and leaseDurationMs to [5000, 300000]
  ✓ 1.2 POST /api/cron/outbox-worker applies batchSize and leaseDurationMs before worker execution

--- 2. GET REJECTION WITH 405 METHOD NOT ALLOWED ---
  ✓ 2.1 GET /api/cron/outbox-worker returns 405 Method Not Allowed with Allow: POST
  ✓ 2.2 GET request does not claim deliveries, mutate state, or execute cycles

--- 3. EXECUTION-TIME BUDGET & BOUNDED TIMEOUTS ---
  ✓ 3.1 runOutboxWorkerCycles aborts cycle when remaining time is below cycle headroom
  ✓ 3.2 OutboxWorker releases unstarted claimed deliveries back to pending when time budget expires
  ✓ 3.3 MetaWhatsAppCloudProvider enforces bounded operation timeout and fails retryable with 504

--- 4. SCALABLE METRICS COMPUTATION (ZERO PII) ---
  ✓ 4.1 FirestoreCommunicationOutboxRepository.getMetrics uses bounded count aggregations

--- 5. CANDIDATE STARVATION PREVENTION ---
  ✓ 5.1 Firestore candidate selection is not starved by active leases and future retries

================================================================================
   Phase 6.5.1 Verification Complete: 9/9 checks passed (SUCCESS)
================================================================================
```

### Full Regression Suite Results
- `npm run test:p651`: **9/9 passed**
- `npm run test:p65`: **23/23 passed**
- `npm run test:p641`: **28/28 passed**
- `npm run test:p64`: **20/20 passed**
- `npm run test:p635`: **18/18 passed**
- `npm run typecheck`: **0 errors**
- `npm run lint`: **0 errors**

---

## 4. Scope & Guardrail Attestation

- `VOICE_BOOKING_ENABLED=false` is strictly maintained across all routes, handlers, and configurations.
- Zero voice calls or PSTN telephony connections are placed.
- WhatsApp Cloud API enforces strict test-recipient allowlist (`allowedRecipients`).
- No paid cloud infrastructure or billing resources were created.
- Git working tree remains completely unstaged: no `git add`, `git commit`, `git push`, or deployments were made.
