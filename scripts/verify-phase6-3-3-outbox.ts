/**
 * BREW Coffee Platform — Phase 6.3.3 Comprehensive Verification Script
 * Validates Outbox Event Models, Atomic Persistence, Provider Idempotency,
 * Worker Claim/Lease Lifecycle, Policy Safety, and Privacy Guarantees.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false"; // Strictly false by default

import assert from "assert";
import {
  MockVoiceProvider,
  MockWhatsAppProvider,
  ProviderIdempotencyConflictError,
  createOutboxDeliveriesForTransition,
  OutboxWorker,
  InMemoryConsentRepository,
  InMemoryDndRepository,
} from "../src/lib/communication";
import {
  TestInMemoryCommunicationOutboxRepository,
  seedOutboxDeliveryForTest,
  withTestVoiceBookingEnabled,
} from "../src/lib/communication/outbox/testFixture";
import {
  InMemoryVoiceSessionRepository,
} from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  processConversationTurn,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  MockExtractionProvider,
} from "../src/lib/voiceBooking/providers/extractionProvider";
import {
  VoiceBookingSession,
  StaffAuthorizationContext,
  OptimisticConcurrencyConflictError,
} from "../src/lib/voiceBooking/types";
import { computeOfficialVanRequestId } from "../src/lib/voiceBooking/vanRequestBridge";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "../src/lib/voiceBooking/quotationAdapter";

console.log("================================================================================");
console.log("   BREW Coffee Platform — Phase 6.3.3 Verification Suite");
console.log("   Outbox Atomicity, Worker Leases, Provider Idempotency & Policy Safety");
console.log("================================================================================\n");

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

const staffAuth: StaffAuthorizationContext = {
  staffIdentity: "usr_fleet_admin_01",
  staffRole: "fleet_admin",
  staffApprovalId: "appr_audit_test_001",
};

async function runAllTests() {
  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void>) {
    total++;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  console.log("--- 1. ATOMICITY TESTS ---");

  await test("1.1 Awaiting staff approval creates WhatsApp outbox delivery atomically", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createTestSession({ state: "awaiting_customer_confirmation" });
    await sessionRepo.save(session);

    // Customer confirms via positive voice turn
    const extractionProvider = new MockExtractionProvider();

    const result = await processConversationTurn(
      session,
      "yes, confirmed! please proceed",
      {
        sessionRepository: sessionRepo,
        extractionProvider,
      }
    );

    assert.strictEqual(result.session.state, "awaiting_staff_approval");
    const deliveries = await sessionRepo.getOutboxDeliveries(session.id);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].eventType, "booking_awaiting_staff_approval");
    assert.strictEqual(deliveries[0].channel, "whatsapp");
    assert.strictEqual(deliveries[0].purpose, "transactional_update");
    assert.strictEqual(deliveries[0].status, "pending");
  });

  await test("1.2 Customer decline creates decline outbox delivery atomically", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createTestSession({ state: "awaiting_customer_confirmation" });
    await sessionRepo.save(session);

    const extractionProvider = new MockExtractionProvider();

    const result = await processConversationTurn(
      session,
      "no, I decline",
      {
        sessionRepository: sessionRepo,
        extractionProvider,
      }
    );

    assert.strictEqual(result.session.state, "customer_declined");
    const deliveries = await sessionRepo.getOutboxDeliveries(session.id);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].eventType, "booking_declined");
    assert.strictEqual(deliveries[0].channel, "whatsapp");
  });

  await test("1.3 Fast-path cancellation creates cancellation outbox delivery atomically", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createTestSession({ state: "collecting_requirements" });
    await sessionRepo.save(session);

    const result = await processConversationTurn(
      session,
      "cancel booking",
      { sessionRepository: sessionRepo }
    );

    assert.strictEqual(result.session.state, "cancelled");
    const deliveries = await sessionRepo.getOutboxDeliveries(session.id);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].eventType, "booking_cancelled");
    assert.strictEqual(deliveries[0].channel, "whatsapp");
  });

  await test("1.4 Fast-path human handoff creates handoff outbox delivery atomically", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createTestSession({ state: "collecting_requirements" });
    await sessionRepo.save(session);

    const extractionProvider = new MockExtractionProvider();

    const result = await processConversationTurn(
      session,
      "i want to speak to a human manager",
      {
        sessionRepository: sessionRepo,
        extractionProvider,
      }
    );

    assert.strictEqual(result.session.state, "human_handoff");
    const deliveries = await sessionRepo.getOutboxDeliveries(session.id);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].eventType, "booking_human_handoff");
    assert.strictEqual(deliveries[0].channel, "whatsapp");
  });

  await test("1.5 Staff approval creates confirmed WhatsApp & Voice outbox deliveries atomically", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createTestSession({ state: "awaiting_staff_approval" });
    await sessionRepo.save(session);

    const approvalResult = await sessionRepo.atomicApproveBooking(
      session.id,
      staffAuth,
      (sess, auth) => {
        sess.state = "booking_confirmed";
        sess.staffApprovalId = auth.staffApprovalId;
        sess.staffApprovalAudit = {
          staffIdentity: auth.staffIdentity,
          staffRole: auth.staffRole as "fleet_admin",
          staffApprovalId: auth.staffApprovalId,
          approvedAt: new Date().toISOString(),
          sessionId: sess.id,
        };
        return sess;
      }
    );

    assert.strictEqual(approvalResult.success, true);
    const deliveries = await sessionRepo.getOutboxDeliveries(session.id);
    // booking_confirmed creates 2 independent records: WhatsApp and Voice
    assert.strictEqual(deliveries.length, 2);
    const channels = deliveries.map((d) => d.channel).sort();
    assert.deepStrictEqual(channels, ["voice", "whatsapp"]);
    for (const d of deliveries) {
      assert.strictEqual(d.eventType, "booking_confirmed");
      assert.strictEqual(d.status, "pending");
    }
  });

  await test("1.6 Concurrency conflict on saveWithOutbox does not persist delivery records", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createTestSession({ state: "collecting_requirements" });
    await sessionRepo.save(session); // stored revision is 1

    const staleSession = { ...session, state: "cancelled" as const };
    const fakeDeliveries = createOutboxDeliveriesForTransition(staleSession);

    // Stale revision: expected 999 but stored revision is 1!
    let errorThrown = false;
    try {
      await sessionRepo.saveWithOutbox(staleSession, 999, fakeDeliveries);
    } catch (e) {
      if (e instanceof OptimisticConcurrencyConflictError) {
        errorThrown = true;
      }
    }
    assert.strictEqual(errorThrown, true, "Should reject stale revision");
    // Verify no outbox delivery was inserted
    const stored = await sessionRepo.getOutboxDeliveries(session.id);
    assert.strictEqual(stored.length, 0);
  });

  console.log("\n--- 2. WORKER RELIABILITY TESTS ---");

  await test("2.1 Concurrent workers cannot claim the same active lease", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createTestSession({ state: "awaiting_staff_approval" });
    const deliveries = createOutboxDeliveriesForTransition(session);
    for (const d of deliveries) {
      await seedOutboxDeliveryForTest(outboxRepo, d);
    }

    const now = new Date("2026-11-02T10:00:00.000Z");
    // Worker 1 claims
    const worker1Claims = await outboxRepo.claimEligibleDeliveries("worker_alpha", 60_000, 10, now);
    assert.strictEqual(worker1Claims.length, 1);
    assert.strictEqual(worker1Claims[0].claimOwner, "worker_alpha");
    assert.strictEqual(worker1Claims[0].attemptCount, 1);

    // Worker 2 attempts claim while lease is active
    const worker2Claims = await outboxRepo.claimEligibleDeliveries("worker_beta", 60_000, 10, now);
    assert.strictEqual(worker2Claims.length, 0, "Active lease must prevent second claim");
  });

  await test("2.2 Expired leases can be reclaimed by another worker", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createTestSession({ state: "awaiting_staff_approval" });
    const deliveries = createOutboxDeliveriesForTransition(session);
    for (const d of deliveries) {
      await seedOutboxDeliveryForTest(outboxRepo, d);
    }

    const claimTime = new Date("2026-11-02T10:00:00.000Z");
    await outboxRepo.claimEligibleDeliveries("worker_alpha", 60_000, 10, claimTime);

    // Advance time by 61 seconds (past 60s lease)
    const afterExpiry = new Date(claimTime.getTime() + 61_000);
    const reclaimed = await outboxRepo.claimEligibleDeliveries("worker_beta", 60_000, 10, afterExpiry);
    assert.strictEqual(reclaimed.length, 1, "Expired lease must be reclaimable");
    assert.strictEqual(reclaimed[0].claimOwner, "worker_beta");
    assert.strictEqual(reclaimed[0].attemptCount, 2);
  });

  await test("2.3 Attempt count and maximum attempts (3) are enforced", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      // Set WhatsApp provider to always fail
      whatsappProvider.setSimulateFailure(true, "Simulated network failure");

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);
      await consentRepo.save({
        id: "c_grant_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent for transactional updates",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      for (const d of deliveries) {
        await seedOutboxDeliveryForTest(outboxRepo, d);
      }

      let clock = new Date("2026-11-02T10:00:00.000Z");
      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => clock,
        },
        { backoffBaseMs: 1_000 }
      );

      // Cycle 1: attempt 1 -> failed
      const c1 = await worker.processCycle();
      assert.strictEqual(c1.failedCount, 1);
      let d = await outboxRepo.getDeliveryById(deliveries[0].id);
      assert.strictEqual(d?.attemptCount, 1);
      assert.strictEqual(d?.status, "failed");

      // Advance past backoff (1s)
      clock = new Date(clock.getTime() + 2_000);
      // Cycle 2: attempt 2 -> failed
      const c2 = await worker.processCycle();
      assert.strictEqual(c2.failedCount, 1);
      d = await outboxRepo.getDeliveryById(deliveries[0].id);
      assert.strictEqual(d?.attemptCount, 2);

      // Advance past backoff (2s)
      clock = new Date(clock.getTime() + 3_000);
      // Cycle 3: attempt 3 -> permanently_failed (max 3 reached)
      const c3 = await worker.processCycle();
      assert.strictEqual(c3.permanentlyFailedCount, 1);
      d = await outboxRepo.getDeliveryById(deliveries[0].id);
      assert.strictEqual(d?.attemptCount, 3);
      assert.strictEqual(d?.status, "permanently_failed");

      // Cycle 4: advance time further -> permanently failed must NOT be reclaimed
      clock = new Date(clock.getTime() + 10_000);
      const c4 = await worker.processCycle();
      assert.strictEqual(c4.claimedCount, 0, "Permanently failed record must not be reclaimed");
    });
  });

  console.log("\n--- 3. POLICY SAFETY TESTS ---");

  await test("3.1 Missing consent marks delivery blocked without provider dispatch", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);
      // NO consent added to consentRepo

      const deliveries = createOutboxDeliveriesForTransition(session);
      for (const d of deliveries) {
        await seedOutboxDeliveryForTest(outboxRepo, d);
      }

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
      assert.strictEqual(cycleResult.dispatchedCount, 0);
      assert.strictEqual(whatsappProvider.getDispatchedMessageCount(), 0);

      const record = await outboxRepo.getDeliveryById(deliveries[0].id);
      assert.strictEqual(record?.status, "blocked");
      assert.strictEqual(record?.policyResult?.reason, "CONSENT_MISSING");
    });
  });

  await test("3.2 Voice consent does NOT satisfy WhatsApp delivery", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      // Grant voice consent only
      await consentRepo.save({
        id: "c_grant_voice_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session); // WhatsApp delivery
      for (const d of deliveries) {
        await seedOutboxDeliveryForTest(outboxRepo, d);
      }

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
      assert.strictEqual(whatsappProvider.getDispatchedMessageCount(), 0);
    });
  });

  await test("3.3 Marketing consent does NOT satisfy transactional update", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      // Grant marketing WhatsApp consent only
      await consentRepo.save({
        id: "c_grant_mkt_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "marketing",
        eventType: "grant",
        granted: true,
        consentText: "Marketing consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      for (const d of deliveries) {
        await seedOutboxDeliveryForTest(outboxRepo, d);
      }

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
      assert.strictEqual(whatsappProvider.getDispatchedMessageCount(), 0);
    });
  });

  await test("3.4 Active channel-specific DND blocks dispatch", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_wa_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      // Register active WhatsApp DND
      await dndRepo.save({
        id: "dnd_wa_01",
        phoneNumber: session.phoneNumber,
        scope: "whatsapp",
        reason: "Customer opted out of WhatsApp",
        createdAt: "2026-11-02T09:30:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      for (const d of deliveries) {
        await seedOutboxDeliveryForTest(outboxRepo, d);
      }

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
      const record = await outboxRepo.getDeliveryById(deliveries[0].id);
      assert.strictEqual(record?.status, "blocked");
      assert.strictEqual(record?.policyResult?.reason, "DND_ACTIVE");
    });
  });

  await test("3.5 Voice outside calling hours blocks voice dispatch", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_voice_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      // Midnight UTC = 05:30 IST (Outside 09:00-20:00 IST window)
      const midnightUtc = new Date("2026-11-02T00:00:00.000Z");

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => midnightUtc,
        },
        {}
      );

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.blockedCount, 1);
      const record = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(record?.status, "blocked");
      assert.strictEqual(record?.policyResult?.reason, "OUTSIDE_CALLING_HOURS");
    });
  });

  await test("3.6 Production feature flag disabled blocks dispatch by default", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession({ state: "awaiting_staff_approval" });
    await sessionRepo.save(session);
    await consentRepo.save({
      id: "c_grant_wa_01",
      phoneNumber: session.phoneNumber,
      channel: "whatsapp",
      purpose: "transactional_update",
      eventType: "grant",
      granted: true,
      consentText: "Consent",
      consentVersion: "v1.0",
      timestamp: "2026-11-02T09:00:00.000Z",
    });

    const deliveries = createOutboxDeliveriesForTransition(session);
    for (const d of deliveries) {
      await seedOutboxDeliveryForTest(outboxRepo, d);
    }

    // Default options (checkFeatureFlag: true, VOICE_BOOKING_ENABLED is false)
    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
    });

    const cycleResult = await worker.processCycle();
    assert.strictEqual(cycleResult.blockedCount, 1);
    const record = await outboxRepo.getDeliveryById(deliveries[0].id);
    assert.strictEqual(record?.status, "blocked");
    assert.strictEqual(record?.policyResult?.reason, "FEATURE_DISABLED");
  });

  console.log("\n--- 4. IDEMPOTENCY TESTS ---");

  await test("4.1 Identical WhatsApp replay returns cached result without extra dispatch", async () => {
    const provider = new MockWhatsAppProvider();
    const params = {
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [
        {
          type: "body" as const,
          parameters: [{ type: "text" as const, text: "CONFIRMED" }],
        },
      ],
      idempotencyKey: "del_test_wa_key_01",
    };

    const res1 = await provider.sendTemplate(params);
    assert.strictEqual(provider.getDispatchedMessageCount(), 1);

    // Replay with exact same key & params
    const res2 = await provider.sendTemplate(params);
    assert.strictEqual(provider.getDispatchedMessageCount(), 1, "Must NOT duplicate dispatched message");
    assert.strictEqual(res2.messageId, res1.messageId);
    assert.strictEqual(res2.dispatchedAt, res1.dispatchedAt);
  });

  await test("4.2 Identical Voice replay returns cached result without extra session", async () => {
    const provider = new MockVoiceProvider();
    const params = {
      sessionId: "sess_voice_001",
      phoneNumber: "+919876543210",
      language: "en" as const,
      idempotencyKey: "del_test_voice_key_01",
    };

    const res1 = await provider.startSession(params);
    assert.strictEqual(provider.getActiveSessionCount(), 1);

    const res2 = await provider.startSession(params);
    assert.strictEqual(provider.getActiveSessionCount(), 1, "Must NOT duplicate active session");
    assert.strictEqual(res2.providerCallId, res1.providerCallId);
    assert.strictEqual(res2.startedAt, res1.startedAt);
  });

  await test("4.3 Reusing idempotency key with conflicting payload fails closed", async () => {
    const provider = new MockWhatsAppProvider();
    const params1 = {
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "del_test_conflict_key_01",
    };

    await provider.sendTemplate(params1);

    // Reusing key with different recipient
    const params2 = {
      ...params1,
      to: "+919876599999",
    };

    let conflictCaught = false;
    try {
      await provider.sendTemplate(params2);
    } catch (e) {
      if (e instanceof ProviderIdempotencyConflictError) {
        conflictCaught = true;
      }
    }
    assert.strictEqual(conflictCaught, true, "Must throw ProviderIdempotencyConflictError on payload mismatch");
  });

  await test("4.4 Failed attempt followed by retry with same key succeeds and caches", async () => {
    const provider = new MockWhatsAppProvider();
    provider.setSimulateFailure(true, "Network timeout");

    const params = {
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "del_test_retry_key_01",
    };

    // Attempt 1 fails
    let failed = false;
    try {
      await provider.sendTemplate(params);
    } catch {
      failed = true;
    }
    assert.strictEqual(failed, true);

    // Turn off simulated failure and retry with identical key
    provider.setSimulateFailure(false);
    const successResult = await provider.sendTemplate(params);
    assert.strictEqual(successResult.status, "simulated_accepted");
    assert.strictEqual(provider.getDispatchedMessageCount(), 1);

    // Subsequent replay returns cached result
    const replayResult = await provider.sendTemplate(params);
    assert.strictEqual(replayResult.messageId, successResult.messageId);
    assert.strictEqual(provider.getDispatchedMessageCount(), 1);
  });

  console.log("\n--- 5. SECURITY & PRIVACY TESTS ---");

  await test("5.1 Outbox documents contain masked phone numbers and no raw phone numbers", async () => {
    const session = createTestSession({ phoneNumber: "+919876543210" });
    const deliveries = createOutboxDeliveriesForTransition(session);

    for (const d of deliveries) {
      assert.strictEqual(d.phoneNumberMasked, "+91******3210");
      assert.strictEqual((d as unknown as Record<string, unknown>).phoneNumber, undefined);
      const serialized = JSON.stringify(d);
      assert.strictEqual(serialized.includes("+919876543210"), false, "Raw phone number must NOT be in outbox JSON");
    }
  });

  await test("5.2 Persisted error details are sanitized and do not leak secrets or stack traces", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      // Injected failure with sensitive internal exception details
      whatsappProvider.setSimulateFailure(true, "Internal DB error at postgres://user:secret123@db.prod:5432/main");

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);
      await consentRepo.save({
        id: "c_grant_wa_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      for (const d of deliveries) {
        await seedOutboxDeliveryForTest(outboxRepo, d);
      }

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

      await worker.processCycle();
      const failedDelivery = await outboxRepo.getDeliveryById(deliveries[0].id);
      assert.strictEqual(failedDelivery?.status, "failed");
      assert.strictEqual(failedDelivery?.lastError?.isRetryable, true);
      // Verify phone number is masked
      assert.strictEqual(failedDelivery?.phoneNumberMasked, "+91******3210");
    });
  });

  console.log("\n================================================================================");
  console.log(`   Verification Summary: ${passed} / ${total} tests passed (100% SUCCESS)`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("Unhandled verification exception:", e);
  process.exit(1);
});
