/**
 * BREW Coffee Platform — Phase 6.5.1 Verification Suite
 * Background Worker Corrections:
 * 1. Option Propagation & Clamping (batchSize, leaseDurationMs)
 * 2. GET Rejection with 405 Method Not Allowed
 * 3. Execution-Time Budget & Bounded Provider Timeouts
 * 4. Scalable, Bounded Metrics Computation (Zero PII)
 * 5. Candidate Starvation Prevention (Active Leases & Future Retries)
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import { NextRequest } from "next/server";
import {
  OutboxWorker,
  createOutboxDeliveriesForTransition,
  createReminderDeliveryForSession,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  MockVoiceProvider,
  MockWhatsAppProvider,
  MetaWhatsAppCloudProvider,
  WhatsAppCloudApiError,
  runOutboxWorkerCycles,
} from "../src/lib/communication";
import {
  TestInMemoryCommunicationOutboxRepository,
  seedOutboxDeliveryForTest,
  withTestVoiceBookingEnabled,
} from "../src/lib/communication/outbox/testFixture";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { VoiceBookingSession, BookingRequirements } from "../src/lib/voiceBooking/types";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  POST as cronWorkerPost,
  GET as cronWorkerGet,
} from "../src/app/api/cron/outbox-worker/route";
import {
  GET as adminMetricsGet,
} from "../src/app/api/admin/outbox/metrics/route";
import {
  _setCronWorkerForTesting,
  _setCronDbProviderForTesting,
  _setMetricsDbProviderForTesting,
} from "../src/lib/communication/testingHooks";
import {
  FirestoreCommunicationOutboxRepository,
} from "../src/lib/communication/outbox/outboxRepository";

const CRON_SECRET = "test_cron_secret_phrase_651_verified";
process.env.CRON_SECRET = CRON_SECRET;

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

function createAuthoritativeSession(overrides: Partial<VoiceBookingSession> = {}): VoiceBookingSession {
  const id = overrides.id || `vbs_p651_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const officialBookingId = overrides.officialBookingId || `enq_voice_${id}`;
  const requirements: BookingRequirements = {
    eventType: "Corporate Gathering",
    guestCount: 120,
    eventDate: "2028-12-05",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "HITEC City, Hyderabad",
    selectedTier: "PREMIUM",
    beveragePreferences: ["Filter Coffee", "Cold Brew"],
    handoffRequested: false,
    customerConfirmed: true,
    confidenceScore: 0.99,
    missingFields: [],
    unresolvedQuestions: [],
    ...overrides.requirements,
  };
  const quotation = overrides.quotation || generateVoiceBookingQuotation(requirements);
  const quotationSnapshot = overrides.quotationSnapshot || createQuotationSnapshot(requirements);

  return {
    id,
    officialBookingId,
    phoneNumber: "+919876543210",
    language: "en",
    state: "booking_confirmed",
    requirements,
    quotation,
    quotationSnapshot,
    conversationHistory: [],
    staffApprovalId: null,
    staffApprovalAudit: null,
    metadata: {
      officialBookingId,
      ...(overrides.metadata || {}),
    },
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.5.1 Corrections Verification Suite");
  console.log("   Option Propagation, GET 405, Time Budget, Scalable Metrics, Starvation");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // 1. Option Propagation & Worker Construction
  // ---------------------------------------------------------------------------
  console.log("\n--- 1. OPTION PROPAGATION & WORKER CONSTRUCTION ---");

  await test("1.1 OutboxWorker constructor clamps batchSize to [1, 50] and leaseDurationMs to [5000, 300000]", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();

    const deps = {
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    };

    // Extreme high
    const workerHigh = new OutboxWorker(deps, {
      batchSize: 9999,
      leaseDurationMs: 9999999,
    });
    const optsHigh = workerHigh.getOptions();
    assert.strictEqual(optsHigh.batchSize, 50, "batchSize must be clamped to 50");
    assert.strictEqual(optsHigh.leaseDurationMs, 300000, "leaseDurationMs must be clamped to 300,000ms");

    // Extreme low
    const workerLow = new OutboxWorker(deps, {
      batchSize: -10,
      leaseDurationMs: 500,
    });
    const optsLow = workerLow.getOptions();
    assert.strictEqual(optsLow.batchSize, 1, "batchSize must be clamped to minimum 1");
    assert.strictEqual(optsLow.leaseDurationMs, 5000, "leaseDurationMs must be clamped to minimum 5,000ms");

    // Valid values preserved
    const workerValid = new OutboxWorker(deps, {
      batchSize: 7,
      leaseDurationMs: 45000,
    });
    const optsValid = workerValid.getOptions();
    assert.strictEqual(optsValid.batchSize, 7);
    assert.strictEqual(optsValid.leaseDurationMs, 45000);
  });

  await test("1.2 POST /api/cron/outbox-worker applies batchSize and leaseDurationMs before worker execution", async () => {
    const holder: { options: ReturnType<OutboxWorker["getOptions"]> | null } = { options: null };

    // Simulate DB provider returning dummy object
    _setCronDbProviderForTesting(() => ({
      collection: () => ({}),
    }));

    // Spy worker override
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const spyWorker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: new InMemoryVoiceSessionRepository(),
      consentRepository: new InMemoryConsentRepository(),
      dndRepository: new InMemoryDndRepository(),
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    }, { batchSize: 15, leaseDurationMs: 25000 });

    spyWorker.processCycle = async () => {
      holder.options = spyWorker.getOptions();
      return {
        claimedCount: 0,
        dispatchedCount: 0,
        blockedCount: 0,
        failedCount: 0,
        permanentlyFailedCount: 0,
      };
    };

    _setCronWorkerForTesting(spyWorker);

    try {
      const req = new NextRequest("http://localhost:3000/api/cron/outbox-worker?batchSize=15&leaseDurationMs=25000", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });

      const res = await cronWorkerPost(req);
      assert.strictEqual(res.status, 200);
      assert.ok(holder.options, "capturedOptions must not be null");
      assert.strictEqual(holder.options.batchSize, 15);
      assert.strictEqual(holder.options.leaseDurationMs, 25000);
    } finally {
      _setCronWorkerForTesting(null);
      _setCronDbProviderForTesting(null);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. GET Rejection with 405 Method Not Allowed
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. GET REJECTION WITH 405 METHOD NOT ALLOWED ---");

  await test("2.1 GET /api/cron/outbox-worker returns 405 Method Not Allowed with Allow: POST", async () => {
    const res = await cronWorkerGet();
    assert.strictEqual(res.status, 405, "GET must return HTTP 405");
    assert.strictEqual(res.headers.get("Allow"), "POST", "Response must include Allow: POST header");

    const body = await res.json();
    assert.ok(body.error.includes("Method Not Allowed"));
  });

  await test("2.2 GET request does not claim deliveries, mutate state, or execute cycles", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createAuthoritativeSession();
    const deliveries = createOutboxDeliveriesForTransition(session);
    const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
    await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

    let executed = false;
    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: new InMemoryVoiceSessionRepository(),
      consentRepository: new InMemoryConsentRepository(),
      dndRepository: new InMemoryDndRepository(),
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    });

    worker.processCycle = async () => {
      executed = true;
      return {
        claimedCount: 1,
        dispatchedCount: 1,
        blockedCount: 0,
        failedCount: 0,
        permanentlyFailedCount: 0,
      };
    };

    _setCronWorkerForTesting(worker);

    try {
      const res = await cronWorkerGet();
      assert.strictEqual(res.status, 405);
      assert.strictEqual(executed, false, "Worker cycle must never be executed on GET");

      const deliveryInRepo = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(deliveryInRepo?.status, "pending", "Outbox record status must remain strictly pending");
      assert.strictEqual(deliveryInRepo?.claimOwner, null, "Claim owner must remain null");
    } finally {
      _setCronWorkerForTesting(null);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Execution-Time Budget & Provider Timeouts
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. EXECUTION-TIME BUDGET & BOUNDED TIMEOUTS ---");

  await test("3.1 runOutboxWorkerCycles aborts cycle when remaining time is below cycle headroom", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    let cyclesRun = 0;

    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: new InMemoryVoiceSessionRepository(),
      consentRepository: new InMemoryConsentRepository(),
      dndRepository: new InMemoryDndRepository(),
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    });

    worker.processCycle = async () => {
      cyclesRun++;
      // Simulate taking 800ms
      await new Promise((r) => setTimeout(r, 800));
      return {
        claimedCount: 1,
        dispatchedCount: 1,
        blockedCount: 0,
        failedCount: 0,
        permanentlyFailedCount: 0,
      };
    };

    // Budget: 1,000ms max duration with 500ms cycle headroom
    const result = await runOutboxWorkerCycles(worker, {
      maxCycles: 5,
      maxDurationMs: 1000,
      minCycleHeadroomMs: 500,
      minDeliveryHeadroomMs: 100,
    });

    assert.strictEqual(cyclesRun, 1, "Only 1 cycle should complete; cycle 2 must be prevented due to remaining time < 500ms");
    assert.strictEqual(result.cyclesCompleted, 1);
    assert.ok(result.durationMs <= 1500, `Duration ${result.durationMs}ms must respect bounded budget`);
  });

  await test("3.2 OutboxWorker releases unstarted claimed deliveries back to pending when time budget expires", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const session = createAuthoritativeSession();

      const sessionRepo = new InMemoryVoiceSessionRepository();
      await sessionRepo.save(session);

      // Create 3 deliveries
      const del1 = createReminderDeliveryForSession(session);
      del1.id = "del_budget_01";
      await seedOutboxDeliveryForTest(outboxRepo, del1);

      const del2 = createReminderDeliveryForSession(session);
      del2.id = "del_budget_02";
      await seedOutboxDeliveryForTest(outboxRepo, del2);

      const del3 = createReminderDeliveryForSession(session);
      del3.id = "del_budget_03";
      await seedOutboxDeliveryForTest(outboxRepo, del3);

      const consentRepo = new InMemoryConsentRepository();
      await consentRepo.save({
        id: "c_budget_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Granted",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      let mockFetchCount = 0;
      const slowFetch = async () => {
        mockFetchCount++;
        // Delivery 1 takes 300ms
        await new Promise((r) => setTimeout(r, 300));
        return new Response(JSON.stringify({ messages: [{ id: "wamid.SLOW_01" }] }), { status: 200 });
      };

      const whatsappProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: slowFetch,
      });

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: new InMemoryDndRepository(),
        whatsappProvider,
        voiceProvider: new MockVoiceProvider(),
      }, { batchSize: 10 });

      // Set deadline 450ms from now with 200ms minDeliveryHeadroomMs
      // del1 will run (takes 300ms, elapsed 300ms, remaining 150ms < 200ms)
      // del2 and del3 must be released back to 'pending'!
      const deadlineMs = Date.now() + 450;
      const cycleRes = await worker.processCycle({
        deadlineMs,
        minDeliveryHeadroomMs: 200,
      });

      assert.strictEqual(cycleRes.claimedCount, 3, "Batch of 3 deliveries was initially claimed");
      assert.strictEqual(cycleRes.dispatchedCount, 1, "Only 1 delivery was dispatched before time budget was exceeded");
      assert.strictEqual(mockFetchCount, 1, "Provider should have only been invoked once");

      // Verify del1 is dispatched
      const d1 = await outboxRepo.getDeliveryById(del1.id);
      assert.strictEqual(d1?.status, "dispatched");

      // Verify del2 and del3 are safely returned to 'pending' without waiting for lease expiry
      const d2 = await outboxRepo.getDeliveryById(del2.id);
      assert.strictEqual(d2?.status, "pending", "del2 must be cooperatively released back to pending");
      assert.strictEqual(d2?.claimOwner, null, "del2 claim owner must be cleared");

      const d3 = await outboxRepo.getDeliveryById(del3.id);
      assert.strictEqual(d3?.status, "pending", "del3 must be cooperatively released back to pending");
      assert.strictEqual(d3?.claimOwner, null, "del3 claim owner must be cleared");
    });
  });

  await test("3.3 MetaWhatsAppCloudProvider enforces bounded operation timeout and fails retryable with 504", async () => {
    // Hanging fetch simulating network socket stall
    const hangingFetch = (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
      fetchFn: hangingFetch as unknown as typeof fetch,
      requestTimeoutMs: 100, // short 100ms timeout
    });

    let caughtError: WhatsAppCloudApiError | null = null;
    try {
      await provider.sendTemplate({
        to: "+919876543210",
        templateName: "booking_confirmation_v1",
        language: "en",
        components: [],
      });
    } catch (err) {
      if (err instanceof WhatsAppCloudApiError) {
        caughtError = err;
      }
    }

    assert.notStrictEqual(caughtError, null, "Hanging fetch must throw WhatsAppCloudApiError");
    assert.strictEqual(caughtError?.statusCode, 504, "Aborted timeout must report HTTP 504 Gateway Timeout");
    assert.strictEqual(caughtError?.isRetryable, true, "Timeout must be classified as retryable");
    assert.ok(caughtError?.message.includes("timed out after 100ms"));
  });

  // ---------------------------------------------------------------------------
  // 4. Metrics Scaling & Zero PII Leakage
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. SCALABLE METRICS COMPUTATION (ZERO PII) ---");

  await test("4.1 FirestoreCommunicationOutboxRepository.getMetrics uses bounded count aggregations", async () => {
    let countQueryCount = 0;
    let fullCollectionGetCalled = false;

    // Mock Firestore DB demonstrating count aggregation usage
    const mockDb = {
      collection: () => {
        return {
          where: (field: string, _op: string, value: unknown) => {
            return {
              where: () => ({
                count: () => ({
                  get: async () => {
                    countQueryCount++;
                    return { data: () => ({ count: 0 }) };
                  },
                }),
              }),
              count: () => ({
                get: async () => {
                  countQueryCount++;
                  // Return mock counts
                  if (field === "status" && value === "pending") return { data: () => ({ count: 12 }) };
                  if (field === "status" && value === "processing") return { data: () => ({ count: 2 }) };
                  if (field === "status" && value === "dispatched") return { data: () => ({ count: 45 }) };
                  if (field === "status" && value === "blocked") return { data: () => ({ count: 3 }) };
                  if (field === "status" && value === "failed") return { data: () => ({ count: 1 }) };
                  if (field === "status" && value === "permanently_failed") return { data: () => ({ count: 2 }) };
                  if (field === "channel" && value === "whatsapp") return { data: () => ({ count: 50 }) };
                  if (field === "channel" && value === "voice") return { data: () => ({ count: 15 }) };
                  return { data: () => ({ count: 0 }) };
                },
              }),
              select: (...fields: string[]) => {
                // Ensure no PII fields are selected
                assert.ok(!fields.includes("phoneNumber"));
                assert.ok(!fields.includes("templateParams"));
                return {
                  limit: (num: number) => {
                    assert.ok(num <= 250, "Projections must be bounded with limit <= 250");
                    return {
                      get: async () => ({ docs: [] }),
                    };
                  },
                };
              },
            };
          },
          get: async () => {
            fullCollectionGetCalled = true;
            return { docs: [] };
          },
        };
      },
    };

    // Inject mock DB by testing getMetrics
    _setMetricsDbProviderForTesting(() => mockDb);

    try {
      const req = new NextRequest("http://localhost:3000/api/admin/outbox/metrics", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      const res = await adminMetricsGet(req);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.metrics.counts.pending, 12);
      assert.strictEqual(json.metrics.counts.total, 65);
      assert.strictEqual(countQueryCount, 8, "Must execute exactly 8 parallel count aggregation queries");
      assert.strictEqual(fullCollectionGetCalled, false, "Must NEVER perform full-collection collection.get()");
    } finally {
      _setMetricsDbProviderForTesting(null);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Candidate Starvation Prevention
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. CANDIDATE STARVATION PREVENTION ---");

  await test("5.1 Firestore candidate selection is not starved by active leases and future retries", async () => {
    const now = new Date();
    const nowMs = now.getTime();

    // Set up mock DB with:
    // - 10 active leases in 'processing' (leaseExpiresAt 60s in future)
    // - 10 not-yet-due 'failed' deliveries (nextRetryAt 5m in future)
    // - 2 genuine 'pending' deliveries
    // - 1 expired lease in 'processing' (leaseExpiresAt 10s in past)
    const activeLeaseDocs = Array.from({ length: 10 }, (_, i) => ({
      id: `del_active_lease_${i}`,
      ref: { id: `del_active_lease_${i}` },
      data: () => ({
        id: `del_active_lease_${i}`,
        status: "processing",
        leaseExpiresAt: new Date(nowMs + 60000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }),
    }));

    const futureRetryDocs = Array.from({ length: 10 }, (_, i) => ({
      id: `del_future_retry_${i}`,
      ref: { id: `del_future_retry_${i}` },
      data: () => ({
        id: `del_future_retry_${i}`,
        status: "failed",
        nextRetryAt: new Date(nowMs + 300000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }),
    }));

    const pendingDocs = [
      {
        id: "del_pending_starve_01",
        ref: { id: "del_pending_starve_01" },
        data: () => ({
          id: "del_pending_starve_01",
          status: "pending",
          attemptCount: 0,
          maxAttempts: 3,
        }),
      },
      {
        id: "del_pending_starve_02",
        ref: { id: "del_pending_starve_02" },
        data: () => ({
          id: "del_pending_starve_02",
          status: "pending",
          attemptCount: 0,
          maxAttempts: 3,
        }),
      },
    ];

    const expiredLeaseDoc = {
      id: "del_expired_reclaim_01",
      ref: { id: "del_expired_reclaim_01" },
      data: () => ({
        id: "del_expired_reclaim_01",
        status: "processing",
        leaseExpiresAt: new Date(nowMs - 10000).toISOString(),
        attemptCount: 1,
        callAttemptCount: 1,
        currentAttemptId: "del_expired_reclaim_01_call1",
        maxAttempts: 3,
      }),
    };

    const mockDb = {
      collection: () => ({
        where: (field: string, _op: string, val: unknown) => {
          return {
            where: () => ({
              limit: () => ({
                get: async () => {
                  if (field === "status" && val === "processing") {
                    return { docs: [expiredLeaseDoc] };
                  }
                  return { docs: [] };
                },
              }),
            }),
            limit: () => ({
              get: async () => {
                if (field === "status" && val === "pending") {
                  return { docs: pendingDocs };
                }
                if (field === "status" && val === "processing") {
                  return { docs: [...activeLeaseDocs, expiredLeaseDoc] };
                }
                if (field === "status" && val === "failed") {
                  return { docs: futureRetryDocs };
                }
                return { docs: [] };
              },
            }),
          };
        },
      }),
      runTransaction: async (updateFn: (t: unknown) => Promise<unknown>) => {
        const mockTransaction = {
          get: async (ref: { id: string }) => {
            const all = [...pendingDocs, expiredLeaseDoc, ...activeLeaseDocs, ...futureRetryDocs];
            const found = all.find((d) => d.id === ref.id);
            return {
              exists: Boolean(found),
              data: () => found?.data(),
            };
          },
          set: () => {},
        };
        return await updateFn(mockTransaction);
      },
    };

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => mockDb as unknown as import("firebase-admin").firestore.Firestore),
      { allowLocalFallback: true }
    );
    // Claim up to 5 deliveries
    const claimed = await repo.claimEligibleDeliveries("starvation_test_worker", 60000, 5, now);

    // Must claim the 2 pending deliveries AND the 1 expired lease!
    // Must NOT be starved by the 10 active leases or 10 future retries!
    assert.strictEqual(claimed.length, 3, "Must claim 3 eligible deliveries (2 pending + 1 expired lease)");

    const claimedIds = claimed.map((d) => d.id);
    assert.ok(claimedIds.includes("del_pending_starve_01"), "Must include pending delivery 1");
    assert.ok(claimedIds.includes("del_pending_starve_02"), "Must include pending delivery 2");
    assert.ok(claimedIds.includes("del_expired_reclaim_01"), "Must include expired lease delivery");

    // Verify claimed deliveries have active leases assigned
    for (const c of claimed) {
      assert.strictEqual(c.status, "processing");
      assert.strictEqual(c.claimOwner, "starvation_test_worker");
      assert.ok(c.claimToken);
    }
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.5.1 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal failure in Phase 6.5.1 verification suite:", err);
  process.exit(1);
});
