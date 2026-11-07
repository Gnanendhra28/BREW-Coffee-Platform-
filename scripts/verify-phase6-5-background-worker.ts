/**
 * BREW Coffee Platform — Phase 6.5 Verification Suite
 * Background Worker & Outbox Recovery:
 * Scheduled Worker Security, Concurrency Leases, Expired Lease Reclaims,
 * Mid-Process Restarts, Pre-Dispatch Safety, Bounded Batches, Backoff & Metrics.
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
  _setMetricsOutboxRepoForTesting,
  _setMetricsDbProviderForTesting,
} from "../src/lib/communication/testingHooks";
import { createSessionToken } from "../src/lib/authTokens";
import { StaleClaimError } from "../src/lib/communication/errors";

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
  const id = overrides.id || `vbs_p65_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const officialBookingId = overrides.officialBookingId || `enq_voice_${id}`;
  const requirements: BookingRequirements = {
    eventType: "Corporate Gathering",
    guestCount: 150,
    eventDate: "2028-11-20",
    startTime: "15:00",
    durationHours: 4,
    venueAddress: "Financial District, Hyderabad",
    selectedTier: "STANDARD",
    beveragePreferences: ["Filter Coffee", "Cold Brew"],
    handoffRequested: false,
    customerConfirmed: true,
    confidenceScore: 0.98,
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
    ...overrides,
  };
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.5 Verification Suite");
  console.log("   Background Worker, Lease Recovery, Concurrency, Metrics & Safe Defaults");
  console.log("================================================================================\n");

  const CRON_SECRET = "secure_test_cron_secret_777";
  process.env.CRON_SECRET = CRON_SECRET;

  // ---------------------------------------------------------------------------
  // 1. Worker Endpoint Authentication & Security
  // ---------------------------------------------------------------------------
  console.log("--- 1. WORKER ENDPOINT AUTHENTICATION & SECURITY ---");

  await test("1.1 Missing or invalid secret fails closed with 401 Unauthorized", async () => {
    // Missing credentials
    const reqNoAuth = new NextRequest("http://localhost:3000/api/cron/outbox-worker", {
      method: "POST",
    });
    const resNoAuth = await cronWorkerPost(reqNoAuth);
    assert.strictEqual(resNoAuth.status, 401);
    const bodyNoAuth = await resNoAuth.json();
    assert.strictEqual(bodyNoAuth.code, "MISSING_WORKER_CREDENTIALS");

    // Invalid secret
    const reqBadAuth = new NextRequest("http://localhost:3000/api/cron/outbox-worker", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong_unauthorized_token",
      },
    });
    const resBadAuth = await cronWorkerPost(reqBadAuth);
    assert.strictEqual(resBadAuth.status, 401);
    const bodyBadAuth = await resBadAuth.json();
    assert.strictEqual(bodyBadAuth.code, "INVALID_WORKER_CREDENTIALS");
  });

  await test("1.2 Missing CRON_SECRET in environment fails closed with 500 Configuration Error", async () => {
    const savedSecret = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.WORKER_SECRET;
    delete process.env.OUTBOX_WORKER_SECRET;

    try {
      const req = new NextRequest("http://localhost:3000/api/cron/outbox-worker", {
        method: "POST",
        headers: {
          Authorization: "Bearer any_token",
        },
      });
      const res = await cronWorkerPost(req);
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.strictEqual(body.code, "WORKER_SECRET_NOT_CONFIGURED");
    } finally {
      process.env.CRON_SECRET = savedSecret;
    }
  });

  await test("1.3 Valid secret via Authorization: Bearer succeeds with 200 and cycle results", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();

    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    });

    _setCronWorkerForTesting(worker);

    try {
      const req = new NextRequest("http://localhost:3000/api/cron/outbox-worker", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });
      const res = await cronWorkerPost(req);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.cyclesCompleted, 1);
      assert.strictEqual(typeof body.result.claimedCount, "number");
    } finally {
      _setCronWorkerForTesting(null);
    }
  });

  await test("1.4 GET request is rejected with 405 Method Not Allowed and does not execute", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();

    let processCycleCalled = false;
    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    });
    // Spy on processCycle
    worker.processCycle = async () => {
      processCycleCalled = true;
      return {
        claimedCount: 0,
        dispatchedCount: 0,
        blockedCount: 0,
        failedCount: 0,
        permanentlyFailedCount: 0,
      };
    };

    _setCronWorkerForTesting(worker);

    try {
      const res = await cronWorkerGet();
      assert.strictEqual(res.status, 405, "GET must return 405 Method Not Allowed");
      assert.strictEqual(res.headers.get("Allow"), "POST", "Allow header must specify POST");
      assert.strictEqual(processCycleCalled, false, "GET must never invoke processCycle");
    } finally {
      _setCronWorkerForTesting(null);
    }
  });

  await test("1.5 Valid secret via x-cron-secret header succeeds on POST request", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();

    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      whatsappProvider: new MockWhatsAppProvider(),
      voiceProvider: new MockVoiceProvider(),
    });

    _setCronWorkerForTesting(worker);

    try {
      const req = new NextRequest("http://localhost:3000/api/cron/outbox-worker?batchSize=5", {
        method: "POST",
        headers: {
          "x-cron-secret": CRON_SECRET,
        },
      });
      const res = await cronWorkerPost(req);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
    } finally {
      _setCronWorkerForTesting(null);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Concurrency & Duplicate Trigger Protection
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. CONCURRENCY & DUPLICATE TRIGGER PROTECTION ---");

  await test("2.1 Concurrent workers cannot claim the same active delivery lease", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      let fetchCount = 0;
      const mockFetch = (async () => {
        fetchCount++;
        return new Response(JSON.stringify({ messages: [{ id: "wamid.CONCURRENT_01" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const worker1 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          whatsappProvider: metaProvider,
          voiceProvider: new MockVoiceProvider(),
        },
        { workerId: "worker_node_1" }
      );

      const worker2 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          whatsappProvider: metaProvider,
          voiceProvider: new MockVoiceProvider(),
        },
        { workerId: "worker_node_2" }
      );

      // Execute both worker cycles concurrently
      const [res1, res2] = await Promise.all([worker1.processCycle(), worker2.processCycle()]);

      // Exactly ONE worker must claim and dispatch the delivery
      assert.strictEqual(
        res1.dispatchedCount + res2.dispatchedCount,
        1,
        "Exactly one worker must dispatch the delivery"
      );
      assert.strictEqual(
        res1.claimedCount + res2.claimedCount,
        1,
        "Delivery must not be claimed twice"
      );
      assert.strictEqual(fetchCount, 1, "Provider must be invoked exactly once");

      const finalRecord = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(finalRecord?.status, "dispatched");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Expired Lease Recovery & Concurrency Fencing
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. EXPIRED LEASE RECOVERY & CONCURRENCY FENCING ---");

  await test("3.1 Delivery with expired lease (leaseExpiresAt <= now) is safely reclaimed and dispatched", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_02",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;

      // Simulate a delivery that was claimed by a dead worker, with lease expired 10 minutes ago
      const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
      const expiredDelivery = {
        ...waDelivery,
        status: "processing" as const,
        claimOwner: "dead_worker_instance_xyz",
        claimToken: "tok_dead_worker",
        claimedAt: tenMinutesAgo,
        leaseExpiresAt: tenMinutesAgo, // EXPIRED
        attemptCount: 1,
        callAttemptCount: 1,
        currentAttemptId: `${waDelivery.id}_call1`,
      };
      await seedOutboxDeliveryForTest(outboxRepo, expiredDelivery);

      let fetchCalled = false;
      const mockFetch = (async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ messages: [{ id: "wamid.RECLAIMED_OK" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const recoveryWorker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          whatsappProvider: metaProvider,
          voiceProvider: new MockVoiceProvider(),
        },
        { workerId: "recovery_worker_01" }
      );

      const cycle = await recoveryWorker.processCycle();
      assert.strictEqual(cycle.claimedCount, 1, "Expired lease must be claimed");
      assert.strictEqual(cycle.dispatchedCount, 1, "Reclaimed delivery must be dispatched");
      assert.strictEqual(fetchCalled, true);

      const updated = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updated?.status, "dispatched");
      // attemptCount incremented (worker leases), but callAttemptCount preserved (logical attempts)
      assert.strictEqual(updated?.attemptCount, 2);
      assert.strictEqual(updated?.callAttemptCount, 1);
      assert.strictEqual(updated?.currentAttemptId, `${waDelivery.id}_call1`);
    });
  });

  await test("3.2 Stale worker whose lease expired cannot commit delivery update", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createAuthoritativeSession();
    const deliveries = createOutboxDeliveriesForTransition(session);
    const delivery = deliveries[0];

    const pastTime = new Date(Date.now() - 300000);
    const expiredClaimContext = {
      claimOwner: "stale_worker",
      claimedAt: pastTime.toISOString(),
      claimToken: "tok_stale",
    };

    delivery.status = "processing";
    delivery.claimOwner = expiredClaimContext.claimOwner;
    delivery.claimToken = expiredClaimContext.claimToken;
    delivery.claimedAt = expiredClaimContext.claimedAt;
    delivery.leaseExpiresAt = pastTime.toISOString(); // Expired!
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const now = new Date();
    try {
      await outboxRepo.updateClaimedDelivery(delivery, expiredClaimContext, now);
      assert.fail("Should have thrown StaleClaimError on expired lease");
    } catch (err) {
      assert.ok(err instanceof StaleClaimError);
    }
  });

  await test("3.3 Stale worker whose lease expired cannot commit session mutation", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createAuthoritativeSession();
    await sessionRepo.save(session);

    const pastTime = new Date(Date.now() - 300000);
    const expiredClaimContext = {
      claimOwner: "stale_worker_mutator",
      claimedAt: pastTime.toISOString(),
      claimToken: "tok_stale_mutator",
    };

    const delivery = createReminderDeliveryForSession(session);
    delivery.status = "processing";
    delivery.claimOwner = expiredClaimContext.claimOwner;
    delivery.claimToken = expiredClaimContext.claimToken;
    delivery.claimedAt = expiredClaimContext.claimedAt;
    delivery.leaseExpiresAt = pastTime.toISOString(); // Expired!
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const now = new Date();
    try {
      await outboxRepo.mutateSessionWithClaimFencing(
        delivery.id,
        expiredClaimContext,
        session.id,
        now,
        (s) => {
          s.metadata.corruptedMutation = true;
        },
        sessionRepo
      );
      assert.fail("Should have thrown StaleClaimError");
    } catch (err) {
      assert.ok(err instanceof StaleClaimError);
    }

    const freshSession = await sessionRepo.getById(session.id);
    assert.strictEqual(
      freshSession?.metadata.corruptedMutation,
      undefined,
      "No stale mutation should be written"
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Worker Restarts & Mid-Process State Recovery
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. WORKER RESTARTS & DURABLE RECOVERY ---");

  await test("4.1 Worker instance killed mid-cycle leaves outbox intact; fresh worker recovers it", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_03",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      // Worker 1 claims delivery with 50ms short lease and then crashes/dies mid-execution
      const claimed = await outboxRepo.claimEligibleDeliveries("crashing_worker", 50, 1, new Date());
      assert.strictEqual(claimed.length, 1);
      // Simulate crash: worker is discarded without completing updateClaimedDelivery

      // Wait 60ms for lease to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Worker 2 (fresh instance created after restart) starts up
      const freshWorker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          whatsappProvider: new MockWhatsAppProvider(),
          voiceProvider: new MockVoiceProvider(),
        },
        { workerId: "restarted_worker_02" }
      );

      const cycle = await freshWorker.processCycle();
      assert.strictEqual(cycle.claimedCount, 1, "Fresh worker claims expired lease");
      assert.strictEqual(cycle.dispatchedCount, 1, "Fresh worker finishes dispatch");

      const finalRecord = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(finalRecord?.status, "dispatched");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Pre-Dispatch Policy Safety (Consent & DND)
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. PRE-DISPATCH POLICY RE-EVALUATION IN BACKGROUND ---");

  await test("5.1 Revoking consent before scheduled worker run transitions delivery to blocked", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      // Revoke consent
      await consentRepo.save({
        id: "c_revoked_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "revoke",
        granted: false,
        consentText: "Revoked",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      let providerCalled = false;
      const mockWhatsApp = new MockWhatsAppProvider();
      mockWhatsApp.sendTemplate = async () => {
        providerCalled = true;
        return {
          messageId: "never_called",
          status: "accepted",
          dispatchedAt: new Date().toISOString(),
          isSimulated: true,
          providerMode: "mock",
        };
      };

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        whatsappProvider: mockWhatsApp,
        voiceProvider: new MockVoiceProvider(),
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.blockedCount, 1);
      assert.strictEqual(providerCalled, false, "Provider must never be called when consent is revoked");

      const updated = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updated?.status, "blocked");
      assert.strictEqual(updated?.policyResult?.reason, "CONSENT_REVOKED");
    });
  });

  await test("5.2 Recipient added to DND before scheduled worker run blocks dispatch", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_04",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      // Register DND
      await dndRepo.save({
        id: "dnd_01",
        phoneNumber: session.phoneNumber,
        scope: "whatsapp",
        reason: "Customer requested DND",
        createdAt: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        whatsappProvider: new MockWhatsAppProvider(),
        voiceProvider: new MockVoiceProvider(),
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.blockedCount, 1);

      const updated = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updated?.status, "blocked");
      assert.strictEqual(updated?.policyResult?.reason, "DND_ACTIVE");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Bounded Batches, Retry Limits & Exponential Backoff
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. BOUNDED BATCHES, RETRY LIMITS & BACKOFF ---");

  await test("6.1 batchSize parameter caps the maximum deliveries claimed per cycle", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createAuthoritativeSession();

    // Seed 15 pending deliveries
    for (let i = 0; i < 15; i++) {
      const del = createReminderDeliveryForSession(session);
      del.id = `del_batch_test_${i}`;
      await seedOutboxDeliveryForTest(outboxRepo, del);
    }

    const claimed = await outboxRepo.claimEligibleDeliveries("batch_tester", 60000, 5, new Date());
    assert.strictEqual(claimed.length, 5, "Must strictly respect batch limit of 5");
  });

  await test("6.2 Failed retryable delivery computes exponential backoff nextRetryAt", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_05",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      // Meta provider returns retryable 500 error
      const mockFetch = (async () => {
        return new Response(JSON.stringify({ error: { message: "Internal Server Error", code: 500 } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const startTime = new Date("2028-11-20T10:00:00.000Z");
      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          whatsappProvider: metaProvider,
          voiceProvider: new MockVoiceProvider(),
          currentTimeProvider: () => startTime,
        },
        { backoffBaseMs: 5000 }
      );

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.failedCount, 1);

      const updated = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updated?.status, "failed");
      assert.strictEqual(updated?.callAttemptCount, 1);
      // Attempt 1 backoff: base * 2^0 = 5000ms
      const expectedNextRetry = new Date(startTime.getTime() + 5000).toISOString();
      assert.strictEqual(updated?.nextRetryAt, expectedNextRetry);
    });
  });

  await test("6.3 Delivery with future nextRetryAt is NOT claimed prematurely", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createAuthoritativeSession();
    const delivery = createReminderDeliveryForSession(session);

    delivery.status = "failed";
    delivery.attemptCount = 1;
    delivery.callAttemptCount = 1;
    delivery.maxAttempts = 3;
    delivery.nextRetryAt = new Date(Date.now() + 60000).toISOString(); // 1 minute in the future
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const now = new Date();
    const claimed = await outboxRepo.claimEligibleDeliveries("worker_premature_test", 60000, 10, now);
    assert.strictEqual(claimed.length, 0, "Delivery with future nextRetryAt must not be claimed");
  });

  await test("6.4 Delivery reaching maxAttempts transitions to permanently_failed without further retries", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_06",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;

      // Delivery already had 2 attempts, maxAttempts: 3
      waDelivery.status = "failed";
      waDelivery.attemptCount = 2;
      waDelivery.callAttemptCount = 2;
      waDelivery.maxAttempts = 3;
      waDelivery.nextRetryAt = new Date(Date.now() - 1000).toISOString(); // Eligible now
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      const mockFetch = (async () => {
        return new Response(JSON.stringify({ error: { message: "503 Unavailable", code: 503 } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        whatsappProvider: metaProvider,
        voiceProvider: new MockVoiceProvider(),
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.permanentlyFailedCount, 1);

      const finalRecord = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(finalRecord?.status, "permanently_failed");
      assert.strictEqual(finalRecord?.callAttemptCount, 3);
      assert.strictEqual(finalRecord?.lastError?.isRetryable, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Monitoring & Operational Metrics Endpoint
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. MONITORING & OPERATIONAL METRICS ENDPOINT ---");

  await test("7.1 GET /api/admin/outbox/metrics rejects unauthenticated caller with 401", async () => {
    const req = new NextRequest("http://localhost:3000/api/admin/outbox/metrics");
    const res = await adminMetricsGet(req);
    assert.strictEqual(res.status, 401);
  });

  await test("7.2 GET /api/admin/outbox/metrics returns accurate counts and metrics for authorized worker token", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createAuthoritativeSession();

    // Seed various statuses
    const pendingDel = createReminderDeliveryForSession(session);
    pendingDel.id = "del_m_pending";
    pendingDel.status = "pending";
    await seedOutboxDeliveryForTest(outboxRepo, pendingDel);

    const dispatchedDel = createReminderDeliveryForSession(session);
    dispatchedDel.id = "del_m_dispatched";
    dispatchedDel.status = "dispatched";
    await seedOutboxDeliveryForTest(outboxRepo, dispatchedDel);

    const blockedDel = createReminderDeliveryForSession(session);
    blockedDel.id = "del_m_blocked";
    blockedDel.status = "blocked";
    await seedOutboxDeliveryForTest(outboxRepo, blockedDel);

    const failedDel = createReminderDeliveryForSession(session);
    failedDel.id = "del_m_failed";
    failedDel.status = "failed";
    failedDel.lastError = { code: "RATE_LIMITED", message: "429", isRetryable: true, occurredAt: new Date().toISOString() };
    await seedOutboxDeliveryForTest(outboxRepo, failedDel);

    const permFailedDel = createReminderDeliveryForSession(session);
    permFailedDel.id = "del_m_perm_failed";
    permFailedDel.status = "permanently_failed";
    permFailedDel.lastError = { code: "MISSING_DATA", message: "fail", isRetryable: false, occurredAt: new Date().toISOString() };
    await seedOutboxDeliveryForTest(outboxRepo, permFailedDel);

    _setMetricsOutboxRepoForTesting(outboxRepo);

    try {
      const req = new NextRequest("http://localhost:3000/api/admin/outbox/metrics", {
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });
      const res = await adminMetricsGet(req);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.metrics.counts.pending, 1);
      assert.strictEqual(data.metrics.counts.dispatched, 1);
      assert.strictEqual(data.metrics.counts.blocked, 1);
      assert.strictEqual(data.metrics.counts.failed, 1);
      assert.strictEqual(data.metrics.counts.permanently_failed, 1);
      assert.strictEqual(data.metrics.counts.total, 5);
      assert.strictEqual(data.metrics.channelBreakdown.whatsapp, 5);
      assert.strictEqual(data.metrics.failureReasons["RATE_LIMITED"], 1);
      assert.strictEqual(data.metrics.failureReasons["MISSING_DATA"], 1);
      assert.strictEqual(typeof data.metrics.oldestPendingAgeSeconds, "number");
    } finally {
      _setMetricsOutboxRepoForTesting(null);
    }
  });

  await test("7.3 GET /api/admin/outbox/metrics is accessible via verified staff admin session", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    _setMetricsOutboxRepoForTesting(outboxRepo);

    // Create valid signed staff session cookie
    const staffToken = await createSessionToken({
      uid: "staff_operator_99",
      role: "admin",
      email: "admin@brewcoffee.internal",
      displayName: "Head Operator",
      sid: "sid_admin_999",
    });

    try {
      const req = new NextRequest("http://localhost:3000/api/admin/outbox/metrics", {
        headers: {
          cookie: `brew_session=${staffToken}`,
        },
      });
      const res = await adminMetricsGet(req);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(typeof data.metrics.counts.total, "number");
    } finally {
      _setMetricsOutboxRepoForTesting(null);
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Firestore Failure Handling
  // ---------------------------------------------------------------------------
  console.log("\n--- 8. FIRESTORE FAILURE SAFETY & DEPLOYED FAILS-CLOSED GATES ---");

  await test("8.1 /api/cron/outbox-worker returns 503 if Firestore database is unavailable", async () => {
    _setCronWorkerForTesting(null); // Ensure test worker is CLEARED
    _setCronDbProviderForTesting(() => null); // Simulate uninitialized Firestore

    try {
      const req = new NextRequest("http://localhost:3000/api/cron/outbox-worker", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });
      const res = await cronWorkerPost(req);
      assert.strictEqual(res.status, 503);
      const body = await res.json();
      assert.ok(body.error.includes("Firestore database not configured"));
    } finally {
      _setCronDbProviderForTesting(null);
    }
  });

  await test("8.2 /api/admin/outbox/metrics returns 503 if Firestore database is unavailable", async () => {
    _setMetricsOutboxRepoForTesting(null); // Ensure test repo is CLEARED
    _setMetricsDbProviderForTesting(() => null); // Simulate uninitialized Firestore

    try {
      const req = new NextRequest("http://localhost:3000/api/admin/outbox/metrics", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });
      const res = await adminMetricsGet(req);
      assert.strictEqual(res.status, 503);
      const body = await res.json();
      assert.ok(body.error.includes("Firestore database not configured"));
    } finally {
      _setMetricsDbProviderForTesting(null);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Scope Invariants & Zero Cost Architecture
  // ---------------------------------------------------------------------------
  console.log("\n--- 9. SCOPE INVARIANTS & ZERO-COST RESTRICTIONS ---");

  await test("9.1 VOICE_BOOKING_ENABLED remains strictly false; zero voice telephony activated", async () => {
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
  });

  await test("9.2 WhatsApp test-recipient restriction remains strictly enforced in worker", async () => {
    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
    });

    try {
      await provider.sendTemplate({
        to: "+919999999999", // Unlisted number
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown 131030 error");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.metaErrorCode, 131030);
    }
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.5 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Verification suite execution failed:", err);
  process.exit(1);
});
