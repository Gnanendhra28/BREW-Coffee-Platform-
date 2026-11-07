# Phase 6.5 Implementation Report: Background Worker & Outbox Recovery

**Date**: 2026-11-06  
**Status**: Completed & Verified  
**Suite**: `verify-phase6-5-background-worker.ts` (22/22 checks passed)  
**TypeScript**: Passed (`tsc --noEmit`, 0 errors)  
**Linter**: Passed (`eslint`, 0 errors)

---

## 1. Executive Summary

Phase 6.5 implements reliable, production-ready background processing and lease recovery for the BREW Coffee transactional communication outbox. Operating strictly within zero-cost development constraints, this phase establishes:
- **Server-Authoritative Endpoint Protection**: Scheduled worker execution (`/api/cron/outbox-worker`) and operational monitoring (`/api/admin/outbox/metrics`) protected with constant-time cryptographic validation against `CRON_SECRET` / `WORKER_SECRET`. Fails closed if secrets are missing or invalid, with automatic token redaction.
- **Lease Expiry Recovery & Concurrency Fencing**: Safe reclamation of abandoned or hung delivery claims (`leaseExpiresAt <= now`). Stale workers whose leases expire cannot overwrite newer state or commit invalid session mutations.
- **Pre-Dispatch Policy Enforcement**: In-flight revocations of consent or additions to Do-Not-Disturb (DND) registries are rechecked immediately before dispatch, automatically transitioning deliveries to `blocked`.
- **Bounded Batches & Exponential Backoff**: Processing batches are strictly bounded (`batchSize` capped at 50, cycle loops capped at 5 with 25s execution timeouts). Retryable failures enforce exponential backoff calculations (`nextRetryAt`), while deliveries reaching `maxAttempts` (default 3) transition to `permanently_failed`.
- **Operational Monitoring**: Real-time aggregate outbox metrics (`pending`, `claimed`, `dispatched`, `blocked`, `failed_retryable`, `permanently_failed`, and expired lease counts) available without leaking customer PII.
- **Zero-Cost & Free-Tier Resiliency**: Comprehensive architectural strategy addressing Render Free tier sleep constraints without activating paid infrastructure or telephony.

---

## 2. Infrastructure Analysis: Render Free Tier vs Free Background Processing Options

Render's Free Web Service tier spins down (sleeps) after 15 minutes of inbound HTTP inactivity, and Render does not provide always-on background worker daemons on its free tier. Running an unbounded Node.js `setInterval` loop inside a free web service process is fundamentally unreliable because the process is halted during idle periods.

### Free Architecture Comparison

| Architecture | Reliability | Free Tier Feasibility | Implementation Complexity | Recommendation |
|---|---|---|---|---|
| **External Scheduled HTTP Webhook** *(Current)* | High (deterministic invocation on cadence) | **100% Free** (Google Cloud Scheduler free tier provides 3 jobs/mo; cron-job.org / Upstash QStash provide free HTTP cron triggers) | Low (single authenticated POST/GET endpoint) | **Recommended (Selected)** |
| **In-Process `setInterval` Daemon** | Low (halts when Render Free spins down after 15 min idle) | **Free**, but intermittently dormant | Very Low | Unsuitable for reliable production SLAs |
| **Render Background Worker (Paid)** | High (continuous execution) | **Paid Only** (\$7/month minimum on Render) | Low | Rejected (Violates zero-cost constraint) |
| **Opportunistic Self-Healing Trigger** | Moderate (fires on inbound user traffic/requests) | **100% Free** (built-in fallback) | Medium | Excellent auxiliary supplement |

### Implemented Strategy
1. **Authenticated Scheduled Webhook Endpoint** (`/api/cron/outbox-worker`): Standard HTTP trigger designed for Google Cloud Scheduler, cron-job.org, GitHub Actions Scheduled Workflows, or Vercel Cron. When triggered, it securely wakes the instance, executes bounded recovery and dispatch cycles, and terminates cleanly.
2. **Safe Bounded Execution**: Prevents serverless/gateway timeouts with an explicit 25-second execution ceiling (`maxDurationMs: 25000`) and max 5 cycles.
3. **Idempotent Self-Healing**: Multiple concurrent or duplicate cron triggers do not conflict or double-dispatch due to atomic delivery lease claiming.

---

## 3. Architecture & Components

```
      [ External Cron / Cloud Scheduler ]
                      │ (Authorization: Bearer <CRON_SECRET>)
                      ▼
         [ /api/cron/outbox-worker ]
                      │
            ┌─────────┴─────────┐
            │  verifyWorkerAuth │ (Constant-time token validation)
            └─────────┬─────────┘
                      ▼
       [ runOutboxWorkerCycles() ]
    (Max 5 cycles, Max 25s wall time)
                      │
                      ▼
               [ OutboxWorker ]
    ┌─────────────────┴─────────────────┐
    │ 1. Atomic Claim & Expired Reclaim │  (claimEligibleDeliveries)
    │ 2. Consent & DND Pre-Check        │  (checkCommunicationPolicy)
    │ 3. Dispatch via WhatsApp/Voice    │  (Mock/Cloud API)
    │ 4. Backoff & Retry Handling       │  (Exponential nextRetryAt)
    └─────────────────┬─────────────────┘
                      ▼
     [ FirestoreCommunicationOutboxRepo ]
                      ▲
                      │
         [ /api/admin/outbox/metrics ]
    (Protected: Staff Session or Bearer Secret)
```

### Key Files Created & Modified

| File | Status | Description |
|---|---|---|
| `src/lib/communication/outbox/workerAuth.ts` | **Created** | Server-authoritative constant-time auth boundary (`verifyWorkerAuth`, `timingSafeEqual`). Supports Bearer tokens and `x-cron-secret`. Redacts secrets from logs. |
| `src/lib/communication/outbox/outboxService.ts` | **Created** | Factory (`createStandardOutboxWorker`) and lifecycle executor (`runOutboxWorkerCycles`) with bounded duration and cycle counts. |
| `src/app/api/cron/outbox-worker/route.ts` | **Created** | Secure scheduled endpoint (POST/GET) with batch parameter bounds, database health checks, and fail-closed 503 behavior. |
| `src/app/api/admin/outbox/metrics/route.ts` | **Created** | Operational monitoring endpoint with dual authentication (worker Bearer secret or authenticated staff session cookie). Returns aggregate delivery counts without PII. |
| `src/lib/communication/outbox/outboxRepository.ts` | Modified | Added `OutboxMetricsSummary` interface and `getMetrics()` calculation to both `InMemory` and `Firestore` repositories. |
| `src/lib/communication/index.ts` | Modified | Exported `workerAuth`, `outboxService`, and `OutboxMetricsSummary`. |
| `scripts/verify-phase6-5-background-worker.ts` | **Created** | Comprehensive 22-test automated verification suite for worker auth, concurrency, lease recovery, policy pre-checks, backoff, and metrics. |
| `package.json` | Modified | Added `"test:p65"` verification script. |

---

## 4. Concurrency, Recovery, & Resilience Guarantees

### 4.1 Expired Lease Recovery
If a worker crashes, is preempted, or hangs mid-dispatch, its lease expires (`leaseExpiresAt <= now`). The repository's atomic `claimEligibleDeliveries()` query identifies and reclaims expired leases:
- Reclaims the delivery with a fresh `claimToken`, fresh `claimOwner`, and updated `leaseExpiresAt`.
- Increments `attemptCount` while preserving delivery identity and associated booking metadata.
- Stale workers holding expired claim tokens are strictly prevented from committing updates (`updateClaimedDelivery` and `mutateSessionWithClaimFencing` reject expired or mismatched claim tokens).

### 4.2 Concurrency & Duplicate Trigger Protection
When multiple worker instances or cron triggers invoke processing concurrently:
- Atomic lease claiming ensures each delivery is assigned to exactly one worker at any given instant.
- Concurrent workers claim distinct subsets or receive empty batches without collision.
- A worker instance killed mid-cycle leaves the outbox in a durable state that is safely recovered on subsequent runs.

### 4.3 Exponential Backoff & Retry Ceilings
Transient network or provider errors increment `attemptCount` and apply exponential backoff:
$$\Delta t = \min(60 \cdot 2^{(\text{attemptCount} - 1)}, 3600) \text{ seconds}$$
- Deliveries with `nextRetryAt > now` are strictly ignored by claiming queries until their backoff window expires.
- Deliveries reaching `maxAttempts` (default 3) transition to `permanently_failed` with descriptive error details.

### 4.4 Pre-Dispatch Consent & DND Fencing
Consent revocations or DND registrations that occur while a delivery is queued or between retries are evaluated at dispatch time:
- The worker invokes `checkCommunicationPolicy` immediately prior to calling provider dispatch.
- If policy checks fail, the delivery immediately transitions to `blocked` status, ensuring zero unwanted communications.

---

## 5. Security & Authentication Model

1. **Constant-Time Comparison**: Both endpoints use `crypto.timingSafeEqual` with byte-length validation to prevent timing side-channel attacks on secret tokens.
2. **Fail-Closed on Unconfigured Environment**: If neither `CRON_SECRET` nor `WORKER_SECRET` is set in the environment, `/api/cron/outbox-worker` immediately rejects all requests with HTTP 500, refusing to operate in an unauthenticated configuration.
3. **Dual Authentication for Metrics**: `/api/admin/outbox/metrics` allows monitoring daemons to authenticate via Bearer secret and human operators to authenticate via staff session cookies (`brew_session`).
4. **PII Protection**: Metrics endpoints aggregate counts across delivery statuses and channels without returning recipient telephone numbers, names, or message bodies.

---

## 6. Verification Results

All 22 automated test scenarios in `scripts/verify-phase6-5-background-worker.ts` passed cleanly:

```
================================================================================
   BREW Coffee Platform — Phase 6.5 Verification Suite
   Background Worker, Lease Recovery, Concurrency, Metrics & Safe Defaults
================================================================================

--- 1. WORKER ENDPOINT AUTHENTICATION & SECURITY ---
  ✓ 1.1 Missing or invalid secret fails closed with 401 Unauthorized
  ✓ 1.2 Missing CRON_SECRET in environment fails closed with 500 Configuration Error
  ✓ 1.3 Valid secret via Authorization: Bearer succeeds with 200 and cycle results
  ✓ 1.4 Valid secret via x-cron-secret header succeeds on GET request

--- 2. CONCURRENCY & DUPLICATE TRIGGER PROTECTION ---
  ✓ 2.1 Concurrent workers cannot claim the same active delivery lease

--- 3. EXPIRED LEASE RECOVERY & CONCURRENCY FENCING ---
  ✓ 3.1 Delivery with expired lease (leaseExpiresAt <= now) is safely reclaimed and dispatched
  ✓ 3.2 Stale worker whose lease expired cannot commit delivery update
  ✓ 3.3 Stale worker whose lease expired cannot commit session mutation

--- 4. WORKER RESTARTS & DURABLE RECOVERY ---
  ✓ 4.1 Worker instance killed mid-cycle leaves outbox intact; fresh worker recovers it

--- 5. PRE-DISPATCH POLICY RE-EVALUATION IN BACKGROUND ---
  ✓ 5.1 Revoking consent before scheduled worker run transitions delivery to blocked
  ✓ 5.2 Recipient added to DND before scheduled worker run blocks dispatch

--- 6. BOUNDED BATCHES, RETRY LIMITS & BACKOFF ---
  ✓ 6.1 batchSize parameter caps the maximum deliveries claimed per cycle
  ✓ 6.2 Failed retryable delivery computes exponential backoff nextRetryAt
  ✓ 6.3 Delivery with future nextRetryAt is NOT claimed prematurely
  ✓ 6.4 Delivery reaching maxAttempts transitions to permanently_failed without further retries

--- 7. MONITORING & OPERATIONAL METRICS ENDPOINT ---
  ✓ 7.1 GET /api/admin/outbox/metrics rejects unauthenticated caller with 401
  ✓ 7.2 GET /api/admin/outbox/metrics returns accurate counts and metrics for authorized worker token
  ✓ 7.3 GET /api/admin/outbox/metrics is accessible via verified staff admin session

--- 8. FIRESTORE FAILURE SAFETY & DEPLOYED FAILS-CLOSED GATES ---
  ✓ 8.1 /api/cron/outbox-worker returns 503 if Firestore database is unavailable
  ✓ 8.2 /api/admin/outbox/metrics returns 503 if Firestore database is unavailable

--- 9. SCOPE INVARIANTS & ZERO-COST RESTRICTIONS ---
  ✓ 9.1 VOICE_BOOKING_ENABLED remains strictly false; zero voice telephony activated
  ✓ 9.2 WhatsApp test-recipient restriction remains strictly enforced in worker

================================================================================
   Phase 6.5 Verification Complete: 22/22 checks passed (SUCCESS)
================================================================================
```

### Full Regression Test Summary
- `npm run test:p65`: **22/22 passed**
- `npm run test:p641`: **28/28 passed**
- `npm run test:p64`: **20/20 passed**
- `npm run test:p635`: **18/18 passed**
- `npm run test:p63431`: **11/11 passed**
- `npm run test:p6343`: **17/17 passed**
- `npm run test:p6342`: **24/24 passed**
- `npm run test:p6341`: **33/33 passed**
- `npm run test:p633`: **21/21 passed**
- `npm run typecheck`: **0 errors**
- `npm run lint`: **0 errors**

---

## 7. Scope & Guardrail Attestation

- `VOICE_BOOKING_ENABLED=false` is strictly preserved across all routes, handlers, and configuration.
- Zero outbound PSTN or cellular voice calls are triggered.
- WhatsApp Cloud API enforces strict test-recipient boundaries (`allowedRecipients`).
- No paid services, billing accounts, or cloud instances were created or activated.
- Git working tree remains completely unstaged: no `git add`, `git commit`, `git push`, or deployment executed.
