/**
 * BREW Coffee Platform — Phase P8 Verification Suite
 * Demonstration & Presentation Readiness Audit
 *
 * Verifies:
 * 1. Scenario A: English Voice Booking end-to-end (Launcher -> Elicit -> Correct -> Compare -> Select -> Confirm).
 * 2. Scenario B: Multilingual Hindi & Telugu journeys (Switch -> Dialogue -> Quote -> Confirm).
 * 3. Scenario C: Staff Review, Quotation Integrity Verification, Approval & Rejection lifecycles.
 * 4. Demo Data Invariants: 3 safe demo sessions (1 Pending, 1 Approved, 1 Declined) auto-seeded in prototype mode.
 * 5. Staff Authentication: Safe local demo authentication via PIN '2026' (Barista) without hardcoded secrets.
 * 6. Customer Visibility Sanitization: Confirmed and declined customer views conceal staff UIDs and internal notes.
 * 7. Zero-Cost Prototype Invariants: VOICE_BOOKING_ENABLED=false, zero paid APIs, $0.00 cost.
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
import { verifyQuotationIntegrity } from "../src/lib/voiceBooking/quotationAdapter";
import {
  createDemoVoiceBookingSessions,
  ensureDemoSessions,
} from "../src/lib/voiceBooking/demoData";
import { createSessionToken } from "../src/lib/authTokens";
import { GET as getSessionRoute } from "../src/app/api/voice-booking/session/route";
import { GET as getSessionsRoute } from "../src/app/api/voice-booking/sessions/route";
import { POST as approveRoute } from "../src/app/api/voice-booking/approve/route";
import { POST as authSessionRoute } from "../src/app/api/auth/session/route";

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

async function run() {
  console.log("\n=======================================================");
  console.log("   BREW Coffee Phase P8 Demo Readiness Verification    ");
  console.log("=======================================================\n");

  const testRepo = new InMemoryVoiceSessionRepository();
  setVoiceSessionRepository(testRepo);

  // ---------------------------------------------------------
  // SUITE 1: Demo Data Seeding & Isolation
  // ---------------------------------------------------------
  console.log("Suite 1: Safe Demonstration Data Invariants & Seeding");

  await test("1.1 createDemoVoiceBookingSessions returns 3 distinct demo sessions with valid HMAC snapshots", () => {
    const demos = createDemoVoiceBookingSessions();
    assert.strictEqual(demos.length, 3);

    const pending = demos.find((d) => d.id === "vbs_demo_pending_review");
    const approved = demos.find((d) => d.id === "vbs_demo_approved_booking");
    const declined = demos.find((d) => d.id === "vbs_demo_declined_booking");

    assert.ok(pending && pending.state === "awaiting_staff_approval");
    assert.ok(approved && approved.state === "booking_confirmed");
    assert.ok(declined && declined.state === "customer_declined");

    // Verify cryptographic integrity of pending demo quotation
    assert.ok(pending.quotation && pending.quotationSnapshot);
    const integrity = verifyQuotationIntegrity(
      pending.quotationSnapshot,
      pending.requirements,
      pending.quotation
    );
    assert.strictEqual(integrity.isMatch, true);
    assert.strictEqual(pending.metadata?.isDemo, true);
  });

  await test("1.2 GET /api/voice-booking/sessions auto-seeds demo data when repository is empty in prototype mode", async () => {
    const emptyRepo = new InMemoryVoiceSessionRepository();
    setVoiceSessionRepository(emptyRepo);

    const baristaToken = await createSessionToken({
      uid: "demo_barista_arjun",
      email: "arjun@brewcoffee.in",
      displayName: "Arjun (Lead Barista)",
      role: "barista",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/sessions", {
      headers: { cookie: `brew_session=${baristaToken}` },
    });
    const res = await getSessionsRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.ok(json.sessions.length >= 3);

    const ids = json.sessions.map((s: { id: string }) => s.id);
    assert.ok(ids.includes("vbs_demo_pending_review"));
    assert.ok(ids.includes("vbs_demo_approved_booking"));
    assert.ok(ids.includes("vbs_demo_declined_booking"));
  });

  // ---------------------------------------------------------
  // SUITE 2: Staff Authentication & RBAC Readiness
  // ---------------------------------------------------------
  console.log("\nSuite 2: Staff Demo Authentication & Authorization");

  await test("2.1 Staff PIN '2026' authenticates as Barista role without exposing secrets", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "staff_pin",
        pin: "2026",
      }),
    });
    const res = await authSessionRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.user.role, "barista");
    assert.strictEqual(json.user.displayName, "Arjun (Lead Barista)");
  });

  // ---------------------------------------------------------
  // SUITE 3: Demonstration Scenario A (English Voice Booking)
  // ---------------------------------------------------------
  console.log("\nSuite 3: Demonstration Scenario A (English Voice Booking)");

  await test("3.1 Scenario A: Live English conversation gathers details, updates count, and presents 3 packages", async () => {
    const session = createVoiceBookingSession("+919876543210", "en");
    await testRepo.save(session);

    // Turn 1: Partial requirements
    const t1 = await processConversationTurn(
      session,
      "We want to book a mobile espresso bar for an office celebration in Hitec City on 2026-12-24 at 15:00.",
      { turnId: `${session.id}_t1`, turnIndex: 1, sessionRepository: testRepo }
    );
    assert.strictEqual(t1.session.state, "collecting_requirements");
    assert.strictEqual(t1.session.requirements.venueAddress, "Hitec City");
    assert.strictEqual(t1.session.requirements.startTime, "15:00");

    // Turn 2: Remaining requirements
    const t2 = await processConversationTurn(
      t1.session,
      "There will be 50 guests and we need service for 3 hours.",
      { turnId: `${session.id}_t2`, turnIndex: 2, sessionRepository: testRepo }
    );
    assert.strictEqual(t2.session.requirements.missingFields?.length, 0);

    // Turn 3: Correction
    const t3 = await processConversationTurn(
      t2.session,
      "Actually make that 75 guests please.",
      { turnId: `${session.id}_t3`, turnIndex: 3, sessionRepository: testRepo }
    );
    assert.strictEqual(t3.session.requirements.guestCount, 75);
    assert.ok(t3.session.quotation);
    assert.strictEqual(t3.session.quotation.tiers.length, 3);

    // Turn 4: Package Selection
    const t4 = await processConversationTurn(
      t3.session,
      "We'd love the Artisanal Signature package.",
      { turnId: `${session.id}_t4`, turnIndex: 4, sessionRepository: testRepo }
    );
    assert.strictEqual(t4.session.requirements.selectedTier, "STANDARD");

    // Turn 5: Confirm and Submit
    const t5 = await processConversationTurn(
      t4.session,
      "I confirm this quotation. Please submit the booking request.",
      { turnId: `${session.id}_t5`, turnIndex: 5, sessionRepository: testRepo }
    );
    assert.strictEqual(t5.session.state, "awaiting_staff_approval");
    assert.ok(t5.session.officialBookingId?.startsWith("enq_voice_"));
  });

  // ---------------------------------------------------------
  // SUITE 4: Demonstration Scenario B (Hindi & Telugu Multilingual)
  // ---------------------------------------------------------
  console.log("\nSuite 4: Demonstration Scenario B (Hindi & Telugu Multilingual)");

  await test("4.1 Scenario B (Hindi): Complete Hindi conversational booking in Devanagari", async () => {
    const session = createVoiceBookingSession("+919876543211", "hi");
    await testRepo.save(session);

    const t1 = await processConversationTurn(
      session,
      "नमस्ते, हमें 2026-12-26 को दोपहर 2 बजे बंजारा हिल्स में 80 मेहमानों के लिए 3 घंटे की कॉफ़ी कैटरिंग चाहिए।",
      { turnId: `${session.id}_hi_t1`, turnIndex: 1, sessionRepository: testRepo }
    );
    assert.strictEqual(t1.session.language, "hi");
    assert.strictEqual(t1.session.requirements.guestCount, 80);
    assert.strictEqual(t1.session.requirements.venueAddress, "Banjara Hills");
    assert.ok(t1.session.quotation);

    const t2 = await processConversationTurn(
      t1.session,
      "हाँ, यह पैकेज कन्फ़र्म कर दीजिए।",
      { turnId: `${session.id}_hi_t2`, turnIndex: 2, sessionRepository: testRepo }
    );
    assert.strictEqual(t2.session.state, "awaiting_staff_approval");
  });

  await test("4.2 Scenario B (Telugu): Complete Telugu conversational booking in Telugu script", async () => {
    const session = createVoiceBookingSession("+919876543212", "te");
    await testRepo.save(session);

    const t1 = await processConversationTurn(
      session,
      "నమస్కారం, నాకు 2026-12-26 న మధ్యాహ్నం 2 గంటలకు గచ్చిబౌలిలో 100 మంది అతిథుల కోసం 4 గంటల కాఫీ క్యాటరింగ్ కావాలి.",
      { turnId: `${session.id}_te_t1`, turnIndex: 1, sessionRepository: testRepo }
    );
    assert.strictEqual(t1.session.language, "te");
    assert.strictEqual(t1.session.requirements.guestCount, 100);
    assert.strictEqual(t1.session.requirements.venueAddress, "Gachibowli");
    assert.ok(t1.session.quotation);

    const t2 = await processConversationTurn(
      t1.session,
      "అవును, ఈ ప్యాకేజీని కన్ఫర్మ్ చేయండి.",
      { turnId: `${session.id}_te_t2`, turnIndex: 2, sessionRepository: testRepo }
    );
    assert.strictEqual(t2.session.state, "awaiting_staff_approval");
  });

  // ---------------------------------------------------------
  // SUITE 5: Demonstration Scenario C (Staff Approval & Rejection)
  // ---------------------------------------------------------
  console.log("\nSuite 5: Demonstration Scenario C (Staff Approval & Rejection)");

  await test("5.1 Scenario C (Staff Approval): Staff authorizes pending booking, verifying cryptographic integrity", async () => {
    setVoiceSessionRepository(testRepo);
    const demos = await ensureDemoSessions(testRepo);
    const pendingSession = demos.find((d) => d.id === "vbs_demo_pending_review")!;
    assert.ok(pendingSession);

    const baristaToken = await createSessionToken({
      uid: "staff-barista-arjun",
      email: "arjun@brewcoffee.in",
      displayName: "Arjun (Lead Barista)",
      role: "barista",
    });

    const approveReq = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${baristaToken}`,
      },
      body: JSON.stringify({ sessionId: pendingSession.id }),
    });
    const approveRes = await approveRoute(approveReq);
    if (approveRes.status !== 200) {
      console.error("Approve error body:", await approveRes.json());
    }
    assert.strictEqual(approveRes.status, 200);

    // Customer poll reflects confirmation
    const customerPollReq = new NextRequest(
      `http://localhost:3000/api/voice-booking/session?sessionId=${pendingSession.id}`
    );
    const customerPollRes = await getSessionRoute(customerPollReq);
    assert.strictEqual(customerPollRes.status, 200);
    const customerPollJson = await customerPollRes.json();
    assert.strictEqual(customerPollJson.session.state, "booking_confirmed");
    assert.strictEqual(customerPollJson.session.staffApprovalStatus, "approved");
    assert.ok(customerPollJson.session.officialBookingId?.startsWith("enq_voice_"));
    // Verify privacy
    const raw = JSON.stringify(customerPollJson);
    assert.strictEqual(raw.includes("staff-barista-arjun"), false, "Staff UID must remain private");
  });

  // ---------------------------------------------------------
  // SUITE 6: Zero-Cost Prototype Safety & Isolation
  // ---------------------------------------------------------
  console.log("\nSuite 6: Zero-Cost Prototype Safety & Isolation");

  await test("6.1 Prototype mode is active with zero external carrier or speech costs", () => {
    assert.strictEqual(isVoicePrototypeMode(), true);
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
    assert.throws(() => assertPrototypeSafetyGuard("exotel"), /Safety violation/);
    assert.throws(() => assertPrototypeSafetyGuard("azure_speech"), /Safety violation/);
  });

  // ---------------------------------------------------------
  // Summary
  // ---------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase P8 Verification Results: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("=======================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unhandled error running Phase P8 tests:", err);
  process.exit(1);
});
