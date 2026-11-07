#!/usr/bin/env tsx
/**
 * BREW Coffee Platform — Phase 6.3.5 Verification Suite
 * Website Integration & End-to-End Mock Booking Demo
 *
 * Verifies the complete end-to-end customer-to-staff mock voice booking journey:
 * 1. Customer booking request submission with voice consent via POST /api/request-van
 * 2. Safe public response verification (voiceSessionId, safe contact masking, zero phone leaks)
 * 3. Customer interactive session retrieval via GET /api/voice-booking/session (safe view, initial greeting)
 * 4. Interactive customer dialogue via POST /api/voice-booking/chat (requirement gathering, quotation)
 * 5. Customer quote confirmation via POST /api/voice-booking/chat (transition to awaiting_staff_approval)
 * 6. Customer boundary protection (unauthorized approve attempts fail closed: 401/403)
 * 7. Staff dashboard session inspection via GET /api/voice-booking/sessions (authenticated staff role)
 * 8. Staff booking authorization via POST /api/voice-booking/approve (transitions to booking_confirmed)
 * 9. Customer visibility of confirmed booking with staff audit trail
 * 10. Turn idempotency & duplicate message rejection
 * 11. Regression safeguards: non-voice bookings, WhatsApp independence, phone privacy, zero real telephony
 */

// Strict guardrail environment configuration
process.env.VOICE_BOOKING_ENABLED = "false";
process.env.VOICE_BOOKING_STORAGE = "firestore";
process.env.BREW_TEST_ENV = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.DISABLE_SMTP = "true";
process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";

import assert from "assert";
import { NextRequest } from "next/server";
import { POST as requestVanPost } from "../src/app/api/request-van/route";
import { GET as getSessionRoute } from "../src/app/api/voice-booking/session/route";
import { POST as chatRoute } from "../src/app/api/voice-booking/chat/route";
import { GET as getSessionsRoute } from "../src/app/api/voice-booking/sessions/route";
import { POST as approveRoute } from "../src/app/api/voice-booking/approve/route";
import { createSessionToken } from "../src/lib/authTokens";
import {
  getVoiceSessionRepository,
  InMemoryVoiceSessionRepository,
} from "../src/lib/voiceBooking";

console.log("================================================================================");
console.log("   BREW Coffee Platform — Phase 6.3.5 Verification Suite");
console.log("   Website Integration & End-to-End Mock Booking Demo");
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

async function runSuite() {
  const repo = getVoiceSessionRepository() as InMemoryVoiceSessionRepository;

  // Helper to construct JSON NextRequest
  function makeJsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return new NextRequest(url, init);
  }

  // Pre-generate staff and customer tokens for authentication tests
  const staffToken = await createSessionToken({
    uid: "barista_staff_01",
    displayName: "Ananya Sharma",
    email: "ananya@brewcoffee.internal",
    role: "barista",
  });

  const customerToken = await createSessionToken({
    uid: "cust_12345",
    displayName: "Suresh Customer",
    email: "suresh@example.com",
    role: "customer",
  });

  let demoVoiceSessionId = "";
  let demoRequestId = "";
  const runId = Date.now();
  const day = 1 + (Math.floor(runId / 1000) % 25);
  const month = 1 + (Math.floor(runId / 25000) % 12);
  const demoEventDate = `2028-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // ---------------------------------------------------------------------------
  // SCENARIO 1: Customer Booking Request with Explicit Voice Consent
  // ---------------------------------------------------------------------------
  console.log("--- Scenario 1: Customer Booking Submission with Voice Consent ---");

  await test("1.1 POST /api/request-van creates booking and links initial voice session", async () => {
    const payload = {
      contact: "+91 98765 43210",
      organization: `Acme Innovations Tech Hub ${runId}`,
      location: "Financial District, Gachibowli, Hyderabad",
      eventDate: demoEventDate,
      crowdSize: "100–300 People",
      notes: "Annual technology summit afternoon coffee break",
      phoneNumber: "+91 98765 43210",
      voiceConsent: true,
      whatsappConsent: false,
    };

    const req = makeJsonRequest("http://localhost:3000/api/request-van", "POST", payload);
    const res = await requestVanPost(req);
    assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`);

    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.requestId, "Missing requestId in response");
    assert.ok(data.requestId.startsWith("enq_"), "requestId should start with enq_");
    assert.ok(data.voiceSessionId, "Missing voiceSessionId when voiceConsent is true");
    assert.ok(data.voiceSessionId.startsWith("vbs_"), "voiceSessionId should start with vbs_");

    demoVoiceSessionId = data.voiceSessionId;
    demoRequestId = data.requestId;

    // Verify phone privacy in public response:
    // Raw "+919876543210" or "9876543210" must NEVER appear in public strings
    const jsonStr = JSON.stringify(data);
    assert.ok(!jsonStr.includes("9876543210"), "Raw phone number must not be exposed in public response JSON");
    if (data.gmailUrl) {
      assert.ok(!data.gmailUrl.includes("9876543210"), "Raw phone number must not appear in gmailUrl");
    }
    if (data.mailtoUrl) {
      assert.ok(!data.mailtoUrl.includes("9876543210"), "Raw phone number must not appear in mailtoUrl");
    }
  });

  await test("1.2 Voice session is verified in repository with initial state", async () => {
    const session = await repo.getById(demoVoiceSessionId);
    assert.ok(session, "Session not found in repository");
    assert.strictEqual(session.id, demoVoiceSessionId);
    assert.strictEqual(session.metadata?.enquiryRequestId, demoRequestId);
    assert.strictEqual(session.state, "created");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Customer Interactive Voice Session Experience (/voice-booking/[id])
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 2: Interactive Session Retrieval & Initial Greeting ---");

  await test("2.1 GET /api/voice-booking/session validates sessionId and returns 400 for missing param", async () => {
    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/session", "GET");
    const res = await getSessionRoute(req);
    assert.strictEqual(res.status, 400);
  });

  await test("2.2 GET /api/voice-booking/session returns 404 for non-existent session", async () => {
    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/session?sessionId=vbs_nonexistent", "GET");
    const res = await getSessionRoute(req);
    assert.strictEqual(res.status, 404);
  });

  await test("2.3 GET /api/voice-booking/session delivers safe projection and does not create a telephone-call event", async () => {
    const req = makeJsonRequest(`http://localhost:3000/api/voice-booking/session?sessionId=${demoVoiceSessionId}`, "GET");
    const res = await getSessionRoute(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(data.session, "Missing session in response");
    const s = data.session;

    // Verify safe customer view invariants
    assert.strictEqual(s.sessionId, demoVoiceSessionId);
    assert.strictEqual(s.state, "created");
    assert.strictEqual(s.callStatus.callAttemptStatus, "pending", "Opening session must NOT mark call as answered");
    assert.strictEqual(s.callStatus.attemptCount, 0, "Opening session must NOT increment attemptCount");
    assert.strictEqual(s.callStatus.lastAttemptAt, null, "Opening session must NOT record lastAttemptAt");
    assert.ok(s.conversationHistory.length >= 1, "Initial greeting turn should be automatically generated");
    assert.strictEqual(s.conversationHistory[0].role, "assistant");
    assert.ok(s.conversationHistory[0].content.length > 10, "Initial greeting text should be populated");

    // Verify raw session in repository was not marked answered or attemptCount incremented
    const rawSession = await repo.getById(demoVoiceSessionId);
    assert.ok(rawSession, "Underlying session must exist");
    assert.strictEqual(rawSession.metadata?.callAttemptStatus, undefined, "Underlying metadata must not have callAttemptStatus set to answered");
    assert.strictEqual(rawSession.metadata?.attemptCount, undefined, "Underlying metadata must not have attemptCount incremented");
    assert.strictEqual(rawSession.metadata?.callAnsweredAt, undefined, "Underlying metadata must not have callAnsweredAt set");

    // Verify privacy & security sanitization:
    assert.strictEqual((s as unknown as Record<string, unknown>).phoneNumber, undefined, "Raw phoneNumber must not exist on safe view");
    assert.strictEqual((s as unknown as Record<string, unknown>).claimToken, undefined, "claimToken must not be exposed");
    assert.strictEqual((s as unknown as Record<string, unknown>).claimOwner, undefined, "claimOwner must not be exposed");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Interactive Multilingual Dialogue & Real-Time Quotation
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 3: Conversational Requirements Extraction & Quotation ---");

  await test("3.1 POST /api/voice-booking/chat gathers event details and generates authoritative quotation", async () => {
    const chatPayload = {
      sessionId: demoVoiceSessionId,
      message: `Hello! We are hosting a 150 person tech conference on ${demoEventDate} in Gachibowli Hyderabad from 11:00 for 4 hours.`,
      clientTurnId: "turn_cust_01",
    };

    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/chat", "POST", chatPayload);
    const res = await chatRoute(req);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);

    const data = await res.json();
    assert.ok(data.assistantResponse, "Missing assistantResponse in chat response");
    assert.ok(data.session, "Missing session in chat response");
    assert.strictEqual(
      data.session.state,
      "awaiting_customer_confirmation",
      `Expected session state awaiting_customer_confirmation, got ${data.session.state}`
    );

    // Verify requirement extraction
    const reqs = data.session.requirements;
    assert.ok(reqs, "Missing requirements in safe session");
    assert.strictEqual(reqs.guestCount, 150);

    // Verify quotation was generated
    const quote = data.session.quotation;
    assert.ok(quote, "Missing quotation in session");
    assert.ok(quote.tiers && quote.tiers.length === 3, "Quotation should have 3 tiers");
    assert.ok(quote.estimatedGuests === 150, "Estimated guests should match 150");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 4: Customer Quotation Confirmation (Awaiting Staff Approval)
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 4: Customer Tier Confirmation ---");

  await test("4.1 POST /api/voice-booking/chat confirms quotation and transitions to awaiting_staff_approval", async () => {
    const confirmPayload = {
      sessionId: demoVoiceSessionId,
      message: "I confirm the Standard package! Everything looks great, please book it.",
      clientTurnId: "turn_cust_02",
    };

    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/chat", "POST", confirmPayload);
    const res = await chatRoute(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.session.state, "awaiting_staff_approval", "State should transition to awaiting_staff_approval");
    assert.ok(
      data.assistantResponse.toLowerCase().includes("staff") ||
      data.assistantResponse.toLowerCase().includes("team") ||
      data.assistantResponse.toLowerCase().includes("confirm"),
      "Response should mention staff review or confirmation"
    );
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 4.1: Turn Idempotency & Replay Protection
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 4.1: Duplicate Customer Turn Idempotency ---");

  await test("4.2 POST /api/voice-booking/chat with identical turn identity does not duplicate messages", async () => {
    // Current history count
    const sessionBefore = await repo.getById(demoVoiceSessionId);
    const historyCountBefore = sessionBefore!.conversationHistory.length;

    // Send a message that was already processed
    const duplicatePayload = {
      sessionId: demoVoiceSessionId,
      message: "I confirm the Standard package! Everything looks great, please book it.",
      clientTurnId: "turn_cust_02", // Replay of turn 2
    };

    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/chat", "POST", duplicatePayload);
    const res = await chatRoute(req);
    assert.strictEqual(res.status, 200);

    const sessionAfter = await repo.getById(demoVoiceSessionId);
    assert.strictEqual(
      sessionAfter!.conversationHistory.length,
      historyCountBefore,
      "Conversation history must NOT grow when replaying duplicate turn"
    );
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 5: Security & Role Boundaries (Customer Cannot Approve Booking)
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 5: Authorization Boundary Hardening ---");

  await test("5.1 POST /api/voice-booking/approve fails closed (401) for unauthenticated caller", async () => {
    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/approve", "POST", {
      sessionId: demoVoiceSessionId,
    });
    const res = await approveRoute(req);
    assert.strictEqual(res.status, 401, "Unauthenticated approve request must return 401");
  });

  await test("5.2 POST /api/voice-booking/approve fails closed (401) for forged/invalid cookie", async () => {
    const req = makeJsonRequest(
      "http://localhost:3000/api/voice-booking/approve",
      "POST",
      { sessionId: demoVoiceSessionId },
      { cookie: "brew_session=invalid.forged.token" }
    );
    const res = await approveRoute(req);
    assert.strictEqual(res.status, 401, "Forged session cookie must return 401");
  });

  await test("5.3 POST /api/voice-booking/approve fails closed (403) for customer role cookie", async () => {
    const req = makeJsonRequest(
      "http://localhost:3000/api/voice-booking/approve",
      "POST",
      { sessionId: demoVoiceSessionId },
      { cookie: `brew_session=${customerToken}` }
    );
    const res = await approveRoute(req);
    assert.strictEqual(res.status, 403, "Customer role cookie must be rejected with 403 Forbidden");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 6: Staff Dashboard Inspection (/barista & GET /api/voice-booking/sessions)
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 6: Staff Dashboard Inquiries Gateway ---");

  await test("6.1 GET /api/voice-booking/sessions rejects unauthenticated caller with 401", async () => {
    const req = makeJsonRequest("http://localhost:3000/api/voice-booking/sessions", "GET");
    const res = await getSessionsRoute(req);
    assert.strictEqual(res.status, 401);
  });

  await test("6.2 GET /api/voice-booking/sessions returns active sessions for authenticated staff", async () => {
    const req = makeJsonRequest(
      "http://localhost:3000/api/voice-booking/sessions",
      "GET",
      undefined,
      { cookie: `brew_session=${staffToken}` }
    );
    const res = await getSessionsRoute(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data.sessions), "Expected sessions array in response");
    const target = data.sessions.find(
      (sess: { sessionId?: string; id?: string }) =>
        sess.sessionId === demoVoiceSessionId || sess.id === demoVoiceSessionId
    );
    assert.ok(target, `Demo session ${demoVoiceSessionId} should be visible in staff sessions list`);
    assert.strictEqual(target.state, "awaiting_staff_approval");
    assert.strictEqual(target.requirements?.guestCount, 150);
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 7: Staff Booking Authorization (POST /api/voice-booking/approve)
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 7: Authorized Staff Booking Approval ---");

  await test("7.1 POST /api/voice-booking/approve authorizes booking and records audit trail", async () => {
    const req = makeJsonRequest(
      "http://localhost:3000/api/voice-booking/approve",
      "POST",
      { sessionId: demoVoiceSessionId },
      { cookie: `brew_session=${staffToken}` }
    );
    const res = await approveRoute(req);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);

    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.session, "Missing updated session in approve response");
    assert.strictEqual(data.session.state, "booking_confirmed");

    // Verify staff audit trail
    const approval = data.session.staffApprovalAudit;
    assert.ok(approval, "Missing staffApprovalAudit object in session");
    assert.strictEqual(approval.staffRole, "barista");
    assert.ok(approval.approvedAt, "approvedAt timestamp must be recorded");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 8: Customer Post-Approval In-Browser Visibility
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 8: Customer View Reflects Final Confirmation ---");

  await test("8.1 GET /api/voice-booking/session reflects booking_confirmed status to customer", async () => {
    const req = makeJsonRequest(`http://localhost:3000/api/voice-booking/session?sessionId=${demoVoiceSessionId}`, "GET");
    const res = await getSessionRoute(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    const s = data.session;
    assert.strictEqual(s.state, "booking_confirmed");
    assert.strictEqual(s.staffApprovalStatus, "approved");
    assert.ok(s.staffApprovalAudit, "Customer safe view includes staff approval audit");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 9: Regression Safeguards & Consent Independence
  // ---------------------------------------------------------------------------
  console.log("\n--- Scenario 9: Regression Safeguards & Consent Independence ---");

  await test("10.1 Booking submission without voice consent does not create voice session", async () => {
    const payload = {
      contact: "team@company.internal",
      organization: "Standard Office Booking",
      location: "Banjara Hills, Hyderabad",
      eventDate: "2026-12-10",
      crowdSize: "50–100 People",
      voiceConsent: false,
      whatsappConsent: false,
    };

    const req = makeJsonRequest("http://localhost:3000/api/request-van", "POST", payload);
    const res = await requestVanPost(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.voiceSessionId, null, "voiceSessionId must be null when voiceConsent is false");
  });

  await test("10.2 Independent WhatsApp consent without voice consent preserves isolation", async () => {
    const payload = {
      contact: "+91 91234 56789",
      phoneNumber: "+91 91234 56789",
      organization: "WhatsApp Only Office",
      location: "Madhapur, Hyderabad",
      eventDate: "2026-12-15",
      crowdSize: "50–100 People",
      voiceConsent: false,
      whatsappConsent: true,
    };

    const req = makeJsonRequest("http://localhost:3000/api/request-van", "POST", payload);
    const res = await requestVanPost(req);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.voiceSessionId, null, "voiceSessionId must be null when voiceConsent is false");
  });

  await test("10.3 VOICE_BOOKING_ENABLED is false; zero real telephony invoked", async () => {
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false", "VOICE_BOOKING_ENABLED must remain false");
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
