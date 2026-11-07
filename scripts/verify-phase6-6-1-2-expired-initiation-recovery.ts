/**
 * BREW Coffee Platform — Phase 6.6.1.2 Verification Suite
 * Expired Initiation Recovery & Webhook Correlation
 *
 * Verifies:
 * 1. Worker crash after carrier acceptance but before Firestore persistence:
 *    Recovered via webhook correlation by internal attempt ID without prior provider mapping.
 * 2. Expired initiation lease recovery:
 *    Expired in-flight lease is atomically transitioned to 'uncertain', quarantining delivery
 *    and strictly blocking automated redial.
 * 3. Two workers concurrently attempting expired-claim recovery:
 *    Only one worker transaction succeeds; the other receives null and no conflicting mutation occurs.
 * 4. Webhook recovery when no providerCallId mapping exists:
 *    Creates providerCallId mapping, resolves unmapped attempts, and handles idempotent redelivery.
 * 5. Rejection of mismatched attempt/session correlation:
 *    Strictly throws error and leaves attempt untouched when sessionId does not match.
 * 6. Rejection of mismatched provider correlation:
 *    Strictly throws error and leaves attempt untouched when provider does not match.
 * 7. Rejection of duplicate providerCallId collision:
 *    Rejects webhook if providerCallId is already mapped to a different attempt.
 */

process.env.CRON_SECRET = "test_cron_secret_6612_auth_token_48chars_secure!";
process.env.APP_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.BUSINESS_PHONE = "+919876543210";
process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import {
  InMemoryVoiceCallAttemptRepository,
  FirestoreVoiceCallAttemptRepository,
  OutboxWorker,
  MockWhatsAppProvider,
  CommunicationDeliveryRecord,
  VoiceProvider,
  VoiceSessionResult,
  VoiceSessionStatusResult,
  VoiceSessionEndResult,
} from "../src/lib/communication";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { VoiceBookingSession } from "../src/lib/voiceBooking/types";
import {
  withTestVoiceBookingEnabled,
  TestInMemoryCommunicationOutboxRepository,
} from "../src/lib/communication/outbox/testFixture";
import { InMemoryConsentRepository } from "../src/lib/communication/repositories/consentRepository";
import { InMemoryDndRepository } from "../src/lib/communication/repositories/dndRepository";

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.6.1.2 Verification Suite");
  console.log("   Expired Initiation Recovery & Webhook Correlation");
  console.log("================================================================================\n");

  const daytime = new Date("2026-11-06T06:30:00.000Z"); // 12:00 PM IST
  const phoneNumber = "+919876543210";

  // ---------------------------------------------------------------------------
  // 1. WORKER CRASH AFTER CARRIER ACCEPTANCE BUT BEFORE FIRESTORE PERSISTENCE
  // ---------------------------------------------------------------------------
  console.log("--- 1. WORKER CRASH BEFORE PERSISTENCE & WEBHOOK RECOVERY ---");

  await test("1.1 Webhook correlation by attemptId recovers attempt when providerCallId was never persisted prior to crash", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();

      await consentRepo.save({
        id: "c_grant_crash_01",
        phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: daytime.toISOString(),
      });

      const session: VoiceBookingSession = {
        id: "vbs_crash_unmapped_01",
        officialBookingId: null,
        phoneNumber,
        language: "en",
        state: "created",
        requirements: {
          eventType: null,
          guestCount: null,
          eventDate: null,
          startTime: null,
          durationHours: null,
          venueAddress: null,
          selectedTier: null,
          beveragePreferences: [],
          handoffRequested: false,
          customerConfirmed: false,
          confidenceScore: 0,
          missingFields: [],
          unresolvedQuestions: [],
        },
        quotation: null,
        quotationSnapshot: null,
        conversationHistory: [],
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
        revision: 1,
        staffApprovalId: null,
        metadata: {},
      };
      await sessionRepo.save(session);

      const internalAttemptId = "del_crash_unmapped_call1";

      // 1. Worker created the attempt in 'in_flight' state
      await callAttemptRepo.createAttempt({
        id: internalAttemptId,
        deliveryId: "del_crash_unmapped_01",
        sessionId: session.id,
        phoneNumberMasked: "+91 98*** ***10",
        provider: "carrier_async",
        claimOwner: "worker_crash_victim",
        claimToken: "tok_crash",
        leaseExpiresAt: new Date(daytime.getTime() + 60000).toISOString(),
        initiationState: "in_flight",
        initiatedAt: daytime.toISOString(),
      });

      // Verification: Attempt exists but has NO providerCallId and no mapping
      const beforeWebhook = await callAttemptRepo.getById(internalAttemptId);
      assert.strictEqual(beforeWebhook?.initiationState, "in_flight");
      assert.strictEqual(beforeWebhook?.providerCallId, null);
      assert.strictEqual(await callAttemptRepo.getByProviderCallId("call_exotel_crash_survivor_999"), null);

      // 2. Incoming carrier status webhook arrives with attemptId and the providerCallId
      const correlateResult = await callAttemptRepo.correlateWebhookByAttemptId({
        attemptId: internalAttemptId,
        providerCallId: "call_exotel_crash_survivor_999",
        provider: "carrier_async",
        sessionId: session.id,
        status: "in_progress",
        timestamp: "2026-11-06T06:30:15.000Z",
      });

      assert.strictEqual(correlateResult.outcome, "updated");
      assert.strictEqual(correlateResult.attempt.providerCallId, "call_exotel_crash_survivor_999");
      assert.strictEqual(correlateResult.attempt.initiationState, "accepted");
      assert.strictEqual(correlateResult.attempt.status, "in_progress");

      // 3. Mapping was registered atomically: fast lookup by providerCallId now works!
      const mappedAttempt = await callAttemptRepo.getByProviderCallId("call_exotel_crash_survivor_999");
      assert.ok(mappedAttempt !== null, "Attempt must now be resolvable by providerCallId");
      assert.strictEqual(mappedAttempt?.id, internalAttemptId);
      assert.strictEqual(mappedAttempt?.initiationState, "accepted");

      // 4. Seed outbox delivery with expired lease to simulate delivery reclaimed by new worker
      const delivery: CommunicationDeliveryRecord = {
        id: "del_crash_unmapped_01",
        eventId: "evt_crash_01",
        sessionId: session.id,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "booking_created",
        phoneNumberMasked: "+91 98*** ***10",
        status: "processing",
        attemptCount: 1,
        callAttemptCount: 1,
        currentAttemptId: internalAttemptId,
        maxAttempts: 3,
        claimOwner: "worker_crash_victim",
        claimToken: "tok_crash",
        claimedAt: daytime.toISOString(),
        leaseExpiresAt: new Date(daytime.getTime() - 1000).toISOString(), // EXPIRED DELIVERY LEASE
        nextRetryAt: null,
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
      };
      outboxRepo.seedDelivery(delivery);

      let redialCount = 0;
      class RecoveryVoiceProvider implements VoiceProvider {
        public readonly providerName = "carrier_async";
        public readonly isAsynchronous = true;

        async startSession(): Promise<VoiceSessionResult> {
          redialCount++;
          throw new Error("Must NOT redial!");
        }
        async getStatus(): Promise<VoiceSessionStatusResult> { throw new Error("not implemented"); }
        async endSession(): Promise<VoiceSessionEndResult> { throw new Error("not implemented"); }
      }

      const recoveryWorker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider: new RecoveryVoiceProvider(),
          whatsappProvider: new MockWhatsAppProvider(),
          callAttemptRepository: callAttemptRepo,
          currentTimeProvider: () => new Date(daytime.getTime() + 10000),
        },
        { workerId: "worker_recovering_crashed_delivery", batchSize: 1, leaseDurationMs: 60000 }
      );

      const cycleResult = await recoveryWorker.processCycle();
      assert.strictEqual(cycleResult.claimedCount, 1);
      assert.strictEqual(cycleResult.dispatchedCount, 1);
      assert.strictEqual(redialCount, 0, "Provider startSession must NOT be called; accepted attempt safely marks delivery dispatched");

      const finalDelivery = await outboxRepo.getDeliveryById(delivery.id);
      assert.strictEqual(finalDelivery?.status, "dispatched");
      assert.strictEqual(finalDelivery?.providerResult?.providerCallId, "call_exotel_crash_survivor_999");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. EXPIRED INITIATION LEASE RECOVERY
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. EXPIRED INITIATION LEASE RECOVERY ---");

  await test("2.1 Expired in-flight initiation lease is atomically recovered to uncertain, blocking automated redial", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();

      await consentRepo.save({
        id: "c_grant_expired_01",
        phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: daytime.toISOString(),
      });

      const session: VoiceBookingSession = {
        id: "vbs_expired_lease_01",
        officialBookingId: null,
        phoneNumber,
        language: "en",
        state: "created",
        requirements: {
          eventType: null,
          guestCount: null,
          eventDate: null,
          startTime: null,
          durationHours: null,
          venueAddress: null,
          selectedTier: null,
          beveragePreferences: [],
          handoffRequested: false,
          customerConfirmed: false,
          confidenceScore: 0,
          missingFields: [],
          unresolvedQuestions: [],
        },
        quotation: null,
        quotationSnapshot: null,
        conversationHistory: [],
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
        revision: 1,
        staffApprovalId: null,
        metadata: {},
      };
      await sessionRepo.save(session);

      const internalAttemptId = "del_exp_01_call1";

      // 1. Attempt was in_flight but its lease expired 10 seconds ago
      const expiredLeaseIso = new Date(daytime.getTime() - 10000).toISOString();
      await callAttemptRepo.createAttempt({
        id: internalAttemptId,
        deliveryId: "del_exp_01",
        sessionId: session.id,
        phoneNumberMasked: "+91 98*** ***10",
        provider: "carrier_async",
        claimOwner: "worker_dead_77",
        claimToken: "tok_dead",
        leaseExpiresAt: expiredLeaseIso,
        initiationState: "in_flight",
        initiatedAt: new Date(daytime.getTime() - 70000).toISOString(),
      });

      // 2. Delivery in outbox is now available for reclamation (its lease also expired)
      const delivery: CommunicationDeliveryRecord = {
        id: "del_exp_01",
        eventId: "evt_exp_01",
        sessionId: session.id,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "booking_created",
        phoneNumberMasked: "+91 98*** ***10",
        status: "processing",
        attemptCount: 1,
        callAttemptCount: 1,
        currentAttemptId: internalAttemptId,
        maxAttempts: 3,
        claimOwner: "worker_dead_77",
        claimToken: "tok_dead",
        claimedAt: new Date(daytime.getTime() - 70000).toISOString(),
        leaseExpiresAt: expiredLeaseIso,
        nextRetryAt: null,
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
      };
      outboxRepo.seedDelivery(delivery);

      let redialAttempts = 0;
      class ExpiredRecoveryVoiceProvider implements VoiceProvider {
        public readonly providerName = "carrier_async";
        public readonly isAsynchronous = true;

        async startSession(): Promise<VoiceSessionResult> {
          redialAttempts++;
          throw new Error("startSession must never be called on expired uncertain attempt");
        }
        async getStatus(): Promise<VoiceSessionStatusResult> { throw new Error("not implemented"); }
        async endSession(): Promise<VoiceSessionEndResult> { throw new Error("not implemented"); }
      }

      // 3. Worker B reclaims the expired delivery
      const workerB = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider: new ExpiredRecoveryVoiceProvider(),
          whatsappProvider: new MockWhatsAppProvider(),
          callAttemptRepository: callAttemptRepo,
          currentTimeProvider: () => daytime,
        },
        { workerId: "worker_b_reclaimer", batchSize: 1, leaseDurationMs: 60000 }
      );

      const cycleResult = await workerB.processCycle();

      assert.strictEqual(cycleResult.claimedCount, 1);
      assert.strictEqual(cycleResult.permanentlyFailedCount, 1);
      assert.strictEqual(redialAttempts, 0, "No duplicate carrier startSession should be initiated");

      // Verify attempt transitioned to uncertain
      const recoveredAttempt = await callAttemptRepo.getById(internalAttemptId);
      assert.strictEqual(recoveredAttempt?.initiationState, "uncertain");
      assert.strictEqual(recoveredAttempt?.errorCode, "EXPIRED_INITIATION_LEASE");
      assert.strictEqual(recoveredAttempt?.claimOwner, null);
      assert.strictEqual(recoveredAttempt?.leaseExpiresAt, null);

      // Verify delivery is quarantined
      const quarantinedDelivery = await outboxRepo.getDeliveryById(delivery.id);
      assert.strictEqual(quarantinedDelivery?.status, "permanently_failed");
      assert.strictEqual(quarantinedDelivery?.nextRetryAt, null);
      assert.strictEqual(quarantinedDelivery?.lastError?.code, "EXPIRED_INITIATION_LEASE");
      assert.strictEqual(quarantinedDelivery?.lastError?.isRetryable, false);

      // Verify session flagged for staff follow-up
      const updatedSession = await sessionRepo.getById(session.id);
      assert.strictEqual(updatedSession?.metadata?.callAttemptStatus, "uncertain");
      assert.strictEqual(updatedSession?.metadata?.staffFollowUpRequired, true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. CONCURRENT WORKERS RECOVERING EXPIRED ATTEMPT
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. CONCURRENT WORKERS EXPIRED-CLAIM RECOVERY ---");

  await test("3.1 Concurrent workers recovering same expired attempt: exactly one transaction succeeds", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const mockDb = {
      collection: (colName: string) => ({
        doc: (docId: string) => ({
          id: docId,
          parent: { id: colName },
          get: async () => ({
            exists: store.has(`${colName}/${docId}`),
            data: () => store.get(`${colName}/${docId}`),
          }),
        }),
      }),
      runTransaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
        const transaction = {
          get: async (ref: { parent?: { id: string }; id: string }) => {
            const path = ref.parent ? `${ref.parent.id}/${ref.id}` : ref.id;
            return {
              exists: store.has(path),
              data: () => store.get(path),
            };
          },
          set: (ref: { parent?: { id: string }; id: string }, newData: Record<string, unknown>, options?: { merge?: boolean }) => {
            const path = ref.parent ? `${ref.parent.id}/${ref.id}` : ref.id;
            const prev = store.get(path) || {};
            store.set(path, options?.merge ? { ...prev, ...newData } : { ...newData });
          },
        };
        return await fn(transaction);
      },
    } as unknown as FirebaseFirestore.Firestore;

    const fsRepo = new FirestoreVoiceCallAttemptRepository(() => mockDb);

    const expiredLease = new Date(daytime.getTime() - 20000).toISOString();
    await fsRepo.createAttempt({
      id: "att_fs_concurrent_exp_01",
      deliveryId: "del_fs_exp_01",
      sessionId: "vbs_fs_exp_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      claimOwner: "worker_initial",
      claimToken: "tok_initial",
      leaseExpiresAt: expiredLease,
      initiationState: "in_flight",
    });

    // Two workers simultaneously try to recover the expired attempt
    const [result1, result2] = await Promise.all([
      fsRepo.recoverExpiredInitiation("att_fs_concurrent_exp_01", daytime, "Recovery Worker 1"),
      fsRepo.recoverExpiredInitiation("att_fs_concurrent_exp_01", daytime, "Recovery Worker 2"),
    ]);

    // Exactly one of the concurrent callers succeeds in transitioning; the other receives null
    const successes = [result1, result2].filter((r) => r !== null);
    const failures = [result1, result2].filter((r) => r === null);

    assert.strictEqual(successes.length, 1, "Exactly one worker transaction must succeed in recovering the expired attempt");
    assert.strictEqual(failures.length, 1, "The second concurrent worker must receive null");

    const finalAttempt = await fsRepo.getById("att_fs_concurrent_exp_01");
    assert.strictEqual(finalAttempt?.initiationState, "uncertain");
    assert.strictEqual(finalAttempt?.errorCode, "EXPIRED_INITIATION_LEASE");
  });

  // ---------------------------------------------------------------------------
  // 4. WEBHOOK RECOVERY WHEN NO PROVIDERCALLID MAPPING EXISTS
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. WEBHOOK RECOVERY WITHOUT PRIOR PROVIDER MAPPING ---");

  await test("4.1 Webhook correlation succeeds and creates provider mapping when none existed", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    await repo.createAttempt({
      id: "att_unmapped_wh_01",
      deliveryId: "del_wh_01",
      sessionId: "vbs_wh_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "carrier_async",
      initiationState: "uncertain",
      metadata: { uncertainReason: "Request timed out" },
    });

    // Verify no mapping exists initially
    assert.strictEqual(await repo.getByProviderCallId("call_carrier_webhook_recovery_111"), null);

    // Correlate incoming carrier webhook
    const updateResult = await repo.correlateWebhookByAttemptId({
      attemptId: "att_unmapped_wh_01",
      providerCallId: "call_carrier_webhook_recovery_111",
      provider: "carrier_async",
      sessionId: "vbs_wh_01",
      status: "ringing",
      timestamp: daytime.toISOString(),
    });

    assert.strictEqual(updateResult.outcome, "updated");
    assert.strictEqual(updateResult.attempt.status, "ringing");
    assert.strictEqual(updateResult.attempt.initiationState, "accepted");
    assert.strictEqual(updateResult.attempt.providerCallId, "call_carrier_webhook_recovery_111");

    // Fast lookup by providerCallId is now populated
    const fetched = await repo.getByProviderCallId("call_carrier_webhook_recovery_111");
    assert.ok(fetched !== null);
    assert.strictEqual(fetched?.id, "att_unmapped_wh_01");

    // Idempotent duplicate: receiving same webhook again does not error and returns idempotent_duplicate
    const duplicateResult = await repo.correlateWebhookByAttemptId({
      attemptId: "att_unmapped_wh_01",
      providerCallId: "call_carrier_webhook_recovery_111",
      provider: "carrier_async",
      sessionId: "vbs_wh_01",
      status: "ringing",
      timestamp: daytime.toISOString(),
    });
    assert.strictEqual(duplicateResult.outcome, "idempotent_duplicate");
  });

  // ---------------------------------------------------------------------------
  // 5. REJECTION OF MISMATCHED SESSION CORRELATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. REJECTION OF MISMATCHED SESSION CORRELATION ---");

  await test("5.1 Webhook correlation strictly rejects mismatched sessionId", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    await repo.createAttempt({
      id: "att_security_session_01",
      deliveryId: "del_sec_01",
      sessionId: "vbs_authentic_session_123",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "carrier_async",
    });

    try {
      await repo.correlateWebhookByAttemptId({
        attemptId: "att_security_session_01",
        providerCallId: "call_spoofed_session_888",
        provider: "carrier_async",
        sessionId: "vbs_ATTACKER_SPOOFED_SESSION_999",
        status: "answered",
      });
      assert.fail("Must reject mismatched sessionId");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Session mismatch"), `Error message must report session mismatch, got: ${err.message}`);
    }

    // Verify attempt remains unchanged
    const untouched = await repo.getById("att_security_session_01");
    assert.strictEqual(untouched?.providerCallId, null);
    assert.strictEqual(untouched?.status, "initiated");
  });

  // ---------------------------------------------------------------------------
  // 6. REJECTION OF MISMATCHED PROVIDER CORRELATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. REJECTION OF MISMATCHED PROVIDER CORRELATION ---");

  await test("6.1 Webhook correlation strictly rejects mismatched provider", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    await repo.createAttempt({
      id: "att_security_provider_01",
      deliveryId: "del_sec_prov_01",
      sessionId: "vbs_prov_123",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "carrier_async",
    });

    try {
      await repo.correlateWebhookByAttemptId({
        attemptId: "att_security_provider_01",
        providerCallId: "call_fake_prov_777",
        provider: "rogue_telephony_provider",
        sessionId: "vbs_prov_123",
        status: "answered",
      });
      assert.fail("Must reject mismatched provider");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Provider mismatch"), `Error message must report provider mismatch, got: ${err.message}`);
    }

    const untouched = await repo.getById("att_security_provider_01");
    assert.strictEqual(untouched?.providerCallId, null);
    assert.strictEqual(untouched?.status, "initiated");
  });

  // ---------------------------------------------------------------------------
  // 7. REJECTION OF DUPLICATE PROVIDERCALLID COLLISION
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. REJECTION OF DUPLICATE PROVIDERCALLID COLLISION ---");

  await test("7.1 Webhook correlation rejects providerCallId already mapped to another attempt", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    await repo.createAttempt({
      id: "att_collision_a",
      deliveryId: "del_col_a",
      sessionId: "vbs_col_a",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "carrier_async",
    });

    await repo.createAttempt({
      id: "att_collision_b",
      deliveryId: "del_col_b",
      sessionId: "vbs_col_b",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "carrier_async",
    });

    // Attempt A attaches providerCallId
    await repo.correlateWebhookByAttemptId({
      attemptId: "att_collision_a",
      providerCallId: "call_contested_shared_id_555",
      provider: "carrier_async",
      sessionId: "vbs_col_a",
      status: "ringing",
    });

    // Attempt B tries to correlate with the same providerCallId
    try {
      await repo.correlateWebhookByAttemptId({
        attemptId: "att_collision_b",
        providerCallId: "call_contested_shared_id_555",
        provider: "carrier_async",
        sessionId: "vbs_col_b",
        status: "ringing",
      });
      assert.fail("Must reject duplicate providerCallId mapped to another attempt");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("conflict"), `Error message must report conflict, got: ${err.message}`);
    }
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.6.1.2 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exitCode = 1;
  }
}

runSuite().catch((err) => {
  console.error("Unhandled fatal verification error:", err);
  process.exitCode = 1;
});
