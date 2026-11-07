/**
 * BREW Coffee Platform — Phase 6.3.4.3 Verification Suite
 * Multilingual Voice Conversation Engine Integration
 *
 * Verifies end-to-end conversation logic, simulated customer turns, multilingual
 * code-switching (English, Hindi, Telugu, Hinglish, Tenglish), quotation integrity,
 * customer confirmation vs. staff approval segregation, claim fencing, and privacy.
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
  extractSafeCallStatus,
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
  getInitialGreeting,
  processConversationTurn,
  simulateVoiceConversation,
  approveBookingByStaff,
} from "../src/lib/voiceBooking";
import {
  StaffAuthorizationContext,
} from "../src/lib/voiceBooking/types";

console.log("================================================================================");
console.log("   BREW Coffee Platform — Phase 6.3.4.3 Verification Suite");
console.log("   Multilingual Voice Conversation Engine Integration");
console.log("================================================================================\n");

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void>) {
  total += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function runAllTests() {
  console.log("--- 1. MULTILINGUAL CONVERSATION FLOWS (ENGLISH, HINDI, TELUGU) ---");

  await test("1.1 English conversation from greeting through quotation", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Initial greeting
    const greeting = getInitialGreeting("en");
    assert.ok(greeting.includes("Welcome to BREW Coffee Concierge"));

    // Turn 1: Customer describes event type
    const turn1 = await processConversationTurn(session, "Hi, I need a coffee van for our corporate tech conference.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn1.session.state, "collecting_requirements");
    assert.strictEqual(turn1.session.requirements.eventType, "corporate");
    assert.ok(turn1.session.requirements.missingFields.length > 0);

    // Turn 2: Customer provides all remaining requirements
    const turn2 = await processConversationTurn(turn1.session, "We expect 120 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn2.session.state, "awaiting_customer_confirmation");
    assert.strictEqual(turn2.session.requirements.guestCount, 120);
    assert.strictEqual(turn2.session.requirements.eventDate, "2026-12-15");
    assert.strictEqual(turn2.session.requirements.startTime, "10:00");
    assert.strictEqual(turn2.session.requirements.durationHours, 4);
    assert.strictEqual(turn2.session.requirements.venueAddress, "Hitec City");
    assert.strictEqual(turn2.session.requirements.missingFields.length, 0);

    // Verify quotation was generated deterministically
    assert.ok(turn2.session.quotation);
    assert.strictEqual(turn2.session.quotation.tiers.length, 3);
    assert.ok(turn2.assistantResponse.includes("Classic Brew"));
    assert.ok(turn2.assistantResponse.includes("Artisanal Signature"));
    assert.ok(turn2.assistantResponse.includes("VIP Unlimited Bar"));
  });

  await test("1.2 Hindi conversation (Devanagari script)", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Turn 1: Customer speaks in Devanagari Hindi
    const turn1 = await processConversationTurn(session, "नमस्ते, हमें अपनी शादी के लिए एक कॉफ़ी वैन चाहिए।", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn1.session.language, "hi", "Language must switch to Hindi from Devanagari script");
    assert.strictEqual(turn1.session.requirements.eventType, "wedding");

    // Turn 2: Customer provides event details in Hindi
    const turn2 = await processConversationTurn(turn1.session, "2026-12-20 को Banjara Hills में 100 मेहमानों के लिए 4 घंटे सुबह 11:00 बजे।", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn2.session.state, "awaiting_customer_confirmation");
    assert.strictEqual(turn2.session.requirements.guestCount, 100);
    assert.strictEqual(turn2.session.requirements.eventDate, "2026-12-20");
    assert.strictEqual(turn2.session.requirements.startTime, "11:00");
    assert.strictEqual(turn2.session.requirements.durationHours, 4);
    assert.strictEqual(turn2.session.requirements.venueAddress, "Banjara Hills");
    assert.strictEqual(turn2.session.language, "hi");

    // Quotation message formatted in Hindi
    assert.ok(turn2.assistantResponse.includes("100 मेहमानों के लिए"));
    assert.ok(turn2.assistantResponse.includes("Classic Brew"));
  });

  await test("1.3 Telugu conversation (Telugu script)", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Turn 1: Customer speaks in Telugu script
    const turn1 = await processConversationTurn(session, "నమస్కారం, మా కాలేజ్ ఫెస్ట్ కోసం కాఫీ వ్యాన్ బుక్ చేయాలనుకుంటున్నాను.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn1.session.language, "te", "Language must switch to Telugu from Telugu script");

    // Turn 2: Customer provides event details in Telugu
    const turn2 = await processConversationTurn(turn1.session, "Jubilee Hills లో 2026-12-25 న 150 మందికి 4 గంటలు ఉదయం 10:00 గంటలకు.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn2.session.state, "awaiting_customer_confirmation");
    assert.strictEqual(turn2.session.requirements.guestCount, 150);
    assert.strictEqual(turn2.session.requirements.eventDate, "2026-12-25");
    assert.strictEqual(turn2.session.requirements.startTime, "10:00");
    assert.strictEqual(turn2.session.requirements.durationHours, 4);
    assert.strictEqual(turn2.session.requirements.venueAddress, "Jubilee Hills");

    // Quotation message formatted in Telugu
    assert.ok(turn2.assistantResponse.includes("150 మంది అతిథుల కోసం"));
  });

  await test("1.4 Hinglish and Tenglish input detection and extraction", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();

    // Hinglish test
    const sessionHinglish = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(sessionHinglish);
    const turnHinglish = await processConversationTurn(
      sessionHinglish,
      "Mujhe corporate event ke liye 2026-12-18 ko Gachibowli mein 80 logon ke liye 3 ghante subah 09:00 baje van chahiye.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(turnHinglish.session.language, "hi", "Hinglish tokens must detect Hindi");
    assert.strictEqual(turnHinglish.session.requirements.guestCount, 80);
    assert.strictEqual(turnHinglish.session.requirements.eventDate, "2026-12-18");
    assert.strictEqual(turnHinglish.session.requirements.startTime, "09:00");
    assert.strictEqual(turnHinglish.session.requirements.durationHours, 3);
    assert.strictEqual(turnHinglish.session.requirements.venueAddress, "Gachibowli");

    // Tenglish test
    const sessionTenglish = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(sessionTenglish);
    const turnTenglish = await processConversationTurn(
      sessionTenglish,
      "Maaku birthday party kosam 2026-12-22 roju Kondapur lo 50 mandiki 3 gantalu 16:00 ki van kavali.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(turnTenglish.session.language, "te", "Tenglish tokens must detect Telugu");
    assert.strictEqual(turnTenglish.session.requirements.guestCount, 50);
    assert.strictEqual(turnTenglish.session.requirements.eventDate, "2026-12-22");
    assert.strictEqual(turnTenglish.session.requirements.startTime, "16:00");
    assert.strictEqual(turnTenglish.session.requirements.durationHours, 3);
    assert.strictEqual(turnTenglish.session.requirements.venueAddress, "Kondapur");
  });

  await test("1.5 Explicit language switching during a conversation", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Initial message in English
    const turn1 = await processConversationTurn(session, "Hello, I want to book a van.", { sessionRepository: sessionRepo });
    assert.strictEqual(turn1.session.language, "en");

    // Switch to Hindi
    const turn2 = await processConversationTurn(turn1.session, "Can we switch to hindi please?", { sessionRepository: sessionRepo });
    assert.strictEqual(turn2.session.language, "hi");
    assert.ok(turn2.assistantResponse.length > 0);

    // Switch to Telugu
    const turn3 = await processConversationTurn(turn2.session, "telugu lo matladu", { sessionRepository: sessionRepo });
    assert.strictEqual(turn3.session.language, "te");

    // Switch back to English
    const turn4 = await processConversationTurn(turn3.session, "switch to english", { sessionRepository: sessionRepo });
    assert.strictEqual(turn4.session.language, "en");
  });

  console.log("\n--- 2. REQUIREMENT COLLECTION, VALIDATION & QUOTATIONS ---");

  await test("2.1 Missing requirements prompt follow-up questions sequentially", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Customer provides only event type and date
    const turn1 = await processConversationTurn(session, "I want a coffee van for a birthday party on 2026-12-15.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn1.session.state, "collecting_requirements");
    assert.strictEqual(turn1.session.requirements.eventType, "birthday");
    assert.strictEqual(turn1.session.requirements.eventDate, "2026-12-15");
    // Missing guestCount is prompted
    assert.ok(turn1.assistantResponse.toLowerCase().includes("guest count") || turn1.assistantResponse.toLowerCase().includes("how many"));

    // Customer provides guest count
    const turn2 = await processConversationTurn(turn1.session, "There will be 80 guests.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn2.session.requirements.guestCount, 80);
    // Missing startTime is prompted
    assert.ok(turn2.assistantResponse.toLowerCase().includes("start time") || turn2.assistantResponse.toLowerCase().includes("time"));
  });

  await test("2.2 Invalid event timing triggers operational clarification without presenting quotation", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Customer provides all details but with timing that crosses midnight (22:00 for 4 hours ends at 02:00)
    const turn = await processConversationTurn(
      session,
      "I need a van on 2026-12-15 for 100 guests at Hitec City starting at 22:00 for 4 hours.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(turn.session.state, "collecting_requirements");
    assert.strictEqual(turn.session.quotation, null);
    assert.ok(turn.assistantResponse.includes("issue with the event timing"));
  });

  console.log("\n--- 3. CONFIRMATION SAFETY GATE, QUOTATION INTEGRITY & DECLINE ---");

  await test("3.1 Ambiguous customer statement does NOT trigger confirmation", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Present quote first
    const quoted = await processConversationTurn(
      session,
      "We need a van for 100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(quoted.session.state, "awaiting_customer_confirmation");

    // Ambiguous confirmation attempt: contains "yes" but is conversational filler / vague
    const ambiguousTurn = await processConversationTurn(
      quoted.session,
      "yes coffee is my favorite drink and let me think about this with my team maybe later",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(ambiguousTurn.session.state, "awaiting_customer_confirmation", "Session must remain in awaiting_customer_confirmation");
    assert.strictEqual(ambiguousTurn.session.requirements.customerConfirmed, false);
    assert.ok(ambiguousTurn.assistantResponse.includes("clearly confirm if you would like to accept"));
  });

  await test("3.2 Explicit positive confirmation transitions to awaiting_staff_approval", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    const quoted = await processConversationTurn(
      session,
      "We need a van for 100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      { sessionRepository: sessionRepo }
    );

    // Customer explicitly accepts
    const confirmed = await processConversationTurn(
      quoted.session,
      "Yes, I confirm the Artisanal Signature package.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(confirmed.session.state, "awaiting_staff_approval");
    assert.strictEqual(confirmed.session.requirements.customerConfirmed, true);
    assert.strictEqual(confirmed.session.requirements.selectedTier, "STANDARD");
    assert.ok(confirmed.session.officialBookingId?.startsWith("enq_voice_"));
    assert.ok(confirmed.assistantResponse.includes("awaiting review and operational scheduling by our staff"));
  });

  await test("3.3 Customer decline transitions to customer_declined", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    const quoted = await processConversationTurn(
      session,
      "We need a van for 100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      { sessionRepository: sessionRepo }
    );

    // Customer declines
    const declined = await processConversationTurn(
      quoted.session,
      "No, this price is too high, cancel the booking.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(declined.session.state, "customer_declined");
    assert.strictEqual(declined.session.requirements.customerConfirmed, false);
    assert.ok(declined.assistantResponse.includes("cancelled this quotation"));
  });

  await test("3.4 Material requirement changes invalidate quotation and require re-confirmation", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    const quoted = await processConversationTurn(
      session,
      "We need a van for 100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
      { sessionRepository: sessionRepo }
    );
    assert.strictEqual(quoted.session.quotation?.guestCount, 100);

    // Customer modifies guest count to 250 while attempting to confirm
    const modifiedTurn = await processConversationTurn(
      quoted.session,
      "Actually make it 250 guests instead of 100, and book it.",
      { sessionRepository: sessionRepo }
    );
    // Old quote was invalidated, new quote generated for 250
    assert.strictEqual(modifiedTurn.session.requirements.guestCount, 250);
    assert.strictEqual(modifiedTurn.session.quotation?.guestCount, 250);
    assert.strictEqual(modifiedTurn.session.requirements.customerConfirmed, false, "Modified quote must NOT be auto-confirmed");
    assert.strictEqual(modifiedTurn.session.state, "awaiting_customer_confirmation");
  });

  console.log("\n--- 4. PERSISTENCE, RECOVERY, CONCURRENCY & REVISION SAFETY ---");

  await test("4.1 Session reload and conversation continuation across turns", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Turn 1
    await processConversationTurn(session, "Hi, I need a coffee van for a wedding.", {
      sessionRepository: sessionRepo,
    });

    // Simulate worker reload from repository
    const reloadedSession = await sessionRepo.getById(session.id);
    assert.ok(reloadedSession);
    assert.strictEqual(reloadedSession.conversationHistory.length, 2); // 1 user + 1 assistant

    // Turn 2 executed on reloaded session
    const turn2 = await processConversationTurn(reloadedSession, "100 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.", {
      sessionRepository: sessionRepo,
    });
    assert.strictEqual(turn2.session.conversationHistory.length, 4); // 2 user + 2 assistant
    assert.strictEqual(turn2.session.revision, 3);
  });

  await test("4.2 Duplicate delivery execution does not duplicate greeting turns", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      const whatsappProvider = new MockWhatsAppProvider();

      voiceProvider.setDefaultOutcome("answered");

      const session = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_dup_greet_01",
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

      // Cycle 1: Dispatches answered call, appends greeting
      await worker.processCycle();
      const sessionAfterCycle1 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterCycle1?.conversationHistory.length, 1);
      assert.strictEqual(sessionAfterCycle1?.conversationHistory[0].role, "assistant");

      // Re-seed delivery to simulate replay
      await seedOutboxDeliveryForTest(outboxRepo, {
        ...voiceDelivery,
        id: "del_replay_voice_01",
        status: "pending",
        attemptCount: 0,
      });

      // Cycle 2: Dispatches duplicate attempt
      await worker.processCycle();
      const sessionAfterCycle2 = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionAfterCycle2?.conversationHistory.length, 1, "Duplicate delivery execution must NOT duplicate greeting");
    });
  });

  await test("4.3 Stale worker cannot append conversation turns after lease reclaim", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const sessionRepo = new InMemoryVoiceSessionRepository();

      const session = createVoiceBookingSession("+919876543210", "en");
      await sessionRepo.save(session);

      const deliveries = createOutboxDeliveriesForTransition(session);
      const voiceDelivery = deliveries.find((d) => d.channel === "voice")!;
      await seedOutboxDeliveryForTest(outboxRepo, voiceDelivery);

      // Worker 1 claims delivery at t0 with 2-second lease
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
      assert.notStrictEqual(claimedW2.claimToken, claimContextW1.claimToken);

      // Worker 1 attempts to append turn with stale claim fencing
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

      // Verify session was NOT updated
      const sessionCheck = await sessionRepo.getById(session.id);
      assert.strictEqual(sessionCheck?.conversationHistory.length, 0);
      assert.strictEqual(sessionCheck?.revision, 1);
    });
  });

  await test("4.4 Staff approval remains separate from customer confirmation gate", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    // Customer confirms quotation
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
    assert.strictEqual(confirmed.session.staffApprovalAudit, null, "Customer confirmation must NOT populate staff approval audit");

    // Staff performs separate authenticated approval
    const authContext: StaffAuthorizationContext = {
      staffIdentity: "barista_priya_01",
      staffRole: "barista",
      staffApprovalId: "appr_staff_789",
    };

    const approvedSession = await approveBookingByStaff(confirmed.session.id, authContext, sessionRepo);

    assert.strictEqual(approvedSession.state, "booking_confirmed");
    assert.ok(approvedSession.staffApprovalAudit);
    assert.strictEqual(approvedSession.staffApprovalAudit.staffIdentity, "barista_priya_01");
    assert.strictEqual(approvedSession.staffApprovalAudit.staffRole, "barista");
  });

  console.log("\n--- 5. END-TO-END OUTBOX WORKER WITH SIMULATED CUSTOMER TURNS ---");

  await test("5.1 End-to-end answered call conducts multi-turn conversation via OutboxWorker", async () => {
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

      // Configure simulated customer conversation script isolated to this specific session ID
      voiceProvider.setSessionCustomerTurns(session.id, [
        "Hi, I want to book a coffee van for our annual tech summit.",
        "We expect 120 guests on 2026-12-15 from 10:00 for 4 hours at Hitec City.",
        "Yes, I confirm the Artisanal Signature package.",
      ]);

      await consentRepo.save({
        id: "c_e2e_voice_01",
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

      // Worker executes complete cycle: claims delivery, answers call, greets, processes all 3 customer turns
      const result = await worker.processCycle();
      assert.strictEqual(result.claimedCount, 1);
      assert.strictEqual(result.dispatchedCount, 1);

      // Verify final session state
      const completedSession = await sessionRepo.getById(session.id);
      assert.ok(completedSession);
      assert.strictEqual(completedSession.state, "awaiting_staff_approval");
      assert.strictEqual(completedSession.requirements.customerConfirmed, true);
      assert.strictEqual(completedSession.requirements.selectedTier, "STANDARD");
      assert.strictEqual(completedSession.metadata?.callAttemptStatus, "answered");

      // Verify conversation history integrity
      // 1 initial greeting + 3 * (1 user + 1 assistant) = 7 messages
      assert.strictEqual(completedSession.conversationHistory.length, 7);
      assert.strictEqual(completedSession.conversationHistory[0].role, "assistant"); // Greeting
      assert.strictEqual(completedSession.conversationHistory[1].role, "user");      // Turn 1
      assert.strictEqual(completedSession.conversationHistory[2].role, "assistant");
      assert.strictEqual(completedSession.conversationHistory[3].role, "user");      // Turn 2
      assert.strictEqual(completedSession.conversationHistory[4].role, "assistant"); // Quotation
      assert.strictEqual(completedSession.conversationHistory[5].role, "user");      // Turn 3 (Confirm)
      assert.strictEqual(completedSession.conversationHistory[6].role, "assistant"); // Awaiting staff approval message

      // Verify privacy guarantee: raw phone number must NEVER appear in conversation history
      for (const msg of completedSession.conversationHistory) {
        assert.strictEqual(msg.content.includes("+919876543210"), false, "Raw phone number must not leak into conversation messages");
      }

      // Safe public status check
      const safeStatus = extractSafeCallStatus(completedSession, await outboxRepo.getDeliveryById(voiceDelivery.id));
      assert.strictEqual(safeStatus.callAttemptStatus, "answered");
      assert.strictEqual(safeStatus.staffFollowUpRequired, false);
    });
  });

  await test("5.2 simulateVoiceConversation helper runs full conversational sequences", async () => {
    const sessionRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await sessionRepo.save(session);

    const simulation = await simulateVoiceConversation(
      session,
      [
        "Hi, I want a van for our college fest on 2026-12-25.",
        "150 guests from 11:00 for 4 hours at Jubilee Hills.",
        "Yes, I confirm the VIP Bar package.",
      ],
      { sessionRepository: sessionRepo }
    );

    assert.strictEqual(simulation.turnResults.length, 3);
    assert.strictEqual(simulation.finalSession.state, "awaiting_staff_approval");
    assert.strictEqual(simulation.finalSession.requirements.selectedTier, "PREMIUM");
    assert.strictEqual(simulation.finalSession.requirements.customerConfirmed, true);
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.3.4.3 Verification Complete: ${passed} / ${total} tests passed!`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
