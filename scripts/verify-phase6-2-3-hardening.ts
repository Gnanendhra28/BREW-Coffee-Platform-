/**
 * BREW Coffee Platform — Phase 6.2.3 Hardening Verification Suite
 * Full Quotation Snapshot Integrity & Trusted Server-Side Staff Authorization
 *
 * Test Groups:
 * 1. Changed event date prevents confirmation against old quotation
 * 2. Changed start time prevents confirmation against old quotation
 * 3. Changed duration prevents confirmation against old quotation
 * 4. Changed venue prevents confirmation against old quotation
 * 5. Changed tier prevents confirmation against old quotation
 * 6. Changed event type prevents confirmation when it affects quote calculation
 * 7. Unchanged quotation snapshot permits valid confirmation
 * 8. Re-quotation after a change requires a new customer confirmation
 * 9. Malformed staff context is rejected by runtime schema validation
 * 10. A client-supplied admin role cannot bypass server-side authentication
 * 11. Missing or expired staff session is rejected at the HTTP boundary
 * 12. Existing approved staff roles remain authorized after proper authentication
 * 13. Existing Phase 6.1–6.2.2 regression behavior remains intact
 */

import { NextRequest } from "next/server";
import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
  verifyQuotationIntegrity,
  evaluateConfirmationSafetyGate,
  InMemoryVoiceSessionRepository,
  BookingRequirements,
  VoiceBookingSession,
  StaffAuthorizationContextSchema,
} from "../src/lib/voiceBooking";
import { createSessionToken } from "../src/lib/authTokens";
import {
  verifyStaffSession,
  deriveTrustedStaffAuthorizationContext,
  authenticateAndApproveBooking,
} from "../src/lib/auth/adminAuth";
import { POST as approveRouteHandler } from "../src/app/api/voice-booking/approve/route";

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passedCount++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failedCount++;
  }
}

async function runPhase623Tests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.3 Full Integrity & Staff Auth Suite");
  console.log("==================================================================\n");

  const repository = new InMemoryVoiceSessionRepository();

  function buildBaseRequirements(): BookingRequirements {
    return {
      guestCount: 100,
      eventDate: "2026-11-20",
      startTime: "14:00",
      durationHours: 3,
      venueAddress: "HITEC City, Hyderabad",
      eventType: "corporate",
      beveragePreferences: ["cold brew", "latte"],
      selectedTier: "STANDARD",
      missingFields: [],
      corrections: [],
      customerConfirmed: false,
      handoffRequested: false,
      confidenceScore: 0.95,
      unresolvedQuestions: [],
    };
  }

  async function createQuotationReadySession(id: string): Promise<VoiceBookingSession> {
    const session = createVoiceBookingSession("+919876543210", "en");
    session.id = id;
    session.requirements = buildBaseRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_customer_confirmation";
    await repository.save(session);
    return session;
  }

  // ============================================================================
  // Test 1: Changed event date prevents confirmation against old quotation
  // ============================================================================
  console.log("Test 1: Changed event date prevents confirmation against old quotation");
  {
    const reqs = buildBaseRequirements();
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    // Customer attempts to confirm but eventDate was modified to next day
    const modifiedReqs = { ...reqs, eventDate: "2026-11-21" };
    const integrity = verifyQuotationIntegrity(snapshot, modifiedReqs, quote);

    assert(!integrity.isMatch, "Integrity check detects eventDate mismatch");
    assert(integrity.mismatchedFields.includes("eventDate"), "Mismatched fields list includes 'eventDate'");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm it please",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: modifiedReqs,
      quotationSnapshot: snapshot,
    });

    assert(!evaluation.isConfirmed, "Confirmation blocked when eventDate differs from snapshot");
    assert(evaluation.intent === "modification_requested", "Intent routed to modification_requested");
  }

  // ============================================================================
  // Test 2: Changed start time prevents confirmation against old quotation
  // ============================================================================
  console.log("\nTest 2: Changed start time prevents confirmation against old quotation");
  {
    const reqs = buildBaseRequirements();
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    const modifiedReqs = { ...reqs, startTime: "16:00" };
    const integrity = verifyQuotationIntegrity(snapshot, modifiedReqs, quote);

    assert(!integrity.isMatch, "Integrity check detects startTime mismatch");
    assert(integrity.mismatchedFields.includes("startTime"), "Mismatched fields list includes 'startTime'");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, proceed with this quote",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: modifiedReqs,
      quotationSnapshot: snapshot,
    });

    assert(!evaluation.isConfirmed, "Confirmation blocked when startTime differs from snapshot");
  }

  // ============================================================================
  // Test 3: Changed duration prevents confirmation against old quotation
  // ============================================================================
  console.log("\nTest 3: Changed duration prevents confirmation against old quotation");
  {
    const reqs = buildBaseRequirements();
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    const modifiedReqs = { ...reqs, durationHours: 5 };
    const integrity = verifyQuotationIntegrity(snapshot, modifiedReqs, quote);

    assert(!integrity.isMatch, "Integrity check detects durationHours mismatch");
    assert(integrity.mismatchedFields.includes("durationHours"), "Mismatched fields includes 'durationHours'");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, book it",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: modifiedReqs,
      quotationSnapshot: snapshot,
    });

    assert(!evaluation.isConfirmed, "Confirmation blocked when durationHours differs from snapshot");
  }

  // ============================================================================
  // Test 4: Changed venue prevents confirmation against old quotation
  // ============================================================================
  console.log("\nTest 4: Changed venue prevents confirmation against old quotation");
  {
    const reqs = buildBaseRequirements();
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    const modifiedReqs = { ...reqs, venueAddress: "Gachibowli, Hyderabad" };
    const integrity = verifyQuotationIntegrity(snapshot, modifiedReqs, quote);

    assert(!integrity.isMatch, "Integrity check detects venueAddress mismatch");
    assert(integrity.mismatchedFields.includes("venueAddress"), "Mismatched fields includes 'venueAddress'");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: modifiedReqs,
      quotationSnapshot: snapshot,
    });

    assert(!evaluation.isConfirmed, "Confirmation blocked when venueAddress differs from snapshot");
  }

  // ============================================================================
  // Test 5: Changed tier prevents confirmation against old quotation
  // ============================================================================
  console.log("\nTest 5: Changed tier prevents confirmation against old quotation");
  {
    const reqs = { ...buildBaseRequirements(), selectedTier: "BASIC" as const };
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    // Customer shifts tier from BASIC to PREMIUM without re-quotation
    const modifiedReqs = { ...reqs, selectedTier: "PREMIUM" as const };
    const integrity = verifyQuotationIntegrity(snapshot, modifiedReqs, quote);

    assert(!integrity.isMatch, "Integrity check detects selectedTier mismatch");
    assert(integrity.mismatchedFields.includes("selectedTier"), "Mismatched fields includes 'selectedTier'");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, book the premium package",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: modifiedReqs,
      quotationSnapshot: snapshot,
    });

    assert(!evaluation.isConfirmed, "Confirmation blocked when selectedTier differs from snapshot");
  }

  // ============================================================================
  // Test 6: Changed event type prevents confirmation when it affects quote calculation
  // ============================================================================
  console.log("\nTest 6: Changed event type prevents confirmation when it affects quote calculation");
  {
    const reqs = { ...buildBaseRequirements(), eventType: "corporate" };
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    // Wedding has different consumption multipliers in Event Booking Concierge
    const modifiedReqs = { ...reqs, eventType: "wedding" };
    const integrity = verifyQuotationIntegrity(snapshot, modifiedReqs, quote);

    assert(!integrity.isMatch, "Integrity check detects eventType mismatch");
    assert(integrity.mismatchedFields.includes("eventType"), "Mismatched fields includes 'eventType'");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: modifiedReqs,
      quotationSnapshot: snapshot,
    });

    assert(!evaluation.isConfirmed, "Confirmation blocked when eventType differs from snapshot");
  }

  // ============================================================================
  // Test 7: Unchanged quotation snapshot permits valid confirmation
  // ============================================================================
  console.log("\nTest 7: Unchanged quotation snapshot permits valid confirmation");
  {
    const reqs = buildBaseRequirements();
    const snapshot = createQuotationSnapshot(reqs);
    const quote = generateVoiceBookingQuotation(reqs);

    const integrity = verifyQuotationIntegrity(snapshot, reqs, quote);
    assert(integrity.isMatch, "Integrity check passes when requirements are identical");
    assert(integrity.mismatchedFields.length === 0, "Zero mismatched fields for unchanged requirements");

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm this quote and proceed with booking.",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.95,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotation: quote,
      currentRequirements: reqs,
      quotationSnapshot: snapshot,
    });

    assert(evaluation.isConfirmed, "Unchanged quotation snapshot permits valid confirmation");
    assert(evaluation.intent === "positive_acceptance", "Intent is positive_acceptance");
  }

  // ============================================================================
  // Test 8: Re-quotation after a change requires a new customer confirmation
  // ============================================================================
  console.log("\nTest 8: Re-quotation after a change requires a new customer confirmation");
  {
    const session = await createQuotationReadySession("sess_requote_test");

    // Turn 1: Customer modifies guestCount from 100 to 180
    const turn1 = await processConversationTurn(
      session,
      "Actually, can we make that 180 guests instead?",
      { sessionRepository: repository }
    );

    assert(turn1.session.quotation !== null, "New quotation was generated for 180 guests");
    assert(turn1.session.quotationSnapshot?.guestCount === 180, "New quotation snapshot reflects 180 guests");
    assert(
      turn1.session.requirements.customerConfirmed === false,
      "customerConfirmed was NOT automatically set to true after re-quotation"
    );
    assert(
      turn1.session.state === "awaiting_customer_confirmation",
      "Session awaits customer confirmation on the new quotation"
    );

    // Turn 2: Customer reviews and provides new explicit confirmation
    const turn2 = await processConversationTurn(
      turn1.session,
      "Yes, this updated quote looks great. Please confirm it.",
      { sessionRepository: repository }
    );

    assert(
      turn2.session.requirements.customerConfirmed === true,
      "customerConfirmed set to true only after customer reviews and confirms updated quote"
    );
    assert(
      turn2.session.state === "awaiting_staff_approval",
      "Session advances to awaiting_staff_approval"
    );
  }

  // ============================================================================
  // Test 9: Malformed staff context is rejected by runtime schema validation
  // ============================================================================
  console.log("\nTest 9: Malformed staff context is rejected by runtime schema validation");
  {
    const session = await createQuotationReadySession("sess_schema_guard_test");
    session.state = "awaiting_staff_approval";
    await repository.save(session, session.revision);

    // 9.1 Missing staffIdentity
    let err1 = false;
    try {
      await approveBookingByStaff(
        session.id,
        // @ts-expect-error Testing missing staffIdentity at runtime
        { staffRole: "barista", staffApprovalId: "APP_1" },
        repository
      );
    } catch (e: unknown) {
      err1 = true;
      assert(
        (e as Error).message.includes("staffIdentity"),
        "Rejected context missing staffIdentity"
      );
    }
    assert(err1, "Schema guard caught missing staffIdentity");

    // 9.2 Missing staffApprovalId
    let err2 = false;
    try {
      await approveBookingByStaff(
        session.id,
        // @ts-expect-error Testing missing staffApprovalId at runtime
        { staffIdentity: "staff_1", staffRole: "barista" },
        repository
      );
    } catch (e: unknown) {
      err2 = true;
      assert(
        (e as Error).message.includes("staffApprovalId"),
        "Rejected context missing staffApprovalId"
      );
    }
    assert(err2, "Schema guard caught missing staffApprovalId");

    // 9.3 Invalid role
    let err3 = false;
    try {
      await approveBookingByStaff(
        session.id,
        { staffIdentity: "staff_1", staffRole: "manager" as unknown as "barista", staffApprovalId: "APP_1" },
        repository
      );
    } catch (e: unknown) {
      err3 = true;
      assert(
        (e as Error).message.includes("manager") || (e as Error).message.includes("staffRole"),
        "Rejected context with unauthorized role"
      );
    }
    assert(err3, "Schema guard caught invalid staffRole");

    // 9.4 Non-object context
    let err4 = false;
    try {
      // @ts-expect-error Testing non-object context at runtime
      await approveBookingByStaff(session.id, "string_context", repository);
    } catch {
      err4 = true;
    }
    assert(err4, "Schema guard caught non-object context");
  }

  // ============================================================================
  // Test 10: A client-supplied admin role cannot bypass server-side authentication
  // ============================================================================
  console.log("\nTest 10: A client-supplied admin role cannot bypass server-side authentication");
  {
    const session = await createQuotationReadySession("sess_forgery_test");
    session.state = "awaiting_staff_approval";
    await repository.save(session, session.revision);

    // Generate genuine customer session token (unprivileged user)
    const customerToken = await createSessionToken({
      uid: "cust_attacker_99",
      email: "attacker@external.com",
      displayName: "Attacker",
      role: "customer",
    });

    // Attacker crafts HTTP request with body claiming: staffRole: "admin", staffIdentity: "root"
    const forgedRequest = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `brew_session=${customerToken}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
        staffRole: "admin", // FORGED CLIENT PARAMETER
        staffIdentity: "admin_super_user", // FORGED CLIENT PARAMETER
        staffApprovalId: "FORGED_APPROVAL_777",
      }),
    });

    const response = await approveRouteHandler(forgedRequest);
    const body = await response.json();

    assert(
      response.status === 401 || response.status === 403,
      `HTTP boundary rejected customer token attempting admin bypass (HTTP ${response.status})`
    );
    assert(
      body.error?.includes("Authentication") || body.error?.includes("Forbidden") || body.error !== undefined,
      "Error reflects rejection of unprivileged customer credentials"
    );

    // Verify session remained in 'awaiting_staff_approval'
    const unchanged = await repository.getById(session.id);
    assert(
      unchanged?.state === "awaiting_staff_approval",
      "Session state was NOT mutated by forged client admin parameters"
    );
  }

  // ============================================================================
  // Test 11: Missing or expired staff session is rejected at the HTTP boundary
  // ============================================================================
  console.log("\nTest 11: Missing or expired staff session is rejected at the HTTP boundary");
  {
    const session = await createQuotationReadySession("sess_expired_test");
    session.state = "awaiting_staff_approval";
    await repository.save(session, session.revision);

    // 11.1 Missing cookie
    const missingCookieReq = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    });

    const resMissing = await approveRouteHandler(missingCookieReq);
    assert(
      resMissing.status === 401,
      "Missing brew_session cookie returns HTTP 401 Unauthorized"
    );

    // 11.2 Expired token check via verifyStaffSession
    const expiredPayload = {
      uid: "barista_old",
      role: "barista" as const,
      email: "old@brew.com",
      displayName: "Old Barista",
    };
    // Create token that expired 1 hour ago
    const validToken = await createSessionToken(expiredPayload);
    // Tamper payload expiration to force expiration rejection
    const parts = validToken.split(".");
    const decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    decoded.expiresAt = Date.now() - 3600000;
    const expiredTamperedToken = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${parts[1]}`;

    const expiredReq = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `brew_session=${expiredTamperedToken}`,
      },
      body: JSON.stringify({ sessionId: session.id }),
    });

    const resExpired = await approveRouteHandler(expiredReq);
    assert(
      resExpired.status === 401,
      "Expired/tampered session cookie returns HTTP 401 Unauthorized"
    );
  }

  // ============================================================================
  // Test 12: Existing approved staff roles remain authorized after proper authentication
  // ============================================================================
  console.log("\nTest 12: Existing approved staff roles remain authorized after proper authentication");
  {
    const roles = ["barista", "fleet_admin"] as const;

    for (const role of roles) {
      const sessId = `sess_valid_auth_${role}`;
      const session = await createQuotationReadySession(sessId);
      session.state = "awaiting_staff_approval";
      await repository.save(session, session.revision);

      // Create genuine HMAC-signed token
      const token = await createSessionToken({
        uid: `staff_${role}_442`,
        email: `${role}@brew.coffee`,
        displayName: `Authorized ${role}`,
        role,
      });

      // Verify token through adminAuth helper
      const verified = await verifyStaffSession(token);
      assert(verified !== null && verified.role === role, `verifyStaffSession verified role '${role}'`);

      // Derive trusted context
      const trustedContext = await deriveTrustedStaffAuthorizationContext({
        tokenOrRequest: token,
        staffApprovalId: `AUDIT_${role.toUpperCase()}_991`,
      });

      assert(
        trustedContext.staffIdentity === `staff_${role}_442`,
        `Staff identity derived from verified session uid for '${role}'`
      );
      assert(
        trustedContext.staffRole === role,
        `Staff role derived from verified session for '${role}'`
      );

      // Approve via end-to-end server function
      const approved = await authenticateAndApproveBooking({
        sessionId: session.id,
        tokenOrRequest: token,
        staffApprovalId: `AUDIT_${role.toUpperCase()}_991`,
        repository,
      });

      assert(approved.state === "booking_confirmed", `Role '${role}' successfully approved session to booking_confirmed`);
      assert(
        approved.staffApprovalId === `AUDIT_${role.toUpperCase()}_991`,
        `Audit trail ID correctly recorded for role '${role}'`
      );
    }
  }

  // ============================================================================
  // Test 13: Existing Phase 6.1–6.2.2 regression behavior remains intact
  // ============================================================================
  console.log("\nTest 13: Existing Phase 6.1–6.2.2 regression behavior remains intact");
  {
    const regressionSession = createVoiceBookingSession("+919876543210", "en");
    regressionSession.id = "p623_regression_e2e";
    await repository.save(regressionSession);

    // Multi-turn booking flow with snapshot verification
    const turn1 = await processConversationTurn(
      regressionSession,
      "We want 120 guests on 2026-11-20 at 14:00 for 3 hours in HITEC City for a corporate event with cold brew, package 2 please.",
      { sessionRepository: repository }
    );

    assert(turn1.state === "awaiting_customer_confirmation", "Presents quote and awaits confirmation");
    assert(turn1.session.quotation !== null, "Quotation generated");
    assert(turn1.session.quotationSnapshot !== null, "Quotation snapshot generated and attached to session");
    assert(turn1.session.quotationSnapshot?.guestCount === 120, "Snapshot accurately recorded 120 guests");

    const turn2 = await processConversationTurn(
      turn1.session,
      "Yes, please confirm this quote.",
      { sessionRepository: repository }
    );

    assert(turn2.state === "awaiting_staff_approval", "Turn 2 confirmed and awaits staff approval");
    assert(turn2.extractedRequirements.customerConfirmed === true, "customerConfirmed recorded true");

    // Server-side approval
    const staffToken = await createSessionToken({
      uid: "barista_lead_77",
      email: "lead@brew.coffee",
      displayName: "Lead Barista",
      role: "barista",
    });

    const approved = await authenticateAndApproveBooking({
      sessionId: "p623_regression_e2e",
      tokenOrRequest: staffToken,
      repository,
    });

    assert(approved.state === "booking_confirmed", "Booking confirmed by authenticated barista");
    assert(StaffAuthorizationContextSchema.safeParse({
      staffIdentity: "barista_lead_77",
      staffRole: "barista",
      staffApprovalId: approved.staffApprovalId!,
    }).success, "Final approval context conforms to strict schema");
  }

  // ============================================================================
  // Summary
  // ============================================================================
  console.log("\n==================================================================");
  console.log(`  PHASE 6.2.3 SUITE SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runPhase623Tests().catch((err) => {
  console.error("Unhandled test suite exception:", err);
  process.exit(1);
});
