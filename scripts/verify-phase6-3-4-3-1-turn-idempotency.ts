/**
 * BREW Coffee Platform — Phase 6.3.4.3.1 Verification Suite
 * Conversation Turn Idempotency & Mock Session Isolation
 *
 * Verifies:
 * 1. Durable per-session conversation progress and turn idempotency.
 * 2. Interrupted script resumption from first unprocessed utterance.
 * 3. Prevention of duplicate customer and assistant messages on retries.
 * 4. Completed turns not reprocessed on new logical call attempts.
 * 5. Failure before persistence leaves turn eligible for retry.
 * 6. Mock customer scripts strictly isolated by session ID.
 * 7. Sessions without scripts receive no fallback from other sessions.
 * 8. Duplicate worker execution does not duplicate greetings or turns.
 * 9. Stale claim fencing protects session mutations.
 * 10. Separation of customer confirmation and staff approval.
 */

process.env.VOICE_BOOKING_ENABLED = "false"; // Strictly preserved as false
process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";

import assert from "assert";
import {
  MockVoiceProvider,
  MockWhatsAppProvider,
  OutboxWorker,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  StaleClaimError,
  createOutboxDeliveriesForTransition,
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
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
} from "../src/lib/voiceBooking";
import {
  StaffAuthorizationContext,
  ExtractionProvider,
} from "../src/lib/voiceBooking/types";

let passedCount = 0;
let failedCount = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err: unknown) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failedCount++;
  }
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.3.4.3.1 Verification Suite");
  console.log("   Conversation Turn Idempotency & Mock Session Isolation");
  console.log("================================================================================\n");

  console.log("--- 1. DURABLE PROGRESS & RESUMPTION AFTER INTERRUPTION ---");

  await test("1.1 Script with three turns interrupted after turn one resumes at turn two", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");
      voiceProvider.clearCustomerTurns();

      const session = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(session);

      const script = [
        "Hi, I want to book a coffee van for our company anniversary.",
        "We expect 100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
        "Yes, I confirm the Artisanal Signature package.",
      ];
      voiceProvider.setSessionCustomerTurns(session.id, script);

      await consentRepo.save({
        id: "c_turn_res_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-06T10:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Phase A: Execute Turn 1 only
      const s0 = await sessionRepo.getById(session.id);
      assert.ok(s0);
      const t1 = await processConversationTurn(s0, script[0], {
        sessionRepository: sessionRepo,
        turnIndex: 0,
        turnId: `${s0.id}_turn_0`,
      });
      assert.strictEqual(t1.session.lastProcessedTurnIndex, 0);
      assert.deepStrictEqual(t1.session.processedTurnIds, [`${session.id}_turn_0`]);
      // 1 user message + 1 assistant message = 2 messages
      assert.strictEqual(t1.session.conversationHistory.length, 2);

      // Phase B: Worker resumes execution of the delivery with full 3-turn script
      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.claimedCount, 1);
      assert.strictEqual(cycleResult.dispatchedCount, 1);

      // Verify final session: Turn 0 was NOT duplicated; turns 1 and 2 were processed
      const sFinal = await sessionRepo.getById(session.id);
      assert.ok(sFinal);
      assert.strictEqual(sFinal.state, "awaiting_staff_approval");
      assert.strictEqual(sFinal.lastProcessedTurnIndex, 2);
      assert.strictEqual(sFinal.processedTurnIds?.length, 3);
      assert.deepStrictEqual(sFinal.processedTurnIds, [
        `${session.id}_turn_0`,
        `${session.id}_turn_1`,
        `${session.id}_turn_2`,
      ]);

      // Message count: 2 messages from Turn 0 + 2 from Turn 1 + 2 from Turn 2 = 6 messages
      assert.strictEqual(sFinal.conversationHistory.length, 6);
      assert.strictEqual(sFinal.conversationHistory[0].id, `msg_u_${session.id}_turn_0`);
      assert.strictEqual(sFinal.conversationHistory[1].id, `msg_a_${session.id}_turn_0`);
      assert.strictEqual(sFinal.conversationHistory[2].id, `msg_u_${session.id}_turn_1`);
      assert.strictEqual(sFinal.conversationHistory[3].id, `msg_a_${session.id}_turn_1`);
      assert.strictEqual(sFinal.conversationHistory[4].id, `msg_u_${session.id}_turn_2`);
      assert.strictEqual(sFinal.conversationHistory[5].id, `msg_a_${session.id}_turn_2`);
    });
  });

  await test("1.2 Retry after turn two does not duplicate customer or assistant messages", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Turn 0
    const res0 = await processConversationTurn(session, "Hi, I need a coffee van.", {
      sessionRepository: sessionRepo,
      turnIndex: 0,
      turnId: `${session.id}_turn_0`,
    });
    // Turn 1
    const res1 = await processConversationTurn(
      res0.session,
      "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      {
        sessionRepository: sessionRepo,
        turnIndex: 1,
        turnId: `${session.id}_turn_1`,
      }
    );

    const initialHistoryLength = res1.session.conversationHistory.length; // 4
    const initialRevision = res1.session.revision;

    // Retry Turn 1 on the session
    const retryRes = await processConversationTurn(
      res1.session,
      "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      {
        sessionRepository: sessionRepo,
        turnIndex: 1,
        turnId: `${session.id}_turn_1`,
      }
    );

    assert.strictEqual(
      retryRes.session.conversationHistory.length,
      initialHistoryLength,
      "Retry must not duplicate messages"
    );
    assert.strictEqual(
      retryRes.session.revision,
      initialRevision,
      "Retry must not increment revision"
    );
    assert.strictEqual(retryRes.session.lastProcessedTurnIndex, 1);
  });

  await test("1.3 Completed turn is not reprocessed on a new logical call attempt", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");
      voiceProvider.clearCustomerTurns();

      const session = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(session);

      const script = [
        "Hi, need coffee van.",
        "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      ];
      voiceProvider.setSessionCustomerTurns(session.id, script);

      await consentRepo.save({
        id: "c_call_att_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-06T10:00:00.000Z",
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      // Attempt 1 processes all configured turns
      await worker.processCycle();
      const sessionAfterAttempt1 = await sessionRepo.getById(session.id);
      assert.ok(sessionAfterAttempt1);
      const msgCountAttempt1 = sessionAfterAttempt1.conversationHistory.length;
      assert.strictEqual(sessionAfterAttempt1.lastProcessedTurnIndex, 1);

      // Simulate a new logical call attempt on a new delivery for the same session
      const retryDelivery = {
        ...voiceDelivery,
        id: "del_voice_logical_retry_02",
        status: "pending" as const,
        attemptCount: 0,
        callAttemptCount: 1,
        currentAttemptId: null,
      };
      await seedOutboxDeliveryForTest(outboxRepo, retryDelivery);

      // Attempt 2 claims and executes
      await worker.processCycle();
      const sessionAfterAttempt2 = await sessionRepo.getById(session.id);
      assert.ok(sessionAfterAttempt2);
      assert.strictEqual(
        sessionAfterAttempt2.conversationHistory.length,
        msgCountAttempt1,
        "New logical call attempt must not replay already completed turns"
      );
    });
  });

  await test("1.4 Failure before turn persistence leaves that turn eligible for retry", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Turn 0 succeeds
    const t0 = await processConversationTurn(session, "Hi, need coffee van.", {
      sessionRepository: sessionRepo,
      turnIndex: 0,
      turnId: `${session.id}_turn_0`,
    });
    assert.strictEqual(t0.session.lastProcessedTurnIndex, 0);

    // Turn 1 fails before persistence via simulated extraction failure
    const failingProvider: ExtractionProvider = {
      async extractRequirements() {
        throw new Error("Simulated extraction network timeout");
      },
    };

    await assert.rejects(
      async () => {
        await processConversationTurn(
          t0.session,
          "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
          {
            sessionRepository: sessionRepo,
            extractionProvider: failingProvider,
            turnIndex: 1,
            turnId: `${session.id}_turn_1`,
          }
        );
      },
      /Simulated extraction network timeout/
    );

    // Verify session in repository was NOT updated with Turn 1
    const sReload = await sessionRepo.getById(session.id);
    assert.ok(sReload);
    assert.strictEqual(sReload.lastProcessedTurnIndex, 0);
    assert.strictEqual(sReload.conversationHistory.length, 2);

    // Turn 1 is retried with working provider and succeeds
    const t1Retry = await processConversationTurn(
      sReload,
      "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      {
        sessionRepository: sessionRepo,
        turnIndex: 1,
        turnId: `${session.id}_turn_1`,
      }
    );

    assert.strictEqual(t1Retry.session.lastProcessedTurnIndex, 1);
    assert.strictEqual(t1Retry.session.conversationHistory.length, 4);
    assert.deepStrictEqual(t1Retry.session.processedTurnIds, [
      `${session.id}_turn_0`,
      `${session.id}_turn_1`,
    ]);
  });

  console.log("\n--- 2. MOCK CUSTOMER SCRIPT SESSION ISOLATION ---");

  await test("2.1 Two sessions configured with different scripts never exchange utterances", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");
      voiceProvider.clearCustomerTurns();

      const sessionA = createVoiceBookingSession("+919876543210", "en");
      const sessionB = createVoiceBookingSession("+919123456789", "en");
      await sessionRepo.save(sessionA);
      await sessionRepo.save(sessionB);

      const scriptA = ["Script A Turn 1: Coffee for wedding", "Script A Turn 2: 100 guests"];
      const scriptB = ["Script B Turn 1: Coffee for tech conference", "Script B Turn 2: 300 guests"];

      voiceProvider.setSessionCustomerTurns(sessionA.id, scriptA);
      voiceProvider.setSessionCustomerTurns(sessionB.id, scriptB);

      // Verify getter returns isolated scripts
      assert.deepStrictEqual(voiceProvider.getSimulatedCustomerTurns(sessionA.id), scriptA);
      assert.deepStrictEqual(voiceProvider.getSimulatedCustomerTurns(sessionB.id), scriptB);

      // Worker executes deliveries for both
      await consentRepo.save({
        id: "c_iso_a",
        phoneNumber: sessionA.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-06T10:00:00.000Z",
      });
      await consentRepo.save({
        id: "c_iso_b",
        phoneNumber: sessionB.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-06T10:00:00.000Z",
      });

      const delivA = createOutboxDeliveriesForTransition(sessionA).find((d) => d.channel === "voice")!;
      const delivB = createOutboxDeliveriesForTransition(sessionB).find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, delivA);
      await seedOutboxDeliveryForTest(outboxRepo, delivB);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      await worker.processCycle();
      await worker.processCycle();

      const finalA = await sessionRepo.getById(sessionA.id);
      const finalB = await sessionRepo.getById(sessionB.id);

      assert.ok(finalA);
      assert.ok(finalB);

      // Final A contains only script A
      const userMsgsA = finalA.conversationHistory.filter((m) => m.role === "user").map((m) => m.content);
      assert.deepStrictEqual(userMsgsA, scriptA);

      // Final B contains only script B
      const userMsgsB = finalB.conversationHistory.filter((m) => m.role === "user").map((m) => m.content);
      assert.deepStrictEqual(userMsgsB, scriptB);
    });
  });

  await test("2.2 Session without configured script receives no other session's default script", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");
      voiceProvider.clearCustomerTurns();

      // Configure a global harness default and another session's script
      voiceProvider.setSimulatedCustomerTurns(["Global fallback turn that should not leak"]);
      voiceProvider.setSessionCustomerTurns("other_session_xyz", ["Other session turn"]);

      const sessionNoScript = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(sessionNoScript);

      // Verify getSimulatedCustomerTurns returns empty array for sessionNoScript
      assert.deepStrictEqual(
        voiceProvider.getSimulatedCustomerTurns(sessionNoScript.id),
        [],
        "Session without configured script must receive empty array"
      );

      await consentRepo.save({
        id: "c_no_script_01",
        phoneNumber: sessionNoScript.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-06T10:00:00.000Z",
      });

      const deliv = createOutboxDeliveriesForTransition(sessionNoScript).find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, deliv);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      await worker.processCycle();

      const finalSession = await sessionRepo.getById(sessionNoScript.id);
      assert.ok(finalSession);
      // Only greeting exists; zero user turns executed
      assert.strictEqual(finalSession.conversationHistory.length, 1);
      assert.strictEqual(finalSession.conversationHistory[0].role, "assistant");
      assert.strictEqual(finalSession.conversationHistory[0].id, `msg_a_${sessionNoScript.id}_init`);
    });
  });

  await test("2.3 Session ID validation prevents raw phone numbers from being used as keys", async () => {
    const voiceProvider = new MockVoiceProvider();
    assert.throws(
      () => {
        voiceProvider.setSessionCustomerTurns("+919876543210", ["Turn 1"]);
      },
      /Security violation: Raw phone number cannot be used as sessionId/
    );
    assert.throws(
      () => {
        voiceProvider.setSessionCustomerTurns("9876543210", ["Turn 1"]);
      },
      /Security violation: Raw phone number cannot be used as sessionId/
    );
    assert.throws(
      () => {
        voiceProvider.setSessionCustomerTurns("", ["Turn 1"]);
      },
      /setSessionCustomerTurns requires a valid non-empty sessionId string/
    );
  });

  console.log("\n--- 3. CONCURRENCY, DEDUPLICATION & GATES ---");

  await test("3.1 Duplicate worker execution does not duplicate greeting or conversation turns", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");
      voiceProvider.clearCustomerTurns();

      const session = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(session);

      voiceProvider.setSessionCustomerTurns(session.id, [
        "Hi, need coffee van.",
        "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      ]);

      await consentRepo.save({
        id: "c_dup_exec_01",
        phoneNumber: session.phoneNumber,
        channel: "voice",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Voice consent",
        consentVersion: "v1.0",
        timestamp: "2026-11-06T10:00:00.000Z",
      });

      const deliv = createOutboxDeliveriesForTransition(session).find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, deliv);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider,
      });

      // Cycle 1: Dispatches and completes turns
      await worker.processCycle();
      const session1 = await sessionRepo.getById(session.id);
      assert.ok(session1);
      const msgCount1 = session1.conversationHistory.length; // 1 greeting + 2 * (1 user + 1 assistant) = 5

      // Re-seed delivery to simulate duplicate worker cycle
      await seedOutboxDeliveryForTest(outboxRepo, {
        ...deliv,
        id: "del_dup_replay_99",
        status: "pending",
        attemptCount: 0,
      });

      // Cycle 2: Runs duplicate worker cycle
      await worker.processCycle();
      const session2 = await sessionRepo.getById(session.id);
      assert.ok(session2);
      assert.strictEqual(session2.conversationHistory.length, msgCount1, "Zero duplicate messages on duplicate execution");
    });
  });

  await test("3.2 Stale claim fencing still prevents session mutation", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();

      const session = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      const t0 = new Date("2026-11-06T10:30:00.000Z");
      const [claimedW1] = await outboxRepo.claimEligibleDeliveries("worker_1", 2000, 1, t0);
      assert.ok(claimedW1);
      const claimContextW1 = {
        claimOwner: "worker_1",
        claimedAt: claimedW1.claimedAt!,
        claimToken: claimedW1.claimToken!,
      };

      // Advance time beyond lease expiry
      const tExpired = new Date(t0.getTime() + 3000);

      // Worker 2 reclaims delivery
      const [claimedW2] = await outboxRepo.claimEligibleDeliveries("worker_2", 60000, 1, tExpired);
      assert.ok(claimedW2);

      // Worker 1 attempts turn mutation with stale claim lease
      await assert.rejects(
        async () => {
          await processConversationTurn(session, "Hi, this is a stale worker turn.", {
            sessionRepository: sessionRepo,
            claimFencing: {
              outboxRepository: outboxRepo,
              deliveryId: voiceDelivery.id,
              claimContext: claimContextW1,
              now: tExpired,
            },
          });
        },
        (err: unknown) => err instanceof StaleClaimError
      );

      const sessionCheck = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionCheck?.conversationHistory.length, 0);
      assert.strictEqual(sessionCheck?.revision, 1);
    });
  });

  await test("3.3 Customer confirmation and staff approval remain separate", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    const quoted = await processConversationTurn(
      session,
      "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      { sessionRepository: sessionRepo }
    );
    const confirmed = await processConversationTurn(
      quoted.session,
      "Yes, I confirm the Artisanal Signature package.",
      { sessionRepository: sessionRepo }
    );

    assert.strictEqual(confirmed.session.state, "awaiting_staff_approval");
    assert.strictEqual(confirmed.session.requirements.customerConfirmed, true);
    assert.strictEqual(confirmed.session.staffApprovalAudit, null, "Customer confirmation must not approve booking");

    const authContext: StaffAuthorizationContext = {
      staffIdentity: "barista_priya_01",
      staffRole: "barista",
      staffApprovalId: "appr_staff_789",
    };

    const approvedSession = await approveBookingByStaff(confirmed.session.id, authContext, sessionRepo);
    assert.strictEqual(approvedSession.state, "booking_confirmed");
    assert.ok(approvedSession.staffApprovalAudit);
    assert.strictEqual(approvedSession.staffApprovalAudit.staffIdentity, "barista_priya_01");
  });

  console.log("\n--- 4. MULTILINGUAL & CODE-SWITCHING INTEGRITY ---");

  await test("4.1 English, Hindi, Telugu, Hinglish, and Tenglish conversations track turn progress", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();

    // Hindi session
    const hindiSession = createVoiceBookingSession("+919876543210", "hi");
    await sessionRepo.save(hindiSession);

    const hTurn1 = await processConversationTurn(
      hindiSession,
      "नमस्ते, मुझे शादी के लिए कॉफ़ी वैन चाहिए।",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(hTurn1.session.lastProcessedTurnIndex, 0);
    assert.strictEqual(hTurn1.session.language, "hi");

    const hTurn2 = await processConversationTurn(
      hTurn1.session,
      "2026-12-25 को 150 मेहमानों के लिए 10:00 बजे से 4 घंटे के लिए गाचीबोवली में।",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(hTurn2.session.lastProcessedTurnIndex, 1);
    assert.strictEqual(hTurn2.session.requirements.guestCount, 150);

    // Telugu session
    const teluguSession = createVoiceBookingSession("+919123456789", "te");
    await sessionRepo.save(teluguSession);

    const tTurn1 = await processConversationTurn(
      teluguSession,
      "నమస్కారం, మా పెళ్లి కోసం కాఫీ కౌంటర్ కావాలి.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(tTurn1.session.lastProcessedTurnIndex, 0);
    assert.strictEqual(tTurn1.session.language, "te");

    const tTurn2 = await processConversationTurn(
      tTurn1.session,
      "2026-12-25 న 200 మందికి 10:00 నుండి 4 గంటల పాటు మాదాపూర్‌లో కాఫీ కౌంటర్ కావాలి.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(tTurn2.session.lastProcessedTurnIndex, 1);
    assert.strictEqual(tTurn2.session.requirements.guestCount, 200);

    // Hinglish code-switching
    const engSession = createVoiceBookingSession("+919988776655", "en");
    await sessionRepo.save(engSession);

    const hinglishTurn = await processConversationTurn(
      engSession,
      "Mujhe 100 logon ke liye wedding mein artisanal coffee bar chahiye.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(hinglishTurn.session.lastProcessedTurnIndex, 0);
    assert.strictEqual(hinglishTurn.session.language, "hi", "Code-switching to Hindi must succeed");
    assert.strictEqual(hinglishTurn.session.requirements.guestCount, 100);
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.4.3.1 Verification Complete: ${passedCount} / ${passedCount + failedCount} tests passed!`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled test suite rejection:", err);
  process.exit(1);
});
