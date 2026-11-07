/**
 * BREW Coffee Platform — Phase P1 Verification Suite
 * Free Voice Prototype Foundation & Zero-Cost Isolation Audit
 *
 * Verifies:
 * 1. Prototype configuration mode & zero-cost safety guards.
 * 2. Browser speech adapter contracts & locale mappings (en-IN, hi-IN, te-IN).
 * 3. Graceful capability detection in non-browser/SSR environments.
 * 4. Full preservation of conversation engine, deterministic quotation, and HMAC integrity.
 * 5. Full preservation of staff approval RBAC and quotation verification.
 * 6. Strict isolation of Exotel and Azure Speech services ($0.00 cost guarantee).
 */

import assert from "assert";

// Ensure required environment variables for booking bridge are present in test
process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "catering@brewcoffee.in";

import {
  isVoicePrototypeMode,
  getVoiceOperatingMode,
  getVoicePrototypeConfig,
  assertPrototypeSafetyGuard,
} from "../src/lib/voiceBooking/prototypeConfig";
import {
  detectBrowserSpeechCapabilities,
  checkMicrophonePermission,
  BROWSER_SPEECH_LANGUAGES,
} from "../src/lib/voiceBooking/browserSpeechAdapter";
import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
} from "../src/lib/voiceBooking/conversationEngine";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  createQuotationSnapshot,
  verifyQuotationIntegrity,
  generateVoiceBookingQuotation,
} from "../src/lib/voiceBooking/quotationAdapter";
import { computeOfficialVanRequestId } from "../src/lib/voiceBooking/vanRequestBridge";
import { isVoiceBookingEnabled } from "../src/lib/communication/config";
import { MockVoiceProvider } from "../src/lib/communication/providers/voiceProvider";

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
  console.log("   BREW Coffee Platform — Phase P1 Verification Suite");
  console.log("   Free Voice Prototype Foundation & Zero-Cost Isolation Audit");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. PROTOTYPE CONFIGURATION & ZERO-COST SAFETY GUARDS
  // ---------------------------------------------------------------------------
  console.log("--- 1. PROTOTYPE CONFIGURATION & SAFETY GUARDS ---");

  test("1.1 Default operating mode is prototype when real dialing is disabled", () => {
    assert.strictEqual(isVoiceBookingEnabled(), false, "VOICE_BOOKING_ENABLED must remain false");
    assert.strictEqual(isVoicePrototypeMode(), true, "Must default to prototype mode");
    assert.strictEqual(getVoiceOperatingMode(), "prototype");

    const config = getVoicePrototypeConfig();
    assert.strictEqual(config.isPrototype, true);
    assert.strictEqual(config.externalCarrierCallsDisabled, true);
    assert.strictEqual(config.externalAzureSpeechDisabled, true);
    assert.strictEqual(config.zeroCostGuaranteed, true);
  });

  test("1.2 Prototype safety guard throws on paid service invocation", () => {
    let threwExotel = false;
    try {
      assertPrototypeSafetyGuard("exotel");
    } catch (err: unknown) {
      threwExotel = true;
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("zero-cost Prototype Mode"));
      assert.ok(err.message.includes("exotel"));
    }
    assert.strictEqual(threwExotel, true, "Must prevent Exotel calls in prototype mode");

    let threwAzure = false;
    try {
      assertPrototypeSafetyGuard("azure_speech");
    } catch (err: unknown) {
      threwAzure = true;
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("azure_speech"));
    }
    assert.strictEqual(threwAzure, true, "Must prevent Azure Speech calls in prototype mode");
  });

  test("1.3 MockVoiceProvider operates as zero-cost simulator without external APIs", async () => {
    const mockProvider = new MockVoiceProvider();
    assert.strictEqual(mockProvider.isSimulated, true);
    assert.strictEqual(mockProvider.providerName, "mock-voice-provider");

    const sessionRes = await mockProvider.startSession({
      sessionId: "vbs_proto_test_01",
      phoneNumber: "+919876543210",
      language: "en",
    });

    assert.strictEqual(sessionRes.status, "simulated_initiated");
    assert.ok(sessionRes.providerCallId.startsWith("mock_call_"));
  });

  // ---------------------------------------------------------------------------
  // 2. BROWSER SPEECH ADAPTER & MULTILINGUAL CONFIGURATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. BROWSER SPEECH ADAPTER & MULTILINGUAL LOCALES ---");

  test("2.1 Supported languages configure valid locales for STT and TTS", () => {
    // English (India)
    assert.strictEqual(BROWSER_SPEECH_LANGUAGES.en.sttLocale, "en-IN");
    assert.ok(BROWSER_SPEECH_LANGUAGES.en.ttsLocales.includes("en-IN"));

    // Hindi (India)
    assert.strictEqual(BROWSER_SPEECH_LANGUAGES.hi.sttLocale, "hi-IN");
    assert.ok(BROWSER_SPEECH_LANGUAGES.hi.ttsLocales.includes("hi-IN"));

    // Telugu (India)
    assert.strictEqual(BROWSER_SPEECH_LANGUAGES.te.sttLocale, "te-IN");
    assert.ok(BROWSER_SPEECH_LANGUAGES.te.ttsLocales.includes("te-IN"));
  });

  test("2.2 detectBrowserSpeechCapabilities executes safely in non-browser context", () => {
    const capabilities = detectBrowserSpeechCapabilities();
    assert.strictEqual(capabilities.hasSpeechRecognition, false);
    assert.strictEqual(capabilities.hasSpeechSynthesis, false);
    assert.strictEqual(capabilities.browserFamily, "unknown");
    assert.ok(capabilities.notes.length > 0);
  });

  await test("2.3 checkMicrophonePermission handles non-browser context safely", async () => {
    const permState = await checkMicrophonePermission();
    assert.strictEqual(permState, "unsupported");
  });

  // ---------------------------------------------------------------------------
  // 3. CONVERSATION ENGINE & DETERMINISTIC QUOTATION PRESERVATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. CONVERSATION ENGINE & DETERMINISTIC QUOTATION ---");

  await test("3.1 Full multi-turn booking conversation flow runs on prototype engine", async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await repo.save(session);

    // Turn 1: Customer specifies guest count and location
    const turn1 = await processConversationTurn(
      session,
      "We need coffee catering for 50 guests in Hitec City on 2026-11-20 at 10:00 for 3 hours with standard package",
      { sessionRepository: repo }
    );

    assert.strictEqual(turn1.session.requirements.guestCount, 50);
    assert.strictEqual(turn1.session.requirements.venueAddress, "Hitec City");
    assert.strictEqual(turn1.session.requirements.eventDate, "2026-11-20");
    assert.strictEqual(turn1.session.requirements.startTime, "10:00");
    assert.strictEqual(turn1.session.requirements.durationHours, 3);
    assert.strictEqual(turn1.session.requirements.selectedTier, "STANDARD");

    // Must have generated deterministic quotation
    assert.ok(turn1.session.quotation !== null, "Quotation must be generated");
    assert.ok(turn1.session.quotationSnapshot !== null, "Quotation snapshot must be generated");
    assert.ok(turn1.session.quotationSnapshot.hash.length > 0, "Quotation HMAC hash must be generated");

    // Turn 2: Customer gives explicit confirmation
    const turn2 = await processConversationTurn(
      turn1.session,
      "Yes, please proceed and confirm this booking",
      { sessionRepository: repo }
    );

    assert.strictEqual(turn2.session.state, "awaiting_staff_approval");
    assert.strictEqual(turn2.session.requirements.customerConfirmed, true);
  });

  test("3.2 Deterministic quotation engine produces consistent, non-fabricated quotes", () => {
    const requirements = {
      guestCount: 100,
      eventDate: "2026-12-01",
      startTime: "14:00",
      durationHours: 4,
      venueAddress: "Gachibowli, Hyderabad",
      selectedTier: "PREMIUM" as const,
      eventType: "corporate",
      beveragePreferences: [],
      handoffRequested: false,
      customerConfirmed: false,
      confidenceScore: 1,
      missingFields: [],
      unresolvedQuestions: [],
      corrections: [],
    };

    const quote1 = generateVoiceBookingQuotation(requirements);
    const quote2 = generateVoiceBookingQuotation(requirements);

    assert.ok(quote1 !== null);
    assert.ok(quote2 !== null);
    assert.strictEqual(quote1.selectedTier?.totalAmount, quote2.selectedTier?.totalAmount);
    assert.strictEqual(quote1.selectedTier?.tierId, "PREMIUM");
    assert.ok((quote1.selectedTier?.totalAmount ?? 0) > 0);
  });

  test("3.3 Quotation HMAC snapshot integrity detects tampering fail-closed", () => {
    const requirements = {
      guestCount: 50,
      eventDate: "2026-11-25",
      startTime: "09:00",
      durationHours: 3,
      venueAddress: "Madhapur, Hyderabad",
      selectedTier: "STANDARD" as const,
      eventType: "corporate",
      beveragePreferences: [],
      handoffRequested: false,
      customerConfirmed: false,
      confidenceScore: 1,
      missingFields: [],
      unresolvedQuestions: [],
      corrections: [],
    };

    const snapshot = createQuotationSnapshot(requirements);
    const quote = generateVoiceBookingQuotation(requirements);

    // Valid check passes
    const valid = verifyQuotationIntegrity(snapshot, requirements, quote);
    assert.strictEqual(valid.isMatch, true);

    // Tampered check (e.g. guest count changed from 50 to 150) fails closed
    const tamperedRequirements = { ...requirements, guestCount: 150 };
    const invalid = verifyQuotationIntegrity(snapshot, tamperedRequirements, quote);
    assert.strictEqual(invalid.isMatch, false);
    assert.ok(invalid.mismatchedFields.includes("guestCount"));
  });

  // ---------------------------------------------------------------------------
  // 4. STAFF APPROVAL WORKFLOW PRESERVATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. STAFF APPROVAL WORKFLOW PRESERVATION ---");

  await test("4.1 Staff approval is strictly required before booking confirmation", async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");

    // Fast-forward session to awaiting_staff_approval
    session.state = "awaiting_staff_approval";
    const officialId = computeOfficialVanRequestId(session.id);
    session.officialBookingId = officialId;
    if (!session.metadata) session.metadata = {};
    session.metadata.officialBookingId = officialId;
    session.metadata.bookingSource = "voice_booking";
    session.requirements.guestCount = 75;
    session.requirements.venueAddress = "Jubilee Hills";
    session.requirements.selectedTier = "PREMIUM";
    session.requirements.eventDate = "2026-11-28";
    session.requirements.startTime = "11:00";
    session.requirements.durationHours = 4;
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);

    await repo.save(session);

    // Unauthenticated approval is rejected
    let threwUnauth = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await approveBookingByStaff(session.id, null as any, repo);
    } catch (err: unknown) {
      threwUnauth = true;
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("missing StaffAuthorizationContext"));
    }
    assert.strictEqual(threwUnauth, true, "Must reject unauthenticated approval");

    // Customer role is rejected
    let threwCustomer = false;
    try {
      await approveBookingByStaff(
        session.id,
        {
          staffIdentity: "cust_01",
          staffRole: "customer" as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          staffApprovalId: "appr_fake",
        },
        repo
      );
    } catch (err: unknown) {
      threwCustomer = true;
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("not permitted to approve catering bookings"));
    }
    assert.strictEqual(threwCustomer, true, "Must reject customer role");

    // Authorized staff approval succeeds
    const approved = await approveBookingByStaff(
      session.id,
      {
        staffIdentity: "barista_ravi",
        staffRole: "barista",
        staffApprovalId: "appr_p1_test_01",
      },
      repo
    );

    assert.strictEqual(approved.state, "booking_confirmed");
    assert.strictEqual(approved.staffApprovalId, "appr_p1_test_01");
    assert.ok(approved.officialBookingId?.startsWith("enq_voice_"));
    assert.strictEqual(approved.staffApprovalAudit?.staffIdentity, "barista_ravi");
  });

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase P1 Verification Complete: ${passedCount}/${passedCount + failedCount} checks passed`);
  console.log(`   RESULT: ${failedCount === 0 ? "ALL TESTS PASSED (SUCCESS)" : "TESTS FAILED"}`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner threw unhandled error:", err);
  process.exit(1);
});
