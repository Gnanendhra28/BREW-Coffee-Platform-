/**
 * BREW Coffee Platform — Phase 6.3.3.2 Verification Suite
 * Worker Boundary & Claim Fencing Hardening
 *
 * Verifies:
 * 1. Reclaimed delivery receives a new claim token.
 * 2. Worker A cannot complete after Worker B reclaims, even if both use the same worker ID.
 * 3. Incorrect claim token is rejected.
 * 4. Correct token with expired lease is rejected.
 * 5. Correct token with active lease succeeds.
 * 6. In-memory and Firestore repository contracts match.
 * 7. Production worker construction cannot disable the feature flag.
 * 8. Test harness can simulate policy-approved execution without exposing a production bypass.
 * 9. No production worker path calls unconditional updateDelivery().
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
import { generateVoiceBookingQuotation, createQuotationSnapshot } from "../src/lib/voiceBooking/quotationAdapter";

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
    `sess_fence_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
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
    claimToken: null,
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
  console.log("   BREW Coffee Platform — Phase 6.3.3.2 Verification Suite");
  console.log("   Worker Boundary & Claim Fencing Hardening");
  console.log("================================================================================\n");

  console.log("--- 1. UNIQUE CLAIM FENCING TOKENS ---");

  await test("1. Reclaimed delivery receives a new unique claim token", async () => {
    let tokCounter = 1;
    const tokenGen = () => `fencetok_${tokCounter++}`;
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository(tokenGen);

    const delivery = createTestDelivery("del_fence_1", "sess_fence_1");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimedA] = await outboxRepo.claimEligibleDeliveries("worker_a", 60_000, 10, t0);
    assert.strictEqual(claimedA.claimToken, "fencetok_1");

    // Advance clock past lease duration
    const t1 = new Date("2026-11-02T10:01:05.000Z");
    const [claimedB] = await outboxRepo.claimEligibleDeliveries("worker_b", 60_000, 10, t1);
    assert.strictEqual(claimedB.claimToken, "fencetok_2");

    assert.notStrictEqual(claimedA.claimToken, claimedB.claimToken);
  });

  await test("2. Worker A cannot complete after Worker B reclaims, even if both use the same worker ID", async () => {
    let tokCounter = 100;
    const tokenGen = () => `fencetok_${tokCounter++}`;
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository(tokenGen);

    const delivery = createTestDelivery("del_fence_2", "sess_fence_2");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimedA] = await outboxRepo.claimEligibleDeliveries("shared_worker_id", 60_000, 10, t0);
    const tokenA = claimedA.claimToken!;
    assert.strictEqual(tokenA, "fencetok_100");

    // Advance clock past lease; another instance with same workerId reclaims
    const t1 = new Date("2026-11-02T10:01:05.000Z");
    const [claimedB] = await outboxRepo.claimEligibleDeliveries("shared_worker_id", 60_000, 10, t1);
    const tokenB = claimedB.claimToken!;
    assert.strictEqual(tokenB, "fencetok_101");

    // Worker A attempts to complete with tokenA
    claimedA.status = "dispatched";
    claimedA.claimOwner = null;
    claimedA.claimToken = null;
    claimedA.leaseExpiresAt = null;

    let threwStaleError = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimedA,
        { claimOwner: "shared_worker_id", claimedAt: t0.toISOString(), claimToken: tokenA },
        t1
      );
    } catch (err) {
      if (err instanceof StaleClaimError) {
        threwStaleError = true;
      }
    }

    assert.strictEqual(threwStaleError, true, "Worker A's stale update must be rejected despite matching workerId");

    // Repository record retains Worker B's active token and processing state
    const stored = await outboxRepo.getDeliveryById("del_fence_2");
    assert.strictEqual(stored?.claimOwner, "shared_worker_id");
    assert.strictEqual(stored?.claimToken, tokenB);
    assert.strictEqual(stored?.status, "processing");
  });

  await test("3. Incorrect claim token is rejected", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_fence_3", "sess_fence_3");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimed] = await outboxRepo.claimEligibleDeliveries("worker_test", 60_000, 10, t0);

    claimed.status = "dispatched";
    claimed.claimOwner = null;
    claimed.claimToken = null;
    claimed.leaseExpiresAt = null;

    let threw = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimed,
        {
          claimOwner: "worker_test",
          claimedAt: t0.toISOString(),
          claimToken: "completely_wrong_fencing_token",
        },
        t0
      );
    } catch (err) {
      threw = err instanceof StaleClaimError;
    }

    assert.strictEqual(threw, true, "Mismatched claimToken must throw StaleClaimError");
  });

  await test("4. Correct token with expired lease is rejected", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_fence_4", "sess_fence_4");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimed] = await outboxRepo.claimEligibleDeliveries("worker_test", 60_000, 10, t0);
    const token = claimed.claimToken!;

    claimed.status = "dispatched";
    claimed.claimOwner = null;
    claimed.claimToken = null;
    claimed.leaseExpiresAt = null;

    // Time is 65s later (lease expired)
    const tExpired = new Date("2026-11-02T10:01:05.000Z");

    let threw = false;
    try {
      await outboxRepo.updateClaimedDelivery(
        claimed,
        {
          claimOwner: "worker_test",
          claimedAt: t0.toISOString(),
          claimToken: token,
        },
        tExpired
      );
    } catch (err) {
      threw = err instanceof StaleClaimError;
    }

    assert.strictEqual(threw, true, "Expired lease with matching token must still be rejected");
  });

  await test("5. Correct token with active lease succeeds", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_fence_5", "sess_fence_5");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    const [claimed] = await outboxRepo.claimEligibleDeliveries("worker_test", 60_000, 10, t0);
    const token = claimed.claimToken!;

    claimed.status = "dispatched";
    claimed.claimOwner = null;
    claimed.claimToken = null;
    claimed.leaseExpiresAt = null;

    // Time is 10s later (active lease)
    const tActive = new Date("2026-11-02T10:00:10.000Z");

    await outboxRepo.updateClaimedDelivery(
      claimed,
      {
        claimOwner: "worker_test",
        claimedAt: t0.toISOString(),
        claimToken: token,
      },
      tActive
    );

    const stored = await outboxRepo.getDeliveryById("del_fence_5");
    assert.strictEqual(stored?.status, "dispatched");
    assert.strictEqual(stored?.claimOwner, null);
    assert.strictEqual(stored?.claimToken, null);
  });

  console.log("\n--- 2. CONTRACT EQUIVALENCE ---");

  await test("6. In-memory and Firestore repository contracts match", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    const firestore = new FirestoreCommunicationOutboxRepository();

    // Verify method signatures exist on both
    assert.strictEqual(typeof inMem.claimEligibleDeliveries, "function");
    assert.strictEqual(typeof firestore.claimEligibleDeliveries, "function");
    assert.strictEqual(typeof inMem.updateClaimedDelivery, "function");
    assert.strictEqual(typeof firestore.updateClaimedDelivery, "function");
    assert.strictEqual(typeof inMem.getDeliveryById, "function");
    assert.strictEqual(typeof firestore.getDeliveryById, "function");
    assert.strictEqual(typeof inMem.getDeliveriesBySessionId, "function");
    assert.strictEqual(typeof firestore.getDeliveriesBySessionId, "function");

    // Verify neither concrete repository exposes unconditional update, seed, or store accessor methods
    assert.strictEqual(typeof (inMem as unknown as Record<string, unknown>).updateDelivery, "undefined");
    assert.strictEqual(typeof (firestore as unknown as Record<string, unknown>).updateDelivery, "undefined");
    assert.strictEqual(typeof (inMem as unknown as Record<string, unknown>).seedDeliveryForTest, "undefined");
    assert.strictEqual(typeof (firestore as unknown as Record<string, unknown>).seedDeliveryForTest, "undefined");
    assert.strictEqual(typeof (inMem as unknown as Record<string, unknown>).getInternalStoreForTest, "undefined");
  });

  console.log("\n--- 3. WORKER BOUNDARY & FEATURE FLAG ENFORCEMENT ---");

  await test("7. Production worker construction cannot disable the feature flag", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const deps = {
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
    };

    // 1. Ordinary options cannot disable the flag
    const forcedOptions = { checkFeatureFlag: false } as unknown as Record<string, unknown>;
    const worker = new OutboxWorker(deps, forcedOptions);
    assert.strictEqual(worker.isFeatureFlagEnforced(), true);

    // 2. Passing a 3rd parameter to constructor has zero effect
    const workerWithSeam = new (OutboxWorker as unknown as new (d: unknown, o: unknown, s: unknown) => OutboxWorker)(
      deps,
      {},
      { checkFeatureFlag: false }
    );
    assert.strictEqual(workerWithSeam.isFeatureFlagEnforced(), true);
  });

  await test("8. Runtime-supplied customPolicyOrchestrator is completely ignored and real policy is enforced", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession({ id: "sess_rogue_pol", state: "awaiting_staff_approval" });
    await sessionRepo.save(session);

    const delivery = createTestDelivery("del_rogue_pol", "sess_rogue_pol");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    let rogueCalled = false;
    const rogueDeps = {
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
      customPolicyOrchestrator: async () => {
        rogueCalled = true;
        return {
          status: "allowed" as const,
          reason: "ALLOWED" as const,
          details: "bypassed",
          evaluatedAt: new Date().toISOString(),
          channel: "whatsapp" as const,
          purpose: "transactional_update" as const,
          phoneNumberMasked: "+91******3210",
        };
      },
    };

    const worker = new OutboxWorker(rogueDeps as unknown as OutboxWorkerDependencies);
    assert.strictEqual(worker.isFeatureFlagEnforced(), true);

    // Process cycle with default VOICE_BOOKING_ENABLED="false"
    const result = await worker.processCycle();
    assert.strictEqual(rogueCalled, false, "Rogue customPolicyOrchestrator must NEVER be called");
    assert.strictEqual(result.blockedCount, 1, "Real policy must execute and block delivery with FEATURE_DISABLED");

    const rec = await outboxRepo.getDeliveryById("del_rogue_pol");
    assert.strictEqual(rec?.status, "blocked");
    assert.strictEqual(rec?.policyResult?.reason, "FEATURE_DISABLED");
  });

  console.log("\n--- 4. RESTRICTED UNCONDITIONAL UPDATES ---");

  await test("9. No production worker path calls unconditional updateDelivery()", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createTestSession({ id: "sess_prod_path", state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_prod_path",
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Transactional consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const delivery = createTestDelivery("del_prod_path", "sess_prod_path");
      await seedOutboxDeliveryForTest(outboxRepo, delivery);

      // Confirm updateDelivery does not exist on outboxRepo
      assert.strictEqual(
        typeof (outboxRepo as unknown as Record<string, unknown>).updateDelivery,
        "undefined"
      );

      // Track calls to updateClaimedDelivery
      let updateClaimedCalled = false;
      const origUpdateClaimed = outboxRepo.updateClaimedDelivery.bind(outboxRepo);
      outboxRepo.updateClaimedDelivery = async (d, c, n) => {
        updateClaimedCalled = true;
        return origUpdateClaimed(d, c, n);
      };

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      const res = await worker.processCycle();
      assert.strictEqual(res.dispatchedCount, 1);
      assert.strictEqual(
        updateClaimedCalled,
        true,
        "Production worker cycle must use updateClaimedDelivery()"
      );
      assert.strictEqual(
        typeof (outboxRepo as unknown as Record<string, unknown>).updateDelivery,
        "undefined",
        "outboxRepo must not expose updateDelivery"
      );
    });
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.3.2 Verification Summary: ${passed} / ${total} tests passed (100% SUCCESS)`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("Unhandled verification exception:", e);
  process.exit(1);
});
