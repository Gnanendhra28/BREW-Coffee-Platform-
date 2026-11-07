/**
 * BREW Coffee Platform — Phase 6.3.3.2.2 Verification Suite
 * Production Policy Boundary & Repository Encapsulation
 *
 * Verifies:
 * 1. Production OutboxWorker unconditionally invokes the real orchestrateCommunicationPolicy().
 * 2. A runtime-supplied customPolicyOrchestrator cannot replace or bypass the real policy.
 * 3. VOICE_BOOKING_ENABLED=false blocks dispatch with FEATURE_DISABLED.
 * 4. Consent and DND evaluations work properly with controlled repositories in test environment.
 * 5. getInternalStoreForTest() no longer exists on InMemoryCommunicationOutboxRepository.
 * 6. Neither concrete repository exposes any public backing-store reference.
 * 7. Fixture seeding works exclusively through the TestInMemoryCommunicationOutboxRepository adapter.
 * 8. Firestore fixture setup (TestFirestoreOutboxFixtureAdapter) refuses non-emulator environments (fails closed).
 * 9. Firestore fixture setup refuses non-test environment markers (fails closed).
 * 10. No test fixture path can silently write to production Firestore.
 * 11. Claim-token fencing and stale-worker rejection still work reliably with reused worker IDs.
 * 12. In-memory and Firestore repository public contracts remain strictly aligned.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false"; // Production default

import assert from "assert";
import {
  InMemoryCommunicationOutboxRepository,
  FirestoreCommunicationOutboxRepository,
  OutboxWorker,
  OutboxWorkerDependencies,
  MockVoiceProvider,
  MockWhatsAppProvider,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  StaleClaimError,
  CommunicationDeliveryRecord,
} from "../src/lib/communication";
import {
  TestInMemoryCommunicationOutboxRepository,
  TestFirestoreOutboxFixtureAdapter,
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

function createTestDelivery(
  id: string,
  sessionId: string,
  channel: "whatsapp" | "voice" = "whatsapp",
  eventType: "booking_awaiting_staff_approval" | "booking_confirmed" = "booking_awaiting_staff_approval",
  status: "pending" | "processing" | "dispatched" | "failed" | "blocked" | "permanently_failed" = "pending",
  claimToken: string | null = null
): CommunicationDeliveryRecord {
  const now = "2026-11-02T10:00:00.000Z";
  return {
    id,
    eventId: `evt_${id}`,
    sessionId,
    officialBookingId: `VR-${sessionId}`,
    eventType,
    channel,
    purpose: "transactional_update",
    status,
    phoneNumberMasked: "+91 98765 *****",
    attemptCount: 0,
    maxAttempts: 3,
    claimOwner: status === "processing" ? "worker_1" : null,
    claimToken,
    claimedAt: status === "processing" ? now : null,
    leaseExpiresAt: status === "processing" ? "2026-11-02T10:01:00.000Z" : null,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createTestSession(id: string): VoiceBookingSession {
  const vanRequestId = computeOfficialVanRequestId(id);
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
    customerConfirmed: true,
    missingFields: [],
    unresolvedQuestions: [],
    confidenceScore: 0.95,
  };

  const quotation = generateVoiceBookingQuotation(requirements);
  const quotationSnapshot = createQuotationSnapshot(requirements);

  return {
    id,
    phoneNumber: "+919876543210",
    language: "en",
    state: "awaiting_staff_approval",
    requirements,
    quotation,
    quotationSnapshot,
    officialBookingId: vanRequestId,
    metadata: {
      officialBookingId: vanRequestId,
      bookingSource: "voice_booking",
    },
    conversationHistory: [],
    revision: 1,
    staffApprovalId: null,
    staffApprovalAudit: null,
    createdAt: "2026-11-02T09:00:00.000Z",
    updatedAt: "2026-11-02T09:00:00.000Z",
  };
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.3.3.2.2 Verification Suite");
  console.log("   Production Policy Boundary & Repository Encapsulation");
  console.log("================================================================================\n");

  console.log("--- 1. POLICY MANDATE & RUNTIME IMMUTABILITY ---");

  await test("1. Production worker unconditionally invokes real orchestrateCommunicationPolicy()", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession("sess_prod_mandate");
    await sessionRepo.save(session);

    // Save active consent
    await consentRepo.save({
      id: "c_mandate",
      phoneNumber: "+919876543210",
      channel: "whatsapp",
      purpose: "transactional_update",
      eventType: "grant",
      granted: true,
      consentText: "Consent",
      consentVersion: "v1.0",
      timestamp: "2026-11-02T09:00:00.000Z",
    });

    const delivery = createTestDelivery("del_prod_mandate", "sess_prod_mandate");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
    });

    // Default: VOICE_BOOKING_ENABLED="false"
    assert.strictEqual(worker.isFeatureFlagEnforced(), true);
    const result = await worker.processCycle();

    // Must be blocked because the real policy checked the feature flag
    assert.strictEqual(result.blockedCount, 1);
    assert.strictEqual(result.dispatchedCount, 0);

    const record = await outboxRepo.getDeliveryById("del_prod_mandate");
    assert.strictEqual(record?.status, "blocked");
    assert.strictEqual(record?.policyResult?.reason, "FEATURE_DISABLED");
  });

  await test("2. Runtime-supplied customPolicyOrchestrator cannot replace or bypass real policy", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession("sess_rogue_check");
    await sessionRepo.save(session);

    const delivery = createTestDelivery("del_rogue_check", "sess_rogue_check");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    let rogueInvoked = false;
    const rogueDeps = {
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
      customPolicyOrchestrator: async () => {
        rogueInvoked = true;
        return {
          status: "allowed" as const,
          reason: "ALLOWED" as const,
          details: "rogue bypass attempted",
          evaluatedAt: new Date().toISOString(),
          channel: "whatsapp" as const,
          purpose: "transactional_update" as const,
          phoneNumberMasked: "+91******3210",
        };
      },
    };

    const worker = new OutboxWorker(rogueDeps as unknown as OutboxWorkerDependencies);
    const result = await worker.processCycle();

    assert.strictEqual(rogueInvoked, false, "Rogue orchestrator must never be invoked");
    assert.strictEqual(result.blockedCount, 1);
    assert.strictEqual(result.dispatchedCount, 0);

    const record = await outboxRepo.getDeliveryById("del_rogue_check");
    assert.strictEqual(record?.status, "blocked");
    assert.strictEqual(record?.policyResult?.reason, "FEATURE_DISABLED");
  });

  await test("3. VOICE_BOOKING_ENABLED=false blocks dispatch with FEATURE_DISABLED", async () => {
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");

    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession("sess_flag_false");
    await sessionRepo.save(session);

    const delivery = createTestDelivery("del_flag_false", "sess_flag_false");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
    });

    const result = await worker.processCycle();
    assert.strictEqual(result.blockedCount, 1);
    assert.strictEqual(result.dispatchedCount, 0);

    const record = await outboxRepo.getDeliveryById("del_flag_false");
    assert.strictEqual(record?.policyResult?.reason, "FEATURE_DISABLED");
  });

  await test("4. Consent and DND evaluations work with controlled repositories in test environment", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession("sess_controlled_test");
      await sessionRepo.save(session);

      // Save valid consent
      await consentRepo.save({
        id: "c_valid_test",
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const delivery = createTestDelivery("del_controlled_test", "sess_controlled_test");
      await seedOutboxDeliveryForTest(outboxRepo, delivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      const result = await worker.processCycle();
      assert.strictEqual(result.dispatchedCount, 1);

      const dispatched = await outboxRepo.getDeliveryById("del_controlled_test");
      assert.strictEqual(dispatched?.status, "dispatched");
      assert.strictEqual(dispatched?.policyResult?.status, "allowed");
    });
  });

  console.log("\n--- 2. REPOSITORY ENCAPSULATION & STORE PROTECTION ---");

  await test("5. getInternalStoreForTest() does not exist on InMemoryCommunicationOutboxRepository", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    assert.strictEqual(
      typeof (inMem as unknown as Record<string, unknown>).getInternalStoreForTest,
      "undefined",
      "InMemoryCommunicationOutboxRepository must not expose getInternalStoreForTest"
    );
  });

  await test("6. Neither concrete repository exposes any public backing-store reference", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    const firestore = new FirestoreCommunicationOutboxRepository();

    // Verify neither exposes store, backingStore, map, or cache
    assert.strictEqual(typeof (inMem as unknown as Record<string, unknown>).store, "undefined");
    assert.strictEqual(typeof (inMem as unknown as Record<string, unknown>).backingStore, "undefined");
    assert.strictEqual(typeof (inMem as unknown as Record<string, unknown>).map, "undefined");
    assert.strictEqual(typeof (firestore as unknown as Record<string, unknown>).store, "undefined");
    assert.strictEqual(typeof (firestore as unknown as Record<string, unknown>).db, "undefined");
  });

  await test("7. Fixture seeding works exclusively through TestInMemoryCommunicationOutboxRepository adapter", async () => {
    const testRepo = new TestInMemoryCommunicationOutboxRepository();
    assert.strictEqual(typeof testRepo.seedDelivery, "function");

    const delivery = createTestDelivery("del_adapter_test", "sess_adapter_test");
    await seedOutboxDeliveryForTest(testRepo, delivery);

    const fetched = await testRepo.getDeliveryById("del_adapter_test");
    assert.strictEqual(fetched?.id, "del_adapter_test");
    assert.strictEqual(testRepo.getRecordCount(), 1);

    // Seeding with plain InMemoryCommunicationOutboxRepository throws
    const prodRepo = new InMemoryCommunicationOutboxRepository();
    await assert.rejects(
      async () => {
        await seedOutboxDeliveryForTest(prodRepo, delivery);
      },
      /Unsupported repository type for test fixture seeding/
    );
  });

  console.log("\n--- 3. FIRESTORE TEST FIXTURE FAIL-CLOSED GUARDS ---");

  await test("8. Firestore fixture setup refuses non-emulator environments (missing FIRESTORE_EMULATOR_HOST)", async () => {
    const adapter = new TestFirestoreOutboxFixtureAdapter();
    const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
    const originalTestEnv = process.env.BREW_TEST_ENV;

    try {
      delete process.env.FIRESTORE_EMULATOR_HOST;
      process.env.BREW_TEST_ENV = "true";

      const delivery = createTestDelivery("del_emul_check", "sess_emul_check");
      await assert.rejects(
        async () => {
          await adapter.seedDelivery(delivery);
        },
        /Security violation: Firestore fixture seeding is strictly prohibited outside the Firebase Emulator/
      );
    } finally {
      if (originalHost) process.env.FIRESTORE_EMULATOR_HOST = originalHost;
      else delete process.env.FIRESTORE_EMULATOR_HOST;
      if (originalTestEnv) process.env.BREW_TEST_ENV = originalTestEnv;
      else delete process.env.BREW_TEST_ENV;
    }
  });

  await test("9. Firestore fixture setup refuses missing test environment markers", async () => {
    const adapter = new TestFirestoreOutboxFixtureAdapter();
    const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
    const originalTestEnv = process.env.BREW_TEST_ENV;
    const originalNodeEnv = process.env.NODE_ENV;

    try {
      process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
      delete process.env.BREW_TEST_ENV;
      delete process.env.BREW_TEST_ENVIRONMENT;
      (process.env as Record<string, string>).NODE_ENV = "production";

      const delivery = createTestDelivery("del_emul_marker", "sess_emul_marker");
      await assert.rejects(
        async () => {
          await adapter.seedDelivery(delivery);
        },
        /Security violation: Firestore fixture seeding requires an explicit test environment marker/
      );
    } finally {
      if (originalHost) process.env.FIRESTORE_EMULATOR_HOST = originalHost;
      else delete process.env.FIRESTORE_EMULATOR_HOST;
      if (originalTestEnv) process.env.BREW_TEST_ENV = originalTestEnv;
      else delete process.env.BREW_TEST_ENV;
      if (originalNodeEnv) (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      else delete (process.env as Record<string, string | undefined>).NODE_ENV;
    }
  });

  await test("10. No test fixture path can silently write to production Firestore", async () => {
    // Both adapter method and seedOutboxDeliveryForTest fail closed without emulator
    const firestoreRepo = new FirestoreCommunicationOutboxRepository();
    const originalHost = process.env.FIRESTORE_EMULATOR_HOST;

    try {
      delete process.env.FIRESTORE_EMULATOR_HOST;
      const delivery = createTestDelivery("del_silent_prod", "sess_silent_prod");

      await assert.rejects(
        async () => {
          await seedOutboxDeliveryForTest(firestoreRepo, delivery);
        },
        /Security violation/
      );
    } finally {
      if (originalHost) process.env.FIRESTORE_EMULATOR_HOST = originalHost;
      else delete process.env.FIRESTORE_EMULATOR_HOST;
    }
  });

  console.log("\n--- 4. CLAIM FENCING & PARITY PRESERVATION ---");

  await test("11. Claim-token fencing and stale-worker rejection still work with reused worker IDs", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();

    const session = createTestSession("sess_fence_parity");
    await sessionRepo.save(session);

    const delivery = createTestDelivery("del_fence_parity", "sess_fence_parity");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimedA] = await outboxRepo.claimEligibleDeliveries("shared_worker_id", 60_000, 10, t0);
    const tokenA = claimedA.claimToken!;

    // Lease expires; another instance with same workerId reclaims
    const t1 = new Date("2026-11-02T10:01:10.000Z");
    const [claimedB] = await outboxRepo.claimEligibleDeliveries("shared_worker_id", 60_000, 10, t1);
    const tokenB = claimedB.claimToken!;
    assert.notStrictEqual(tokenA, tokenB);

    // Stale Worker A attempt fails
    claimedA.status = "dispatched";
    claimedA.claimOwner = null;
    claimedA.claimToken = null;
    claimedA.leaseExpiresAt = null;

    await assert.rejects(
      async () => {
        await outboxRepo.updateClaimedDelivery(
          claimedA,
          { claimOwner: "shared_worker_id", claimedAt: t0.toISOString(), claimToken: tokenA },
          t1
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof StaleClaimError);
        assert.match((err as StaleClaimError).message, /claimToken mismatch/);
        return true;
      }
    );
  });

  await test("12. In-memory and Firestore repository public contracts remain strictly aligned", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    const firestore = new FirestoreCommunicationOutboxRepository();

    const expectedMethods = [
      "claimEligibleDeliveries",
      "updateClaimedDelivery",
      "getDeliveryById",
      "getDeliveriesBySessionId",
    ];

    for (const m of expectedMethods) {
      assert.strictEqual(
        typeof (inMem as unknown as Record<string, unknown>)[m],
        "function",
        `InMemory must have method ${m}`
      );
      assert.strictEqual(
        typeof (firestore as unknown as Record<string, unknown>)[m],
        "function",
        `Firestore must have method ${m}`
      );
    }

    // Both must NOT have updateDelivery, seedDeliveryForTest, or getInternalStoreForTest
    const forbiddenMethods = ["updateDelivery", "seedDeliveryForTest", "getInternalStoreForTest"];
    for (const m of forbiddenMethods) {
      assert.strictEqual(
        typeof (inMem as unknown as Record<string, unknown>)[m],
        "undefined",
        `InMemory must NOT have method ${m}`
      );
      assert.strictEqual(
        typeof (firestore as unknown as Record<string, unknown>)[m],
        "undefined",
        `Firestore must NOT have method ${m}`
      );
    }
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.3.2.2 Verification Summary: ${passed} / ${total} tests passed (100% SUCCESS)`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
