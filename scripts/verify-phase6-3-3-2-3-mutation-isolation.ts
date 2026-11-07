/**
 * BREW Coffee Platform — Phase 6.3.3.2.3 Verification Suite
 * Final Repository Mutation and Emulator Isolation Fix
 *
 * Verifies:
 * 1. Production in-memory repository does not expose clear().
 * 2. Constructor cannot accept or retain an external mutable backing store.
 * 3. Private backing-store encapsulation is preserved (no public store access).
 * 4. Test adapter can seed fixtures without passing a mutable Map into production repo.
 * 5. Local emulator endpoints (localhost:port, 127.0.0.1:port, [::1]:port) are accepted.
 * 6. Remote hostnames, production endpoints, malformed values, missing host, and missing test markers are rejected.
 * 7. Fixture writes fail closed before obtaining or using Admin Firestore DB.
 * 8. Claim-token fencing and outbox lifecycle parity are fully preserved.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false"; // Production default

import assert from "assert";
import {
  InMemoryCommunicationOutboxRepository,
  FirestoreCommunicationOutboxRepository,
  OutboxWorker,
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
  isValidLocalFirestoreEmulatorHost,
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
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
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
    policyResult: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createTestSession(id: string = "sess_miso_001"): VoiceBookingSession {
  const vanRequestId = computeOfficialVanRequestId(id);
  const requirements = {
    customerName: "Joy Gupta",
    city: "Hyderabad" as const,
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
  console.log("   BREW Coffee Platform — Phase 6.3.3.2.3 Verification Suite");
  console.log("   Final Repository Mutation and Emulator Isolation Fix");
  console.log("================================================================================");

  console.log("\n--- 1. IN-MEMORY REPOSITORY ENCAPSULATION & MUTATION BOUNDARY ---");

  await test("1. Production in-memory repository does not expose clear()", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    assert.strictEqual(
      typeof (inMem as unknown as Record<string, unknown>).clear,
      "undefined",
      "InMemoryCommunicationOutboxRepository must not expose clear()"
    );
  });

  await test("2. Constructor rejects external mutable store argument", async () => {
    const externalMap = new Map<string, CommunicationDeliveryRecord>();
    assert.throws(
      () => {
        // Attempting to pass a Map as the first argument must throw TypeError
        new InMemoryCommunicationOutboxRepository(externalMap as unknown as () => string);
      },
      /TypeError: InMemoryCommunicationOutboxRepository constructor expects an optional tokenGenerator function, not an external store or object/,
      "Passing a Map to InMemoryCommunicationOutboxRepository constructor must fail closed"
    );
  });

  await test("3. Constructor accepts custom tokenGenerator function", async () => {
    let callCount = 0;
    const customGen = () => {
      callCount++;
      return `custom_tok_${callCount}`;
    };

    const inMem = new InMemoryCommunicationOutboxRepository(customGen);
    assert.strictEqual(typeof inMem.claimEligibleDeliveries, "function");
  });

  await test("4. Backing store encapsulation remains strictly preserved", async () => {
    const inMem = new InMemoryCommunicationOutboxRepository();
    const firestore = new FirestoreCommunicationOutboxRepository();

    const inMemObj = inMem as unknown as Record<string, unknown>;
    const firestoreObj = firestore as unknown as Record<string, unknown>;

    assert.strictEqual(typeof inMemObj.store, "undefined");
    assert.strictEqual(typeof inMemObj.sharedStore, "undefined");
    assert.strictEqual(typeof inMemObj.backingStore, "undefined");
    assert.strictEqual(typeof inMemObj.map, "undefined");
    assert.strictEqual(typeof inMemObj.clear, "undefined");
    assert.strictEqual(typeof inMemObj.updateDelivery, "undefined");
    assert.strictEqual(typeof inMemObj.seedDelivery, "undefined");

    assert.strictEqual(typeof firestoreObj.store, "undefined");
    assert.strictEqual(typeof firestoreObj.db, "undefined");
    assert.strictEqual(typeof firestoreObj.clear, "undefined");
  });

  console.log("\n--- 2. TEST ADAPTER SEEDING & INTEGRITY ---");

  await test("5. Test adapter seeds fixtures without passing mutable Map to super()", async () => {
    const testRepo = new TestInMemoryCommunicationOutboxRepository();
    assert.strictEqual(typeof testRepo.seedDelivery, "function");

    const delivery = createTestDelivery("del_seed_001", "sess_seed_001");
    testRepo.seedDelivery(delivery);

    const fetched = await testRepo.getDeliveryById("del_seed_001");
    assert.strictEqual(fetched?.id, "del_seed_001");
    assert.strictEqual(fetched?.status, "pending");
    assert.strictEqual(testRepo.getRecordCount(), 1);
  });

  await test("6. Seeded deliveries are claimable and updateable via updateClaimedDelivery", async () => {
    const testRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_seed_002", "sess_seed_002");
    testRepo.seedDelivery(delivery);

    const now = new Date();
    const claimed = await testRepo.claimEligibleDeliveries("worker_test", 60000, 10, now);
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(claimed[0].status, "processing");
    assert.strictEqual(claimed[0].claimOwner, "worker_test");
    assert.ok(claimed[0].claimToken, "Must have claim token");

    // Update with valid claim context
    const updatedDelivery: CommunicationDeliveryRecord = {
      ...claimed[0],
      status: "dispatched",
      updatedAt: new Date().toISOString(),
    };

    await testRepo.updateClaimedDelivery(
      updatedDelivery,
      {
        claimOwner: "worker_test",
        claimToken: claimed[0].claimToken!,
        claimedAt: claimed[0].claimedAt!,
      },
      new Date()
    );

    const result = await testRepo.getDeliveryById("del_seed_002");
    assert.strictEqual(result?.status, "dispatched");
  });

  console.log("\n--- 3. FIRESTORE FIXTURE EMULATOR ISOLATION ---");

  await test("7. Local emulator endpoints are accepted by validator", async () => {
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:8080"), true);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("127.0.0.1:8080"), true);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("127.0.0.1:8085"), true);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("[::1]:8080"), true);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:9099"), true);
  });

  await test("8. Arbitrary remote hostnames and production endpoints are rejected", async () => {
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("firestore.googleapis.com:443"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("emulator.remote.corp:8080"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("192.168.1.100:8080"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("10.0.0.1:8080"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("brew-staging-db.internal:8080"), false);
  });

  await test("9. Malformed emulator hosts are rejected", async () => {
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("http://localhost:8080"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("https://localhost:8080"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:8080/path"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost"), false); // missing port
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("127.0.0.1"), false); // missing port
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:abc"), false); // non-numeric port
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:0"), false); // port < 1
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:65536"), false); // port > 65535
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("localhost:99999"), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost(""), false);
    assert.strictEqual(isValidLocalFirestoreEmulatorHost("   "), false);
  });

  await test("10. Fixture setup rejects remote host with security violation error", async () => {
    const adapter = new TestFirestoreOutboxFixtureAdapter();
    const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
    const originalTestEnv = process.env.BREW_TEST_ENV;

    try {
      process.env.BREW_TEST_ENV = "true";
      process.env.FIRESTORE_EMULATOR_HOST = "firestore.googleapis.com:443";

      const delivery = createTestDelivery("del_remote_check", "sess_remote_check");
      await assert.rejects(
        async () => {
          await adapter.seedDelivery(delivery);
        },
        /Security violation: FIRESTORE_EMULATOR_HOST 'firestore\.googleapis\.com:443' is not an authorized local emulator endpoint/
      );
    } finally {
      if (originalHost) process.env.FIRESTORE_EMULATOR_HOST = originalHost;
      else delete process.env.FIRESTORE_EMULATOR_HOST;
      if (originalTestEnv) process.env.BREW_TEST_ENV = originalTestEnv;
      else delete process.env.BREW_TEST_ENV;
    }
  });

  await test("11. Fixture setup rejects malformed host (missing port, url scheme)", async () => {
    const adapter = new TestFirestoreOutboxFixtureAdapter();
    const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
    const originalTestEnv = process.env.BREW_TEST_ENV;

    try {
      process.env.BREW_TEST_ENV = "true";
      process.env.FIRESTORE_EMULATOR_HOST = "http://localhost:8080";

      const delivery = createTestDelivery("del_scheme_check", "sess_scheme_check");
      await assert.rejects(
        async () => {
          await adapter.seedDelivery(delivery);
        },
        /Security violation: FIRESTORE_EMULATOR_HOST 'http:\/\/localhost:8080' is not an authorized local emulator endpoint/
      );
    } finally {
      if (originalHost) process.env.FIRESTORE_EMULATOR_HOST = originalHost;
      else delete process.env.FIRESTORE_EMULATOR_HOST;
      if (originalTestEnv) process.env.BREW_TEST_ENV = originalTestEnv;
      else delete process.env.BREW_TEST_ENV;
    }
  });

  await test("12. Fixture setup rejects missing host and missing test markers", async () => {
    const adapter = new TestFirestoreOutboxFixtureAdapter();
    const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
    const originalTestEnv = process.env.BREW_TEST_ENV;
    const originalNodeEnv = process.env.NODE_ENV;

    // Test 12a: Missing host
    try {
      delete process.env.FIRESTORE_EMULATOR_HOST;
      process.env.BREW_TEST_ENV = "true";

      const delivery = createTestDelivery("del_miss_host", "sess_miss_host");
      await assert.rejects(
        async () => {
          await adapter.seedDelivery(delivery);
        },
        /Security violation: Firestore fixture seeding is strictly prohibited outside the Firebase Emulator/
      );
    } finally {
      if (originalHost) process.env.FIRESTORE_EMULATOR_HOST = originalHost;
      else delete process.env.FIRESTORE_EMULATOR_HOST;
    }

    // Test 12b: Missing test marker
    try {
      process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
      delete process.env.BREW_TEST_ENV;
      delete process.env.BREW_TEST_ENVIRONMENT;
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      const delivery = createTestDelivery("del_miss_marker", "sess_miss_marker");
      await assert.rejects(
        async () => {
          await adapter.seedDelivery(delivery);
        },
        /Security violation: Firestore fixture seeding requires an explicit test environment marker/
      );
    } finally {
      if (originalTestEnv) process.env.BREW_TEST_ENV = originalTestEnv;
      else delete process.env.BREW_TEST_ENV;
      if (originalNodeEnv) (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      else delete (process.env as Record<string, string | undefined>).NODE_ENV;
    }
  });

  console.log("\n--- 4. CLAIM FENCING & OUTBOX LIFECYCLE PARITY ---");

  await test("13. Claim fencing token prevents stale worker completion with reused worker IDs", async () => {
    const testRepo = new TestInMemoryCommunicationOutboxRepository();
    const delivery = createTestDelivery("del_fence_001", "sess_fence_001");
    testRepo.seedDelivery(delivery);

    const now = new Date("2026-11-02T10:00:00.000Z");

    // Worker A claims with 5-minute lease
    const claimedA = await testRepo.claimEligibleDeliveries("worker-node-1", 300000, 1, now);
    assert.strictEqual(claimedA.length, 1);
    const tokenA = claimedA[0].claimToken!;

    // Advance time past Worker A's lease (10 minutes later)
    const afterExpiry = new Date("2026-11-02T10:10:00.000Z");

    // Worker B reclaims the delivery using the SAME worker ID (e.g. reused node name)
    const claimedB = await testRepo.claimEligibleDeliveries("worker-node-1", 300000, 1, afterExpiry);
    assert.strictEqual(claimedB.length, 1);
    const tokenB = claimedB[0].claimToken!;
    assert.notStrictEqual(tokenA, tokenB, "Reclaimed delivery must receive a fresh unique claim token");

    // Worker A attempts to complete with its stale claim context
    const staleCompletion: CommunicationDeliveryRecord = {
      ...claimedA[0],
      status: "dispatched",
      updatedAt: afterExpiry.toISOString(),
    };

    await assert.rejects(
      async () => {
        await testRepo.updateClaimedDelivery(
          staleCompletion,
          {
            claimOwner: "worker-node-1",
            claimToken: tokenA,
            claimedAt: claimedA[0].claimedAt!,
          },
          afterExpiry
        );
      },
      StaleClaimError,
      "Worker A with stale token must be rejected even though claimOwner matches"
    );

    // Worker B completes with active claim context -> must succeed
    const validCompletion: CommunicationDeliveryRecord = {
      ...claimedB[0],
      status: "dispatched",
      updatedAt: afterExpiry.toISOString(),
    };

    await testRepo.updateClaimedDelivery(
      validCompletion,
      {
        claimOwner: "worker-node-1",
        claimToken: tokenB,
        claimedAt: claimedB[0].claimedAt!,
      },
      afterExpiry
    );

    const finalRecord = await testRepo.getDeliveryById("del_fence_001");
    assert.strictEqual(finalRecord?.status, "dispatched");
    assert.strictEqual(finalRecord?.claimToken, tokenB);
  });

  await test("14. Outbox worker processes claimed deliveries end-to-end with real policy", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const voiceProvider = new MockVoiceProvider();
    const whatsappProvider = new MockWhatsAppProvider();

    const session = createTestSession("sess_miso_001");
    await sessionRepo.save(session);

    // Grant valid WhatsApp transactional consent
    await consentRepo.save({
      id: "c_grant_001",
      phoneNumber: session.phoneNumber,
      channel: "whatsapp",
      purpose: "transactional_update",
      eventType: "grant",
      granted: true,
      consentText: "I agree to receive booking updates via WhatsApp",
      consentVersion: "v1.0",
      timestamp: new Date().toISOString(),
    });

    const delivery = createTestDelivery("del_worker_e2e", session.id);
    outboxRepo.seedDelivery(delivery);

    const worker = new OutboxWorker({
      outboxRepository: outboxRepo,
      sessionRepository: sessionRepo,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider,
    });

    // 14a: Default execution (VOICE_BOOKING_ENABLED=false) -> blocks dispatch
    const cycle1 = await worker.processCycle();
    assert.strictEqual(cycle1.blockedCount, 1);
    assert.strictEqual(cycle1.dispatchedCount, 0);

    const blockedRecord = await outboxRepo.getDeliveryById("del_worker_e2e");
    assert.strictEqual(blockedRecord?.status, "blocked");
    assert.strictEqual(blockedRecord?.policyResult?.reason, "FEATURE_DISABLED");

    // 14b: Scoped simulation with withTestVoiceBookingEnabled -> allows dispatch
    const delivery2 = createTestDelivery("del_worker_e2e_2", session.id);
    outboxRepo.seedDelivery(delivery2);

    await withTestVoiceBookingEnabled(async () => {
      const cycle2 = await worker.processCycle();
      assert.strictEqual(cycle2.dispatchedCount, 1);
      assert.strictEqual(cycle2.blockedCount, 0);

      const dispatchedRecord = await outboxRepo.getDeliveryById("del_worker_e2e_2");
      assert.strictEqual(dispatchedRecord?.status, "dispatched");
      assert.strictEqual(dispatchedRecord?.policyResult?.reason, "ALLOWED");
    });

    // Verify VOICE_BOOKING_ENABLED is safely restored
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.3.2.3 Verification Summary: ${passed} / ${passed + failed} tests passed (${Math.round((passed / (passed + failed)) * 100)}% SUCCESS)`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
