/**
 * BREW Coffee Platform — Phase 6.5.2 Verification Suite
 * Queue Fairness & Metrics Corrections:
 * 1. Queue Fairness & Backlog Starvation Prevention (Expired Leases, Due Retries, Pending)
 * 2. Visible Query / Composite Index Failures (No Blind Scans)
 * 3. Exact Metrics Fidelity & Aggregation Failure Handling (No Silent 500 Sample)
 * 4. Response-Body Streaming Timeout (Retryable 504 Gateway Timeout)
 * 5. Execution Deadline & Bounded Operations
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import {
  OutboxWorker,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  MockVoiceProvider,
  MockWhatsAppProvider,
  MetaWhatsAppCloudProvider,
  WhatsAppCloudApiError,
  CommunicationDeliveryRecord,
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
  FirestoreCommunicationOutboxRepository,
  computeOutboxMetricsFromRecords,
} from "../src/lib/communication/outbox/outboxRepository";

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
  const id = overrides.id || `vbs_p652_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
    ...overrides,
  };
}

function createValidDeliveryRecord(overrides: Partial<CommunicationDeliveryRecord> = {}): CommunicationDeliveryRecord {
  const id = overrides.id || `del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    eventId: `evt_${id}`,
    sessionId: "sess_p652_default",
    officialBookingId: "enq_p652_default",
    eventType: "booking_confirmed",
    channel: "whatsapp",
    purpose: "transactional_update",
    status: "pending",
    phoneNumberMasked: "+91 ••••• •••10",
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.5.2 Corrections Verification Suite");
  console.log("   Queue Fairness, Index Failures, Metrics Fidelity, Streaming Timeout");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // 1. Queue Fairness & Backlog Starvation Prevention
  // ---------------------------------------------------------------------------
  console.log("\n--- 1. QUEUE FAIRNESS & BACKLOG STARVATION PREVENTION ---");

  await test("1.1 InMemoryCommunicationOutboxRepository fairly interleaves expired leases, due retries, and pending deliveries", async () => {
    const repo = new TestInMemoryCommunicationOutboxRepository();
    const now = new Date();
    const nowMs = now.getTime();

    // Seed 1 expired lease
    const expiredLeaseRecord = createValidDeliveryRecord({
      id: "del_fair_expired_01",
      sessionId: "sess_fair_01",
      officialBookingId: "enq_fair_01",
      status: "processing",
      attemptCount: 1,
      claimOwner: "abandoned_worker",
      claimToken: "stale_token",
      claimedAt: new Date(nowMs - 120000).toISOString(),
      leaseExpiresAt: new Date(nowMs - 60000).toISOString(),
      createdAt: new Date(nowMs - 120000).toISOString(),
      updatedAt: new Date(nowMs - 120000).toISOString(),
    });
    await seedOutboxDeliveryForTest(repo, expiredLeaseRecord);

    // Seed 1 due retry
    const dueRetryRecord = createValidDeliveryRecord({
      id: "del_fair_retry_01",
      sessionId: "sess_fair_02",
      officialBookingId: "enq_fair_02",
      status: "failed",
      attemptCount: 1,
      nextRetryAt: new Date(nowMs - 10000).toISOString(),
      lastError: {
        code: "NETWORK_ERROR",
        message: "Simulated retryable glitch",
        isRetryable: true,
        occurredAt: new Date(nowMs - 10000).toISOString(),
        attempt: 1,
      },
      createdAt: new Date(nowMs - 60000).toISOString(),
      updatedAt: new Date(nowMs - 10000).toISOString(),
    });
    await seedOutboxDeliveryForTest(repo, dueRetryRecord);

    // Seed 10 fresh pending deliveries
    for (let i = 1; i <= 10; i++) {
      const pendingRecord = createValidDeliveryRecord({
        id: `del_fair_pending_${i.toString().padStart(2, "0")}`,
        sessionId: `sess_fair_pending_${i}`,
        officialBookingId: `enq_fair_pending_${i}`,
        status: "pending",
        attemptCount: 0,
        createdAt: new Date(nowMs - 5000 + i).toISOString(),
        updatedAt: new Date(nowMs - 5000 + i).toISOString(),
      });
      await seedOutboxDeliveryForTest(repo, pendingRecord);
    }

    // Claim a batch of 3 deliveries
    const claimedBatch1 = await repo.claimEligibleDeliveries("fair_worker_1", 60000, 3, now);
    assert.strictEqual(claimedBatch1.length, 3, "Batch size limit 3 must be respected");

    const batch1Ids = claimedBatch1.map((d) => d.id);
    // Fair round-robin allocation MUST take 1 expired lease, 1 due retry, and 1 pending!
    assert.ok(
      batch1Ids.includes("del_fair_expired_01"),
      "Batch of 3 under 10-pending backlog MUST include the expired lease (no starvation)"
    );
    assert.ok(
      batch1Ids.includes("del_fair_retry_01"),
      "Batch of 3 under 10-pending backlog MUST include the due retry (no starvation)"
    );
    assert.ok(
      batch1Ids.includes("del_fair_pending_01"),
      "Batch of 3 under 10-pending backlog MUST include the first pending delivery"
    );
  });

  await test("1.2 FirestoreCommunicationOutboxRepository fairly allocates candidates across all three groups", async () => {
    const now = new Date();
    const nowMs = now.getTime();

    const expiredDoc = {
      id: "fs_fair_expired_01",
      ref: { id: "fs_fair_expired_01" },
      data: () => ({
        id: "fs_fair_expired_01",
        status: "processing",
        leaseExpiresAt: new Date(nowMs - 30000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }),
    };

    const retryDoc = {
      id: "fs_fair_retry_01",
      ref: { id: "fs_fair_retry_01" },
      data: () => ({
        id: "fs_fair_retry_01",
        status: "failed",
        nextRetryAt: new Date(nowMs - 5000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }),
    };

    const pendingDocs = Array.from({ length: 15 }, (_, i) => ({
      id: `fs_fair_pending_${(i + 1).toString().padStart(2, "0")}`,
      ref: { id: `fs_fair_pending_${(i + 1).toString().padStart(2, "0")}` },
      data: () => ({
        id: `fs_fair_pending_${(i + 1).toString().padStart(2, "0")}`,
        status: "pending",
        attemptCount: 0,
        maxAttempts: 3,
      }),
    }));

    const mockDb = {
      collection: () => ({
        where: (field1: string, _op1: string, val1: unknown) => {
          return {
            where: (field2: string) => ({
              limit: (lim: number) => ({
                get: async () => {
                  if (field1 === "status" && val1 === "processing" && field2 === "leaseExpiresAt") {
                    return { docs: [expiredDoc].slice(0, lim) };
                  }
                  if (field1 === "status" && val1 === "failed" && field2 === "nextRetryAt") {
                    return { docs: [retryDoc].slice(0, lim) };
                  }
                  return { docs: [] };
                },
              }),
            }),
            limit: (lim: number) => ({
              get: async () => {
                if (field1 === "status" && val1 === "pending") {
                  return { docs: pendingDocs.slice(0, lim) };
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
            const all = [expiredDoc, retryDoc, ...pendingDocs];
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

    // Request batch of 4 under 15-item pending backlog
    const claimed = await repo.claimEligibleDeliveries("fs_fairness_worker", 60000, 4, now);
    assert.strictEqual(claimed.length, 4, "Batch size limit 4 must be respected");

    const claimedIds = claimed.map((d) => d.id);
    assert.ok(claimedIds.includes("fs_fair_expired_01"), "Batch must include expired lease");
    assert.ok(claimedIds.includes("fs_fair_retry_01"), "Batch must include due retry");
    assert.ok(claimedIds.includes("fs_fair_pending_01"), "Batch must include pending delivery 1");
    assert.ok(claimedIds.includes("fs_fair_pending_02"), "Batch must include pending delivery 2");
  });

  // ---------------------------------------------------------------------------
  // 2. Visible Query / Composite Index Failures
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. VISIBLE QUERY / COMPOSITE INDEX FAILURES ---");

  await test("2.1 Firestore candidate selection fails visibly when configured indexed query fails", async () => {
    const mockFailingDb = {
      collection: () => ({
        where: (field1: string, _op1: string, val1: unknown) => {
          return {
            where: () => ({
              limit: () => ({
                get: async () => {
                  if (field1 === "status" && val1 === "processing") {
                    throw new Error(
                      "FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/..."
                    );
                  }
                  return { docs: [] };
                },
              }),
            }),
            limit: () => ({
              get: async () => ({ docs: [] }),
            }),
          };
        },
      }),
    };

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => mockFailingDb as unknown as import("firebase-admin").firestore.Firestore)
    );

    await assert.rejects(
      async () => {
        await repo.claimEligibleDeliveries("test_worker", 60000, 10, new Date());
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("[OUTBOX_INDEX_QUERY_ERROR]"),
          `Expected [OUTBOX_INDEX_QUERY_ERROR], received: ${err.message}`
        );
        assert.ok(
          err.message.includes("firestore.indexes.json"),
          `Expected index deployment guidance, received: ${err.message}`
        );
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Exact Metrics Fidelity & Aggregation Failure Handling
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. EXACT METRICS FIDELITY & AGGREGATION FAILURE HANDLING ---");

  await test("3.1 Firestore metrics computation returns exact fidelity metadata on successful aggregation", async () => {
    const mockAggDb = {
      collection: () => ({
        where: (field: string, _op: string, val: unknown) => ({
          count: () => ({
            get: async () => ({
              data: () => ({
                count: val === "pending" ? 7 : val === "dispatched" ? 43 : 0,
              }),
            }),
          }),
          select: () => ({
            limit: () => ({
              get: async () => ({ docs: [] }),
            }),
          }),
        }),
      }),
    };

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => mockAggDb as unknown as import("firebase-admin").firestore.Firestore)
    );

    const metrics = await repo.getMetrics(new Date());
    assert.strictEqual(metrics.counts.pending, 7);
    assert.strictEqual(metrics.counts.dispatched, 43);
    assert.strictEqual(metrics.counts.total, 50);
    assert.strictEqual(metrics.components?.counts.fidelity, "exact");
    assert.strictEqual(metrics.components?.counts.isExact, true);
    assert.strictEqual(metrics.fidelity, "sampled");
    assert.strictEqual(metrics.isExact, false);
  });

  await test("3.2 Firestore metrics computation fails visibly when count aggregation fails (no silent 500-sample)", async () => {
    const mockFailingAggDb = {
      collection: () => ({
        where: () => ({
          count: () => ({
            get: async () => {
              throw new Error("UNAVAILABLE: Datastore service temporarily unavailable");
            },
          }),
        }),
        limit: () => ({
          get: async () => {
            throw new Error("Should not be called! Fallback scan must be eliminated.");
          },
        }),
      }),
    };

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => mockFailingAggDb as unknown as import("firebase-admin").firestore.Firestore)
    );

    await assert.rejects(
      async () => {
        await repo.getMetrics(new Date());
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("[OUTBOX_METRICS_AGGREGATION_FAILED]"),
          `Expected [OUTBOX_METRICS_AGGREGATION_FAILED], received: ${err.message}`
        );
        return true;
      }
    );
  });

  await test("3.3 computeOutboxMetricsFromRecords clearly distinguishes exact from sampled calculations", () => {
    const records = [
      createValidDeliveryRecord({
        id: "rec_sample_01",
        status: "pending",
      }),
    ];

    // Default calculation is exact
    const exactMetrics = computeOutboxMetricsFromRecords(records);
    assert.strictEqual(exactMetrics.fidelity, "exact");
    assert.strictEqual(exactMetrics.isExact, true);
    assert.strictEqual(exactMetrics.sampleDetails, undefined);

    // Explicit sampled calculation
    const sampledMetrics = computeOutboxMetricsFromRecords(records, new Date(), {
      fidelity: "sampled",
      sampleSize: 100,
      sampleReason: "high_volume_estimate",
    });
    assert.strictEqual(sampledMetrics.fidelity, "sampled");
    assert.strictEqual(sampledMetrics.isExact, false);
    assert.strictEqual(sampledMetrics.sampleDetails?.sampleSize, 100);
    assert.strictEqual(sampledMetrics.sampleDetails?.reason, "high_volume_estimate");
  });

  // ---------------------------------------------------------------------------
  // 4. Response-Body Streaming Timeout
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. RESPONSE-BODY STREAMING TIMEOUT ---");

  await test("4.1 MetaWhatsAppCloudProvider aborts when response body consumption hangs after 200 OK headers", async () => {
    // Custom fetchFn: immediately returns HTTP 200 OK Response, but response.text() hangs indefinitely
    const hangingBodyFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const signal = init?.signal;

      const hangingStream = new ReadableStream({
        start(controller) {
          if (signal) {
            signal.addEventListener("abort", () => {
              controller.error(new Error("Stream aborted by client timeout"));
            });
          }
        },
      });

      return new Response(hangingStream, {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "109876543210987",
      accessToken: "EAAG_TEST_ACCESS_TOKEN_PHASE652",
      allowedRecipients: ["919876543210"],
      fetchFn: hangingBodyFetch as unknown as typeof fetch,
      requestTimeoutMs: 75, // Strict 75ms timeout
    });

    await assert.rejects(
      async () => {
        await provider.sendTemplate({
          to: "+919876543210",
          templateName: "brew_booking_confirmed",
          language: "en",
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Gnanendhra" },
                { type: "text", text: "2028-12-05" },
                { type: "text", text: "14:00" },
                { type: "text", text: "HITEC City" },
                { type: "text", text: "enq_voice_12345" },
              ],
            },
          ],
        });
      },
      (err: Error) => {
        assert.ok(err instanceof WhatsAppCloudApiError, "Must throw WhatsAppCloudApiError");
        assert.strictEqual((err as WhatsAppCloudApiError).statusCode, 504, "Must return 504 Gateway Timeout");
        assert.strictEqual((err as WhatsAppCloudApiError).isRetryable, true, "Timeout MUST remain retryable");
        assert.ok(
          err.message.includes("timed out after 75ms"),
          `Expected timeout error message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Execution Deadline & Bounded Operations
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. EXECUTION DEADLINE & BOUNDED OPERATIONS ---");

  await test("5.1 OutboxWorker releases unstarted claimed deliveries back to pending when execution budget expires", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();

    const session = createAuthoritativeSession({ id: "vbs_deadline_01" });
    await sessionRepo.save(session);
    await consentRepo.save({
      id: "c_p652_deadline_01",
      phoneNumber: session.phoneNumber,
      channel: "whatsapp",
      purpose: "transactional_update",
      eventType: "grant",
      granted: true,
      consentText: "Granted",
      consentVersion: "v1.0",
      timestamp: new Date().toISOString(),
    });

    const now = new Date();
    // Seed 3 pending deliveries
    for (let i = 1; i <= 3; i++) {
      await seedOutboxDeliveryForTest(
        outboxRepo,
        createValidDeliveryRecord({
          id: `del_deadline_${i}`,
          sessionId: session.id,
          officialBookingId: session.officialBookingId ?? undefined,
          status: "pending",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
      );
    }

    // Mock WhatsApp provider that takes 120ms for delivery 1
    const slowProvider = new MockWhatsAppProvider();
    const origSend = slowProvider.sendTemplate.bind(slowProvider);
    slowProvider.sendTemplate = async (params) => {
      await new Promise((r) => setTimeout(r, 120));
      return origSend(params);
    };

    const worker = new OutboxWorker({
      sessionRepository: sessionRepo,
      outboxRepository: outboxRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      whatsappProvider: slowProvider,
      voiceProvider: new MockVoiceProvider(),
    });

    // Provide a tight deadline of now + 150ms with 100ms headroom
    const deadlineMs = Date.now() + 150;
    const cycleResult = await withTestVoiceBookingEnabled(async () => {
      return await worker.processCycle({
        deadlineMs,
        minDeliveryHeadroomMs: 100,
      });
    });

    // Delivery 1 takes 120ms. Remaining time = 30ms < 100ms headroom.
    // Deliveries 2 and 3 must be released back to pending!
    assert.strictEqual(cycleResult.claimedCount, 3, "Claimed all 3 in the batch");
    assert.strictEqual(cycleResult.dispatchedCount, 1, "Only 1 delivery was dispatched before time budget expired");

    const record1 = await outboxRepo.getDeliveryById("del_deadline_1");
    const record2 = await outboxRepo.getDeliveryById("del_deadline_2");
    const record3 = await outboxRepo.getDeliveryById("del_deadline_3");

    assert.strictEqual(record1?.status, "dispatched", "Delivery 1 was dispatched");
    assert.strictEqual(record2?.status, "pending", "Delivery 2 was released back to pending");
    assert.strictEqual(record2?.claimOwner, null, "Delivery 2 claimOwner cleared");
    assert.strictEqual(record3?.status, "pending", "Delivery 3 was released back to pending");
    assert.strictEqual(record3?.claimOwner, null, "Delivery 3 claimOwner cleared");
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.5.2 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal failure in Phase 6.5.2 verification suite:", err);
  process.exit(1);
});
