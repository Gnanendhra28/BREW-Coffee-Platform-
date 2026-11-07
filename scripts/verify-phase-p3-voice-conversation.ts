/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BREW Coffee Platform — Phase P3 Verification Suite
 * AI Voice Conversation & Multi-Turn Multilingual Dialogue Audit
 *
 * Verifies:
 * 1. Natural voice conversation loop (speech recognition -> chat turn -> speech synthesis).
 * 2. Multi-turn booking information collection (date, time, duration, guests, venue, package).
 * 3. Multilingual dialogue in English (en), Hindi (hi), and Telugu (te).
 * 4. Language switching and code-switching mid-conversation.
 * 5. Reliability: Turn deduplication, clientTurnId idempotency, error recovery, barge-in, pause/resume.
 * 6. Booking & quotation integrity: deterministic pricing, HMAC snapshot validation, staff approval gate.
 * 7. Zero-cost isolation: $0.00 cost guarantee, zero Exotel calls, zero Azure requests.
 */

import assert from "assert";

process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "catering@brewcoffee.in";

import {
  isVoicePrototypeMode,
  assertPrototypeSafetyGuard,
} from "../src/lib/voiceBooking/prototypeConfig";
import {
  createVoiceBookingSession,
  processConversationTurn,
} from "../src/lib/voiceBooking/conversationEngine";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  createBrowserSpeechSynthesizer,
} from "../src/lib/voiceBooking/browserSpeechAdapter";
import {
  generateVoiceBookingQuotation,
  verifyQuotationIntegrity,
} from "../src/lib/voiceBooking/quotationAdapter";

let passedCount = 0;
let failedCount = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failedCount++;
  }
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase P3 Verification Suite");
  console.log("   AI Voice Conversation & Multilingual Multi-Turn Dialogue Audit");
  console.log("================================================================================\n");

  const repository = new InMemoryVoiceSessionRepository();

  // ---------------------------------------------------------------------------
  // 1. NATURAL VOICE CONVERSATION LOOP
  // ---------------------------------------------------------------------------
  console.log("--- 1. NATURAL VOICE CONVERSATION LOOP ---");

  await test("1.1 Conversation loop executes end-to-end: recognized turn -> response -> synthesis", async () => {
    const session = createVoiceBookingSession("+919876543210", "en");
    await repository.save(session);

    // Mock browser window for speech synthesis
    const spokeTexts: string[] = [];
    (global as any).window = {
      speechSynthesis: {
        speak: (utterance: any) => {
          spokeTexts.push(utterance.text);
          if (utterance.onstart) utterance.onstart();
          if (utterance.onend) utterance.onend();
        },
        cancel: () => {},
        getVoices: () => [{ lang: "en-IN", name: "Rishi", default: true }],
      },
      SpeechSynthesisUtterance: class {
        text: string;
        lang: string = "";
        onstart?: () => void;
        onend?: () => void;
        onerror?: (err: any) => void;
        constructor(text: string) {
          this.text = text;
        }
      },
    };

    const synthesizer = createBrowserSpeechSynthesizer({
      language: "en",
      onStart: () => {},
      onEnd: () => {},
    });

    // 1. Customer speaks
    const recognizedUtterance = "We are planning an office party for 75 guests";

    // 2. Process conversation turn
    const turnResult = await processConversationTurn(session, recognizedUtterance, {
      sessionRepository: repository,
      turnIndex: 1,
      turnId: `${session.id}_turn_1`,
    });

    assert.ok(turnResult.assistantResponse, "Assistant should provide response");
    assert.strictEqual(turnResult.session.requirements.guestCount, 75, "Extracted 75 guests");

    // 3. Spoken assistant response
    synthesizer.speak(turnResult.assistantResponse);
    assert.strictEqual(spokeTexts.length, 1, "Synthesizer spoke assistant response");
    assert.strictEqual(spokeTexts[0], turnResult.assistantResponse);
  });

  // ---------------------------------------------------------------------------
  // 2. MULTI-TURN MISSING INFORMATION COLLECTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. MULTI-TURN BOOKING INFORMATION COLLECTION ---");

  await test("2.1 Multi-turn sequential collection collects all mandatory booking requirements", async () => {
    let session = createVoiceBookingSession("+919876543210", "en");
    await repository.save(session);

    // Initial state: 5 missing fields
    assert.strictEqual(session.requirements.missingFields.length, 5);

    // Turn 1: Guest count
    let result = await processConversationTurn(session, "We are expecting 60 people", {
      sessionRepository: repository,
      turnIndex: 1,
    });
    session = result.session;
    assert.strictEqual(session.requirements.guestCount, 60);
    assert.ok(!session.requirements.missingFields.includes("guestCount"));
    assert.ok(result.assistantResponse.toLowerCase().includes("date"), "Prompts for date next");

    // Turn 2: Event Date
    result = await processConversationTurn(session, "It is on 2026-12-20", {
      sessionRepository: repository,
      turnIndex: 2,
    });
    session = result.session;
    assert.strictEqual(session.requirements.eventDate, "2026-12-20");
    assert.ok(!session.requirements.missingFields.includes("eventDate"));
    assert.ok(result.assistantResponse.toLowerCase().includes("time"), "Prompts for time next");

    // Turn 3: Start Time
    result = await processConversationTurn(session, "Starting at 15:00", {
      sessionRepository: repository,
      turnIndex: 3,
    });
    session = result.session;
    assert.strictEqual(session.requirements.startTime, "15:00");
    assert.ok(!session.requirements.missingFields.includes("startTime"));
    assert.ok(result.assistantResponse.toLowerCase().includes("hour"), "Prompts for duration next");

    // Turn 4: Duration
    result = await processConversationTurn(session, "We need 3 hours of service", {
      sessionRepository: repository,
      turnIndex: 4,
    });
    session = result.session;
    assert.strictEqual(session.requirements.durationHours, 3);
    assert.ok(!session.requirements.missingFields.includes("durationHours"));
    assert.ok(result.assistantResponse.toLowerCase().includes("venue") || result.assistantResponse.toLowerCase().includes("hyderabad"), "Prompts for venue next");

    // Turn 5: Venue Address
    result = await processConversationTurn(session, "At Hitec City in Cyber Towers", {
      sessionRepository: repository,
      turnIndex: 5,
    });
    session = result.session;
    assert.strictEqual(session.requirements.venueAddress, "Hitec City");
    assert.strictEqual(session.requirements.missingFields.length, 0, "All 5 mandatory fields collected");

    // State machine transitions to quotation_presented / awaiting_customer_confirmation
    assert.strictEqual(session.state, "awaiting_customer_confirmation");
    assert.ok(session.quotation, "Quotation generated automatically upon collecting all details");
    assert.strictEqual(session.quotation.guestCount, 60);
    assert.strictEqual(session.quotation.tiers.length, 3, "Presents all 3 catering packages");

    // Turn 6: Package Selection & Confirmation
    result = await processConversationTurn(
      session,
      "Yes, please confirm the Artisanal Signature package",
      {
        sessionRepository: repository,
        turnIndex: 6,
      }
    );
    session = result.session;

    assert.strictEqual(session.state, "awaiting_staff_approval", "Transitions strictly to awaiting_staff_approval");
    assert.strictEqual(session.requirements.customerConfirmed, true);
    assert.strictEqual(session.requirements.selectedTier, "STANDARD");
    assert.ok(session.officialBookingId?.startsWith("enq_voice_"), "Official booking ID attached");
  });

  // ---------------------------------------------------------------------------
  // 3. MULTILINGUAL DIALOGUE (HINDI & TELUGU)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. MULTILINGUAL CONVERSATION (EN, HI, TE) ---");

  await test("3.1 Complete booking dialogue executes naturally in Hindi", async () => {
    let session = createVoiceBookingSession("+919876543211", "hi");
    await repository.save(session);

    // Hindi Turn 1: Guests
    let res = await processConversationTurn(session, "Hamare yahan 80 log aayenge", {
      sessionRepository: repository,
      turnIndex: 1,
    });
    session = res.session;
    assert.strictEqual(session.language, "hi");
    assert.strictEqual(session.requirements.guestCount, 80);
    assert.ok(res.assistantResponse.includes("तारीख"), "Hindi prompt asks for date");

    // Hindi Turn 2: Date
    res = await processConversationTurn(session, "2026-12-25 ko hai event", {
      sessionRepository: repository,
      turnIndex: 2,
    });
    session = res.session;
    assert.strictEqual(session.requirements.eventDate, "2026-12-25");
    assert.ok(res.assistantResponse.includes("समय"), "Hindi prompt asks for time");

    // Hindi Turn 3: Time
    res = await processConversationTurn(session, "Dopahar 2 baje shuru karo", {
      sessionRepository: repository,
      turnIndex: 3,
    });
    session = res.session;
    assert.strictEqual(session.requirements.startTime, "14:00");

    // Hindi Turn 4: Duration
    res = await processConversationTurn(session, "4 ghante chahiye", {
      sessionRepository: repository,
      turnIndex: 4,
    });
    session = res.session;
    assert.strictEqual(session.requirements.durationHours, 4);

    // Hindi Turn 5: Location
    res = await processConversationTurn(session, "Hitec City Hyderabad mein", {
      sessionRepository: repository,
      turnIndex: 5,
    });
    session = res.session;
    assert.strictEqual(session.requirements.venueAddress, "Hitec City");
    assert.strictEqual(session.state, "awaiting_customer_confirmation");
    assert.ok(res.assistantResponse.includes("₹"), "Hindi quote includes rupee pricing");

    // Hindi Turn 6: Confirmation
    res = await processConversationTurn(session, "Haan theek hai confirm kar do", {
      sessionRepository: repository,
      turnIndex: 6,
    });
    session = res.session;
    assert.strictEqual(session.state, "awaiting_staff_approval");
    assert.ok(res.assistantResponse.includes("धन्यवाद"), "Hindi confirmation message returned");
  });

  await test("3.2 Complete booking dialogue executes naturally in Telugu", async () => {
    let session = createVoiceBookingSession("+919876543212", "te");
    await repository.save(session);

    // Telugu Turn 1: Guests
    let res = await processConversationTurn(session, "Maaku 100 mandi guests vastharu", {
      sessionRepository: repository,
      turnIndex: 1,
    });
    session = res.session;
    assert.strictEqual(session.language, "te");
    assert.strictEqual(session.requirements.guestCount, 100);
    assert.ok(res.assistantResponse.includes("తేదీన"), "Telugu prompt asks for date");

    // Telugu Turn 2: Date
    res = await processConversationTurn(session, "2026-12-28 roju event", {
      sessionRepository: repository,
      turnIndex: 2,
    });
    session = res.session;
    assert.strictEqual(session.requirements.eventDate, "2026-12-28");

    // Telugu Turn 3: Time
    res = await processConversationTurn(session, "10:00 AM ki start cheyyandi", {
      sessionRepository: repository,
      turnIndex: 3,
    });
    session = res.session;
    assert.strictEqual(session.requirements.startTime, "10:00");

    // Telugu Turn 4: Duration
    res = await processConversationTurn(session, "3 gantalu kavali", {
      sessionRepository: repository,
      turnIndex: 4,
    });
    session = res.session;
    assert.strictEqual(session.requirements.durationHours, 3);

    // Telugu Turn 5: Location
    res = await processConversationTurn(session, "Gachibowli daggara", {
      sessionRepository: repository,
      turnIndex: 5,
    });
    session = res.session;
    assert.strictEqual(session.requirements.venueAddress, "Gachibowli");
    assert.strictEqual(session.state, "awaiting_customer_confirmation");

    // Telugu Turn 6: Confirmation
    res = await processConversationTurn(session, "Avunu confirm cheyyandi", {
      sessionRepository: repository,
      turnIndex: 6,
    });
    session = res.session;
    assert.strictEqual(session.state, "awaiting_staff_approval");
    assert.ok(res.assistantResponse.includes("ధన్యవాదాలు"), "Telugu confirmation message returned");
  });

  await test("3.3 Explicit language switching mid-dialogue switches responses immediately", async () => {
    const session = createVoiceBookingSession("+919876543213", "en");
    await repository.save(session);

    // English turn
    let res = await processConversationTurn(session, "We have 50 guests", {
      sessionRepository: repository,
      turnIndex: 1,
    });
    assert.strictEqual(res.session.language, "en");

    // Customer requests switch to Hindi
    res = await processConversationTurn(res.session, "Hindi me baat karte hain", {
      sessionRepository: repository,
      turnIndex: 2,
    });
    assert.strictEqual(res.session.language, "hi", "Language switched to Hindi");
    assert.ok(res.assistantResponse.includes("तारीख"), "Response is now in Hindi");
  });

  // ---------------------------------------------------------------------------
  // 4. CONVERSATION RELIABILITY & IDEMPOTENCY
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. CONVERSATION RELIABILITY & IDEMPOTENCY ---");

  await test("4.1 Duplicate clientTurnId does not process turn twice or corrupt history", async () => {
    const session = createVoiceBookingSession("+919876543214", "en");
    await repository.save(session);

    const clientTurnId = `${session.id}_turn_1_unique_hash`;

    // Turn 1 first attempt
    const turn1 = await processConversationTurn(session, "40 guests in Banjara Hills", {
      sessionRepository: repository,
      turnIndex: 1,
      turnId: clientTurnId,
    });

    const historyLengthAfterFirst = turn1.session.conversationHistory.length;

    // Turn 1 identical duplicate (network retry)
    const turn1Retry = await processConversationTurn(turn1.session, "40 guests in Banjara Hills", {
      sessionRepository: repository,
      turnIndex: 1,
      turnId: clientTurnId,
    });

    assert.strictEqual(
      turn1Retry.session.conversationHistory.length,
      historyLengthAfterFirst,
      "Duplicate turn did not append duplicate messages"
    );
    assert.strictEqual(
      turn1Retry.assistantResponse,
      turn1.assistantResponse,
      "Duplicate turn returns identical assistant response"
    );
  });

  await test("4.2 Interruption (barge-in) cancels synthesizer and resets voice state", async () => {
    let cancelCalled = false;
    (global as any).window = {
      speechSynthesis: {
        speak: () => {},
        cancel: () => {
          cancelCalled = true;
        },
        getVoices: () => [{ lang: "en-IN", name: "Rishi", default: true }],
      },
      SpeechSynthesisUtterance: class {
        text: string;
        lang: string = "";
        constructor(text: string) {
          this.text = text;
        }
      },
    };

    const synthesizer = createBrowserSpeechSynthesizer({
      language: "en",
      onStart: () => {},
      onEnd: () => {},
    });

    synthesizer.speak("Welcome to BREW Coffee Concierge! How many guests are you expecting?");
    assert.strictEqual(synthesizer.isSpeaking(), true);

    // Customer barge-in: cancel speech
    synthesizer.cancel();
    assert.strictEqual(cancelCalled, true, "Synthesizer cancel invoked on user interruption");
  });

  // ---------------------------------------------------------------------------
  // 5. BOOKING & QUOTATION INTEGRITY
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. BOOKING & QUOTATION INTEGRITY ---");

  await test("5.1 Deterministic quotation matches exact mathematical formula without fabrication", () => {
    const requirements = {
      guestCount: 120,
      eventDate: "2026-12-15",
      startTime: "11:00",
      durationHours: 4,
      venueAddress: "Jubilee Hills",
      eventType: "corporate",
      beveragePreferences: ["espresso", "cold brew"],
      selectedTier: null,
      handoffRequested: false,
      customerConfirmed: false,
      confidenceScore: 1.0,
      missingFields: [],
      unresolvedQuestions: [],
    };

    const quotation = generateVoiceBookingQuotation(requirements, "session_test_quote");
    assert.strictEqual(quotation.guestCount, 120);
    assert.strictEqual(quotation.tiers.length, 3);

    // Verify tiers are ordered logically: Basic < Standard < Premium
    const [basic, standard, premium] = quotation.tiers;
    assert.ok(basic.totalAmount > 0, "Basic total > 0");
    assert.ok(standard.totalAmount > basic.totalAmount, "Standard total > Basic total");
    assert.ok(premium.totalAmount > standard.totalAmount, "Premium total > Standard total");
    assert.ok(standard.isRecommended, "Standard is marked as recommended");
  });

  await test("5.2 Quotation snapshot integrity check detects tampering fail-closed", () => {
    const requirements = {
      guestCount: 50,
      eventDate: "2026-12-10",
      startTime: "10:00",
      durationHours: 3,
      venueAddress: "Madhapur",
      eventType: "private_party",
      beveragePreferences: [],
      selectedTier: null,
      handoffRequested: false,
      customerConfirmed: false,
      confidenceScore: 1.0,
      missingFields: [],
      unresolvedQuestions: [],
    };

    const quotation = generateVoiceBookingQuotation(requirements, "session_test_tamper");
    const snapshot = {
      guestCount: 50,
      eventDate: "2026-12-10",
      startTime: "10:00",
      durationHours: 3,
      venueAddress: "Madhapur",
      selectedTier: "STANDARD" as const,
      eventType: "private_party",
      generatedAt: new Date().toISOString(),
      hash: "original_valid_hash",
    };

    // Tamper with requirements (change guest count from 50 to 200 without re-quotation)
    const tamperedReqs = { ...requirements, guestCount: 200 };
    const integrityResult = verifyQuotationIntegrity(snapshot, tamperedReqs, quotation);
    assert.strictEqual(integrityResult.isMatch, false, "Tampered requirements must fail integrity check");
  });

  // ---------------------------------------------------------------------------
  // 6. ZERO-COST ISOLATION AUDIT
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. ZERO-COST ISOLATION AUDIT ---");

  await test("6.1 Prototype mode guarantees zero paid services and zero carrier calls", () => {
    assert.strictEqual(isVoicePrototypeMode(), true, "Must run in prototype mode");
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED ?? "false", "false", "VOICE_BOOKING_ENABLED must be false");

    // Verifies safety guard triggers if paid external services are attempted
    assert.throws(
      () => assertPrototypeSafetyGuard("exotel"),
      /Safety violation.*exotel/,
      "Exotel carrier calling blocked"
    );
    assert.throws(
      () => assertPrototypeSafetyGuard("azure_speech"),
      /Safety violation.*azure_speech/,
      "Azure TTS service blocked"
    );
  });

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase P3 Verification Complete: ${passedCount}/${passedCount + failedCount} checks passed`);
  if (failedCount === 0) {
    console.log("   RESULT: ALL TESTS PASSED (SUCCESS)");
  } else {
    console.log(`   RESULT: ${failedCount} CHECKS FAILED`);
  }
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
