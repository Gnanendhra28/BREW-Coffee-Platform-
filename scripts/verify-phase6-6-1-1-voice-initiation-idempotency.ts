/**
 * BREW Coffee Platform — Phase 6.6.1.1 Verification Suite
 * Voice Initiation Idempotency & Recovery Review
 *
 * Verifies:
 * 1. Timeout-after-acceptance / network timeout transitions attempt to 'uncertain' and blocks automated redial.
 * 2. Worker crash mid-flight: recovering worker reclaims delivery, detects accepted attempt, and completes without redialing.
 * 3. Concurrent worker protection: second worker detects active in-flight initiation lease and aborts duplicate dispatch.
 * 4. ProviderCallId uniqueness & collision rejection: duplicate providerCallIds across different attempts reject atomically.
 * 5. Terminal-state conflict preservation: conflicting terminal events are recorded in terminalConflict rather than silently overwritten.
 * 6. Webhook recovery: carrier status webhook reconciles an uncertain attempt, attaching providerCallId and advancing lifecycle.
 */

process.env.CRON_SECRET = "test_cron_secret_6611_auth_token_48chars_secure!";
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
  console.log("   BREW Coffee Platform — Phase 6.6.1.1 Verification Suite");
  console.log("   Voice Initiation Idempotency & Safe Recovery Review");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. TIMEOUT-AFTER-ACCEPTANCE / NETWORK TIMEOUT (UNCERTAIN OUTCOME)
  // ---------------------------------------------------------------------------
  console.log("--- 1. TIMEOUT-AFTER-ACCEPTANCE & UNCERTAIN OUTCOME ---");

  await test("1.1 Carrier API network timeout marks attempt uncertain and blocks automated redial", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();

      const daytime = new Date("2026-11-06T06:30:00.000Z"); // 12:00 PM IST
      const phoneNumber = "+919876543210";

      await consentRepo.save({
        id: "c_grant_voice_uncertain_01",
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
        id: "vbs_uncertain_01",
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

      const delivery: CommunicationDeliveryRecord = {
        id: "del_uncertain_01",
        eventId: "evt_uncertain_01",
        sessionId: session.id,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "booking_created",
        phoneNumberMasked: "+91 98*** ***10",
        status: "pending",
        attemptCount: 0,
        maxAttempts: 3,
        claimOwner: null,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        nextRetryAt: null,
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
      };
      outboxRepo.seedDelivery(delivery);

      let dialAttempts = 0;
      class TimingOutVoiceProvider implements VoiceProvider {
        public readonly providerName = "mock-timing-out-carrier";
        public readonly isAsynchronous = true;

        async startSession(): Promise<VoiceSessionResult> {
          dialAttempts++;
          const timeoutErr = new Error("Gateway timeout: carrier API took > 10000ms to respond");
          timeoutErr.name = "TimeoutError";
          throw timeoutErr;
        }
        async getStatus(): Promise<VoiceSessionStatusResult> { throw new Error("not implemented"); }
        async endSession(): Promise<VoiceSessionEndResult> { throw new Error("not implemented"); }
      }

      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider: new TimingOutVoiceProvider(),
          whatsappProvider: new MockWhatsAppProvider(),
          callAttemptRepository: callAttemptRepo,
          currentTimeProvider: () => daytime,
        },
        { batchSize: 1, leaseDurationMs: 60000 }
      );

      // Cycle 1: Dispatches carrier request, which times out
      const cycle1 = await worker.processCycle();
      assert.strictEqual(cycle1.claimedCount, 1);
      assert.strictEqual(cycle1.permanentlyFailedCount, 1);
      assert.strictEqual(dialAttempts, 1);

      // Verify attempt is marked 'uncertain' in repository
      const expectedAttemptId = `${delivery.id}_call1`;
      const attempt = await callAttemptRepo.getById(expectedAttemptId);
      assert.ok(attempt !== null, "Attempt record must exist");
      assert.strictEqual(attempt.initiationState, "uncertain");
      assert.strictEqual(attempt.uncertainReason, "PROVIDER_TIMEOUT");

      // Verify outbox delivery blocked automatic redial (status: permanently_failed, nextRetryAt: null, isRetryable: false)
      const updatedDelivery = await outboxRepo.getDeliveryById(delivery.id);
      assert.strictEqual(updatedDelivery?.status, "permanently_failed");
      assert.strictEqual(updatedDelivery?.nextRetryAt, null, "nextRetryAt must be null to block automatic redial");
      assert.strictEqual(updatedDelivery?.lastError?.isRetryable, false);

      // Verify session metadata reflects uncertain state and flags staff follow-up
      const updatedSession = await sessionRepo.getById(session.id);
      assert.strictEqual(updatedSession?.metadata?.callAttemptStatus, "uncertain");
      assert.strictEqual(updatedSession?.metadata?.staffFollowUpRequired, true);

      // Cycle 2: Subsequent worker cycle must NOT place a duplicate dial attempt
      const cycle2 = await worker.processCycle();
      assert.strictEqual(dialAttempts, 1, "Automated redial must be strictly blocked; dialAttempts must remain 1");
      assert.strictEqual(cycle2.claimedCount, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. WORKER CRASH MID-FLIGHT & RECOVERY WITHOUT REDIALING
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. WORKER CRASH MID-FLIGHT & SAFE RECOVERY ---");

  await test("2.1 Crashed worker whose call was accepted is recovered by next worker without duplicate dial", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();

      const daytime = new Date("2026-11-06T06:30:00.000Z");
      const phoneNumber = "+919876543210";

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
        id: "vbs_crash_01",
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

      // Delivery was claimed by Worker A, which crashed after carrier accepted call
      const internalAttemptId = "del_crash_01_call1";
      const delivery: CommunicationDeliveryRecord = {
        id: "del_crash_01",
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
        claimOwner: "worker_crashed_process_101",
        claimToken: "tok_crashed_101",
        claimedAt: new Date(daytime.getTime() - 120000).toISOString(),
        leaseExpiresAt: new Date(daytime.getTime() - 60000).toISOString(), // EXPIRED LEASE
        nextRetryAt: null,
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
      };
      outboxRepo.seedDelivery(delivery);

      // Carrier accepted call before Worker A died, but Worker A died before updating outbox
      await callAttemptRepo.createAttempt({
        id: internalAttemptId,
        deliveryId: delivery.id,
        sessionId: session.id,
        phoneNumberMasked: delivery.phoneNumberMasked,
        provider: "carrier_async",
        providerCallId: "call_exotel_accepted_crash_recovery_777",
        initiationState: "accepted",
      });

      let redialCount = 0;
      class RecoveryVoiceProvider implements VoiceProvider {
        public readonly providerName = "carrier_async";
        public readonly isAsynchronous = true;

        async startSession(): Promise<VoiceSessionResult> {
          redialCount++;
          return {
            sessionId: session.id,
            providerCallId: "call_duplicate_SHOULD_NEVER_BE_CREATED",
            status: "initiated",
            startedAt: daytime.toISOString(),
            isSimulated: true,
            providerMode: "mock",
          };
        }
        async getStatus(): Promise<VoiceSessionStatusResult> { throw new Error("not implemented"); }
        async endSession(): Promise<VoiceSessionEndResult> { throw new Error("not implemented"); }
      }

      // Fresh Worker B recovers the expired lease
      const workerB = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider: new RecoveryVoiceProvider(),
          whatsappProvider: new MockWhatsAppProvider(),
          callAttemptRepository: callAttemptRepo,
          currentTimeProvider: () => daytime,
        },
        { workerId: "worker_fresh_recovery_202", batchSize: 1, leaseDurationMs: 60000 }
      );

      const cycleResult = await workerB.processCycle();

      // Worker B reclaimed delivery and safely marked it dispatched using existing accepted attempt
      assert.strictEqual(cycleResult.claimedCount, 1);
      assert.strictEqual(cycleResult.dispatchedCount, 1);
      assert.strictEqual(redialCount, 0, "Carrier startSession must NOT be called on recovery of accepted attempt");

      const updatedDelivery = await outboxRepo.getDeliveryById(delivery.id);
      assert.strictEqual(updatedDelivery?.status, "dispatched");
      assert.strictEqual(updatedDelivery?.providerResult?.providerCallId, "call_exotel_accepted_crash_recovery_777");
      assert.strictEqual(updatedDelivery?.claimOwner, null, "Claim owner must be released");
      assert.strictEqual(updatedDelivery?.leaseExpiresAt, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. CONCURRENT WORKER RETRY & LEASE FENCING
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. CONCURRENT WORKER INITIATION PROTECTION ---");

  await test("3.1 Concurrent worker detects active in-flight initiation lease and aborts duplicate dispatch", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();

      const daytime = new Date("2026-11-06T06:30:00.000Z");
      const phoneNumber = "+919876543210";

      await consentRepo.save({
        id: "c_grant_concurrent_01",
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
        id: "vbs_concurrent_01",
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

      const internalAttemptId = "del_conc_01_call1";
      const delivery: CommunicationDeliveryRecord = {
        id: "del_conc_01",
        eventId: "evt_conc_01",
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
        claimOwner: "worker_active_alpha",
        claimToken: "tok_alpha",
        claimedAt: daytime.toISOString(),
        leaseExpiresAt: new Date(daytime.getTime() + 60000).toISOString(), // ACTIVE LEASE FOR 60s
        nextRetryAt: null,
        createdAt: daytime.toISOString(),
        updatedAt: daytime.toISOString(),
      };
      outboxRepo.seedDelivery(delivery);

      // Attempt is actively in-flight under Worker Alpha's claim
      await callAttemptRepo.createAttempt({
        id: internalAttemptId,
        deliveryId: delivery.id,
        sessionId: session.id,
        phoneNumberMasked: delivery.phoneNumberMasked,
        provider: "carrier_async",
        claimOwner: "worker_active_alpha",
        claimToken: "tok_alpha",
        leaseExpiresAt: new Date(daytime.getTime() + 60000).toISOString(),
        initiationState: "in_flight",
      });

      let redialCount = 0;
      class ConcurrentVoiceProvider implements VoiceProvider {
        public readonly providerName = "carrier_async";
        public readonly isAsynchronous = true;

        async startSession(): Promise<VoiceSessionResult> {
          redialCount++;
          throw new Error("Should not be called");
        }
        async getStatus(): Promise<VoiceSessionStatusResult> { throw new Error("not implemented"); }
        async endSession(): Promise<VoiceSessionEndResult> { throw new Error("not implemented"); }
      }

      // Worker Beta attempts to process while Worker Alpha is in-flight
      const workerBeta = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider: new ConcurrentVoiceProvider(),
          whatsappProvider: new MockWhatsAppProvider(),
          callAttemptRepository: callAttemptRepo,
          currentTimeProvider: () => daytime,
        },
        { workerId: "worker_beta", batchSize: 1, leaseDurationMs: 60000 }
      );

      const cycleResult = await workerBeta.processCycle();

      // Worker Beta must NOT claim active lease or dial carrier
      assert.strictEqual(cycleResult.claimedCount, 0);
      assert.strictEqual(redialCount, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. PROVIDER CALL ID UNIQUENESS & COLLISION REJECTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. PROVIDER CALL ID UNIQUENESS & COLLISION REJECTION ---");

  await test("4.1 InMemoryVoiceCallAttemptRepository rejects duplicate providerCallId across different attempts", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    await repo.createAttempt({
      id: "att_unique_01",
      deliveryId: "del_01",
      sessionId: "vbs_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
    });

    await repo.createAttempt({
      id: "att_unique_02",
      deliveryId: "del_02",
      sessionId: "vbs_02",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
    });

    // Attach providerCallId to Attempt 1
    await repo.attachProviderCallId("att_unique_01", "call_exotel_unique_999");
    assert.strictEqual((await repo.getById("att_unique_01"))?.providerCallId, "call_exotel_unique_999");

    // Attempt 2 trying to attach the same providerCallId must throw conflict error
    try {
      await repo.attachProviderCallId("att_unique_02", "call_exotel_unique_999");
      assert.fail("Should have thrown error on duplicate providerCallId");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("conflict"), "Error must report provider call ID conflict");
    }
  });

  await test("4.2 FirestoreVoiceCallAttemptRepository rejects duplicate providerCallId in atomic transaction", async () => {
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

    const repo = new FirestoreVoiceCallAttemptRepository(() => mockDb);

    await repo.createAttempt({
      id: "att_fs_unique_01",
      deliveryId: "del_fs_01",
      sessionId: "vbs_fs_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
    });

    await repo.createAttempt({
      id: "att_fs_unique_02",
      deliveryId: "del_fs_02",
      sessionId: "vbs_fs_02",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
    });

    await repo.attachProviderCallId("att_fs_unique_01", "call_fs_collision_888");

    try {
      await repo.attachProviderCallId("att_fs_unique_02", "call_fs_collision_888");
      assert.fail("Firestore atomic transaction must reject duplicate providerCallId mapping");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("conflict"), "Error must report provider call ID conflict");
    }
  });

  // ---------------------------------------------------------------------------
  // 5. TERMINAL STATE CONFLICT PRESERVATION FOR RECONCILIATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. TERMINAL-STATE CONFLICT PRESERVATION ---");

  await test("5.1 Conflicting terminal event preserves original terminal outcome and records terminalConflict", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    await repo.createAttempt({
      id: "att_terminal_audit_01",
      deliveryId: "del_term_01",
      sessionId: "vbs_term_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
    });

    // Advance to completed
    await repo.updateStatus("att_terminal_audit_01", { status: "answered", timestamp: "2026-11-06T06:30:00.000Z" });
    await repo.updateStatus("att_terminal_audit_01", {
      status: "completed",
      timestamp: "2026-11-06T06:34:00.000Z",
      durationSeconds: 240,
    });

    const completedRecord = await repo.getById("att_terminal_audit_01");
    assert.strictEqual(completedRecord?.status, "completed");
    assert.strictEqual(completedRecord?.durationSeconds, 240);
    assert.strictEqual(completedRecord?.terminalConflict, null);

    // Conflicting webhook arrives: delayed 'failed' or 'busy'
    const conflictResult = await repo.updateStatus("att_terminal_audit_01", {
      status: "failed",
      timestamp: "2026-11-06T06:35:00.000Z",
      errorCode: "CARRIER_BUSY",
      errorMessage: "Late delayed busy event",
    });

    assert.strictEqual(conflictResult.outcome, "terminal_conflict");

    // Primary record retains authoritative 'completed' outcome
    const reconciledRecord = await repo.getById("att_terminal_audit_01");
    assert.strictEqual(reconciledRecord?.status, "completed", "Primary terminal status must NOT be overwritten");
    assert.strictEqual(reconciledRecord?.durationSeconds, 240, "Primary duration must NOT be overwritten");

    // Conflicting event is preserved for reconciliation and auditing
    assert.ok(reconciledRecord?.terminalConflict !== null, "terminalConflict must be preserved for audit");
    assert.strictEqual(reconciledRecord?.terminalConflict?.conflictingStatus, "failed");
    assert.strictEqual(reconciledRecord?.terminalConflict?.receivedAt, "2026-11-06T06:35:00.000Z");
  });

  // ---------------------------------------------------------------------------
  // 6. WEBHOOK RECOVERY OF UNCERTAIN ATTEMPT
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. WEBHOOK RECOVERY OF UNCERTAIN ATTEMPT ---");

  await test("6.1 Incoming carrier webhook recovers uncertain attempt, attaching providerCallId and advancing state", async () => {
    const repo = new InMemoryVoiceCallAttemptRepository();

    const attempt = await repo.createAttempt({
      id: "att_uncertain_recovery_01",
      deliveryId: "del_rec_01",
      sessionId: "vbs_rec_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
    });
    assert.strictEqual(attempt.initiationState, "pending");

    // Mark uncertain due to API timeout
    await repo.markInitiationUncertain("att_uncertain_recovery_01", "HTTP_TIMEOUT", "Carrier timeout after 10s");
    const uncertainAttempt = await repo.getById("att_uncertain_recovery_01");
    assert.strictEqual(uncertainAttempt?.initiationState, "uncertain");

    // Carrier status webhook arrives: confirms call was placed and provides providerCallId
    await repo.attachProviderCallId("att_uncertain_recovery_01", "call_exotel_recovered_from_uncertainty_555");
    const recoveredAttempt = await repo.getById("att_uncertain_recovery_01");
    assert.strictEqual(recoveredAttempt?.initiationState, "accepted");
    assert.strictEqual(recoveredAttempt?.providerCallId, "call_exotel_recovered_from_uncertainty_555");

    // Life-cycle advances forward on subsequent webhooks
    const ringingResult = await repo.updateStatusByProviderCallId("call_exotel_recovered_from_uncertainty_555", {
      status: "ringing",
      timestamp: "2026-11-06T06:31:00.000Z",
    });
    assert.strictEqual(ringingResult.outcome, "updated");
    assert.strictEqual(ringingResult.attempt.status, "ringing");

    const answeredResult = await repo.updateStatusByProviderCallId("call_exotel_recovered_from_uncertainty_555", {
      status: "answered",
      timestamp: "2026-11-06T06:31:15.000Z",
    });
    assert.strictEqual(answeredResult.outcome, "updated");
    assert.strictEqual(answeredResult.attempt.status, "answered");
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.6.1.1 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exitCode = 1;
  }
}

runSuite().catch((err) => {
  console.error("Unhandled fatal verification error:", err);
  process.exitCode = 1;
});
