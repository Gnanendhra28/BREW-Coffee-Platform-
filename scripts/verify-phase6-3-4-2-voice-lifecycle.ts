/**
 * BREW Coffee Platform — Phase 6.3.4.2 Verification Suite
 * Mock Voice Call Lifecycle Integration
 *
 * Verifies:
 * 1. Answered call starts the existing conversation engine with initial greeting.
 * 2. Unanswered call leaves booking enquiry pending and follows retry policy.
 * 3. Busy and failed outcomes follow exponential backoff retry policy.
 * 4. Maximum retry attempts result in terminal failure and flag staffFollowUpRequired.
 * 5. Deterministic provider idempotency: identical replay cached, conflicting fails closed.
 * 6. Dispatch-time consent revocation halts delivery before provider invocation.
 * 7. Dispatch-time DND registration halts delivery before provider invocation.
 * 8. Stale worker claim cannot overwrite a newer claim's result.
 * 9. Session remains in correct initial state until actual customer interaction, preserving multilingual capabilities.
 * 10. Customer confirmation safety gate strictly precedes staff approval.
 * 11. Safe customer and staff visibility: zero exposure of raw phone numbers, tokens, or credentials.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false"; // Preserved as false

import assert from "assert";
import {
  MockVoiceProvider,
  MockWhatsAppProvider,
  ProviderIdempotencyConflictError,
  StaleClaimError,
  createOutboxDeliveriesForTransition,
  OutboxWorker,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  extractSafeCallStatus,
} from "../src/lib/communication";
import { getEffectiveCallAttemptCount } from "../src/lib/communication/outbox/outboxModel";
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
  getInitialGreeting,
  approveBookingByStaff,
  OptimisticConcurrencyConflictError,
} from "../src/lib/voiceBooking";
import {
  VoiceBookingSession,
  StaffAuthorizationContext,
} from "../src/lib/voiceBooking/types";

console.log("================================================================================");
console.log("   BREW Coffee Platform — Phase 6.3.4.2 Verification Suite");
console.log("   Mock Voice Call Lifecycle Integration");
console.log("================================================================================\n");

function createInitialSession(overrides: Partial<VoiceBookingSession> = {}): VoiceBookingSession {
  const sessionId = overrides.id || `vbs_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  return {
    id: sessionId,
    phoneNumber: "+919876543210",
    language: "en",
    state: "created",
    requirements: {
      guestCount: null,
      eventDate: "2026-12-15",
      startTime: null,
      durationHours: null,
      venueAddress: "HITEC City Phase 2, Hyderabad",
      eventType: "Corporate Gathering",
      beveragePreferences: [],
      selectedTier: null,
      handoffRequested: false,
      customerConfirmed: false,
      confidenceScore: 0.0,
      missingFields: ["guestCount", "startTime", "durationHours", "selectedTier"],
      unresolvedQuestions: [],
      corrections: [],
    },
    quotation: null,
    quotationSnapshot: null,
    conversationHistory: [],
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    revision: 1,
    staffApprovalId: null,
    staffApprovalAudit: null,
    officialBookingId: null,
    metadata: {
      source: "web_catering_enquiry",
      enquiryRequestId: `enq_${sessionId}`,
      crowdSizeEstimate: "100-200",
    },
    ...overrides,
  };
}

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

async function runAllTests() {
  console.log("--- 1. MOCK VOICE CALL OUTCOMES & LIFECYCLE ---");

  await test("1.1 Answered call starts conversation engine with greeting turn", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setNextOutcome("answered");
      voiceProvider.setNextCallId("call_answered_001");

      const session = createInitialSession();
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      assert.ok(voiceDelivery, "Should produce a voice delivery for created state");
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const clock = new Date("2026-11-02T10:30:00.000Z"); // 16:00 IST (valid calling hours)
      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
        currentTimeProvider: () => clock,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.dispatchedCount, 1, "Answered delivery should be dispatched");

      const updatedDelivery = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(updatedDelivery?.status, "dispatched");
      assert.strictEqual(updatedDelivery?.providerResult?.callOutcome, "answered");
      assert.strictEqual(updatedDelivery?.providerResult?.providerCallId, "call_answered_001");

      const updatedSession = await sessionRepo.getById(session.id);
      assert.ok(updatedSession);
      // Crucial verification: Session remains in 'created' state before user responds!
      assert.strictEqual(updatedSession?.state, "created", "Session must remain in 'created' state until customer responds");
      // Initial greeting added to conversationHistory
      assert.strictEqual(updatedSession?.conversationHistory.length, 1);
      assert.strictEqual(updatedSession?.conversationHistory[0].role, "assistant");
      assert.strictEqual(updatedSession?.conversationHistory[0].content, getInitialGreeting("en"));
      // Safe metadata updated
      assert.strictEqual(updatedSession?.metadata?.callAttemptStatus, "answered");
      assert.strictEqual(updatedSession?.metadata?.staffFollowUpRequired, false);
      assert.strictEqual(updatedSession?.requirements.customerConfirmed, false);
      assert.strictEqual(updatedSession?.quotation, null);
    });
  });

  await test("1.2 No-answer leaves booking enquiry pending and schedules retry", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setNextOutcome("no_answer");

      const session = createInitialSession();
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_02",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const clock = new Date("2026-11-02T10:30:00.000Z");
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
        { backoffBaseMs: 5_000 }
      );

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.failedCount, 1, "Unanswered call is a retryable failure");

      const updatedDelivery = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(updatedDelivery?.status, "failed");
      assert.strictEqual(updatedDelivery?.lastError?.code, "CALL_NO_ANSWER");
      assert.strictEqual(updatedDelivery?.lastError?.isRetryable, true);
      assert.ok(updatedDelivery?.nextRetryAt);

      const updatedSession = await sessionRepo.getById(session.id);
      assert.strictEqual(updatedSession?.state, "created", "Session remains in created state");
      assert.strictEqual(updatedSession?.conversationHistory.length, 0, "No assistant greeting if call was unanswered");
      assert.strictEqual(updatedSession?.metadata?.callAttemptStatus, "no_answer");
      assert.strictEqual(updatedSession?.metadata?.staffFollowUpRequired, false);
      assert.strictEqual(updatedSession?.quotation, null);
    });
  });

  await test("1.3 Busy and failed outcomes follow exponential backoff retry policy", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      // 1. Test 'busy' outcome and initial backoff
      voiceProvider.setNextOutcome("busy");

      const sessionBusy = createInitialSession({ id: "vbs_busy_01" });
      await sessionRepo.save(sessionBusy);

      await consentRepo.save({
        id: "c_voice_busy",
        phoneNumber: sessionBusy.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const busyDeliveries = createOutboxDeliveriesForTransition(sessionBusy);
      const busyDelivery = busyDeliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, busyDelivery);

      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const workerBusy = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => t0,
        },
        { backoffBaseMs: 5_000 }
      );

      await workerBusy.processCycle();

      const busyRecord = await outboxRepo.getDeliveryById(busyDelivery.id);
      assert.strictEqual(busyRecord?.status, "failed");
      assert.strictEqual(busyRecord?.lastError?.code, "CALL_BUSY");
      // Attempt 1 backoff: base * 2^0 = 5000ms
      const expectedRetry1 = new Date(t0.getTime() + 5_000).toISOString();
      assert.strictEqual(busyRecord?.nextRetryAt, expectedRetry1);

      // 2. Test 'failed' outcome with multiple retry backoff progression
      const sessionFailed = createInitialSession({ id: "vbs_failed_01" });
      await sessionRepo.save(sessionFailed);

      const failedDeliveries = createOutboxDeliveriesForTransition(sessionFailed);
      const failedDelivery = failedDeliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, failedDelivery);

      voiceProvider.setDefaultOutcome("failed");

      const workerFailed1 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => t0,
        },
        { backoffBaseMs: 5_000 }
      );

      await workerFailed1.processCycle();

      const failedRecord1 = await outboxRepo.getDeliveryById(failedDelivery.id);
      assert.strictEqual(failedRecord1?.status, "failed");
      assert.strictEqual(failedRecord1?.attemptCount, 1);
      assert.strictEqual(failedRecord1?.lastError?.code, "CALL_FAILED");
      assert.strictEqual(failedRecord1?.nextRetryAt, expectedRetry1);

      // Attempt 2 after backoff window expires
      const t1 = new Date(t0.getTime() + 5_000);
      const workerFailed2 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => t1,
        },
        { backoffBaseMs: 5_000 }
      );

      await workerFailed2.processCycle();

      const failedRecord2 = await outboxRepo.getDeliveryById(failedDelivery.id);
      assert.strictEqual(failedRecord2?.status, "failed");
      assert.strictEqual(failedRecord2?.attemptCount, 2);
      assert.strictEqual(failedRecord2?.lastError?.code, "CALL_FAILED");
      // Attempt 2 backoff: base * 2^1 = 10000ms
      const expectedRetry2 = new Date(t1.getTime() + 10_000).toISOString();
      assert.strictEqual(failedRecord2?.nextRetryAt, expectedRetry2);
    });
  });

  await test("1.4 Reaching max attempts results in permanent failure and flags staffFollowUpRequired", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setNextOutcome("no_answer");

      const session = createInitialSession();
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_04",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      // Seed with callAttemptCount = 2 (so next genuine attempt is attempt 3 = maxAttempts)
      voiceDelivery.attemptCount = 2;
      voiceDelivery.callAttemptCount = 2;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const clock = new Date("2026-11-02T10:30:00.000Z");
      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
        currentTimeProvider: () => clock,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.permanentlyFailedCount, 1, "Exhausted attempts must permanently fail");

      const permFailed = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(permFailed?.status, "permanently_failed");
      assert.strictEqual(permFailed?.attemptCount, 3);
      assert.strictEqual(permFailed?.lastError?.isRetryable, false);
      assert.strictEqual(permFailed?.nextRetryAt, null);

      const finalSession = await sessionRepo.getById(session.id);
      assert.strictEqual(finalSession?.metadata?.staffFollowUpRequired, true, "Staff follow up must be flagged on permanent failure");
      assert.strictEqual(finalSession?.metadata?.callAttemptStatus, "no_answer");
    });
  });

  await test("1.5 Attempt 1 returns no_answer, a later genuine retry attempt returns answered", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession({ id: "vbs_retry_progression_01" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_retry_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Attempt 1: Outcome is 'no_answer'
      voiceProvider.setNextOutcome("no_answer");

      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const workerAttempt1 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => t0,
        },
        { backoffBaseMs: 5_000 }
      );

      const cycle1 = await workerAttempt1.processCycle();
      assert.strictEqual(cycle1.failedCount, 1);

      const recordAfterAttempt1 = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(recordAfterAttempt1?.status, "failed");
      assert.strictEqual(recordAfterAttempt1?.attemptCount, 1);
      assert.strictEqual(recordAfterAttempt1?.callAttemptCount, 1);
      assert.strictEqual(recordAfterAttempt1?.currentAttemptId, `${voiceDelivery.id}_call1`);
      assert.strictEqual(recordAfterAttempt1?.lastError?.code, "CALL_NO_ANSWER");

      const sessionAfterAttempt1 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterAttempt1?.metadata?.callAttemptStatus, "no_answer");
      assert.strictEqual(sessionAfterAttempt1?.conversationHistory.length, 0);

      // Attempt 2: After backoff, genuine new retry outcome is 'answered'
      const t1 = new Date(t0.getTime() + 5_000); // 5s backoff
      voiceProvider.setNextOutcome("answered");

      const workerAttempt2 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => t1,
        },
        { backoffBaseMs: 5_000 }
      );

      const cycle2 = await workerAttempt2.processCycle();
      assert.strictEqual(cycle2.dispatchedCount, 1);

      const recordAfterAttempt2 = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(recordAfterAttempt2?.status, "dispatched");
      assert.strictEqual(recordAfterAttempt2?.attemptCount, 2);
      assert.strictEqual(recordAfterAttempt2?.callAttemptCount, 2);
      assert.strictEqual(recordAfterAttempt2?.currentAttemptId, `${voiceDelivery.id}_call2`);
      assert.strictEqual(recordAfterAttempt2?.providerResult?.callOutcome, "answered");

      const sessionAfterAttempt2 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterAttempt2?.metadata?.callAttemptStatus, "answered");
      assert.strictEqual(sessionAfterAttempt2?.metadata?.staffFollowUpRequired, false);
      assert.strictEqual(sessionAfterAttempt2?.conversationHistory.length, 1);
      assert.strictEqual(sessionAfterAttempt2?.conversationHistory[0].role, "assistant");
    });
  });

  console.log("\n--- 2. IDEMPOTENCY & PROVIDER SAFETY ---");

  await test("2.1 Repeated idempotency key returns cached result without duplicate simulation", async () => {
    const provider = new MockVoiceProvider();
    provider.setDefaultOutcome("answered");

    const params = {
      sessionId: "vbs_idem_001",
      phoneNumber: "+919876543210",
      language: "en" as const,
      enquiryId: "enq_idem_001",
      idempotencyKey: "idem_key_voice_12345",
    };

    const first = await provider.startSession(params);
    assert.strictEqual(first.callOutcome, "answered");

    // Repeated call with same idempotency key and same payload
    const second = await provider.startSession(params);
    assert.strictEqual(second.providerCallId, first.providerCallId, "Repeated call must return same providerCallId");
    assert.strictEqual(second.callOutcome, first.callOutcome);
    assert.strictEqual(provider.getActiveSessionCount(), 1, "Provider should not duplicate active session");

    // Same idempotency key with conflicting payload must fail closed
    const conflictingParams = {
      ...params,
      language: "hi" as const, // Different language changes payload fingerprint
    };

    await assert.rejects(
      async () => {
        await provider.startSession(conflictingParams);
      },
      (err: unknown) => err instanceof ProviderIdempotencyConflictError
    );
  });

  await test("2.2 Reclaiming an expired in-flight attempt does not create duplicate mock calls", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");

      const session = createInitialSession({ id: "vbs_inflight_recovery_01" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_inflight_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t=0 with short 2-second lease
      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedByW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedByW1);
      assert.strictEqual(claimedByW1.attemptCount, 1);
      assert.strictEqual(claimedByW1.callAttemptCount, 1);
      assert.strictEqual(claimedByW1.currentAttemptId, `${voiceDelivery.id}_call1`);

      // Worker 1 initiates provider call before crashing / stalling
      const providerResult1 = await voiceProvider.startSession({
        sessionId: session.id,
        phoneNumber: session.phoneNumber,
        language: "en",
        enquiryId: claimedByW1.officialBookingId,
        idempotencyKey: claimedByW1.currentAttemptId!,
      });
      assert.strictEqual(voiceProvider.getActiveSessionCount(), 1);

      // Lease expires at t=3000ms
      const tExpired = new Date(t0.getTime() + 3000);

      // Worker 2 reclaims and processes the expired in-flight attempt
      const worker2 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => tExpired,
        },
        { workerId: "worker_2" }
      );

      const cycle2 = await worker2.processCycle();
      assert.strictEqual(cycle2.claimedCount, 1, "Worker 2 must reclaim the expired in-flight delivery");
      assert.strictEqual(cycle2.dispatchedCount, 1, "Worker 2 must successfully dispatch");

      // Idempotency cache was used: provider active sessions did NOT double!
      assert.strictEqual(voiceProvider.getActiveSessionCount(), 1, "No duplicate mock call created on in-flight claim recovery");

      const finalDelivery = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(finalDelivery?.status, "dispatched");
      assert.strictEqual(finalDelivery?.attemptCount, 2, "Claim lease counter incremented on reclaim");
      assert.strictEqual(finalDelivery?.callAttemptCount, 1, "Logical call attempt counter preserved");
      assert.strictEqual(finalDelivery?.currentAttemptId, `${voiceDelivery.id}_call1`, "Attempt key preserved");
      assert.strictEqual(finalDelivery?.providerResult?.providerCallId, providerResult1.providerCallId, "Must return original providerCallId");
    });
  });

  console.log("\n--- 3. DISPATCH-TIME POLICY INTEGRITY ---");

  await test("3.1 Consent revocation before dispatch blocks delivery and skips provider", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession();
      await sessionRepo.save(session);

      // Grant consent initially
      await consentRepo.save({
        id: "c_voice_05",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Customer revokes consent prior to worker execution
      await consentRepo.revoke(
        session.phoneNumber,
        "voice",
        "transactional_update",
        "Customer opted out",
        "2026-11-02T10:15:00.000Z"
      );

      const clock = new Date("2026-11-02T10:30:00.000Z");
      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
        currentTimeProvider: () => clock,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.blockedCount, 1, "Revoked consent must block delivery");

      const blockedDelivery = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(blockedDelivery?.status, "blocked");
      assert.strictEqual(blockedDelivery?.policyResult?.reason, "CONSENT_REVOKED");
      assert.strictEqual(voiceProvider.getActiveSessionCount(), 0, "Provider must NEVER be invoked when blocked");

      const sessionAfter = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfter?.metadata?.callAttemptStatus, "blocked");
      assert.strictEqual(sessionAfter?.metadata?.staffFollowUpRequired, true);
    });
  });

  await test("3.2 DND registration before dispatch blocks delivery and skips provider", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession();
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_06",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Register DND suppression on voice channel
      await dndRepo.save({
        id: "dnd_voice_01",
        phoneNumber: session.phoneNumber,
        scope: "voice",
        reason: "Customer requested DND for voice calls",
        createdAt: "2026-11-02T10:15:00.000Z",
      });

      const clock = new Date("2026-11-02T10:30:00.000Z");
      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
        currentTimeProvider: () => clock,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.blockedCount, 1, "DND must block delivery");

      const blockedDelivery = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(blockedDelivery?.status, "blocked");
      assert.strictEqual(blockedDelivery?.policyResult?.reason, "DND_ACTIVE");
      assert.strictEqual(voiceProvider.getActiveSessionCount(), 0, "Provider must NEVER be invoked when DND active");
    });
  });

  console.log("\n--- 4. CONCURRENCY & LEASE FENCING ---");

  await test("4.1 Stale worker cannot overwrite newer claim result", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession();
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_07",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t=0 with short 2-second lease
      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedByW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedByW1);
      assert.strictEqual(claimedByW1.claimOwner, "worker_1");

      // Lease expires at t=3000ms
      const tExpired = new Date(t0.getTime() + 3000);

      // Worker 2 reclaims the expired delivery
      const [claimedByW2] = await outboxRepo.claimEligibleDeliveries("worker_2", 60000, 1, tExpired);
      assert.ok(claimedByW2);
      assert.strictEqual(claimedByW2.claimOwner, "worker_2");
      assert.notStrictEqual(claimedByW2.claimToken, claimedByW1.claimToken, "New claim gets unique token");

      // Worker 2 completes dispatch
      claimedByW2.status = "dispatched";
      claimedByW2.providerResult = {
        providerCallId: "w2_call",
        status: "simulated_answered",
        isSimulated: true,
        providerMode: "mock",
        completedAt: tExpired.toISOString(),
      };
      await outboxRepo.updateClaimedDelivery(
        claimedByW2,
        {
          claimOwner: "worker_2",
          claimedAt: claimedByW2.claimedAt!,
          claimToken: claimedByW2.claimToken!,
        },
        tExpired
      );

      // Worker 1 attempts to write its delayed result
      claimedByW1.status = "failed";
      claimedByW1.lastError = {
        code: "STALE_ERROR",
        message: "Stale write",
        isRetryable: false,
        occurredAt: tExpired.toISOString(),
      };

      const w1Worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      // safeUpdateClaimedDelivery must reject stale claim
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const safeUpdated = await (w1Worker as any).safeUpdateClaimedDelivery(
        claimedByW1,
        {
          claimOwner: "worker_1",
          claimedAt: claimedByW1.claimedAt!,
          claimToken: claimedByW1.claimToken!,
        },
        tExpired
      );
      assert.strictEqual(safeUpdated, false, "Stale worker update must return false");

      const finalRecord = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(finalRecord?.status, "dispatched", "Worker 2 dispatched status must remain intact");
      assert.strictEqual(finalRecord?.providerResult?.providerCallId, "w2_call");
    });
  });

  await test("4.2 Stale worker whose claim was reclaimed or whose lease expired cannot update voice session greeting or metadata", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");

      const session = createInitialSession({ id: "vbs_stale_fencing_01" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_stale_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t=0 with short 2-second lease
      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedByW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedByW1);
      assert.strictEqual(claimedByW1.claimOwner, "worker_1");

      // Lease expires at t=3000ms
      const tExpired = new Date(t0.getTime() + 3000);

      // Worker 2 reclaims delivery at tExpired
      const [claimedByW2] = await outboxRepo.claimEligibleDeliveries("worker_2", 60000, 1, tExpired);
      assert.ok(claimedByW2);
      assert.strictEqual(claimedByW2.claimOwner, "worker_2");

      // Worker 1 (stale, lost claim) attempts to process delivery at tExpired
      const worker1 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => tExpired,
        },
        { workerId: "worker_1" }
      );

      // Call processSingleDelivery directly on worker1 with claimedByW1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcomeW1 = await (worker1 as any).processSingleDelivery(claimedByW1, tExpired);
      assert.strictEqual(outcomeW1, "stale_claim_lost", "Stale worker execution must result in stale_claim_lost");

      // Verify session was NOT modified by Worker 1
      const sessionAfterW1 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterW1?.conversationHistory.length, 0, "Stale worker must NOT initialize greeting");
      assert.strictEqual(sessionAfterW1?.metadata?.callAttemptStatus, undefined, "Stale worker must NOT update metadata");

      // Now Worker 2 processes the active claim legitimately
      const worker2 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => tExpired,
        },
        { workerId: "worker_2" }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcomeW2 = await (worker2 as any).processSingleDelivery(claimedByW2, tExpired);
      assert.strictEqual(outcomeW2, "dispatched", "Active claim owner must succeed");

      // Verify Worker 2 correctly initialized session greeting and metadata
      const sessionAfterW2 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterW2?.conversationHistory.length, 1);
      assert.strictEqual(sessionAfterW2?.metadata?.callAttemptStatus, "answered");
    });
  });

  console.log("\n--- 5. CONVERSATION ENGINE MULTILINGUAL INTERACTION & SEPARATE GATES ---");

  await test("5.1 Conversation engine starts on answered call and handles customer turn in Telugu", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();

    // 1. Web booking created session with Telugu preferred language
    const session = createInitialSession({ language: "te" });
    await sessionRepo.save(session);

    // Initial greeting was set when call was answered
    const greeting = getInitialGreeting("te");
    session.conversationHistory.push({
      id: "msg_a_init",
      role: "assistant",
      content: greeting,
      language: "te",
      timestamp: new Date().toISOString(),
    });
    session.metadata.callAttemptStatus = "answered";
    await sessionRepo.save(session, session.revision);

    assert.strictEqual(session.state, "created", "Remains in created state until customer speaks");

    // 2. Customer speaks Telugu: "మాకు 75 మంది అతిథుల కోసం కాఫీ కావాలి" (75 guests)
    const turnResult = await processConversationTurn(
      session,
      "మాకు 75 మంది అతిథుల కోసం కాఫీ కావాలి",
      { sessionRepository: sessionRepo }
    );

    // Engine transitioned from 'created' to 'collecting_requirements'
    assert.strictEqual(turnResult.session.state, "collecting_requirements");
    assert.strictEqual(turnResult.session.language, "te");
    assert.strictEqual(turnResult.extractedRequirements.guestCount, 75);
    // Still missing fields -> assistant asks for next missing field in Telugu
    assert.ok(turnResult.assistantResponse.length > 0);
    // Quotation NOT yet created and customer NOT confirmed
    assert.strictEqual(turnResult.session.quotation, null);
    assert.strictEqual(turnResult.session.requirements.customerConfirmed, false);
  });

  await test("5.2 Customer confirmation gate cannot be bypassed by staff approval", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createInitialSession({ state: "collecting_requirements" });
    await sessionRepo.save(session);

    const staffAuth: StaffAuthorizationContext = {
      staffIdentity: "fleet_admin_01",
      staffRole: "admin",
      staffApprovalId: "appr_test_01",
    };

    // Attempting staff approval when state is NOT awaiting_staff_approval must fail
    await assert.rejects(
      async () => {
        await approveBookingByStaff(session.id, staffAuth, sessionRepo);
      },
      (err: Error) => err.message.includes("expected 'awaiting_staff_approval'")
    );

    const checkSession = await sessionRepo.getById(session.id);
    assert.strictEqual(checkSession?.state, "collecting_requirements");
    assert.strictEqual(checkSession?.staffApprovalAudit, null);
  });

  console.log("\n--- 6. CUSTOMER & STAFF VISIBILITY PRIVACY GUARANTEE ---");

  await test("6.1 extractSafeCallStatus exposes only safe metadata without leaking sensitive fields", async () => {
    const session = createInitialSession({
      phoneNumber: "+919876543210",
      metadata: {
        callAttemptStatus: "answered",
        lastAttemptAt: "2026-11-02T10:30:00.000Z",
        attemptCount: 1,
        staffFollowUpRequired: false,
        internalProviderKey: "SECRET_KEY_NEVER_LEAK",
        sessionToken: "tok_secret_jwt",
      },
    });

    const safeStatus = extractSafeCallStatus(session);

    assert.deepStrictEqual(safeStatus, {
      callAttemptStatus: "answered",
      lastAttemptAt: "2026-11-02T10:30:00.000Z",
      attemptCount: 1,
      staffFollowUpRequired: false,
    });

    // Verify raw phone or secrets are not present
    const keys = Object.keys(safeStatus);
    assert.strictEqual(keys.length, 4, "Must contain exactly the 4 safe fields");
    assert.strictEqual(keys.includes("phoneNumber"), false);
    assert.strictEqual(keys.includes("internalProviderKey"), false);
    assert.strictEqual(keys.includes("sessionToken"), false);
  });

  console.log("\n--- 7. PHASE 6.3.4.2.2: LOGICAL RETRY ACCOUNTING & TRANSACTIONAL MUTATION FENCING ---");

  await test("7.1 Multiple expired-lease recoveries do not consume logical call attempts; backoff uses logical count", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession({ id: "vbs_multi_lease_01" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_multi_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const t0 = new Date("2026-11-02T10:30:00.000Z");

      // Claim 1: Worker 1 claims at t0 with 2s lease
      const [claim1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.strictEqual(claim1.attemptCount, 1);
      assert.strictEqual(claim1.callAttemptCount, 1);
      assert.strictEqual(claim1.currentAttemptId, `${voiceDelivery.id}_call1`);

      // Worker 1 stalls, lease expires at t0 + 2s.
      // Claim 2: Worker 2 reclaims at t0 + 3s with 2s lease (expired-lease recovery)
      const tExpired1 = new Date(t0.getTime() + 3000);
      const [claim2] = await outboxRepo.claimEligibleDeliveries("worker_2", 2000, 1, tExpired1);
      assert.strictEqual(claim2.attemptCount, 2, "Lease claims counter must increment on reclaim");
      assert.strictEqual(claim2.callAttemptCount, 1, "Logical call attempts must NOT increment on lease recovery");
      assert.strictEqual(claim2.currentAttemptId, `${voiceDelivery.id}_call1`);

      // Worker 2 stalls, lease expires at t0 + 5s.
      // Claim 3: Worker 3 reclaims at t0 + 6s with 2s lease
      const tExpired2 = new Date(t0.getTime() + 6000);
      const [claim3] = await outboxRepo.claimEligibleDeliveries("worker_3", 2000, 1, tExpired2);
      assert.strictEqual(claim3.attemptCount, 3);
      assert.strictEqual(claim3.callAttemptCount, 1, "Still on logical call attempt 1");
      assert.strictEqual(claim3.currentAttemptId, `${voiceDelivery.id}_call1`);

      // Worker 3 stalls, lease expires at t0 + 8s.
      // Claim 4: Worker 4 reclaims at t0 + 9s with 2s lease
      const tExpired3 = new Date(t0.getTime() + 9000);
      const [claim4] = await outboxRepo.claimEligibleDeliveries("worker_4", 2000, 1, tExpired3);
      assert.strictEqual(claim4.attemptCount, 4, "Lease claims counter is 4 (exceeding default maxAttempts=3)");
      assert.strictEqual(claim4.callAttemptCount, 1, "Logical call attempt counter is STILL 1");
      assert.strictEqual(claim4.currentAttemptId, `${voiceDelivery.id}_call1`);

      // Worker 4 executes call attempt 1 with outcome 'no_answer'
      voiceProvider.setNextOutcome("no_answer");
      const worker4 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => tExpired3,
        },
        { workerId: "worker_4", backoffBaseMs: 5000 }
      );

      // Execute single delivery on worker4
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome4 = await (worker4 as any).processSingleDelivery(claim4, tExpired3);
      assert.strictEqual(outcome4, "failed", "Call attempt 1 failure must be retryable, NOT permanently failed");

      const recordAfterCall1 = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(recordAfterCall1?.status, "failed");
      assert.strictEqual(recordAfterCall1?.attemptCount, 4);
      assert.strictEqual(recordAfterCall1?.callAttemptCount, 1);
      assert.strictEqual(recordAfterCall1?.lastError?.isRetryable, true);

      // Backoff MUST be calculated using logical call attempts (callAttemptCount = 1):
      // base * 2^(1 - 1) = 5000ms (NOT base * 2^(4 - 1) = 40000ms!)
      const expectedBackoffTime = new Date(tExpired3.getTime() + 5000).toISOString();
      assert.strictEqual(recordAfterCall1?.nextRetryAt, expectedBackoffTime);

      const sessionAfterCall1 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterCall1?.metadata?.staffFollowUpRequired, false, "Staff follow up must NOT be triggered after call 1");
      assert.strictEqual(sessionAfterCall1?.metadata?.callAttemptStatus, "no_answer");
    });
  });

  await test("7.2 Genuine retry after backoff increments callAttemptCount and succeeds on answered call", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession({ id: "vbs_retry_after_recoveries_01" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_retry_after_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      // Simulate: delivery failed on attempt 1 after 3 lease claims, next retry is at t=10:35:00
      voiceDelivery.status = "failed";
      voiceDelivery.attemptCount = 3;
      voiceDelivery.callAttemptCount = 1;
      voiceDelivery.currentAttemptId = `${voiceDelivery.id}_call1`;
      voiceDelivery.nextRetryAt = "2026-11-02T10:35:00.000Z";
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Advance clock past backoff window to t=10:35:01
      const tRetry = new Date("2026-11-02T10:35:01.000Z");

      // Claim genuine retry: Worker 5 claims it
      const [retryClaim] = await outboxRepo.claimEligibleDeliveries("worker_5", 2000, 1, tRetry);
      assert.ok(retryClaim);
      assert.strictEqual(retryClaim.attemptCount, 4);
      assert.strictEqual(retryClaim.callAttemptCount, 2, "Genuine retry increments callAttemptCount to 2");
      assert.strictEqual(retryClaim.currentAttemptId, `${voiceDelivery.id}_call2`, "New deterministic attempt ID generated");

      // Worker 5 stalls, lease expires at tRetry + 2s
      const tExpiredRetry = new Date(tRetry.getTime() + 3000);
      const [reclaimedRetry] = await outboxRepo.claimEligibleDeliveries("worker_6", 60000, 1, tExpiredRetry);
      assert.ok(reclaimedRetry);
      assert.strictEqual(reclaimedRetry.attemptCount, 5);
      assert.strictEqual(reclaimedRetry.callAttemptCount, 2, "In-flight reclaim preserves callAttemptCount = 2");
      assert.strictEqual(reclaimedRetry.currentAttemptId, `${voiceDelivery.id}_call2`);

      // Worker 6 executes call attempt 2 with outcome 'answered'
      voiceProvider.setNextOutcome("answered");
      const worker6 = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => tExpiredRetry,
        },
        { workerId: "worker_6" }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome6 = await (worker6 as any).processSingleDelivery(reclaimedRetry, tExpiredRetry);
      assert.strictEqual(outcome6, "dispatched");

      const finalRecord = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(finalRecord?.status, "dispatched");
      assert.strictEqual(finalRecord?.attemptCount, 5);
      assert.strictEqual(finalRecord?.callAttemptCount, 2);
      assert.strictEqual(finalRecord?.providerResult?.callOutcome, "answered");

      const finalSession = await sessionRepo.getById(session.id);
      assert.strictEqual(finalSession?.metadata?.callAttemptStatus, "answered");
      assert.strictEqual(finalSession?.metadata?.staffFollowUpRequired, false);
      assert.strictEqual(finalSession?.conversationHistory.length, 1);
    });
  });

  await test("7.3 Exhaustion of logical call attempts triggers permanent failure and staffFollowUpRequired", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      const session = createInitialSession({ id: "vbs_exhaustion_01" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_voice_exh_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-02T09:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      // Seed with callAttemptCount = 2, attemptCount = 8 (numerous previous lease recoveries)
      voiceDelivery.status = "failed";
      voiceDelivery.attemptCount = 8;
      voiceDelivery.callAttemptCount = 2;
      voiceDelivery.maxAttempts = 3;
      voiceDelivery.currentAttemptId = `${voiceDelivery.id}_call2`;
      voiceDelivery.nextRetryAt = "2026-11-02T10:35:00.000Z";
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const tAttempt3 = new Date("2026-11-02T10:35:01.000Z");
      voiceProvider.setNextOutcome("no_answer");

      const worker = new OutboxWorker(
        {
          outboxRepository: outboxRepo,
          sessionRepository: sessionRepo,
          consentRepository: consentRepo,
          dndRepository: dndRepo,
          voiceProvider,
          whatsappProvider,
          currentTimeProvider: () => tAttempt3,
        },
        { workerId: "worker_exh" }
      );

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.permanentlyFailedCount, 1, "Reaching max logical attempts must permanently fail");

      const finalRecord = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(finalRecord?.status, "permanently_failed");
      assert.strictEqual(finalRecord?.callAttemptCount, 3, "Logical call attempts reached 3");
      assert.strictEqual(finalRecord?.attemptCount, 9, "Lease claims counter is 9");
      assert.strictEqual(finalRecord?.lastError?.isRetryable, false);

      const finalSession = await sessionRepo.getById(session.id);
      assert.strictEqual(finalSession?.metadata?.staffFollowUpRequired, true, "Staff follow up MUST be flagged when logical attempts exhausted");
      assert.strictEqual(finalSession?.metadata?.callAttemptStatus, "no_answer");
    });
  });

  await test("7.4 Legacy record fallback bounded by attemptCount prevents unlimited retries", async () => {
    // Legacy record where callAttemptCount is missing (undefined)
    const legacyRecord = {
      attemptCount: 3,
      callAttemptCount: undefined,
    };
    const effective = getEffectiveCallAttemptCount(legacyRecord);
    assert.strictEqual(effective, 3, "Legacy records without callAttemptCount fall back to attemptCount");

    const newRecord = {
      attemptCount: 10,
      callAttemptCount: 1,
    };
    assert.strictEqual(getEffectiveCallAttemptCount(newRecord), 1, "New records strictly use callAttemptCount");
  });

  await test("7.5 Transactional session mutation fencing: concurrent reclaim cannot slip between ownership verification and write", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();

      const session = createInitialSession({ id: "vbs_fencing_race_01" });
      await sessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t0
      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedByW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedByW1);
      const claimContextW1 = {
        claimOwner: "worker_1",
        claimedAt: claimedByW1.claimedAt!,
        claimToken: claimedByW1.claimToken!,
      };

      // Lease expires at t0 + 2s
      const tExpired = new Date(t0.getTime() + 3000);

      // Worker 2 reclaims delivery at tExpired
      const [claimedByW2] = await outboxRepo.claimEligibleDeliveries("worker_2", 60000, 1, tExpired);
      assert.ok(claimedByW2);
      assert.notStrictEqual(claimedByW2.claimToken, claimedByW1.claimToken);

      // Worker 1 attempts to mutate session using mutateSessionWithClaimFencing with its stale claim context
      await assert.rejects(
        async () => {
          await outboxRepo.mutateSessionWithClaimFencing(
            voiceDelivery.id,
            claimContextW1,
            session.id,
            tExpired,
            (s) => {
              s.metadata = {
                ...s.metadata,
                callAttemptStatus: "answered",
                staleWriteSlipped: true,
              };
            },
            sessionRepo
          );
        },
        (err: unknown) => err instanceof StaleClaimError
      );

      // Verify session was NOT modified
      const sessionCheck = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionCheck?.metadata?.staleWriteSlipped, undefined, "Stale mutation must be rejected before write");
      assert.strictEqual(sessionCheck?.revision, 1, "Session revision must remain unchanged");
    });
  });

  console.log("\n--- 8. PHASE 6.3.4.2.3: INMEMORY CLAIM AND SESSION MUTATION ATOMICITY ---");

  await test("8.1 Concurrent reclaim cannot interleave between claim check and session persistence", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const rawSessionRepo = new InMemoryVoiceSessionRepository();

      const session = createInitialSession({ id: "vbs_interleave_01" });
      await rawSessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t0 with lease 2000ms
      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedByW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedByW1);
      const claimContextW1 = {
        claimOwner: "worker_1",
        claimedAt: claimedByW1.claimedAt!,
        claimToken: claimedByW1.claimToken!,
      };

      const tValid = new Date(t0.getTime() + 500);
      const tExpired = new Date(t0.getTime() + 3000);

      let reclaimAttempted = false;
      let reclaimResolved = false;

      // Wrap session repo to trigger a concurrent reclaim attempt right during session persistence
      const interceptedSessionRepo = new Proxy(rawSessionRepo, {
        get(target, prop, receiver) {
          if (prop === "save") {
            return async (sess: VoiceBookingSession, rev?: number) => {
              // Assert that delivery is locked by worker 1 during save
              assert.strictEqual(
                outboxRepo.isDeliveryLocked(voiceDelivery.id),
                true,
                "Delivery lock must be held during session save"
              );

              // Trigger concurrent reclaim attempt while lock is held
              reclaimAttempted = true;
              const reclaimPromise = outboxRepo.claimEligibleDeliveries(
                "worker_2",
                60000,
                1,
                tExpired
              );

              // Allow microtasks to execute: reclaim should block and NOT resolve yet
              await new Promise((r) => setTimeout(r, 20));
              assert.strictEqual(
                reclaimResolved,
                false,
                "Concurrent reclaim must NOT resolve while mutation holds delivery lock"
              );

              // Complete the session save
              const saveResult = await target.save(sess, rev);

              // Track reclaim completion
              reclaimPromise.then(() => {
                reclaimResolved = true;
              });

              return saveResult;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // Worker 1 runs session mutation under valid lease
      const mutationResult = await outboxRepo.mutateSessionWithClaimFencing(
        voiceDelivery.id,
        claimContextW1,
        session.id,
        tValid,
        (s) => {
          s.metadata = {
            ...s.metadata,
            callAttemptStatus: "answered",
            worker1Mutated: true,
          };
        },
        interceptedSessionRepo
      );

      assert.strictEqual(mutationResult, true);
      assert.strictEqual(reclaimAttempted, true);

      // Give event loop a tick for reclaim to finish now that lock is released
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(reclaimResolved, true, "Reclaim should complete after mutation releases lock");

      // Verify session was persisted with Worker 1's changes
      const updatedSession = await rawSessionRepo.getById(session.id);
      assert.strictEqual(updatedSession?.metadata?.worker1Mutated, true);
      assert.strictEqual(updatedSession?.revision, 2);
    });
  });

  await test("8.2 If lease expires and reclaim completes before mutation begins, mutation fails cleanly with StaleClaimError", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();

      const session = createInitialSession({ id: "vbs_reclaim_first_01" });
      await sessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t0 with 2-second lease
      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedByW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedByW1);
      const claimContextW1 = {
        claimOwner: "worker_1",
        claimedAt: claimedByW1.claimedAt!,
        claimToken: claimedByW1.claimToken!,
      };

      // Lease expires at tExpired
      const tExpired = new Date(t0.getTime() + 3000);

      // Worker 2 reclaims delivery
      const [claimedByW2] = await outboxRepo.claimEligibleDeliveries("worker_2", 60000, 1, tExpired);
      assert.ok(claimedByW2);
      assert.notStrictEqual(claimedByW2.claimToken, claimContextW1.claimToken);

      // Worker 1 attempts to mutate session with stale claim
      await assert.rejects(
        async () => {
          await outboxRepo.mutateSessionWithClaimFencing(
            voiceDelivery.id,
            claimContextW1,
            session.id,
            tExpired,
            (s) => {
              s.metadata = {
                ...s.metadata,
                staleWriteApplied: true,
              };
            },
            sessionRepo
          );
        },
        (err: unknown) => err instanceof StaleClaimError
      );

      // Verify session was never updated
      const sessionCheck = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionCheck?.metadata?.staleWriteApplied, undefined);
      assert.strictEqual(sessionCheck?.revision, 1);
    });
  });

  await test("8.3 Unrelated deliveries do not block each other (per-delivery key locking)", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const rawSessionRepo = new InMemoryVoiceSessionRepository();

      const sessionA = createInitialSession({ id: "vbs_unrelated_a" });
      const sessionB = createInitialSession({ id: "vbs_unrelated_b" });
      await rawSessionRepo.save(sessionA);
      await rawSessionRepo.save(sessionB);

      const delivA = createOutboxDeliveriesForTransition(sessionA).find((d) => d.channel === "voice")!;
      const delivB = createOutboxDeliveriesForTransition(sessionB).find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, delivA);
      await seedOutboxDeliveryForTest(outboxRepo, delivB);

      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimedA] = await outboxRepo.claimEligibleDeliveries("worker_1", 30000, 1, t0);
      const [claimedB] = await outboxRepo.claimEligibleDeliveries("worker_2", 30000, 1, t0);
      assert.ok(claimedA);
      assert.ok(claimedB);

      const contextA = {
        claimOwner: "worker_1",
        claimedAt: claimedA.claimedAt!,
        claimToken: claimedA.claimToken!,
      };
      const contextB = {
        claimOwner: "worker_2",
        claimedAt: claimedB.claimedAt!,
        claimToken: claimedB.claimToken!,
      };

      let releaseA: () => void = () => {};
      const pauseAPromise = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      // Session repo that pauses save of sessionA until releaseA is called
      const interceptedRepo = new Proxy(rawSessionRepo, {
        get(target, prop, receiver) {
          if (prop === "save") {
            return async (sess: VoiceBookingSession, rev?: number) => {
              if (sess.id === sessionA.id) {
                await pauseAPromise;
              }
              return target.save(sess, rev);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // Start slow mutation on delivA
      let mutationAComplete = false;
      const mutationAPromise = outboxRepo.mutateSessionWithClaimFencing(
        delivA.id,
        contextA,
        sessionA.id,
        t0,
        (s) => {
          s.metadata = { ...s.metadata, mutatedA: true };
        },
        interceptedRepo
      ).then(() => {
        mutationAComplete = true;
      });

      // Wait a microtask to ensure A acquired lock
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(outboxRepo.isDeliveryLocked(delivA.id), true, "delivA must be locked");

      // Now execute mutation on delivB — it must NOT be blocked by delivA
      let mutationBComplete = false;
      await outboxRepo.mutateSessionWithClaimFencing(
        delivB.id,
        contextB,
        sessionB.id,
        t0,
        (s) => {
          s.metadata = { ...s.metadata, mutatedB: true };
        },
        interceptedRepo
      );
      mutationBComplete = true;

      assert.strictEqual(mutationBComplete, true, "delivB mutation must complete while delivA is held");
      assert.strictEqual(mutationAComplete, false, "delivA mutation must still be paused");
      assert.strictEqual(outboxRepo.isDeliveryLocked(delivB.id), false, "delivB must be unlocked");

      // Verify sessionB was persisted
      const savedB = await rawSessionRepo.getById(sessionB.id);
      assert.strictEqual(savedB?.metadata?.mutatedB, true);
      assert.strictEqual(savedB?.revision, 2);

      // Release A and complete
      releaseA();
      await mutationAPromise;
      assert.strictEqual(mutationAComplete, true);
      assert.strictEqual(outboxRepo.isDeliveryLocked(delivA.id), false, "delivA must be unlocked after finish");

      const savedA = await rawSessionRepo.getById(sessionA.id);
      assert.strictEqual(savedA?.metadata?.mutatedA, true);
      assert.strictEqual(savedA?.revision, 2);
    });
  });

  await test("8.4 An error during mutation cleanly releases the delivery lock", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();

      const session = createInitialSession({ id: "vbs_error_lock_01" });
      await sessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimed] = await outboxRepo.claimEligibleDeliveries("worker_1", 30000, 1, t0);
      assert.ok(claimed);
      const context = {
        claimOwner: "worker_1",
        claimedAt: claimed.claimedAt!,
        claimToken: claimed.claimToken!,
      };

      // Attempt mutation with a failing mutator
      await assert.rejects(
        async () => {
          await outboxRepo.mutateSessionWithClaimFencing(
            voiceDelivery.id,
            context,
            session.id,
            t0,
            () => {
              throw new Error("Deliberate mutator failure");
            },
            sessionRepo
          );
        },
        /Deliberate mutator failure/
      );

      // Verify lock is released immediately
      assert.strictEqual(
        outboxRepo.isDeliveryLocked(voiceDelivery.id),
        false,
        "Lock must be released on failure"
      );

      // Verify subsequent operation on same delivery can proceed without deadlock
      const retryResult = await outboxRepo.mutateSessionWithClaimFencing(
        voiceDelivery.id,
        context,
        session.id,
        t0,
        (s) => {
          s.metadata = { ...s.metadata, retriedSuccessfully: true };
        },
        sessionRepo
      );
      assert.strictEqual(retryResult, true);
      const saved = await sessionRepo.getById(session.id);
      assert.strictEqual(saved?.metadata?.retriedSuccessfully, true);
    });
  });

  await test("8.5 Session optimistic revision conflicts are handled correctly without leaving stale delivery state", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const rawSessionRepo = new InMemoryVoiceSessionRepository();

      const session = createInitialSession({ id: "vbs_occ_conflict_01" });
      await rawSessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const t0 = new Date("2026-11-02T10:30:00.000Z");
      const [claimed] = await outboxRepo.claimEligibleDeliveries("worker_1", 30000, 1, t0);
      assert.ok(claimed);
      const context = {
        claimOwner: "worker_1",
        claimedAt: claimed.claimedAt!,
        claimToken: claimed.claimToken!,
      };

      // Wrap repo to simulate concurrent session update in storage right before save
      const interceptedRepo = new Proxy(rawSessionRepo, {
        get(target, prop, receiver) {
          if (prop === "save") {
            return async (sess: VoiceBookingSession, rev?: number) => {
              // External concurrent update bumps revision to 2 behind worker's back
              const current = await target.getById(sess.id);
              if (current && current.revision === 1) {
                current.metadata = { ...current.metadata, concurrentExternalBump: true };
                await target.save(current, 1);
              }
              // Now attempt worker's save with stale expectedRevision = 1
              return target.save(sess, rev);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // Worker 1 attempts mutation; must be rejected with OptimisticConcurrencyConflictError
      await assert.rejects(
        async () => {
          await outboxRepo.mutateSessionWithClaimFencing(
            voiceDelivery.id,
            context,
            session.id,
            t0,
            (s) => {
              s.metadata = { ...s.metadata, staleWorkerWrite: true };
            },
            interceptedRepo
          );
        },
        (err: unknown) => err instanceof OptimisticConcurrencyConflictError
      );

      // Verify delivery lock was released
      assert.strictEqual(
        outboxRepo.isDeliveryLocked(voiceDelivery.id),
        false,
        "Delivery lock must be released on OCC conflict"
      );

      // Verify delivery record in outbox was NOT corrupted
      const currentDelivery = await outboxRepo.getDeliveryById(voiceDelivery.id);
      assert.strictEqual(currentDelivery?.status, "processing");
      assert.strictEqual(currentDelivery?.claimToken, context.claimToken);

      // Verify session was NOT overwritten by worker's stale write
      const finalSession = await rawSessionRepo.getById(session.id);
      assert.strictEqual(finalSession?.metadata?.concurrentExternalBump, true);
      assert.strictEqual(finalSession?.metadata?.staleWorkerWrite, undefined);
      assert.strictEqual(finalSession?.revision, 2);
    });
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.4.2 Verification Complete: ${passed} / ${total} tests passed!`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
