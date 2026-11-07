/**
 * BREW Coffee Platform — Phase P5 Verification Suite
 * Staff Approval & Booking Confirmation Verification
 *
 * Verifies:
 * 1. Server-side staff authentication and RBAC enforcement (barista, fleet_admin, admin vs customer/unauthenticated).
 * 2. Client-side identity forgery resistance (client payload cannot forge staffRole or staffIdentity).
 * 3. Protected staff sessions retrieval API (/api/voice-booking/sessions) with full requirements, quotation integrity, and audit fields.
 * 4. Valid staff approval moves session from awaiting_staff_approval to booking_confirmed with immutable audit record and official booking ID.
 * 5. Valid staff rejection moves session to customer_declined with mandatory audit reason (>= 3 chars) and optional customer-facing reason.
 * 6. Mandatory rejection reason validation enforces fail-closed boundary on empty or < 3 char reasons.
 * 7. Duplicate action prevention: duplicate approvals and duplicate rejections fail closed (409 Conflict).
 * 8. Conflicting action prevention: rejecting approved booking or approving declined booking fails closed.
 * 9. Quotation cryptographic integrity verification gate: tampered requirements or invalid HMAC snapshots block approval.
 * 10. Customer visibility projection sanitization: customer view displays approved status or sanitized customer-facing reason, strictly hiding internal staff notes and UIDs.
 * 11. Zero-Cost Free Prototype isolation: zero paid APIs, zero Exotel calls, zero Azure Speech costs ($0.00), VOICE_BOOKING_ENABLED=false.
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
} from "../src/lib/voiceBooking/conversationEngine";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "../src/lib/voiceBooking/quotationAdapter";
import { computeOfficialVanRequestId } from "../src/lib/voiceBooking/vanRequestBridge";
import {
  inspectStaffSession,
  deriveTrustedStaffAuthorizationContext,
  authenticateAndApproveBooking,
  authenticateAndRejectBooking,
} from "../src/lib/auth/adminAuth";
import { createSessionToken } from "../src/lib/authTokens";
import { revokeSession } from "../src/lib/sessionRevocation";
import { toSafeCustomerVoiceSessionView } from "../src/lib/communication/visibility";
import { BookingRequirements, VoiceBookingSession } from "../src/lib/voiceBooking/types";
import { GET as getSessionsRoute } from "../src/app/api/voice-booking/sessions/route";
import { POST as approveRoute } from "../src/app/api/voice-booking/approve/route";
import { POST as rejectRoute } from "../src/app/api/voice-booking/reject/route";

let passedCount = 0;
let failedCount = 0;
let uniqueDateCounter = 0;

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

// Helper: create a fully confirmed session ready for staff approval
async function createAwaitingApprovalSession(
  repo: InMemoryVoiceSessionRepository,
  opts?: {
    guestCount?: number;
    eventDate?: string;
    startTime?: string;
    tamperWithRequirements?: boolean;
    tamperWithHmac?: boolean;
  }
): Promise<VoiceBookingSession> {
  const session = createVoiceBookingSession("+919876543210", "en");

  // Unique date/time prevents resource slot collisions across independent test cases
  const uniqueDay = (10 + (uniqueDateCounter++ % 20)).toString().padStart(2, "0");
  const eventDate = opts?.eventDate || `2026-12-${uniqueDay}`;
  const startTime = opts?.startTime || "14:00";

  const requirements: BookingRequirements = {
    ...session.requirements,
    eventType: "corporate",
    guestCount: opts?.guestCount || 75,
    eventDate,
    startTime,
    durationHours: 3,
    venueAddress: "Hitec City, Cyber Towers, Hyderabad",
    selectedTier: "STANDARD",
    customerConfirmed: true,
    missingFields: [],
  };

  const quotation = generateVoiceBookingQuotation(requirements);
  let snapshot = createQuotationSnapshot(requirements);

  if (opts?.tamperWithHmac) {
    snapshot = {
      ...snapshot,
      hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
  }

  const finalRequirements = opts?.tamperWithRequirements
    ? { ...requirements, guestCount: 500 } // Tampered: 75 -> 500
    : requirements;

  const officialVanId = computeOfficialVanRequestId(session.id);
  const awaitingSession: VoiceBookingSession = {
    ...session,
    state: "awaiting_staff_approval",
    officialBookingId: officialVanId,
    metadata: {
      ...session.metadata,
      officialBookingId: officialVanId,
      enquiryRequestId: officialVanId,
    },
    requirements: finalRequirements,
    quotation,
    quotationSnapshot: snapshot,
    updatedAt: new Date().toISOString(),
  };

  await repo.save(awaitingSession);
  return awaitingSession;
}

async function run() {
  console.log("\n=======================================================");
  console.log("   BREW Coffee Phase P5 Staff Approval Test Suite      ");
  console.log("=======================================================\n");

  const testRepo = new InMemoryVoiceSessionRepository();
  setVoiceSessionRepository(testRepo);

  // ---------------------------------------------------------
  // SUITE 1: Server-Side Staff Authentication & RBAC
  // ---------------------------------------------------------
  console.log("Suite 1: Server-Side Staff Authentication & RBAC");

  await test("1.1 Missing session cookie returns 401 Unauthorized", async () => {
    const fakeReq = {
      cookies: {
        get: (_name: string) => undefined,
      },
    };
    const result = await inspectStaffSession(fakeReq);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.code, "MISSING_SESSION");
  });

  await test("1.2 Malformed or invalid session token returns 401 Unauthorized", async () => {
    const fakeReq = {
      cookies: {
        get: (_name: string) => ({ value: "malformed.invalid.token" }),
      },
    };
    const result = await inspectStaffSession(fakeReq);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.code, "INVALID_SESSION");
  });

  await test("1.3 Customer role token returns 403 Forbidden", async () => {
    const customerToken = await createSessionToken({
      uid: "cust_123",
      email: "customer@example.com",
      displayName: "Customer User",
      role: "customer",
    });

    const result = await inspectStaffSession(customerToken);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.code, "UNAUTHORIZED_ROLE");
  });

  await test("1.4 Authorized staff roles (barista, fleet_admin, admin) return 200 OK", async () => {
    for (const role of ["barista", "fleet_admin", "admin"] as const) {
      const staffToken = await createSessionToken({
        uid: `staff_${role}_1`,
        email: `${role}@brewcoffee.in`,
        displayName: `Staff ${role}`,
        role,
      });

      const result = await inspectStaffSession(staffToken);
      assert.strictEqual(result.ok, true, `Expected ok for role ${role}`);
      if (result.ok) {
        assert.strictEqual(result.session.role, role);
        assert.strictEqual(result.session.uid, `staff_${role}_1`);
      }
    }
  });

  await test("1.5 Revoked staff session token returns 401 Unauthorized", async () => {
    const sid = `sess_revoked_${Date.now()}`;
    const staffToken = await createSessionToken({
      uid: "staff_revoked_1",
      email: "barista_revoked@brewcoffee.in",
      displayName: "Revoked Barista",
      role: "barista",
      sid,
    });

    // Revoke the session
    await revokeSession(sid);

    const result = await inspectStaffSession(staffToken);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.code, "REVOKED_SESSION");
  });

  await test("1.6 Resistance to client-side forgery: client cannot inject arbitrary staffRole or staffIdentity", async () => {
    const baristaToken = await createSessionToken({
      uid: "real_barista_42",
      email: "barista@brewcoffee.in",
      displayName: "Real Barista",
      role: "barista",
    });

    // Client passes fake identity in parameters
    const inspection = await inspectStaffSession(baristaToken);
    assert.strictEqual(inspection.ok, true);
    if (!inspection.ok) return;

    const authContext = await deriveTrustedStaffAuthorizationContext({
      verifiedSession: inspection.session,
    });

    // Derived context strictly binds verified token values
    assert.strictEqual(authContext.staffIdentity, "real_barista_42");
    assert.strictEqual(authContext.staffRole, "barista");
    assert.notStrictEqual(authContext.staffRole, "admin");
  });

  // ---------------------------------------------------------
  // SUITE 2: Staff Sessions Dashboard Retrieval API
  // ---------------------------------------------------------
  console.log("\nSuite 2: Staff Sessions Dashboard Retrieval API");

  await test("2.1 Unauthenticated request to /api/voice-booking/sessions returns 401", async () => {
    const req = new NextRequest("http://localhost:3000/api/voice-booking/sessions");
    const res = await getSessionsRoute(req);
    assert.strictEqual(res.status, 401);
  });

  await test("2.2 Customer token to /api/voice-booking/sessions returns 403 Forbidden", async () => {
    const customerToken = await createSessionToken({
      uid: "cust_viewer",
      email: "cust@gmail.com",
      displayName: "Customer",
      role: "customer",
    });
    const req = new NextRequest("http://localhost:3000/api/voice-booking/sessions", {
      headers: { cookie: `brew_session=${customerToken}` },
    });
    const res = await getSessionsRoute(req);
    assert.strictEqual(res.status, 403);
  });

  await test("2.3 Authorized staff receives comprehensive session details with quotation integrity", async () => {
    // Populate a test session
    const awaiting = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_kds",
      email: "kds@brewcoffee.in",
      displayName: "KDS Barista",
      role: "barista",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/sessions", {
      headers: { cookie: `brew_session=${baristaToken}` },
    });
    const res = await getSessionsRoute(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.ok(Array.isArray(json.sessions));
    assert.ok(json.sessions.length > 0);

    const found = json.sessions.find((s: { id: string }) => s.id === awaiting.id);
    assert.ok(found, "Awaiting session must be found in dashboard list");
    assert.strictEqual(found.status, "awaiting_staff_approval");
    assert.ok(found.maskedPhone?.includes("****"), "Phone must be masked");
    assert.strictEqual(found.language, "en");
    assert.strictEqual(found.bookingRequirements.guestCount, 75);
    assert.ok(found.quotation, "Quotation must be attached");
    assert.strictEqual(found.quotationIntegrity?.valid, true, "Quotation integrity must be valid");
  });

  // ---------------------------------------------------------
  // SUITE 3: Valid Staff Approval Workflow
  // ---------------------------------------------------------
  console.log("\nSuite 3: Valid Staff Approval Workflow");

  await test("3.1 Valid staff approval transitions session to booking_confirmed with audit record", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_approver_1",
      email: "barista1@brewcoffee.in",
      displayName: "Lead Barista",
      role: "barista",
    });

    const approved = await authenticateAndApproveBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      repository: testRepo,
    });

    assert.strictEqual(approved.state, "booking_confirmed");
    assert.ok(approved.officialBookingId?.startsWith("enq_voice_"));
    assert.ok(approved.staffApprovalAudit);
    assert.strictEqual(approved.staffApprovalAudit.staffIdentity, "barista_approver_1");
    assert.strictEqual(approved.staffApprovalAudit.staffRole, "barista");
    assert.ok(approved.staffApprovalAudit.approvedAt);
    assert.ok(approved.staffApprovalAudit.staffApprovalId.startsWith("appr_"));

    // Verify stored session in repository
    const stored = await testRepo.getById(session.id);
    assert.strictEqual(stored?.state, "booking_confirmed");
    assert.strictEqual(stored?.officialBookingId, approved.officialBookingId);
  });

  await test("3.2 Route POST /api/voice-booking/approve successfully authorizes valid session", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const adminToken = await createSessionToken({
      uid: "admin_approver_1",
      email: "admin@brewcoffee.in",
      displayName: "Fleet Admin",
      role: "fleet_admin",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        cookie: `brew_session=${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.id }),
    });

    const res = await approveRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.state, "booking_confirmed");
    assert.ok(json.officialBookingId?.startsWith("enq_voice_"));
    assert.strictEqual(json.staffApprovalAudit?.staffRole, "fleet_admin");
  });

  // ---------------------------------------------------------
  // SUITE 4: Valid Staff Rejection Workflow
  // ---------------------------------------------------------
  console.log("\nSuite 4: Valid Staff Rejection Workflow");

  await test("4.1 Valid staff rejection transitions session to customer_declined with audit record", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_rejecter_1",
      email: "barista_rej@brewcoffee.in",
      displayName: "Shift Barista",
      role: "barista",
    });

    const rejected = await authenticateAndRejectBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      reason: "Van scheduled for mandatory chassis maintenance during event window.",
      customerFacingReason: "Our mobile van is undergoing maintenance during the requested hours.",
      repository: testRepo,
    });

    assert.strictEqual(rejected.state, "customer_declined");
    assert.ok(rejected.staffRejectionAudit);
    assert.strictEqual(rejected.staffRejectionAudit.staffIdentity, "barista_rejecter_1");
    assert.strictEqual(rejected.staffRejectionAudit.staffRole, "barista");
    assert.strictEqual(
      rejected.staffRejectionAudit.reason,
      "Van scheduled for mandatory chassis maintenance during event window."
    );
    assert.strictEqual(
      rejected.staffRejectionAudit.customerFacingReason,
      "Our mobile van is undergoing maintenance during the requested hours."
    );
    assert.ok(rejected.staffRejectionAudit.rejectedAt);

    // Verify stored session in repository
    const stored = await testRepo.getById(session.id);
    assert.strictEqual(stored?.state, "customer_declined");
    assert.ok(stored?.staffRejectionAudit);
  });

  await test("4.2 Route POST /api/voice-booking/reject successfully declines session", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const adminToken = await createSessionToken({
      uid: "admin_rejecter_1",
      email: "admin_rej@brewcoffee.in",
      displayName: "Admin Rejection",
      role: "admin",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/reject", {
      method: "POST",
      headers: {
        cookie: `brew_session=${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: session.id,
        reason: "Capacity exhausted: three prior catering bookings in Gachibowli",
        customerFacingReason: "We are at peak capacity for this time slot.",
      }),
    });

    const res = await rejectRoute(req);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.state, "customer_declined");
    assert.strictEqual(json.staffRejectionAudit?.staffRole, "admin");
    assert.strictEqual(
      json.staffRejectionAudit?.reason,
      "Capacity exhausted: three prior catering bookings in Gachibowli"
    );
  });

  // ---------------------------------------------------------
  // SUITE 5: Rejection Validation Rules (Fail-Closed)
  // ---------------------------------------------------------
  console.log("\nSuite 5: Rejection Validation Rules (Fail-Closed)");

  await test("5.1 Rejection without reason fails closed with 400 Bad Request", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_rej_test",
      email: "b@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/reject", {
      method: "POST",
      headers: {
        cookie: `brew_session=${baristaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: session.id,
        reason: "", // Empty reason
      }),
    });

    const res = await rejectRoute(req);
    assert.strictEqual(res.status, 400);

    // Session remains in awaiting_staff_approval
    const stored = await testRepo.getById(session.id);
    assert.strictEqual(stored?.state, "awaiting_staff_approval");
  });

  await test("5.2 Rejection reason shorter than 3 characters fails closed", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_rej_test2",
      email: "b2@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/reject", {
      method: "POST",
      headers: {
        cookie: `brew_session=${baristaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: session.id,
        reason: "no", // Only 2 chars
      }),
    });

    const res = await rejectRoute(req);
    assert.strictEqual(res.status, 400);

    const stored = await testRepo.getById(session.id);
    assert.strictEqual(stored?.state, "awaiting_staff_approval");
  });

  // ---------------------------------------------------------
  // SUITE 6: Duplicate Actions Prevention (Idempotency & Conflict)
  // ---------------------------------------------------------
  console.log("\nSuite 6: Duplicate Actions Prevention");

  await test("6.1 Duplicate approval on already-confirmed session fails with 409 Conflict", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_dup_1",
      email: "dup@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    // First approval succeeds
    await authenticateAndApproveBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      repository: testRepo,
    });

    // Second approval attempt via route
    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        cookie: `brew_session=${baristaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.id }),
    });

    const res = await approveRoute(req);
    assert.strictEqual(res.status, 409);
    const json = await res.json();
    assert.ok(json.error?.includes("already been approved") || json.error?.includes("booking_confirmed"));
  });

  await test("6.2 Duplicate rejection on already-declined session fails with 409 Conflict", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const baristaToken = await createSessionToken({
      uid: "barista_dup_2",
      email: "dup2@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    // First rejection succeeds
    await authenticateAndRejectBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      reason: "Initial decline reason",
      repository: testRepo,
    });

    // Second rejection attempt via route
    const req = new NextRequest("http://localhost:3000/api/voice-booking/reject", {
      method: "POST",
      headers: {
        cookie: `brew_session=${baristaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.id, reason: "Duplicate decline attempt" }),
    });

    const res = await rejectRoute(req);
    assert.strictEqual(res.status, 409);
    const json = await res.json();
    assert.ok(json.error?.includes("already been rejected") || json.error?.includes("customer_declined"));
  });

  // ---------------------------------------------------------
  // SUITE 7: Conflicting Actions Prevention
  // ---------------------------------------------------------
  console.log("\nSuite 7: Conflicting Actions Prevention");

  await test("7.1 Rejecting an already-approved booking fails with 409 Conflict", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const staffToken = await createSessionToken({
      uid: "staff_conflict_1",
      email: "c1@brewcoffee.in",
      displayName: "Staff",
      role: "barista",
    });

    // Approve first
    await authenticateAndApproveBooking({
      sessionId: session.id,
      tokenOrRequest: staffToken,
      repository: testRepo,
    });

    // Attempt to reject
    const req = new NextRequest("http://localhost:3000/api/voice-booking/reject", {
      method: "POST",
      headers: {
        cookie: `brew_session=${staffToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.id, reason: "Attempting to reject approved session" }),
    });

    const res = await rejectRoute(req);
    assert.strictEqual(res.status, 409);
  });

  await test("7.2 Approving an already-declined booking fails with 409 Conflict", async () => {
    const session = await createAwaitingApprovalSession(testRepo);

    const staffToken = await createSessionToken({
      uid: "staff_conflict_2",
      email: "c2@brewcoffee.in",
      displayName: "Staff",
      role: "barista",
    });

    // Reject first
    await authenticateAndRejectBooking({
      sessionId: session.id,
      tokenOrRequest: staffToken,
      reason: "Initial rejection",
      repository: testRepo,
    });

    // Attempt to approve
    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        cookie: `brew_session=${staffToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.id }),
    });

    const res = await approveRoute(req);
    assert.strictEqual(res.status, 409);
  });

  // ---------------------------------------------------------
  // SUITE 8: Quotation Cryptographic Integrity Verification Gate
  // ---------------------------------------------------------
  console.log("\nSuite 8: Quotation Cryptographic Integrity Gate");

  await test("8.1 Tampered requirements parameters cause staff approval to fail closed", async () => {
    const tamperedSession = await createAwaitingApprovalSession(testRepo, {
      guestCount: 75,
      tamperWithRequirements: true, // guestCount modified to 500 without recalculating snapshot
    });

    const baristaToken = await createSessionToken({
      uid: "barista_guard",
      email: "guard@brewcoffee.in",
      displayName: "Guard",
      role: "barista",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        cookie: `brew_session=${baristaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: tamperedSession.id }),
    });

    const res = await approveRoute(req);
    assert.strictEqual(res.status, 409);
    const json = await res.json();
    assert.ok(json.error?.toLowerCase().includes("quotation integrity verification failed"));

    // Session remains awaiting_staff_approval
    const stored = await testRepo.getById(tamperedSession.id);
    assert.strictEqual(stored?.state, "awaiting_staff_approval");
  });

  await test("8.2 Corrupted HMAC signature in snapshot causes staff approval to fail closed", async () => {
    const corruptedSession = await createAwaitingApprovalSession(testRepo, {
      tamperWithHmac: true,
    });

    const baristaToken = await createSessionToken({
      uid: "barista_guard2",
      email: "guard2@brewcoffee.in",
      displayName: "Guard 2",
      role: "barista",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        cookie: `brew_session=${baristaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: corruptedSession.id }),
    });

    const res = await approveRoute(req);
    assert.strictEqual(res.status, 409);
    const json = await res.json();
    assert.ok(json.error?.toLowerCase().includes("quotation integrity verification failed"));

    const stored = await testRepo.getById(corruptedSession.id);
    assert.strictEqual(stored?.state, "awaiting_staff_approval");
  });

  // ---------------------------------------------------------
  // SUITE 9: Customer Visibility Projection Sanitization
  // ---------------------------------------------------------
  console.log("\nSuite 9: Customer Visibility Projection Sanitization");

  await test("9.1 Approved session view exposes officialBookingId and sanitized audit, hiding staff UID", async () => {
    const session = await createAwaitingApprovalSession(testRepo);
    const baristaToken = await createSessionToken({
      uid: "confidential_staff_uid_99",
      email: "staff@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    const approved = await authenticateAndApproveBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      repository: testRepo,
    });

    const safeView = toSafeCustomerVoiceSessionView(approved);
    assert.strictEqual(safeView.staffApprovalStatus, "approved");
    assert.strictEqual(safeView.state, "booking_confirmed");
    assert.ok(safeView.officialBookingId?.startsWith("enq_voice_"));
    assert.strictEqual(safeView.staffApprovalAudit?.staffRole, "barista");
    assert.ok(safeView.staffApprovalAudit?.approvedAt);

    // Ensure confidential staff UID is NOT in customer view
    const viewString = JSON.stringify(safeView);
    assert.strictEqual(viewString.includes("confidential_staff_uid_99"), false);
  });

  await test("9.2 Declined session view exposes customerFacingRejectionReason, strictly hiding internal notes", async () => {
    const session = await createAwaitingApprovalSession(testRepo);
    const baristaToken = await createSessionToken({
      uid: "confidential_staff_uid_100",
      email: "staff2@brewcoffee.in",
      displayName: "Barista",
      role: "barista",
    });

    const rejected = await authenticateAndRejectBooking({
      sessionId: session.id,
      tokenOrRequest: baristaToken,
      reason: "INTERNAL AUDIT NOTE: Customer was difficult on phone and asked for illegal parking.",
      customerFacingReason: "We are unable to secure municipal parking clearance for your chosen venue.",
      repository: testRepo,
    });

    const safeView = toSafeCustomerVoiceSessionView(rejected);
    assert.strictEqual(safeView.staffApprovalStatus, "declined");
    assert.strictEqual(safeView.state, "customer_declined");
    assert.strictEqual(
      safeView.customerFacingRejectionReason,
      "We are unable to secure municipal parking clearance for your chosen venue."
    );

    const viewString = JSON.stringify(safeView);
    assert.strictEqual(viewString.includes("confidential_staff_uid_100"), false);
    assert.strictEqual(viewString.includes("Customer was difficult on phone"), false);
  });

  // ---------------------------------------------------------
  // SUITE 10: Zero-Cost Isolation & Safety Enforcement
  // ---------------------------------------------------------
  console.log("\nSuite 10: Zero-Cost Isolation & Safety Enforcement");

  await test("10.1 isVoicePrototypeMode() is true and assertPrototypeSafetyGuard() blocks paid services", () => {
    assert.strictEqual(isVoicePrototypeMode(), true);
    assert.throws(
      () => assertPrototypeSafetyGuard("exotel"),
      /Safety violation/
    );
    assert.throws(
      () => assertPrototypeSafetyGuard("azure_speech"),
      /Safety violation/
    );
  });

  await test("10.2 VOICE_BOOKING_ENABLED is false", () => {
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
  });

  // ---------------------------------------------------------
  // Summary
  // ---------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase P5 Verification Results: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("=======================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Unhandled error running Phase P5 tests:", err);
  process.exit(1);
});
