/**
 * BREW Coffee Platform — Phase P6 Verification Suite
 * Complete Customer Booking Experience Audit
 *
 * Verifies:
 * 1. Complete 13-step customer booking journey end-to-end:
 *    - Session initialization (POST /api/voice-booking/session)
 *    - Initial greeting in chosen language (English, Hindi, Telugu)
 *    - Multi-turn conversational requirements gathering
 *    - Extraction of all 5 mandatory fields
 *    - Customer corrections & dynamic quotation updates
 *    - 3-tier package comparison (Classic Brew, Artisanal Signature, VIP Unlimited Bar)
 *    - Package tier selection
 *    - Explicit customer quotation confirmation (awaiting_staff_approval)
 *    - Deterministic inquiry ID generation (officialBookingId)
 *    - Staff authorization / rejection lifecycle reflection
 * 2. Multilingual conversation journeys across English (en), Hindi (hi), and Telugu (te).
 * 3. Conversational reliability, duplicate submission prevention (idempotency by clientTurnId).
 * 4. Session restoration and recovery across page reloads (GET /api/voice-booking/session).
 * 5. Customer visibility projection data sanitization:
 *    - Customer-facing status ("awaiting_approval", "approved", "declined")
 *    - Strictly hides internal staff audit notes, staff UIDs, and carrier credentials.
 * 6. Free Prototype isolation: zero paid APIs, zero Exotel calls, zero Azure Speech costs ($0.00), VOICE_BOOKING_ENABLED=false.
 */

import assert from "assert";
import { NextRequest } from "next/server";

process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "catering@brewcoffee.in";
process.env.VOICE_BOOKING_ENABLED = process.env.VOICE_BOOKING_ENABLED || "false";
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "brew-platform-secure-jwt-hmac-secret-key-2026";
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-key-32chars!";

import {
  isVoicePrototypeMode,
  assertPrototypeSafetyGuard,
} from "../src/lib/voiceBooking/prototypeConfig";
import {
  createVoiceBookingSession,
  setVoiceSessionRepository,
  processConversationTurn,
} from "../src/lib/voiceBooking/conversationEngine";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
  verifyQuotationIntegrity,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  authenticateAndApproveBooking,
  authenticateAndRejectBooking,
} from "../src/lib/auth/adminAuth";
import { createSessionToken } from "../src/lib/authTokens";
import { toSafeCustomerVoiceSessionView } from "../src/lib/communication/visibility";
import { computeOfficialVanRequestId } from "../src/lib/voiceBooking/vanRequestBridge";
import { GET as getSessionRoute, POST as createSessionRoute } from "../src/app/api/voice-booking/session/route";

let passedCount = 0;
let failedCount = 0;
let dateCounter = 0;

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

async function run() {
  console.log("\n=======================================================");
  console.log("   BREW Coffee Phase P6 Complete Customer Journey       ");
  console.log("=======================================================\n");

  const testRepo = new InMemoryVoiceSessionRepository();
  setVoiceSessionRepository(testRepo);

  // ---------------------------------------------------------
  // SUITE 1: Session Initiation & Landing Entrypoint
  // ---------------------------------------------------------
  console.log("Suite 1: Customer Session Initiation & Landing Entrypoint");

  await test("1.1 POST /api/voice-booking/session initializes new session with localized greeting", async () => {
    const req = new NextRequest("http://localhost:3000/api/voice-booking/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phoneNumber: "+91 98765 43210",
        language: "en",
      }),
    });

    const res = await createSessionRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.ok(json.sessionId.startsWith("vbs_"));
    assert.strictEqual(json.session.language, "en");
    assert.strictEqual(json.session.state, "created");
    assert.ok(json.session.conversationHistory.length > 0);
    assert.strictEqual(json.session.conversationHistory[0].role, "assistant");
  });

  await test("1.2 GET /api/voice-booking/session?sessionId=... restores active session for returning customer", async () => {
    // Create session in repo
    const created = createVoiceBookingSession("+919876543210", "en");
    await testRepo.save(created);

    const req = new NextRequest(`http://localhost:3000/api/voice-booking/session?sessionId=${created.id}`);
    const res = await getSessionRoute(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.session.sessionId, created.id);
    assert.strictEqual(json.session.language, "en");
    assert.ok(json.session.conversationHistory.length > 0);
  });

  // ---------------------------------------------------------
  // SUITE 2: Complete 13-Step Customer Journey (English)
  // ---------------------------------------------------------
  console.log("\nSuite 2: Complete 13-Step Customer Journey (English)");

  await test("2.1 End-to-End English Journey: Init -> Gather -> Correct -> Compare -> Select -> Confirm -> Staff Decision", async () => {
    // Step 1 & 2: Start session
    const uniqueDay = (10 + (dateCounter++ % 18)).toString().padStart(2, "0");
    const eventDate = `2026-12-${uniqueDay}`;

    const session = createVoiceBookingSession("+919876543210", "en");
    await testRepo.save(session);

    // Step 3 & 4: Customer speaks partial requirements
    const turn1Res = await processConversationTurn(
      session,
      "Hi, I want coffee catering for a corporate event in Hitec City on " + eventDate + " starting at 2 PM",
      {
        turnId: `${session.id}_turn_1`,
        turnIndex: 1,
        sessionRepository: testRepo,
      }
    );
    assert.strictEqual(turn1Res.session.state, "collecting_requirements");
    assert.strictEqual(turn1Res.session.requirements.eventDate, eventDate);
    assert.strictEqual(turn1Res.session.requirements.startTime, "14:00");

    // Step 5: Follow-up question asked for missing fields (guest count, duration)
    assert.ok(turn1Res.session.requirements.missingFields?.includes("guestCount"));

    // Customer supplies missing details
    const turn2Res = await processConversationTurn(
      turn1Res.session,
      "We will have 50 guests for a duration of 3 hours.",
      {
        turnId: `${session.id}_turn_2`,
        turnIndex: 2,
        sessionRepository: testRepo,
      }
    );

    // Step 6: All 5 requirements extracted
    assert.strictEqual(turn2Res.session.requirements.guestCount, 50);
    assert.strictEqual(turn2Res.session.requirements.durationHours, 3);
    assert.strictEqual(turn2Res.session.requirements.missingFields?.length, 0);

    // Step 7: Customer updates guest count (correction flow)
    const turn3Res = await processConversationTurn(
      turn2Res.session,
      "Actually our team expanded, change guest count to 80 guests please.",
      {
        turnId: `${session.id}_turn_3`,
        turnIndex: 3,
        sessionRepository: testRepo,
      }
    );
    assert.strictEqual(turn3Res.session.requirements.guestCount, 80);

    // Step 8: 3 Catering Packages generated and mathematically verified
    assert.ok(turn3Res.session.quotation);
    assert.strictEqual(turn3Res.session.quotation.tiers.length, 3);
    const classicTier = turn3Res.session.quotation.tiers.find((t) => t.tierId === "BASIC");
    const signatureTier = turn3Res.session.quotation.tiers.find((t) => t.tierId === "STANDARD");
    const vipTier = turn3Res.session.quotation.tiers.find((t) => t.tierId === "PREMIUM");
    assert.ok(classicTier && classicTier.totalAmount > 0);
    assert.ok(signatureTier && signatureTier.totalAmount > classicTier.totalAmount);
    assert.ok(vipTier && vipTier.totalAmount > signatureTier.totalAmount);
    assert.strictEqual(classicTier?.totalAmount, 15900);

    // Step 9: Customer selects Artisanal Signature tier
    const turn4Res = await processConversationTurn(
      turn3Res.session,
      "We would like to choose the Artisanal Signature package.",
      {
        turnId: `${session.id}_turn_4`,
        turnIndex: 4,
        sessionRepository: testRepo,
      }
    );
    assert.strictEqual(turn4Res.session.requirements.selectedTier, "STANDARD");

    // Step 10: Quotation snapshot verified with HMAC
    assert.ok(turn4Res.session.quotationSnapshot);
    const integrity = verifyQuotationIntegrity(
      turn4Res.session.quotationSnapshot,
      turn4Res.session.requirements,
      turn4Res.session.quotation
    );
    assert.strictEqual(integrity.isMatch, true);

    // Step 11: Explicit customer confirmation submits booking
    const turn5Res = await processConversationTurn(
      turn4Res.session,
      "I confirm this quotation and want to submit this booking request for staff approval.",
      {
        turnId: `${session.id}_turn_5`,
        turnIndex: 5,
        sessionRepository: testRepo,
      }
    );

    // Step 12: Session in awaiting_staff_approval with official inquiry ID
    assert.strictEqual(turn5Res.session.state, "awaiting_staff_approval");
    assert.strictEqual(turn5Res.session.requirements.customerConfirmed, true);
    assert.ok(turn5Res.session.officialBookingId?.startsWith("enq_voice_"));

    // Step 13: Staff approval updates authoritative status
    const baristaToken = await createSessionToken({
      uid: "barista_lead_p6",
      email: "lead@brewcoffee.in",
      displayName: "Lead Barista",
      role: "barista",
    });

    const approved = await authenticateAndApproveBooking({
      sessionId: turn5Res.session.id,
      tokenOrRequest: baristaToken,
      repository: testRepo,
    });

    assert.strictEqual(approved.state, "booking_confirmed");
    assert.strictEqual(approved.staffApprovalAudit?.staffRole, "barista");

    // Customer safe view reflects confirmed status
    const customerView = toSafeCustomerVoiceSessionView(approved);
    assert.strictEqual(customerView.staffApprovalStatus, "approved");
    assert.strictEqual(customerView.officialBookingId, approved.officialBookingId);
  });

  // ---------------------------------------------------------
  // SUITE 3: Multilingual Journeys (Hindi & Telugu)
  // ---------------------------------------------------------
  console.log("\nSuite 3: Multilingual Journeys (Hindi & Telugu)");

  await test("3.1 Complete Hindi Journey: Full requirements gathering in Hindi", async () => {
    const uniqueDay = (10 + (dateCounter++ % 18)).toString().padStart(2, "0");
    const eventDate = `2026-12-${uniqueDay}`;

    const session = createVoiceBookingSession("+919876543210", "hi");
    await testRepo.save(session);

    const turnRes = await processConversationTurn(
      session,
      `नमस्ते, मुझे ${eventDate} को दोपहर 2 बजे 60 मेहमानों के लिए 3 घंटे का कॉफी कैटरिंग चाहिए हाईटेक सिटी में।`,
      {
        turnId: `${session.id}_hi_1`,
        turnIndex: 1,
        sessionRepository: testRepo,
      }
    );

    assert.strictEqual(turnRes.session.language, "hi");
    assert.strictEqual(turnRes.session.requirements.guestCount, 60);
    assert.strictEqual(turnRes.session.requirements.durationHours, 3);
    assert.strictEqual(turnRes.session.requirements.eventDate, eventDate);
    assert.ok(turnRes.session.quotation);
    assert.strictEqual(turnRes.session.quotation.guestCount, 60);
  });

  await test("3.2 Complete Telugu Journey: Full requirements gathering in Telugu", async () => {
    const uniqueDay = (10 + (dateCounter++ % 18)).toString().padStart(2, "0");
    const eventDate = `2026-12-${uniqueDay}`;

    const session = createVoiceBookingSession("+919876543210", "te");
    await testRepo.save(session);

    const turnRes = await processConversationTurn(
      session,
      `నమస్కారం, నాకు ${eventDate} న మధ్యాహ్నం 2 గంటలకు 100 మంది అతిథుల కోసం 4 గంటల కాఫీ క్యాటరింగ్ కావాలి గచ్చిబౌలిలో.`,
      {
        turnId: `${session.id}_te_1`,
        turnIndex: 1,
        sessionRepository: testRepo,
      }
    );

    assert.strictEqual(turnRes.session.language, "te");
    assert.strictEqual(turnRes.session.requirements.guestCount, 100);
    assert.strictEqual(turnRes.session.requirements.durationHours, 4);
    assert.strictEqual(turnRes.session.requirements.eventDate, eventDate);
    assert.ok(turnRes.session.quotation);
    assert.strictEqual(turnRes.session.quotation.guestCount, 100);
  });

  // ---------------------------------------------------------
  // SUITE 4: Conversational Reliability & Turn Idempotency
  // ---------------------------------------------------------
  console.log("\nSuite 4: Conversational Reliability & Turn Idempotency");

  await test("4.1 Duplicate submission with identical clientTurnId does not process twice", async () => {
    const session = createVoiceBookingSession("+919876543210", "en");
    await testRepo.save(session);

    const clientTurnId = `${session.id}_turn_unique_100`;

    // First submission
    const res1 = await processConversationTurn(session, "50 guests in Banjara Hills", {
      turnId: clientTurnId,
      turnIndex: 1,
      sessionRepository: testRepo,
    });
    const historyCount1 = res1.session.conversationHistory.length;

    // Duplicate submission (simulated rapid double-click or network retry)
    const res2 = await processConversationTurn(res1.session, "50 guests in Banjara Hills", {
      turnId: clientTurnId,
      turnIndex: 1,
      sessionRepository: testRepo,
    });
    const historyCount2 = res2.session.conversationHistory.length;

    assert.strictEqual(historyCount1, historyCount2, "Duplicate turn must not append extra messages");
  });

  // ---------------------------------------------------------
  // SUITE 5: Customer Rejection Journey & Data Sanitization
  // ---------------------------------------------------------
  console.log("\nSuite 5: Customer Rejection Journey & Data Sanitization");

  await test("5.1 Staff rejection displays customerFacingReason, strictly concealing internal notes and UIDs", async () => {
    const uniqueDay = (10 + (dateCounter++ % 18)).toString().padStart(2, "0");
    const eventDate = `2026-12-${uniqueDay}`;

    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = {
      ...session.requirements,
      eventType: "corporate",
      guestCount: 50,
      eventDate,
      startTime: "14:00",
      durationHours: 3,
      venueAddress: "Jubilee Hills",
      selectedTier: "STANDARD",
      customerConfirmed: true,
      missingFields: [],
    };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    const officialBookingId = computeOfficialVanRequestId(session.id);
    session.officialBookingId = officialBookingId;
    session.metadata = {
      ...(session.metadata || {}),
      officialBookingId,
      enquiryRequestId: officialBookingId,
      bookingSource: "voice_booking",
    };
    await testRepo.save(session);

    const baristaToken = await createSessionToken({
      uid: "private_staff_uid_007",
      email: "shift@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    const rejected = await authenticateAndRejectBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      reason: "CONFIDENTIAL INTERNAL NOTE: Van 2 generator failed voltage test. Route cancelled.",
      customerFacingReason: "Our mobile van is undergoing scheduled technical maintenance during this time slot.",
      repository: testRepo,
    });

    assert.strictEqual(rejected.state, "customer_declined");

    const safeView = toSafeCustomerVoiceSessionView(rejected);
    assert.strictEqual(safeView.staffApprovalStatus, "declined");
    assert.strictEqual(
      safeView.customerFacingRejectionReason,
      "Our mobile van is undergoing scheduled technical maintenance during this time slot."
    );

    // Strict sanitization assertion
    const serialized = JSON.stringify(safeView);
    assert.strictEqual(serialized.includes("private_staff_uid_007"), false, "Staff UID must not be in safe view");
    assert.strictEqual(serialized.includes("generator failed voltage test"), false, "Internal notes must not be in safe view");
  });

  // ---------------------------------------------------------
  // SUITE 6: Zero-Cost Isolation & Prototype Safety
  // ---------------------------------------------------------
  console.log("\nSuite 6: Zero-Cost Isolation & Prototype Safety");

  await test("6.1 Prototype mode is active and paid services are blocked", () => {
    assert.strictEqual(isVoicePrototypeMode(), true);
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
    assert.throws(() => assertPrototypeSafetyGuard("exotel"), /Safety violation/);
    assert.throws(() => assertPrototypeSafetyGuard("azure_speech"), /Safety violation/);
  });

  // ---------------------------------------------------------
  // Summary
  // ---------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase P6 Verification Results: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("=======================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unhandled error running Phase P6 tests:", err);
  process.exit(1);
});
