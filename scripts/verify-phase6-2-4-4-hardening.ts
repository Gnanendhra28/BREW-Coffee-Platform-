/**
 * BREW Coffee Platform — Phase 6.2.4.4 Verification Suite
 * Targeted Review Fixes and Regression Verification
 * 
 * Verifies:
 * 1. Legacy staffApprovalAudit handling:
 *    - Legacy session with staffApprovalAudit omitted (undefined) proceeds to approval without false duplicate-rejection.
 *    - Session with staffApprovalAudit: null proceeds to approval without false duplicate-rejection.
 *    - Session with existing genuine staffApprovalAudit record blocks duplicate approval.
 *    - Subsequent approval attempt on newly approved session is rejected with HTTP 409 Conflict.
 * 2. Real extra-logistics verifier test:
 *    - Authoritative quote has no logistics, active quote has logistics -> rejected by verifyQuotationIntegrity().
 *    - Authoritative quote has logistics, active quote has no logistics -> rejected by verifyQuotationIntegrity().
 * 3. Ingredient manifest unit alteration test:
 *    - Modifying only the 'unit' field in active quotation is rejected by verifyQuotationIntegrity().
 *    - Verifies all other manifest variations (missing, extra, missing item, altered quantity, altered unit cost, altered total cost).
 * 4. Mandatory atomic approval contract:
 *    - Repository missing atomicApproveBooking fails closed immediately.
 *    - Process-local mutex serializes concurrent approvals via Promise.all (exactly one 200, one 409).
 */

import assert from "assert";
import { NextRequest } from "next/server";
import {
  BookingRequirements,
  createQuotationSnapshot,
  verifyQuotationIntegrity,
  generateVoiceBookingQuotation,
  createVoiceBookingSession,
  approveBookingByStaff,
  defaultSessionRepository,
  VoiceSessionRepository,
  StaffAuthorizationContext,
} from "../src/lib/voiceBooking";
import { createSessionToken } from "../src/lib/authTokens";
import { POST as approveRouteHandler } from "../src/app/api/voice-booking/approve/route";

async function runPhase6244Tests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.4.4 Targeted Fixes & Regression Suite");
  console.log("==================================================================");

  const TEST_SECRET = "p6244-test-secret-key-32-chars-long!";
  process.env.QUOTATION_SNAPSHOT_SECRET = TEST_SECRET;

  const baseReqs: BookingRequirements = {
    guestCount: 80,
    eventDate: "2026-12-18",
    startTime: "15:00",
    durationHours: 3,
    venueAddress: "Banjara Hills, Road No 10, Hyderabad",
    selectedTier: "STANDARD",
    eventType: "corporate",
    beveragePreferences: [],
    handoffRequested: false,
    customerConfirmed: false,
    confidenceScore: 1.0,
    missingFields: [],
    unresolvedQuestions: [],
    corrections: [],
  };

  const authQuote = generateVoiceBookingQuotation(baseReqs);
  const authSnapshot = createQuotationSnapshot(baseReqs);

  // ----------------------------------------------------------------------------
  // SECTION 1: Legacy staffApprovalAudit Semantics & Duplicate Approval
  // ----------------------------------------------------------------------------
  console.log("\nSection 1: Legacy staffApprovalAudit Semantics & Duplicate Approval");

  const baristaToken = await createSessionToken({
    uid: "usr_barista_p6244",
    email: "barista_p6244@brew.cafe",
    displayName: "Lead Barista P6244",
    role: "barista",
    sid: "sess_barista_p6244",
  });

  const authContext: StaffAuthorizationContext = {
    staffIdentity: "usr_barista_p6244",
    staffRole: "barista",
    staffApprovalId: "appr_test_legacy_001",
  };

  // 1.1 Legacy session with staffApprovalAudit completely omitted (undefined)
  {
    defaultSessionRepository.clear();
    const session = createVoiceBookingSession("+919888811111", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    // Explicitly delete staffApprovalAudit to simulate legacy database record
    delete session.staffApprovalAudit;
    assert.strictEqual(session.staffApprovalAudit, undefined, "staffApprovalAudit is undefined on legacy session");
    await defaultSessionRepository.save(session);

    // Legacy session without audit must NOT be falsely classified as already approved!
    const approved = await approveBookingByStaff(session.id, authContext, defaultSessionRepository);
    assert.strictEqual(approved.state, "booking_confirmed", "Legacy session approved successfully");
    assert(approved.staffApprovalAudit != null, "Genuine audit record generated on approval");
    assert.strictEqual(approved.staffApprovalAudit?.staffIdentity, "usr_barista_p6244");
    console.log("  ✓ Legacy session with omitted (undefined) staffApprovalAudit approved without false rejection");
  }

  // 1.2 Session with staffApprovalAudit: null
  {
    defaultSessionRepository.clear();
    const session = createVoiceBookingSession("+919888822222", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    session.staffApprovalAudit = null;
    await defaultSessionRepository.save(session);

    const approved = await approveBookingByStaff(session.id, authContext, defaultSessionRepository);
    assert.strictEqual(approved.state, "booking_confirmed", "Session with null audit approved successfully");
    assert(approved.staffApprovalAudit != null, "Genuine audit record generated on approval");
    console.log("  ✓ Session with staffApprovalAudit: null approved without false rejection");
  }

  // 1.3 Session with existing genuine audit record blocks duplicate approval
  {
    defaultSessionRepository.clear();
    const session = createVoiceBookingSession("+919888833333", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    session.staffApprovalAudit = {
      staffIdentity: "usr_prior_barista",
      staffRole: "barista",
      staffApprovalId: "appr_existing_prior",
      approvedAt: new Date().toISOString(),
      sessionId: session.id,
    };
    await defaultSessionRepository.save(session);

    // Must be rejected by approveBookingByStaff
    await assert.rejects(
      async () => {
        await approveBookingByStaff(session.id, authContext, defaultSessionRepository);
      },
      /already been approved and confirmed/,
      "Existing audit record strictly blocks approval"
    );

    // Must also be rejected with HTTP 409 Conflict via route handler
    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${baristaToken}`,
      },
      body: JSON.stringify({ sessionId: session.id }),
    });
    const res = await approveRouteHandler(req);
    assert.strictEqual(res.status, 409, "Duplicate approval returns HTTP 409 Conflict");
    console.log("  ✓ Session with existing audit record strictly blocks duplicate approval (HTTP 409)");
  }

  // 1.4 Newly approved session blocks subsequent approval attempt
  {
    defaultSessionRepository.clear();
    const session = createVoiceBookingSession("+919888844444", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    // First approval succeeds
    const firstReq = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${baristaToken}`,
      },
      body: JSON.stringify({ sessionId: session.id }),
    });
    const firstRes = await approveRouteHandler(firstReq);
    assert.strictEqual(firstRes.status, 200, "First approval returns HTTP 200 OK");

    // Second approval attempt returns HTTP 409 Conflict
    const secondReq = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${baristaToken}`,
      },
      body: JSON.stringify({ sessionId: session.id }),
    });
    const secondRes = await approveRouteHandler(secondReq);
    assert.strictEqual(secondRes.status, 409, "Second approval returns HTTP 409 Conflict");
    console.log("  ✓ Subsequent approval attempt on confirmed session returns HTTP 409 Conflict");
  }

  // ----------------------------------------------------------------------------
  // SECTION 2: Real Logistics Presence Verifier Tests
  // ----------------------------------------------------------------------------
  console.log("\nSection 2: Real Logistics Presence Verifier Tests");

  // 2.1 Authoritative quote has no logistics, active quote has logistics -> REJECTED BY VERIFIER
  {
    const quoteWithoutLogistics = JSON.parse(JSON.stringify(authQuote));
    const activeWithLogistics = JSON.parse(JSON.stringify(authQuote));
    delete quoteWithoutLogistics.logistics;

    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, activeWithLogistics, {
      authoritativeQuoteOverride: quoteWithoutLogistics,
    });
    assert.strictEqual(res.isMatch, false, "Extra logistics in active quote must be rejected");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Actual verifier rejects active quote when authoritative quote has no logistics");
  }

  // 2.2 Authoritative quote has logistics, active quote has no logistics -> REJECTED BY VERIFIER
  {
    const activeWithoutLogistics = JSON.parse(JSON.stringify(authQuote));
    delete activeWithoutLogistics.logistics;

    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, activeWithoutLogistics);
    assert.strictEqual(res.isMatch, false, "Missing logistics in active quote must be rejected");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Actual verifier rejects active quote when missing logistics");
  }

  // ----------------------------------------------------------------------------
  // SECTION 3: Ingredient Manifest Unit & Value Regression Tests
  // ----------------------------------------------------------------------------
  console.log("\nSection 3: Ingredient Manifest Unit & Value Regression Tests");

  // 3.1 Altering only the 'unit' field of an ingredient item
  {
    const tamperedUnit = JSON.parse(JSON.stringify(authQuote));
    assert(tamperedUnit.ingredientManifest.length > 0, "Manifest has items");
    const originalUnit = tamperedUnit.ingredientManifest[0].unit;
    tamperedUnit.ingredientManifest[0].unit = originalUnit === "kg" ? "lbs" : "kg";

    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tamperedUnit);
    assert.strictEqual(res.isMatch, false, "Altered manifest unit must be rejected");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Actual verifier rejects active quote with altered ingredient manifest unit");
  }

  // 3.2 Missing ingredient manifest
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    delete tampered.ingredientManifest;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Missing manifest must be rejected");
    assert(res.mismatchedFields.includes("quotation_pricing_mismatch"));
    console.log("  ✓ Actual verifier rejects missing ingredient manifest");
  }

  // 3.3 Extra ingredient manifest item
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest.push({
      ingredient: "Extra Luxury Cinnamon Sticks",
      quantity: 10,
      unit: "sticks",
      unitCost: 15,
      totalCost: 150,
      inStockQuantity: 20,
      shortfallQuantity: 0,
      procurementRequired: false,
    });
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Extra manifest item must be rejected");
    assert(res.mismatchedFields.includes("quotation_pricing_mismatch"));
    console.log("  ✓ Actual verifier rejects extra ingredient manifest item");
  }

  // 3.4 Missing individual manifest item
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest.pop();
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Missing individual manifest item must be rejected");
    assert(res.mismatchedFields.includes("quotation_pricing_mismatch"));
    console.log("  ✓ Actual verifier rejects missing individual manifest item");
  }

  // 3.5 Altered individual manifest item quantity
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].quantity += 10;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered quantity must be rejected");
    assert(res.mismatchedFields.includes("quotation_pricing_mismatch"));
    console.log("  ✓ Actual verifier rejects altered manifest item quantity");
  }

  // 3.6 Altered individual manifest item unitCost
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].unitCost += 25;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered unitCost must be rejected");
    assert(res.mismatchedFields.includes("quotation_pricing_mismatch"));
    console.log("  ✓ Actual verifier rejects altered manifest item unitCost");
  }

  // 3.7 Altered individual manifest item totalCost
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].totalCost += 250;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered totalCost must be rejected");
    assert(res.mismatchedFields.includes("quotation_pricing_mismatch"));
    console.log("  ✓ Actual verifier rejects altered manifest item totalCost");
  }

  // ----------------------------------------------------------------------------
  // SECTION 4: Mandatory Atomic Approval Contract & Concurrency
  // ----------------------------------------------------------------------------
  console.log("\nSection 4: Mandatory Atomic Approval Contract & Concurrency");

  // 4.1 Repository lacking atomicApproveBooking fails closed
  {
    const mockRepo: VoiceSessionRepository = {
      getById: async () => null,
      save: async () => {},
      getByPhoneNumber: async () => null,
      // @ts-expect-error Testing mandatory contract enforcement at runtime
      atomicApproveBooking: undefined,
    };

    await assert.rejects(
      async () => {
        await approveBookingByStaff("vbs_test_contract", authContext, mockRepo);
      },
      /Repository contract violation: repository does not implement mandatory atomicApproveBooking/,
      "Missing atomicApproveBooking fails closed immediately"
    );
    console.log("  ✓ Missing atomicApproveBooking fails closed immediately with contract error");
  }

  // 4.2 Concurrent execution produces exactly one HTTP 200 and one HTTP 409
  {
    defaultSessionRepository.clear();
    const session = createVoiceBookingSession("+919888855555", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    const createReq = () =>
      new NextRequest("http://localhost:3000/api/voice-booking/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `brew_session=${baristaToken}`,
        },
        body: JSON.stringify({ sessionId: session.id }),
      });

    const [res1, res2] = await Promise.all([
      approveRouteHandler(createReq()),
      approveRouteHandler(createReq()),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 409],
      "Exactly one request succeeds (200) and one fails with Conflict (409)"
    );
    console.log("  ✓ Process-local mutex serializes concurrent requests: exactly one 200 and one 409");
  }

  console.log("\n==================================================================");
  console.log("  PHASE 6.2.4.4 SUITE SUMMARY: ALL 15 REGRESSION TESTS PASSED");
  console.log("==================================================================");
}

runPhase6244Tests().catch((err) => {
  console.error("Unhandled error in Phase 6.2.4.4 verification suite:", err);
  process.exit(1);
});
