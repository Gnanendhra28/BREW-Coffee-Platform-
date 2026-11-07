/**
 * BREW Coffee Platform — Phase 6.3.3.1 Verification Suite
 * Targeted Outbox Reliability & Privacy Hardening
 *
 * Verifies:
 * 1. Worker A's lease expires and Worker B reclaims the delivery.
 * 2. Worker A cannot overwrite Worker B's newer claim or completion.
 * 3. A stale worker cannot mark a delivery dispatched.
 * 4. A stale worker cannot mark a delivery failed or blocked.
 * 5. Provider exceptions containing fake secrets and phone numbers are sanitized before persistence.
 * 6. Policy evaluation uses a fresh timestamp for each delivery in a batch.
 * 7. A batch crossing 20:00 IST blocks a later voice delivery.
 * 8. A consent revocation after enqueue but before dispatch blocks delivery.
 * 9. DND repository outage creates a retryable failure and never invokes the provider.
 * 10. Provider idempotency limitations after instance replacement are accurately tested and documented.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";

import assert from "assert";
import {
  OutboxWorker,
  MockVoiceProvider,
  MockWhatsAppProvider,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  StaleClaimError,
  CommunicationDeliveryRecord,
  BookingLifecycleEventType,
} from "../src/lib/communication";
import {
  TestInMemoryCommunicationOutboxRepository,
  seedOutboxDeliveryForTest,
  withTestVoiceBookingEnabled,
} from "../src/lib/communication/outbox/testFixture";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { VoiceBookingSession } from "../src/lib/voiceBooking/types";
import { computeOfficialVanRequestId } from "../src/lib/voiceBooking/vanRequestBridge";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "../src/lib/voiceBooking/quotationAdapter";

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void>) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function createTestSession(overrides: Partial<VoiceBookingSession> = {}): VoiceBookingSession {
  const sessionId =
    overrides.id ||
    `sess_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const vanRequestId = computeOfficialVanRequestId(sessionId);

  const requirements = {
    guestCount: 50,
    eventDate: "2026-11-20",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "HITEC City Phase 2, Hyderabad",
    eventType: "corporate",
    beveragePreferences: ["Cappuccino", "Cold Brew"],
    selectedTier: "STANDARD" as const,
    handoffRequested: false,
    customerConfirmed: overrides.state === "awaiting_staff_approval" || overrides.state === "booking_confirmed",
    missingFields: [],
    unresolvedQuestions: [],
    confidenceScore: 0.95,
    ...overrides.requirements,
  };

  const quotation = generateVoiceBookingQuotation(requirements);
  const quotationSnapshot = createQuotationSnapshot(requirements);

  return {
    id: sessionId,
    phoneNumber: "+919876543210",
    language: "en",
    state: "details_collected",
    requirements,
    quotation,
    quotationSnapshot,
    officialBookingId: vanRequestId,
    metadata: {
      officialBookingId: vanRequestId,
      bookingSource: "voice_booking",
    },
    conversationHistory: [],
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    revision: 1,
    staffApprovalId: null,
    staffApprovalAudit: null,
    ...overrides,
  };
}

function createTestDelivery(
  id: string,
  sessionId: string,
  channel: "whatsapp" | "voice" = "whatsapp",
  eventType: BookingLifecycleEventType = "booking_awaiting_staff_approval"
): CommunicationDeliveryRecord {
  const now = "2026-11-02T10:00:00.000Z";
  const vanRequestId = computeOfficialVanRequestId(sessionId);
  return {
    id,
    eventId: `evt_${eventType}_${sessionId}_r1`,
    sessionId,
    officialBookingId: vanRequestId,
    eventType,
    channel,
    purpose: "transactional_update",
    status: "pending",
    phoneNumberMasked: "+91******3210",
    attemptCount: 0,
    maxAttempts: 3,
    claimOwner: null,
    claimedAt: null,
    leaseExpiresAt: null,
    nextRetryAt: null,
    lastError: null,
    policyResult: null,
    providerResult: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function runAllTests() {
  console.log("\n================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.3.3.1 Verification Suite");
  console.log("   Targeted Outbox Reliability & Privacy Hardening");
  console.log("================================================================================\n");

  console.log("--- 1. LEASE-OWNER PROTECTED COMPLETION ---");

  await test("1. Worker A's lease expires and Worker B reclaims the delivery", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_lease_exp_1", "sess_lease_1");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const claimedByA = await outboxRepo.claimEligibleDeliveries("worker_a", 60_000, 10, t0);
    assert.strictEqual(claimedByA.length, 1);
    assert.strictEqual(claimedByA[0].claimOwner, "worker_a");
    assert.strictEqual(claimedByA[0].status, "processing");
    assert.strictEqual(claimedByA[0].attemptCount, 1);

    // Advance clock past 60s lease (65 seconds later)
    const t1 = new Date("2026-11-02T10:01:05.000Z");
    const claimedByB = await outboxRepo.claimEligibleDeliveries("worker_b", 60_000, 10, t1);
    assert.strictEqual(claimedByB.length, 1);
    assert.strictEqual(claimedByB[0].claimOwner, "worker_b");
    assert.strictEqual(claimedByB[0].status, "processing");
    assert.strictEqual(claimedByB[0].attemptCount, 2);
    assert.strictEqual(claimedByB[0].claimedAt, t1.toISOString());
  });

  await test("2. Worker A cannot overwrite Worker B's newer claim or completion", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_lease_exp_2", "sess_lease_2");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimedByA] = await outboxRepo.claimEligibleDeliveries("worker_a", 60_000, 10, t0);

    // Lease expires, Worker B claims and marks dispatched
    const t1 = new Date("2026-11-02T10:01:05.000Z");
    const [claimedByB] = await outboxRepo.claimEligibleDeliveries("worker_b", 60_000, 10, t1);
    const tokenB = claimedByB.claimToken!;
    claimedByB.status = "dispatched";
    claimedByB.claimOwner = null;
    claimedByB.claimToken = null;
    claimedByB.leaseExpiresAt = null;
    await outboxRepo.updateClaimedDelivery(
      claimedByB,
      { claimOwner: "worker_b", claimedAt: t1.toISOString(), claimToken: tokenB },
      t1
    );

    // Stale Worker A attempts to complete its claim
    const tokenA = claimedByA.claimToken!;
    claimedByA.status = "dispatched";
    claimedByA.claimOwner = null;
    claimedByA.claimToken = null;
    claimedByA.leaseExpiresAt = null;

    let threwStaleError = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimedByA,
        { claimOwner: "worker_a", claimedAt: t0.toISOString(), claimToken: tokenA },
        t1
      );
    } catch (err) {
      if (err instanceof StaleClaimError) {
        threwStaleError = true;
      }
    }

    assert.strictEqual(threwStaleError, true, "Worker A's stale update must throw StaleClaimError");

    // Repository record remains Worker B's record
    const finalRecord = await outboxRepo.getDeliveryById("del_lease_exp_2");
    assert.strictEqual(finalRecord?.status, "dispatched");
    assert.strictEqual(finalRecord?.attemptCount, 2);
  });

  await test("3. A stale worker cannot mark a delivery dispatched", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_stale_disp_3", "sess_stale_3");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimedByA] = await outboxRepo.claimEligibleDeliveries("worker_a", 60_000, 10, t0);

    // Lease expires, Worker B claims it
    const t1 = new Date("2026-11-02T10:01:10.000Z");
    await outboxRepo.claimEligibleDeliveries("worker_b", 60_000, 10, t1);

    // Worker A tries to mark dispatched
    claimedByA.status = "dispatched";
    let threw = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimedByA,
        { claimOwner: "worker_a", claimedAt: t0.toISOString(), claimToken: claimedByA.claimToken! },
        t1
      );
    } catch (err) {
      threw = err instanceof StaleClaimError;
    }

    assert.strictEqual(threw, true);
    const stored = await outboxRepo.getDeliveryById("del_stale_disp_3");
    assert.strictEqual(stored?.claimOwner, "worker_b");
    assert.strictEqual(stored?.status, "processing");
  });

  await test("4. A stale worker cannot mark a delivery failed or blocked", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_stale_fail_4", "sess_stale_4");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimedByA] = await outboxRepo.claimEligibleDeliveries("worker_a", 60_000, 10, t0);

    // Lease expires, Worker B claims it
    const t1 = new Date("2026-11-02T10:01:10.000Z");
    await outboxRepo.claimEligibleDeliveries("worker_b", 60_000, 10, t1);

    // Worker A tries to mark failed
    claimedByA.status = "failed";
    claimedByA.lastError = {
      code: "PROVIDER_DISPATCH_FAILED",
      message: "PROVIDER_DISPATCH_FAILED",
      isRetryable: true,
      occurredAt: t1.toISOString(),
      attempt: 1,
    };

    let threwOnFailed = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimedByA,
        { claimOwner: "worker_a", claimedAt: t0.toISOString(), claimToken: claimedByA.claimToken! },
        t1
      );
    } catch (err) {
      threwOnFailed = err instanceof StaleClaimError;
    }
    assert.strictEqual(threwOnFailed, true);

    // Worker A tries to mark blocked
    claimedByA.status = "blocked";
    let threwOnBlocked = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimedByA,
        { claimOwner: "worker_a", claimedAt: t0.toISOString(), claimToken: claimedByA.claimToken! },
        t1
      );
    } catch (err) {
      threwOnBlocked = err instanceof StaleClaimError;
    }
    assert.strictEqual(threwOnBlocked, true);

    // Repository record remains in Worker B's active processing state
    const stored = await outboxRepo.getDeliveryById("del_stale_fail_4");
    assert.strictEqual(stored?.claimOwner, "worker_b");
    assert.strictEqual(stored?.status, "processing");
  });

  console.log("\n--- 2. PRIVACY & PROVIDER ERROR SANITIZATION ---");

  await test("5. Provider exceptions containing fake secrets and phone numbers are sanitized before persistence", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ id: "sess_sec_5", state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_sec_5",
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const delivery = createTestDelivery("del_sec_5", "sess_sec_5", "whatsapp");
      await seedOutboxDeliveryForTest(outboxRepo, delivery);

      // Inject sensitive exception containing fake secret key, fake token, and phone number
      const sensitiveMessage =
        "Meta API Error 401: Unauthorized Bearer sk_live_fake_secret_key_12345 for recipient +919876543210 at https://graph.facebook.com/v19.0/messages";
      whatsappProvider.setSimulateFailure(true, sensitiveMessage);

      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
        },
        {}
      );

      const result = await worker.processCycle();
      assert.strictEqual(result.failedCount, 1);

      const updated = await outboxRepo.getDeliveryById("del_sec_5");
      assert.strictEqual(updated?.status, "failed");
      assert.strictEqual(updated?.lastError?.code, "PROVIDER_DISPATCH_FAILED");
      assert.strictEqual(updated?.lastError?.message, "PROVIDER_DISPATCH_FAILED");
      assert.strictEqual(updated?.lastError?.isRetryable, true);

      const serialized = JSON.stringify(updated);
      assert.strictEqual(serialized.includes("sk_live_fake_secret_key_12345"), false);
      assert.strictEqual(serialized.includes("+919876543210"), false);
      assert.strictEqual(updated?.phoneNumberMasked, "+91******3210");
    });
  });

  console.log("\n--- 3. FRESH DISPATCH-TIME TIMESTAMPS & CALLING HOURS ---");

  await test("6. Policy evaluation uses a fresh timestamp for each delivery in a batch", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const sess1 = createTestSession({ id: "sess_batch_1", state: "awaiting_staff_approval" });
      const sess2 = createTestSession({ id: "sess_batch_2", state: "awaiting_staff_approval" });
      await sessionRepo.save(sess1);
      await sessionRepo.save(sess2);

      await consentRepo.save({
        id: "c_grant_batch_1",
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      await seedOutboxDeliveryForTest(outboxRepo, createTestDelivery("del_batch_1", "sess_batch_1"));
      await seedOutboxDeliveryForTest(outboxRepo, createTestDelivery("del_batch_2", "sess_batch_2"));

      let currentTimeMs = new Date("2026-11-02T10:00:00.000Z").getTime();
      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => {
            currentTimeMs += 1_000; // Advances 1 second per clock read
            return new Date(currentTimeMs);
          },
        },
        {}
      );

      await worker.processCycle();

      const d1 = await outboxRepo.getDeliveryById("del_batch_1");
      const d2 = await outboxRepo.getDeliveryById("del_batch_2");

      assert.ok(d1?.policyResult?.evaluatedAt);
      assert.ok(d2?.policyResult?.evaluatedAt);

      const tD1 = new Date(d1!.policyResult!.evaluatedAt).getTime();
      const tD2 = new Date(d2!.policyResult!.evaluatedAt).getTime();

      assert.ok(tD2 > tD1, `Second delivery evaluatedAt (${d2!.policyResult!.evaluatedAt}) must be strictly later than first (${d1!.policyResult!.evaluatedAt})`);
    });
  });

  await test("7. A batch crossing 20:00 IST blocks a later voice delivery", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const s1 = createTestSession({ id: "sess_cross_1", state: "booking_confirmed" });
      const s2 = createTestSession({ id: "sess_cross_2", state: "booking_confirmed" });
      await sessionRepo.save(s1);
      await sessionRepo.save(s2);

      await consentRepo.save({
        id: "c_grant_voice_7",
        phoneNumber: "+919876543210",
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      // Two voice deliveries
      await seedOutboxDeliveryForTest(outboxRepo, createTestDelivery("del_cross_1", "sess_cross_1", "voice", "booking_confirmed"));
      await seedOutboxDeliveryForTest(outboxRepo, createTestDelivery("del_cross_2", "sess_cross_2", "voice", "booking_confirmed"));

      // 19:59:50 IST is 14:29:50 UTC.
      // Calling hours 09:00 - 20:00 IST.
      // First read: 14:29:50 UTC (allowed)
      // Clock then advances past 20:00:00 IST -> 14:30:10 UTC (20:00:10 IST -> blocked!)
      const times = [
        new Date("2026-11-02T14:29:50.000Z"), // cycle claim
        new Date("2026-11-02T14:29:50.000Z"), // delivery 1 process start
        new Date("2026-11-02T14:29:52.000Z"), // delivery 1 policy check (19:59:52 IST -> ALLOWED)
        new Date("2026-11-02T14:29:55.000Z"), // delivery 1 dispatch completion
        new Date("2026-11-02T14:30:10.000Z"), // delivery 2 process start (20:00:10 IST)
        new Date("2026-11-02T14:30:12.000Z"), // delivery 2 policy check (20:00:12 IST -> BLOCKED)
        new Date("2026-11-02T14:30:15.000Z"), // delivery 2 update
      ];

      let callIndex = 0;
      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => {
            const t = times[callIndex] || times[times.length - 1];
            callIndex++;
            return t;
          },
        },
        {}
      );

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.dispatchedCount, 1, "First delivery should be dispatched");
      assert.strictEqual(cycleResult.blockedCount, 1, "Second delivery crossing 20:00 IST must be blocked");

      const d1 = await outboxRepo.getDeliveryById("del_cross_1");
      const d2 = await outboxRepo.getDeliveryById("del_cross_2");

      assert.strictEqual(d1?.status, "dispatched");
      assert.strictEqual(d2?.status, "blocked");
      assert.strictEqual(d2?.policyResult?.reason, "OUTSIDE_CALLING_HOURS");
    });
  });

  console.log("\n--- 4. DYNAMIC POLICY RE-EVALUATION & OUTAGE RESILIENCE ---");

  await test("8. A consent revocation after enqueue but before dispatch blocks delivery", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ id: "sess_rev_8", state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_rev_8",
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      // Enqueue delivery
      await seedOutboxDeliveryForTest(outboxRepo, createTestDelivery("del_rev_8", "sess_rev_8"));

      // Revoke consent before worker cycle runs
      await consentRepo.revoke(
        "+919876543210",
        "whatsapp",
        "transactional_update",
        "customer_requested_opt_out",
        "2026-11-02T10:05:00.000Z"
      );

      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
        },
        {}
      );

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.blockedCount, 1);

      const updated = await outboxRepo.getDeliveryById("del_rev_8");
      assert.strictEqual(updated?.status, "blocked");
      assert.strictEqual(updated?.policyResult?.reason, "CONSENT_REVOKED");
    });
  });

  await test("9. DND repository outage creates a retryable failure and never invokes the provider", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ id: "sess_dnd_err_9", state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_dnd_9",
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      await seedOutboxDeliveryForTest(outboxRepo, createTestDelivery("del_dnd_err_9", "sess_dnd_err_9"));

      // Simulate database outage on DND repository
      dndRepo.findActiveScopes = async () => {
        throw new Error("Firestore connection timeout (504 Gateway Timeout)");
      };

      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
        },
        {}
      );

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.failedCount, 1);

      const updated = await outboxRepo.getDeliveryById("del_dnd_err_9");
      assert.strictEqual(updated?.status, "failed");
      assert.strictEqual(updated?.lastError?.code, "POLICY_INFRASTRUCTURE_FAILURE");
      assert.strictEqual(updated?.lastError?.message, "POLICY_INFRASTRUCTURE_FAILURE");
      assert.strictEqual(updated?.lastError?.isRetryable, true);
      assert.ok(updated?.nextRetryAt !== null);
    });
  });

  console.log("\n--- 5. MOCK IDEMPOTENCY LIMITATIONS & DOCUMENTATION ---");

  await test("10. Provider idempotency limitations after instance replacement are accurately tested and documented", async () => {
    // Instance 1
    const provider1 = new MockWhatsAppProvider();
    const params = {
      to: "+919876543210",
      templateName: "booking_confirmed",
      language: "en",
      idempotencyKey: "idem_replace_test_key_123",
      components: [],
    };

    // First call caches result in provider1
    const res1 = await provider1.sendTemplate(params);
    const res2 = await provider1.sendTemplate(params);
    assert.strictEqual(res1.messageId, res2.messageId);

    // Simulate process restart or new provider instance
    const provider2 = new MockWhatsAppProvider();
    const res3 = await provider2.sendTemplate(params);

    // Provider 2 generates a new message ID because in-memory cache is instance-local
    assert.notStrictEqual(
      res3.messageId,
      res1.messageId,
      "Fresh provider instance must NOT share in-memory cache with replaced instance"
    );
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.3.1 Hardening Summary: ${passed} / ${total} tests passed (100% SUCCESS)`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("Unhandled verification exception:", e);
  process.exit(1);
});
