/**
 * BREW Coffee Platform — Phase 6.2.4 Hardening Verification Suite
 *
 * Dedicated tests for:
 * 1. Missing staff session ID rejected.
 * 2. Revocation lookup performed for every privileged token.
 * 3. Unsupported role rejected.
 * 4. Legitimately issued staff roles remain valid.
 * 5. Snapshot hash recomputation succeeds for valid snapshot.
 * 6. Tampered snapshot hash is rejected.
 * 7. Modified snapshot fields with recomputed hash still fail if they diverge from current requirements.
 * 8. Unknown quotation tier is rejected.
 * 9. Tier selection from the active quotation is handled correctly.
 * 10. Tier changes require a new quotation and confirmation.
 * 11. Staff approval audit records authenticated identity and role.
 * 12. Client-supplied audit identity cannot override server identity.
 * 13. Authentication errors map to HTTP 401.
 * 14. Customer role maps to HTTP 403.
 * 15. Missing snapshot cannot bypass the confirmation gate.
 * 16. All existing Phase 6.1–6.2.3 regressions remain intact.
 */

import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
  generateVoiceBookingQuotation,
  evaluateConfirmationSafetyGate,
  createQuotationSnapshot,
  verifyQuotationIntegrity,
  buildCanonicalSnapshotPayload,
  SNAPSHOT_CANONICAL_VERSION,
  InMemoryVoiceSessionRepository,
  BookingRequirements,
  QuotationMaterialSnapshot,
  StaffApprovalAuditRecordSchema,
} from "../src/lib/voiceBooking";
import {
  createSessionToken,
  verifySessionToken,
  UserRole,
} from "../src/lib/authTokens";
import {
  inspectStaffSession,
  verifyStaffSession,
  deriveTrustedStaffAuthorizationContext,
} from "../src/lib/auth/adminAuth";
import { revokeSession, isSessionRevoked } from "../src/lib/sessionRevocation";
import { POST as approveRouteHandler } from "../src/app/api/voice-booking/approve/route";
import { NextRequest } from "next/server";

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passedCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failedCount++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function runPhase624Tests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.4 Authentication, Hash & Audit Hardening");
  console.log("==================================================================");

  const baseReqs: BookingRequirements = {
    guestCount: 100,
    eventDate: "2026-11-20",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "Jubilee Hills",
    eventType: "corporate",
    beveragePreferences: ["espresso"],
    selectedTier: "STANDARD",
    missingFields: [],
    corrections: [],
    customerConfirmed: false,
    handoffRequested: false,
    confidenceScore: 0.95,
    unresolvedQuestions: [],
  };

  // ----------------------------------------------------------------------------
  // Test 1: Missing staff session ID rejected
  // ----------------------------------------------------------------------------
  console.log("\nTest 1: Missing staff session ID rejected");
  {
    // A privileged staff token created without a session ID (or empty sid) must be rejected
    const tokenWithoutSid = await createSessionToken({
      uid: "staff-barista-1",
      email: "barista@brew.cafe",
      displayName: "Barista",
      role: "barista",
      sid: "", // Empty sid
    });

    const parsed = await verifySessionToken(tokenWithoutSid);
    assert(parsed === null, "Privileged staff token with empty sid is rejected by verifySessionToken");

    const inspection = await inspectStaffSession(tokenWithoutSid);
    assert(!inspection.ok, "inspectStaffSession rejects token with empty sid");
    assert(inspection.ok === false && inspection.status === 401, "Rejected staff session with empty sid returns HTTP 401");
  }

  // ----------------------------------------------------------------------------
  // Test 2: Revocation lookup performed for every privileged token
  // ----------------------------------------------------------------------------
  console.log("\nTest 2: Revocation lookup performed for every privileged token");
  {
    const staffSid = `sess_staff_rev_${Date.now()}`;
    const staffToken = await createSessionToken({
      uid: "staff-fleet-admin-rev",
      email: "fleet@brew.cafe",
      displayName: "Fleet Admin",
      role: "fleet_admin",
      sid: staffSid,
    });

    // Revoke this session in the durable revocation store
    await revokeSession(staffSid, "staff-fleet-admin-rev", Date.now() + 100000);

    const isRev = await isSessionRevoked(staffSid, "fleet_admin", Date.now() + 100000);
    assert(isRev === true, "Session successfully registered in revocation store");

    const inspection = await inspectStaffSession(staffToken);
    assert(!inspection.ok, "Revoked staff token is rejected by inspectStaffSession");
    assert(inspection.ok === false && inspection.code === "REVOKED_SESSION", "Reports REVOKED_SESSION code");
    assert(inspection.ok === false && inspection.status === 401, "Revoked staff session returns HTTP 401");
  }

  // ----------------------------------------------------------------------------
  // Test 3: Unsupported role rejected
  // ----------------------------------------------------------------------------
  console.log("\nTest 3: Unsupported role rejected");
  {
    const malformedToken = await createSessionToken({
      uid: "usr-hacker-1",
      email: "hacker@test.com",
      displayName: "Hacker",
      role: "manager" as unknown as UserRole, // Unsupported role
      sid: "sess_malformed_1",
    });

    const parsed = await verifySessionToken(malformedToken);
    assert(parsed === null, "Unsupported role 'manager' rejected by verifySessionToken");

    const inspection = await inspectStaffSession(malformedToken);
    assert(!inspection.ok, "Unsupported role rejected by inspectStaffSession");
    assert(inspection.ok === false && inspection.status === 401, "Malformed role returns HTTP 401");
  }

  // ----------------------------------------------------------------------------
  // Test 4: Legitimately issued staff roles remain valid
  // ----------------------------------------------------------------------------
  console.log("\nTest 4: Legitimately issued staff roles remain valid");
  {
    for (const validRole of ["barista", "fleet_admin", "admin"] as const) {
      const token = await createSessionToken({
        uid: `staff-${validRole}-valid`,
        email: `${validRole}@brew.cafe`,
        displayName: `Staff ${validRole}`,
        role: validRole,
        sid: `sess_${validRole}_${Date.now()}`,
      });

      const parsed = await verifySessionToken(token);
      assert(parsed !== null && parsed.role === validRole, `Valid role '${validRole}' verified successfully`);

      const staff = await verifyStaffSession(token);
      assert(staff !== null && staff.role === validRole, `verifyStaffSession accepts legitimate '${validRole}'`);
    }
  }

  // ----------------------------------------------------------------------------
  // Test 5: Snapshot hash recomputation succeeds for valid snapshot
  // ----------------------------------------------------------------------------
  console.log("\nTest 5: Snapshot hash recomputation succeeds for valid snapshot");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    assert(typeof snapshot.hash === "string" && snapshot.hash.length === 64, "Generated SHA-256 hash is 64 hex characters");

    const integrity = verifyQuotationIntegrity(snapshot, baseReqs, quote);
    assert(integrity.isMatch === true, "Snapshot hash recomputation matches stored hash for valid snapshot");
    assert(integrity.mismatchedFields.length === 0, "No mismatched fields for untampered snapshot");
  }

  // ----------------------------------------------------------------------------
  // Test 6: Tampered snapshot hash is rejected
  // ----------------------------------------------------------------------------
  console.log("\nTest 6: Tampered snapshot hash is rejected");
  {
    const validSnapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    // Tamper with the hash string (e.g. replace characters)
    const tamperedSnapshot: QuotationMaterialSnapshot = {
      ...validSnapshot,
      hash: "a".repeat(64), // Forged hash
    };

    const integrity = verifyQuotationIntegrity(tamperedSnapshot, baseReqs, quote);
    assert(integrity.isMatch === false, "Tampered snapshot hash is strictly rejected");
    assert(integrity.mismatchedFields.includes("hash"), "Mismatched fields identifies 'hash'");
    assert(
      (integrity.reason || "").includes("hash integrity check failed"),
      "Reason indicates hash integrity check failure"
    );
  }

  // ----------------------------------------------------------------------------
  // Test 7: Modified snapshot fields with recomputed hash still fail if they diverge
  // ----------------------------------------------------------------------------
  console.log("\nTest 7: Modified snapshot fields with recomputed hash still fail if they diverge");
  {
    // Attacker modifies guestCount from 100 to 50 in snapshot and recomputes the valid hash for 50
    const modifiedReqs = { ...baseReqs, guestCount: 50 };
    const forgedSnapshotWithValidHash = createQuotationSnapshot(modifiedReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);

    // Current requirements still demand 100 guests
    const integrity = verifyQuotationIntegrity(forgedSnapshotWithValidHash, baseReqs, quote);
    assert(integrity.isMatch === false, "Snapshot with recomputed hash still fails if requirements diverge");
    assert(integrity.mismatchedFields.includes("guestCount"), "Mismatched fields detects 'guestCount'");
    assert(!integrity.mismatchedFields.includes("hash"), "Hash itself was mathematically valid for the forged object");
  }

  // ----------------------------------------------------------------------------
  // Test 8: Unknown quotation tier is rejected
  // ----------------------------------------------------------------------------
  console.log("\nTest 8: Unknown quotation tier is rejected");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);

    const invalidTierReqs = {
      ...baseReqs,
      selectedTier: "SUPER_VIP_ULTRA" as unknown as "BASIC",
    };

    const integrity = verifyQuotationIntegrity(snapshot, invalidTierReqs, quote);
    assert(integrity.isMatch === false, "Unknown quotation tier 'SUPER_VIP_ULTRA' is rejected");
    assert(integrity.mismatchedFields.includes("selectedTier"), "Mismatched fields identifies 'selectedTier'");
  }

  // ----------------------------------------------------------------------------
  // Test 9: Tier selection from the active quotation is handled correctly
  // ----------------------------------------------------------------------------
  console.log("\nTest 9: Tier selection from the active quotation is handled correctly");
  {
    // Snapshot generated with selectedTier: null
    const reqsNoTier = { ...baseReqs, selectedTier: null };
    const quote = generateVoiceBookingQuotation(reqsNoTier);

    // Customer selects "PREMIUM" from active quotation
    const reqsSelectedPremium = { ...reqsNoTier, selectedTier: "PREMIUM" as const };
    quote.selectedTier = quote.tiers.find((t) => t.tierId === "PREMIUM");
    const snapshotPremium = createQuotationSnapshot(reqsSelectedPremium);
    const integrity = verifyQuotationIntegrity(snapshotPremium, reqsSelectedPremium, quote);
    assert(integrity.isMatch === true, "Customer can select 'PREMIUM' present in active quotation");
  }

  // ----------------------------------------------------------------------------
  // Test 10: Tier changes require a new quotation and confirmation
  // ----------------------------------------------------------------------------
  console.log("\nTest 10: Tier changes require a new quotation and confirmation");
  {
    const reqsBasic = { ...baseReqs, selectedTier: "BASIC" as const };
    const snapshotBasic = createQuotationSnapshot(reqsBasic);
    const quoteBasic = generateVoiceBookingQuotation(reqsBasic);

    // Customer attempts to confirm against BASIC quote while changing tier to PREMIUM
    const reqsChangedToPremium = { ...baseReqs, selectedTier: "PREMIUM" as const };
    const integrity = verifyQuotationIntegrity(snapshotBasic, reqsChangedToPremium, quoteBasic);
    assert(integrity.isMatch === false, "Tier change from BASIC to PREMIUM rejected without re-quotation");
    assert(integrity.mismatchedFields.includes("selectedTier"), "Mismatched fields identifies 'selectedTier'");
  }

  // ----------------------------------------------------------------------------
  // Test 11: Staff approval audit records authenticated identity and role
  // ----------------------------------------------------------------------------
  console.log("\nTest 11: Staff approval audit records authenticated identity and role");
  {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919888877777", "en");
    session.state = "awaiting_staff_approval";
    session.requirements = { ...baseReqs, customerConfirmed: true };
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await repo.save(session);

    const approved = await approveBookingByStaff(
      session.id,
      {
        staffIdentity: "usr_lead_barista_44",
        staffRole: "barista",
        staffApprovalId: "appr_test_audit_99",
      },
      repo
    );

    assert(approved.state === "booking_confirmed", "Session advanced to booking_confirmed");
    assert(approved.staffApprovalId === "appr_test_audit_99", "staffApprovalId recorded on session");
    assert(approved.staffApprovalAudit !== null && approved.staffApprovalAudit !== undefined, "Structured staffApprovalAudit record created");
    assert(approved.staffApprovalAudit!.staffIdentity === "usr_lead_barista_44", "Audit record preserves staffIdentity");
    assert(approved.staffApprovalAudit!.staffRole === "barista", "Audit record preserves staffRole");
    assert(approved.staffApprovalAudit!.staffApprovalId === "appr_test_audit_99", "Audit record preserves staffApprovalId");
    assert(approved.staffApprovalAudit!.sessionId === session.id, "Audit record preserves sessionId");
    assert(typeof approved.staffApprovalAudit!.approvedAt === "string" && approved.staffApprovalAudit!.approvedAt.endsWith("Z"), "Audit record has ISO UTC approvedAt");

    // Verify audit schema validation
    const auditParsed = StaffApprovalAuditRecordSchema.safeParse(approved.staffApprovalAudit);
    assert(auditParsed.success, "staffApprovalAudit conforms strictly to StaffApprovalAuditRecordSchema");
  }

  // ----------------------------------------------------------------------------
  // Test 12: Client-supplied audit identity cannot override server identity
  // ----------------------------------------------------------------------------
  console.log("\nTest 12: Client-supplied audit identity cannot override server identity");
  {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919666655555", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await repo.save(session);

    const legitimateBaristaToken = await createSessionToken({
      uid: "usr_genuine_barista_101",
      email: "barista101@brew.cafe",
      displayName: "Genuine Barista",
      role: "barista",
      sid: "sess_barista_101",
    });

    // Attacker sends request with spoofed staffRole 'admin' and staffIdentity 'attacker' in body
    const req = new NextRequest("http://127.0.0.1:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${legitimateBaristaToken}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
        staffApprovalId: "appr_client_supplied_id",
        staffIdentity: "attacker_spoof_identity",
        staffRole: "admin",
      }),
    });

    // Context derived strictly from server-side session
    const derivedContext = await deriveTrustedStaffAuthorizationContext({
      tokenOrRequest: req,
      staffApprovalId: "appr_client_supplied_id",
    });

    assert(derivedContext.staffIdentity === "usr_genuine_barista_101", "Client spoof identity was ignored; genuine server identity derived");
    assert(derivedContext.staffRole === "barista", "Client spoof role 'admin' was ignored; genuine server role 'barista' derived");
  }

  // ----------------------------------------------------------------------------
  // Test 13: Authentication errors map to HTTP 401
  // ----------------------------------------------------------------------------
  console.log("\nTest 13: Authentication errors map to HTTP 401");
  {
    // 13.1 Missing cookie
    const reqMissing = new NextRequest("http://127.0.0.1:3000/api/voice-booking/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "test-session" }),
    });
    const resMissing = await approveRouteHandler(reqMissing);
    assert(resMissing.status === 401, "Missing session cookie returns HTTP 401");

    // 13.2 Invalid token
    const reqInvalid = new NextRequest("http://127.0.0.1:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "brew_session=invalid.tampered.token",
      },
      body: JSON.stringify({ sessionId: "test-session" }),
    });
    const resInvalid = await approveRouteHandler(reqInvalid);
    assert(resInvalid.status === 401, "Invalid/tampered session cookie returns HTTP 401");

    // 13.3 Expired token
    const expiredToken = await createSessionToken({
      uid: "staff-expired",
      email: "expired@brew.cafe",
      displayName: "Expired Staff",
      role: "barista",
      sid: "sess_expired",
    });
    // Manually tamper expiration
    const [payloadB64, sigB64] = expiredToken.split(".");
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    decoded.expiresAt = Date.now() - 100000;
    const tamperedExpired = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sigB64}`;

    const reqExpired = new NextRequest("http://127.0.0.1:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${tamperedExpired}`,
      },
      body: JSON.stringify({ sessionId: "test-session" }),
    });
    const resExpired = await approveRouteHandler(reqExpired);
    assert(resExpired.status === 401, "Expired session returns HTTP 401");
  }

  // ----------------------------------------------------------------------------
  // Test 14: Customer role maps to HTTP 403
  // ----------------------------------------------------------------------------
  console.log("\nTest 14: Customer role maps to HTTP 403");
  {
    const customerToken = await createSessionToken({
      uid: "usr_customer_regular",
      email: "guest@example.com",
      displayName: "Guest",
      role: "customer",
    });

    const reqCustomer = new NextRequest("http://127.0.0.1:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${customerToken}`,
      },
      body: JSON.stringify({ sessionId: "test-session" }),
    });

    const resCustomer = await approveRouteHandler(reqCustomer);
    assert(resCustomer.status === 403, "Authenticated customer attempting approval returns HTTP 403 Forbidden");
    const json = await resCustomer.json();
    assert(json.error.includes("Forbidden") || json.error.includes("Customer"), "Error message explains customer forbidden status");
  }

  // ----------------------------------------------------------------------------
  // Test 15: Missing snapshot cannot bypass the confirmation gate
  // ----------------------------------------------------------------------------
  console.log("\nTest 15: Missing snapshot cannot bypass the confirmation gate");
  {
    const evaluationMissingSnapshot = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, I confirm the quotation!",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.99,
        confirmationIntent: "positive_acceptance",
        data: null,
      },
      hasValidQuotation: true,
      currentRequirements: baseReqs,
      quotationSnapshot: null, // MISSING SNAPSHOT
    });

    assert(evaluationMissingSnapshot.isConfirmed === false, "Missing snapshot fails closed at confirmation gate");
    assert(
      evaluationMissingSnapshot.reason.includes("Missing quotation snapshot"),
      "Reason indicates missing quotation snapshot"
    );
    assert(
      Boolean(evaluationMissingSnapshot.integrityResult?.mismatchedFields.includes("snapshot_missing")),
      "Integrity result flags snapshot_missing"
    );
  }

  // ----------------------------------------------------------------------------
  // Test 16: All existing Phase 6.1–6.2.3 regressions remain intact
  // ----------------------------------------------------------------------------
  console.log("\nTest 16: All existing Phase 6.1–6.2.3 regressions remain intact");
  {
    // Canonical version is v1
    assert(SNAPSHOT_CANONICAL_VERSION === "v1", "SNAPSHOT_CANONICAL_VERSION is 'v1'");

    // Deterministic payload serialization
    const p1 = buildCanonicalSnapshotPayload({
      durationHours: 3,
      eventDate: "2026-11-20",
      eventType: "corporate",
      guestCount: 100,
      selectedTier: "STANDARD",
      startTime: "14:00",
      venueAddress: "Jubilee Hills",
    });
    const p2 = buildCanonicalSnapshotPayload({
      guestCount: 100,
      selectedTier: "STANDARD",
      durationHours: 3,
      startTime: "14:00",
      venueAddress: "Jubilee Hills",
      eventDate: "2026-11-20",
      eventType: "corporate",
    });
    assert(p1 === p2, "Canonical snapshot payload serialization is completely deterministic regardless of property insertion order");

    // Full roundtrip confirmation and approval
    const repo = new InMemoryVoiceSessionRepository();
    let session = createVoiceBookingSession("+919555544444", "en");
    await repo.save(session);

    // Turn 1: Collecting details
    const turn1 = await processConversationTurn(
      session,
      "I need catering for 80 guests on 2026-12-10 at 11:00 for 4 hours at Hitec City corporate event",
      { sessionRepository: repo }
    );
    session = turn1.session;
    assert(session.state === "awaiting_customer_confirmation", "Turn 1 reaches awaiting_customer_confirmation");
    assert(session.quotation !== null, "Quotation generated");
    assert(session.quotationSnapshot !== null, "Quotation snapshot generated and attached");

    // Turn 2: Customer confirms
    const turn2 = await processConversationTurn(
      session,
      "Yes, please confirm the Artisanal Signature package!",
      { sessionRepository: repo }
    );
    session = turn2.session;
    assert(session.state === "awaiting_staff_approval", "Turn 2 transitions to awaiting_staff_approval");
    assert(session.requirements.customerConfirmed === true, "customerConfirmed recorded true");

    // Turn 3: Staff approves
    const approved = await approveBookingByStaff(
      session.id,
      {
        staffIdentity: "usr_barista_master",
        staffRole: "barista",
        staffApprovalId: "appr_final_master_1",
      },
      repo
    );
    assert(approved.state === "booking_confirmed", "Session reached booking_confirmed");
    assert(approved.staffApprovalAudit?.staffIdentity === "usr_barista_master", "Audit preserves authorized staffIdentity");
  }

  // ----------------------------------------------------------------------------
  // Final Results
  // ----------------------------------------------------------------------------
  console.log("==================================================================");
  console.log(`  PHASE 6.2.4 SUITE SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("==================================================================");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runPhase624Tests().catch((err) => {
  console.error("Unhandled error in Phase 6.2.4 hardening suite:", err);
  process.exit(1);
});
