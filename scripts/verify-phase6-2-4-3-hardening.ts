/**
 * BREW Coffee Platform — Phase 6.2.4.3 Verification Suite
 * Final Fail-Closed Quotation and Repository Contract Hardening
 * 
 * Verifies:
 * 1. Mandatory logistics and ingredient manifest verification:
 *    - Missing logistics when authoritative logistics exist.
 *    - Extra logistics when authoritative logistics are absent.
 *    - Missing ingredient manifest.
 *    - Extra ingredient manifest.
 *    - Missing and altered individual manifest items (identity, quantity, unit cost, total cost).
 * 2. Bidirectional selected-tier consistency across all null/non-null combinations:
 *    - All three selected-tier values null: valid unselected state.
 *    - Requirements null, snapshot null, quotation selected: fails closed (selectedTier mismatch).
 *    - Requirements selected, snapshot null, quotation selected: fails closed (selectedTier mismatch).
 *    - Requirements selected, snapshot selected, quotation null: fails closed (selectedTier mismatch).
 *    - All three selected but different tiers: fails closed (selectedTier mismatch).
 *    - All three selected and identical tier: succeeds with isMatch: true.
 * 3. Mandatory atomic approval contract:
 *    - Repository implementation without atomicApproveBooking fails closed immediately.
 *    - Type checking enforces atomicApproveBooking as mandatory on VoiceSessionRepository.
 *    - Concurrent approval via Promise.all produces exactly one HTTP 200 and one HTTP 409.
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

async function runPhase6243Tests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.4.3 Final Hardening & Contract Suite");
  console.log("==================================================================");

  const TEST_SECRET = "p6243-test-secret-key-32-chars-long!";
  process.env.QUOTATION_SNAPSHOT_SECRET = TEST_SECRET;

  const baseReqs: BookingRequirements = {
    guestCount: 100,
    eventDate: "2026-12-20",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "Jubilee Hills, Road No 36, Hyderabad",
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

  // ----------------------------------------------------------------------------
  // SECTION 1: Mandatory Logistics & Ingredient Manifest Verification
  // ----------------------------------------------------------------------------
  console.log("\nSection 1: Mandatory Logistics & Ingredient Manifest Verification");

  const authQuote = generateVoiceBookingQuotation(baseReqs);
  const authSnapshot = createQuotationSnapshot(baseReqs);

  // 1.1 Missing logistics when authoritative logistics exist
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    delete tampered.logistics;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Missing logistics must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Missing logistics when authoritative logistics exist is strictly rejected");
  }

  // 1.2 Extra logistics when authoritative logistics are absent
  {
    const quoteWithoutLogistics = JSON.parse(JSON.stringify(authQuote));
    const extraLogisticsQuote = JSON.parse(JSON.stringify(authQuote));
    delete quoteWithoutLogistics.logistics;

    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, extraLogisticsQuote, {
      authoritativeQuoteOverride: quoteWithoutLogistics,
    });
    assert.strictEqual(res.isMatch, false, "Extra logistics when authoritative has none must be rejected");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Extra logistics when authoritative logistics are absent is strictly rejected by verifier");
  }

  // 1.3 Missing ingredient manifest
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    delete tampered.ingredientManifest;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Missing ingredientManifest must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Missing ingredient manifest is strictly rejected");
  }

  // 1.4 Extra ingredient manifest items
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest.push({
      ingredient: "Artisanal Vanilla Pod Extract Extra",
      quantity: 5,
      unit: "bottles",
      unitCost: 200,
      totalCost: 1000,
      inStockQuantity: 10,
      shortfallQuantity: 0,
      procurementRequired: false,
    });
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Extra manifest item must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Extra ingredient manifest item is strictly rejected");
  }

  // 1.5 Missing individual manifest item
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest = tampered.ingredientManifest.slice(1);
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Missing manifest item must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Missing individual manifest item is strictly rejected");
  }

  // 1.6 Altered individual manifest item identity
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].ingredient = "Substituted Cheap Coffee Beans";
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered manifest item identity must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Altered individual manifest item identity is strictly rejected");
  }

  // 1.7 Altered individual manifest item quantity
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].quantity += 25;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered manifest item quantity must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Altered individual manifest item quantity is strictly rejected");
  }

  // 1.8 Altered individual manifest item unitCost
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].unitCost += 15;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered manifest item unitCost must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Altered individual manifest item unitCost is strictly rejected");
  }

  // 1.9 Altered individual manifest item totalCost
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].totalCost += 100;
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered manifest item totalCost must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Altered individual manifest item totalCost is strictly rejected");
  }

  // 1.10 Altered individual manifest item unit
  {
    const tampered = JSON.parse(JSON.stringify(authQuote));
    tampered.ingredientManifest[0].unit = "gallons";
    const res = verifyQuotationIntegrity(authSnapshot, baseReqs, tampered);
    assert.strictEqual(res.isMatch, false, "Altered manifest item unit must fail closed");
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Mismatched fields includes quotation_pricing_mismatch"
    );
    console.log("  ✓ Altered individual manifest item unit is strictly rejected");
  }

  // ----------------------------------------------------------------------------
  // SECTION 2: Bidirectional Selected-Tier Consistency
  // ----------------------------------------------------------------------------
  console.log("\nSection 2: Bidirectional Selected-Tier Consistency");

  // 2.1 All three selected-tier values null: valid unselected state
  {
    const reqsNoTier: BookingRequirements = { ...baseReqs, selectedTier: null };
    const snapNoTier = createQuotationSnapshot(reqsNoTier);
    const quoteNoTier = generateVoiceBookingQuotation(reqsNoTier);

    assert.strictEqual(reqsNoTier.selectedTier, null, "Requirements selectedTier is null");
    assert.strictEqual(snapNoTier.selectedTier, null, "Snapshot selectedTier is null");
    assert.strictEqual(quoteNoTier.selectedTier, undefined, "Quotation selectedTier is undefined");

    const res = verifyQuotationIntegrity(snapNoTier, reqsNoTier, quoteNoTier);
    assert.strictEqual(res.isMatch, true, "All three null is valid unselected state");
    assert.strictEqual(res.mismatchedFields.length, 0);
    console.log("  ✓ All three selected-tier values null is valid unselected state");
  }

  // 2.2 Requirements null, snapshot null, quotation selected -> REJECTED
  {
    const reqsNoTier: BookingRequirements = { ...baseReqs, selectedTier: null };
    const snapNoTier = createQuotationSnapshot(reqsNoTier);
    const quoteWithSelectedTier = generateVoiceBookingQuotation(reqsNoTier);
    quoteWithSelectedTier.selectedTier = quoteWithSelectedTier.tiers[1]; // inject selected tier

    const res = verifyQuotationIntegrity(snapNoTier, reqsNoTier, quoteWithSelectedTier);
    assert.strictEqual(res.isMatch, false, "Quotation selected when reqs and snapshot null must fail");
    assert(res.mismatchedFields.includes("selectedTier"), "Mismatched fields includes selectedTier");
    console.log("  ✓ Requirements null, snapshot null, quotation selected is strictly rejected");
  }

  // 2.3 Requirements selected, snapshot null, quotation selected -> REJECTED
  {
    const reqsNoTier: BookingRequirements = { ...baseReqs, selectedTier: null };
    const snapNoTier = createQuotationSnapshot(reqsNoTier);
    const reqsSelected: BookingRequirements = { ...baseReqs, selectedTier: "STANDARD" };
    const quote = generateVoiceBookingQuotation(reqsSelected);

    const res = verifyQuotationIntegrity(snapNoTier, reqsSelected, quote);
    assert.strictEqual(res.isMatch, false, "Requirements selected but snapshot null must fail");
    assert(res.mismatchedFields.includes("selectedTier"), "Mismatched fields includes selectedTier");
    console.log("  ✓ Requirements selected, snapshot null, quotation selected is strictly rejected");
  }

  // 2.4 Requirements selected, snapshot selected, quotation null -> REJECTED
  {
    const reqsSelected: BookingRequirements = { ...baseReqs, selectedTier: "STANDARD" };
    const snapSelected = createQuotationSnapshot(reqsSelected);
    const quoteNoSelectedTier = generateVoiceBookingQuotation(reqsSelected);
    delete quoteNoSelectedTier.selectedTier;

    const res = verifyQuotationIntegrity(snapSelected, reqsSelected, quoteNoSelectedTier);
    assert.strictEqual(res.isMatch, false, "Quotation missing selected tier when requirements selected must fail");
    assert(res.mismatchedFields.includes("selectedTier"), "Mismatched fields includes selectedTier");
    console.log("  ✓ Requirements selected, snapshot selected, quotation null is strictly rejected");
  }

  // 2.5 All three selected but different tiers -> REJECTED
  {
    const reqsBasic: BookingRequirements = { ...baseReqs, selectedTier: "BASIC" };
    const reqsStandard: BookingRequirements = { ...baseReqs, selectedTier: "STANDARD" };
    const snapStandard = createQuotationSnapshot(reqsStandard);
    const quotePremium = generateVoiceBookingQuotation(reqsBasic);
    quotePremium.selectedTier = quotePremium.tiers.find((t) => t.tierId === "PREMIUM");

    const res = verifyQuotationIntegrity(snapStandard, reqsBasic, quotePremium);
    assert.strictEqual(res.isMatch, false, "Conflicting tiers across three sources must fail");
    assert(res.mismatchedFields.includes("selectedTier"), "Mismatched fields includes selectedTier");
    console.log("  ✓ All three selected but different tiers is strictly rejected");
  }

  // 2.6 All three selected and identical tier -> SUCCEEDS
  {
    const reqsSelected: BookingRequirements = { ...baseReqs, selectedTier: "STANDARD" };
    const snapSelected = createQuotationSnapshot(reqsSelected);
    const quoteSelected = generateVoiceBookingQuotation(reqsSelected);

    const res = verifyQuotationIntegrity(snapSelected, reqsSelected, quoteSelected);
    assert.strictEqual(res.isMatch, true, "All three agreeing on identical tier succeeds");
    assert.strictEqual(res.mismatchedFields.length, 0);
    console.log("  ✓ All three agreeing on identical tier passes verification");
  }

  // ----------------------------------------------------------------------------
  // SECTION 3: Mandatory Atomic Approval Contract Enforcement
  // ----------------------------------------------------------------------------
  console.log("\nSection 3: Mandatory Atomic Approval Contract Enforcement");

  // 3.1 Repository without atomicApproveBooking fails closed
  {
    const mockRepoWithoutAtomic: VoiceSessionRepository = {
      getById: async () => null,
      save: async () => {},
      getByPhoneNumber: async () => null,
      // @ts-expect-error Intentionally omitting mandatory atomicApproveBooking for fail-closed test
      atomicApproveBooking: undefined,
    };

    const authContext: StaffAuthorizationContext = {
      staffIdentity: "usr_barista_test",
      staffRole: "barista",
      staffApprovalId: "appr_test_123",
    };

    await assert.rejects(
      async () => {
        await approveBookingByStaff("vbs_test_session", authContext, mockRepoWithoutAtomic);
      },
      /Repository contract violation: repository does not implement mandatory atomicApproveBooking/,
      "Repository without atomicApproveBooking fails closed immediately"
    );
    console.log("  ✓ Repository implementation without atomic approval fails closed immediately");
  }

  // 3.2 Concurrent approval via Promise.all produces exactly one success
  {
    defaultSessionRepository.clear();

    const session = createVoiceBookingSession("+919666677777", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.requirements.selectedTier = "STANDARD";
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    const token = await createSessionToken({
      uid: "usr_concurrency_barista_p6243",
      email: "barista_p6243@brew.cafe",
      displayName: "Barista P6243",
      role: "barista",
      sid: "sess_barista_p6243",
    });

    const createReq = () =>
      new NextRequest("http://localhost:3000/api/voice-booking/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `brew_session=${token}`,
        },
        body: JSON.stringify({
          sessionId: session.id,
        }),
      });

    const [res1, res2] = await Promise.all([
      approveRouteHandler(createReq()),
      approveRouteHandler(createReq()),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 409],
      "Concurrent execution produces exactly one HTTP 200 and one HTTP 409 Conflict"
    );

    const saved = await defaultSessionRepository.getById(session.id);
    assert(saved, "Session exists in repository");
    assert.strictEqual(saved.state, "booking_confirmed", "Session confirmed");
    assert(saved.staffApprovalAudit !== null, "Audit record committed");
    console.log("  ✓ Concurrent approval serialized: exactly one HTTP 200 and one HTTP 409 Conflict");
  }

  console.log("\n==================================================================");
  console.log("  PHASE 6.2.4.3 SUITE SUMMARY: ALL ADVERSARIAL TESTS PASSED");
  console.log("==================================================================");
}

runPhase6243Tests().catch((err) => {
  console.error("Unhandled error in Phase 6.2.4.3 verification suite:", err);
  process.exit(1);
});
