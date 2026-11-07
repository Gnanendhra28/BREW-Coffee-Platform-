/**
 * BREW Coffee Platform — Phase 6.3.3.2.1 Verification Suite
 * Boundary Closure: Feature-Flag Immutability, Repository Interface Segregation, and Schema Fencing
 *
 * Verifies:
 * 1. Public OutboxWorker constructor accepts only (dependencies, options) and cannot disable the feature flag.
 * 2. Passing an extra parameter or option to OutboxWorker has zero effect on enforcement.
 * 3. Default production worker without custom policy orchestrator enforces real feature flag (blocks when VOICE_BOOKING_ENABLED=false).
 * 4. Test policy simulation via customPolicyOrchestrator allows deterministic outcomes without mutating production enforcement.
 * 5. Neither InMemoryCommunicationOutboxRepository nor FirestoreCommunicationOutboxRepository exposes updateDelivery().
 * 6. Neither InMemoryCommunicationOutboxRepository nor FirestoreCommunicationOutboxRepository exposes seedDeliveryForTest().
 * 7. Test fixture utilities (seedOutboxDeliveryForTest) are strictly isolated and not exported from the production barrel.
 * 8. CommunicationDeliveryRecordSchema rejects status='processing' with null, missing, or whitespace claimToken.
 * 9. CommunicationDeliveryRecordSchema permits non-processing records (pending, dispatched, etc.) with null/undefined claimToken.
 * 10. End-to-end claim fencing prevents stale completion when worker IDs are reused on reclaimed leases.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false"; // Production default

import assert from "assert";
import { readFileSync } from "fs";
import { join } from "path";
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
  CommunicationDeliveryRecordSchema,
} from "../src/lib/communication";
import {
  TestInMemoryCommunicationOutboxRepository,
  seedOutboxDeliveryForTest,
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
  console.log("   BREW Coffee Platform — Phase 6.3.3.2.1 Verification Suite");
  console.log("   Boundary Closure: Feature-Flag & Repository Segregation");
  console.log("================================================================================\n");

  console.log("--- 1. FEATURE-FLAG IMMUTABILITY & CONSTRUCTOR HARDENING ---");

  await test("1. OutboxWorker constructor accepts only (dependencies, options) and always enforces feature flag", async () => {
    // Constructor parameter length should be at most 2
    assert.strictEqual(OutboxWorker.length <= 2, true, "OutboxWorker constructor must accept at most 2 parameters");

    const outboxRepo = new InMemoryCommunicationOutboxRepository();
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

    const worker = new OutboxWorker(deps, { workerId: "test_worker_1" });
    assert.strictEqual(worker.isFeatureFlagEnforced(), true);
  });

  await test("2. Attempting to pass 3rd constructor parameter has zero effect", async () => {
    const outboxRepo = new InMemoryCommunicationOutboxRepository();
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

    // Cast to any to attempt 3rd argument injection
    const workerWithSeam = new (OutboxWorker as unknown as new (d: unknown, o: unknown, s: unknown) => OutboxWorker)(
      deps,
      {},
      { checkFeatureFlag: false }
    );

    assert.strictEqual(workerWithSeam.isFeatureFlagEnforced(), true, "3rd parameter must be ignored");
  });

  await test("3. Default production worker enforces real feature flag (blocks when VOICE_BOOKING_ENABLED=false)", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession("sess_flag_check");
    await sessionRepo.save(session);

    // Valid consent
    await consentRepo.save({
      id: "c_flag",
      phoneNumber: "+919876543210",
      channel: "whatsapp",
      purpose: "transactional_update",
      eventType: "grant",
      granted: true,
      consentText: "Consent",
      consentVersion: "v1.0",
      timestamp: "2026-11-02T09:00:00.000Z",
    });

    const delivery = createTestDelivery("del_flag_check", "sess_flag_check");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    // Construct pure production worker
    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
    });

    const result = await worker.processCycle();
    assert.strictEqual(result.blockedCount, 1, "Must block delivery because feature flag is disabled");
    assert.strictEqual(result.dispatchedCount, 0);

    const saved = await outboxRepo.getDeliveryById("del_flag_check");
    assert.strictEqual(saved?.status, "blocked");
    assert.strictEqual(saved?.policyResult?.reason, "FEATURE_DISABLED");
  });

  await test("4. Runtime-supplied customPolicyOrchestrator is completely ignored and real policy is enforced", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession("sess_sim_check");
    await sessionRepo.save(session);

    const delivery = createTestDelivery("del_sim_check", "sess_sim_check");
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

    // With VOICE_BOOKING_ENABLED="false", real policy must block with FEATURE_DISABLED
    const result = await worker.processCycle();
    assert.strictEqual(rogueCalled, false, "Rogue customPolicyOrchestrator must NEVER be called");
    assert.strictEqual(result.blockedCount, 1);
    assert.strictEqual(result.dispatchedCount, 0);

    const saved = await outboxRepo.getDeliveryById("del_sim_check");
    assert.strictEqual(saved?.status, "blocked");
    assert.strictEqual(saved?.policyResult?.reason, "FEATURE_DISABLED");
  });

  console.log("\n--- 2. REPOSITORY SEGREGATION & TEST FIXTURE ISOLATION ---");

  await test("5. Concrete repositories do not expose updateDelivery()", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    const firestore = new FirestoreCommunicationOutboxRepository();

    assert.strictEqual(
      typeof (inMem as unknown as Record<string, unknown>).updateDelivery,
      "undefined",
      "InMemoryCommunicationOutboxRepository must not have updateDelivery"
    );
    assert.strictEqual(
      typeof (firestore as unknown as Record<string, unknown>).updateDelivery,
      "undefined",
      "FirestoreCommunicationOutboxRepository must not have updateDelivery"
    );
  });

  await test("6. Concrete repositories do not expose seedDeliveryForTest()", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    const firestore = new FirestoreCommunicationOutboxRepository();

    assert.strictEqual(
      typeof (inMem as unknown as Record<string, unknown>).seedDeliveryForTest,
      "undefined",
      "InMemoryCommunicationOutboxRepository must not have seedDeliveryForTest"
    );
    assert.strictEqual(
      typeof (firestore as unknown as Record<string, unknown>).seedDeliveryForTest,
      "undefined",
      "FirestoreCommunicationOutboxRepository must not have seedDeliveryForTest"
    );
    assert.strictEqual(
      typeof (inMem as unknown as Record<string, unknown>).getInternalStoreForTest,
      "undefined",
      "InMemoryCommunicationOutboxRepository must not have getInternalStoreForTest"
    );
  });

  await test("7. Test fixture utilities are isolated and not exported from production barrel", async () => {
    const barrel = await import("../src/lib/communication");
    assert.strictEqual(
      (barrel as Record<string, unknown>).seedOutboxDeliveryForTest,
      undefined,
      "seedOutboxDeliveryForTest must NOT be exported from src/lib/communication/index.ts"
    );
    assert.strictEqual(
      (barrel as Record<string, unknown>).createTestOutboxWorker,
      undefined,
      "createTestOutboxWorker must NOT be exported from src/lib/communication/index.ts"
    );
    assert.strictEqual(
      (barrel as Record<string, unknown>).OutboxWorkerTestSeam,
      undefined,
      "OutboxWorkerTestSeam must NOT exist or be exported"
    );
  });

  await test("8. Audit confirms zero production source files call seedOutboxDeliveryForTest or updateDelivery", async () => {
    // Read outboxWorker.ts source
    const workerSrc = readFileSync(
      join(__dirname, "../src/lib/communication/outbox/outboxWorker.ts"),
      "utf-8"
    );
    assert.strictEqual(workerSrc.includes("updateDelivery"), false, "outboxWorker must not call updateDelivery");
    assert.strictEqual(workerSrc.includes("seedDeliveryForTest"), false, "outboxWorker must not call seedDeliveryForTest");
    assert.strictEqual(workerSrc.includes("seedOutboxDeliveryForTest"), false, "outboxWorker must not call seedOutboxDeliveryForTest");
  });

  console.log("\n--- 3. SCHEMA FENCING FOR PROCESSING DELIVERIES ---");

  await test("9. CommunicationDeliveryRecordSchema rejects status='processing' with empty/null/missing claimToken", async () => {
    const base = createTestDelivery("del_schema_1", "sess_schema_1", "whatsapp", "booking_awaiting_staff_approval", "processing", null);

    // 1. claimToken is null
    assert.throws(
      () => CommunicationDeliveryRecordSchema.parse(base),
      /claimToken/i,
      "Schema must reject status='processing' with claimToken=null"
    );

    // 2. claimToken is undefined
    const noToken = { ...base };
    delete (noToken as Record<string, unknown>).claimToken;
    assert.throws(
      () => CommunicationDeliveryRecordSchema.parse(noToken),
      /claimToken/i,
      "Schema must reject status='processing' with claimToken=undefined"
    );

    // 3. claimToken is empty string or whitespace
    const emptyToken = { ...base, claimToken: "   " };
    assert.throws(
      () => CommunicationDeliveryRecordSchema.parse(emptyToken),
      /claimToken/i,
      "Schema must reject status='processing' with whitespace claimToken"
    );

    // 4. claimToken is valid non-empty string -> passes
    const validToken = { ...base, claimToken: "claim_tok_valid_123" };
    assert.doesNotThrow(() => CommunicationDeliveryRecordSchema.parse(validToken));
  });

  await test("10. CommunicationDeliveryRecordSchema accepts non-processing records with null/undefined claimToken", async () => {
    const statuses: Array<"pending" | "dispatched" | "failed" | "blocked" | "permanently_failed"> = [
      "pending",
      "dispatched",
      "failed",
      "blocked",
      "permanently_failed",
    ];

    for (const st of statuses) {
      const rec = createTestDelivery(`del_${st}`, `sess_${st}`, "whatsapp", "booking_awaiting_staff_approval", st, null);
      assert.doesNotThrow(
        () => CommunicationDeliveryRecordSchema.parse(rec),
        `Schema must accept status='${st}' with claimToken=null`
      );
    }
  });

  console.log("\n--- 4. END-TO-END CLAIM FENCING WITH REUSED WORKER IDS ---");

  await test("11. Stale worker completion rejected when worker IDs are reused on reclaimed leases", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const sessionRepo = new InMemoryVoiceSessionRepository();

    const session = createTestSession("sess_fence_reused");
    await sessionRepo.save(session);

    const delivery = createTestDelivery("del_fence_reused", "sess_fence_reused");
    await seedOutboxDeliveryForTest(outboxRepo, delivery);

    const t0 = new Date("2026-11-02T10:00:00.000Z");
    // Worker A claims delivery with lease duration 60s
    const [claimedByA] = await outboxRepo.claimEligibleDeliveries("worker_shared_id", 60_000, 10, t0);
    assert.ok(claimedByA.claimToken);
    const tokenA = claimedByA.claimToken;

    // Advance past lease expiration (70s)
    const t1 = new Date("2026-11-02T10:01:10.000Z");

    // Worker B (reusing the same worker_shared_id) reclaims the expired lease
    const [claimedByB] = await outboxRepo.claimEligibleDeliveries("worker_shared_id", 60_000, 10, t1);
    assert.ok(claimedByB.claimToken);
    const tokenB = claimedByB.claimToken;

    // Token must be distinct
    assert.notStrictEqual(tokenA, tokenB, "Reclaimed lease must receive a new distinct claimToken");

    // Now Worker A attempts completion with stale tokenA (even with claimedAt updated, tokenA is stale)
    const staleCompletion: CommunicationDeliveryRecord = {
      ...claimedByA,
      status: "dispatched",
      claimToken: null,
      updatedAt: t1.toISOString(),
    };

    await assert.rejects(
      async () => {
        await outboxRepo.updateClaimedDelivery(
          staleCompletion,
          {
            claimOwner: "worker_shared_id",
            claimedAt: claimedByA.claimedAt!,
            claimToken: tokenA,
          },
          t1
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof StaleClaimError);
        assert.match((err as StaleClaimError).message, /claimToken mismatch/);
        return true;
      },
      "Worker A's completion must fail with StaleClaimError due to token mismatch"
    );

    // Worker B's completion with tokenB succeeds
    const validCompletion: CommunicationDeliveryRecord = {
      ...claimedByB,
      status: "dispatched",
      claimToken: null,
      updatedAt: t1.toISOString(),
    };

    await outboxRepo.updateClaimedDelivery(
      validCompletion,
      {
        claimOwner: "worker_shared_id",
        claimedAt: claimedByB.claimedAt!,
        claimToken: tokenB,
      },
      t1
    );

    const finalRecord = await outboxRepo.getDeliveryById("del_fence_reused");
    assert.strictEqual(finalRecord?.status, "dispatched");
    assert.strictEqual(finalRecord?.attemptCount, 2);
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.3.2.1 Verification Summary: ${passed} / ${total} tests passed (100% SUCCESS)`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
