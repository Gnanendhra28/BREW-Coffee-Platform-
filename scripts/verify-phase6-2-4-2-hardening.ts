/**
 * BREW Coffee Platform — Phase 6.2.4.2 Verification Suite
 * Final Quotation Integrity and Atomic Approval Remediation
 * 
 * Verifies:
 * 1. Fail-closed quotation existence:
 *    - Already-selected tier with missing activeQuotation fails closed.
 *    - Missing active quotation with snapshot tier null fails closed.
 *    - Empty tier list with snapshot tier set fails closed.
 *    - Empty tier list with snapshot tier null fails closed.
 *    - Selected-tier mismatch between requirements and active quotation fails closed.
 *    - Missing selected-tier record when requirements has selected tier fails closed.
 *    - Valid complete quotation passes with isMatch: true.
 * 2. Complete authoritative quotation comparison:
 *    - Tampering with each actual financial quotation field individually fails closed:
 *      guestCount, durationMinutes, eventDate, startTime, endTime, eventType,
 *      tier pricePerGuest, totalAmount, totalCost, grossProfit, grossMarginPercent, staffAssigned,
 *      logistics totalLogisticsCost, baseTravelFee, distanceSurcharge, setupTeardownFee,
 *      ingredient manifest quantity, unitCost, totalCost.
 * 3. Atomic duplicate approval protection:
 *    - Concurrent approval requests via Promise.all serialize at the repository boundary:
 *      exactly one succeeds with HTTP 200 and the concurrent duplicate fails with HTTP 409 Conflict.
 *    - Repeated approval attempt on an already confirmed session returns HTTP 409 Conflict.
 * 4. Spoofed staff identity and role ignored:
 *    - Server derives authoritative identity from verified session token.
 * 5. HMAC secret environment policy:
 *    - Missing secret in deployed cloud/staging/production environment fails closed immediately.
 *    - Local development and test environments permit deterministic fallback.
 *    - Key rotation via QUOTATION_SNAPSHOT_SECRET_PREVIOUS validates gracefully.
 */

import assert from "assert";
import { NextRequest } from "next/server";
import {
  BookingRequirements,
  createQuotationSnapshot,
  verifyQuotationIntegrity,
  generateVoiceBookingQuotation,
  getSnapshotHmacSecret,
  createVoiceBookingSession,
  defaultSessionRepository,
} from "../src/lib/voiceBooking";
import { createSessionToken } from "../src/lib/authTokens";
import { POST as approveRouteHandler } from "../src/app/api/voice-booking/approve/route";

async function runPhase6242Tests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.4.2 Final Integrity & Concurrency Suite");
  console.log("==================================================================");

  const TEST_SECRET = "p6242-test-secret-key-32-chars-long!";
  process.env.QUOTATION_SNAPSHOT_SECRET = TEST_SECRET;

  const baseReqs: BookingRequirements = {
    guestCount: 120,
    eventDate: "2026-12-15",
    startTime: "11:00",
    durationHours: 4,
    venueAddress: "Banjara Hills, Road No 12, Hyderabad",
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
  // SECTION 1: Fail-Closed Quotation Existence & Tier Consistency
  // ----------------------------------------------------------------------------
  console.log("\nSection 1: Fail-Closed Quotation Existence & Tier Consistency");

  // 1.1 Already-selected tier with missing quotation
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const res = verifyQuotationIntegrity(snapshot, baseReqs, undefined);
    assert.strictEqual(res.isMatch, false, "Missing quotation must fail closed");
    assert(
      res.reason && res.reason.includes("Active quotation record is mandatory"),
      "Reason indicates missing active quotation"
    );
    assert(res.mismatchedFields.includes("activeQuotation"));
    assert(res.mismatchedFields.includes("selectedTier"));
    console.log("  ✓ Already-selected tier with missing quotation fails closed");
  }

  // 1.2 Missing active quotation with snapshot tier null
  {
    const reqsNoTier: BookingRequirements = { ...baseReqs, selectedTier: null };
    const snapshot = createQuotationSnapshot(reqsNoTier);
    const res = verifyQuotationIntegrity(snapshot, reqsNoTier, null);
    assert.strictEqual(res.isMatch, false, "Null quotation must fail closed");
    assert(res.mismatchedFields.includes("activeQuotation"));
    console.log("  ✓ Missing active quotation with snapshot tier null fails closed");
  }

  // 1.3 Empty tier list with snapshot tier set
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    const tamperedQuote = { ...quote, tiers: [] };
    const res = verifyQuotationIntegrity(snapshot, baseReqs, tamperedQuote);
    assert.strictEqual(res.isMatch, false, "Empty tier list fails closed");
    assert(res.mismatchedFields.includes("activeQuotation_tiers"));
    assert(res.mismatchedFields.includes("selectedTier"));
    console.log("  ✓ Empty tier list with snapshot tier set fails closed");
  }

  // 1.4 Empty tier list with snapshot tier null
  {
    const reqsNoTier: BookingRequirements = { ...baseReqs, selectedTier: null };
    const snapshot = createQuotationSnapshot(reqsNoTier);
    const quote = generateVoiceBookingQuotation(reqsNoTier);
    const tamperedQuote = { ...quote, tiers: [] };
    const res = verifyQuotationIntegrity(snapshot, reqsNoTier, tamperedQuote);
    assert.strictEqual(res.isMatch, false, "Empty tier list with null tier fails closed");
    assert(res.mismatchedFields.includes("activeQuotation_tiers"));
    console.log("  ✓ Empty tier list with snapshot tier null fails closed");
  }

  // 1.5 Selected-tier mismatch between requirements and active quotation
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    const tamperedQuote = {
      ...quote,
      selectedTier: {
        ...quote.tiers[0],
        tierId: "BASIC" as const,
      },
    };
    const res = verifyQuotationIntegrity(snapshot, baseReqs, tamperedQuote);
    assert.strictEqual(res.isMatch, false, "Selected tier mismatch rejected");
    assert(res.mismatchedFields.includes("selectedTier"));
    console.log("  ✓ Selected-tier mismatch between requirements and active quotation rejected");
  }

  // 1.6 Missing selected-tier record in activeQuotation when snapshot recorded selectedTier
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    const quoteWithoutSelectedTier = { ...quote, selectedTier: undefined };
    const res = verifyQuotationIntegrity(snapshot, baseReqs, quoteWithoutSelectedTier);
    assert.strictEqual(res.isMatch, false, "Missing selectedTier in quote rejected");
    assert(res.mismatchedFields.includes("selectedTier"));
    console.log("  ✓ Missing selected-tier record when snapshot has selected tier rejected");
  }

  // 1.7 Valid complete quotation passes
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    const res = verifyQuotationIntegrity(snapshot, baseReqs, quote);
    assert.strictEqual(res.isMatch, true, "Valid complete quotation must pass");
    assert.strictEqual(res.mismatchedFields.length, 0);
    console.log("  ✓ Valid complete quotation passes integrity verification");
  }

  // ----------------------------------------------------------------------------
  // SECTION 2: Complete Authoritative Quotation Comparison (Tamper Detection)
  // ----------------------------------------------------------------------------
  console.log("\nSection 2: Complete Authoritative Quotation Comparison (Tamper Detection)");

  const baseQuote = generateVoiceBookingQuotation(baseReqs);
  const baseSnapshot = createQuotationSnapshot(baseReqs);

  // Helper to assert tampering is caught
  const testTamper = (label: string, modifier: (q: typeof baseQuote) => typeof baseQuote) => {
    const clonedQuote = JSON.parse(JSON.stringify(baseQuote));
    const modified = modifier(clonedQuote);
    const res = verifyQuotationIntegrity(baseSnapshot, baseReqs, modified);
    assert.strictEqual(res.isMatch, false, `Tampering with ${label} must be rejected`);
    assert(
      res.mismatchedFields.includes("quotation_pricing_mismatch"),
      `Tampering with ${label} must produce quotation_pricing_mismatch`
    );
    console.log(`  ✓ Tampered ${label} detected and rejected`);
  };

  testTamper("guestCount", (q) => ({ ...q, guestCount: 150 }));
  testTamper("durationMinutes", (q) => ({ ...q, durationMinutes: 300 }));
  testTamper("eventDate", (q) => ({ ...q, eventDate: "2026-12-25" }));
  testTamper("startTime", (q) => ({ ...q, startTime: "12:00" }));
  testTamper("endTime", (q) => ({ ...q, endTime: "16:00" }));
  testTamper("eventType", (q) => ({ ...q, eventType: "wedding" }));

  // Tier financial details
  testTamper("tier pricePerGuest", (q) => {
    q.tiers[0].pricePerGuest -= 50;
    return q;
  });
  testTamper("tier totalAmount", (q) => {
    q.tiers[1].totalAmount -= 5000;
    return q;
  });
  testTamper("tier totalCost", (q) => {
    q.tiers[1].totalCost += 1000;
    return q;
  });
  testTamper("tier grossProfit", (q) => {
    q.tiers[1].grossProfit += 1000;
    return q;
  });
  testTamper("tier grossMarginPercent", (q) => {
    q.tiers[1].grossMarginPercent = 50;
    return q;
  });
  testTamper("tier staffAssigned", (q) => {
    q.tiers[1].staffAssigned = 10;
    return q;
  });

  // Selected tier pricing details
  testTamper("selectedTier totalAmount", (q) => {
    if (q.selectedTier) q.selectedTier.totalAmount -= 2000;
    return q;
  });

  // Logistics fees
  testTamper("logistics totalLogisticsCost", (q) => {
    if (q.logistics) q.logistics.totalLogisticsCost += 500;
    return q;
  });
  testTamper("logistics baseTravelFee", (q) => {
    if (q.logistics) q.logistics.baseTravelFee += 200;
    return q;
  });
  testTamper("logistics distanceSurcharge", (q) => {
    if (q.logistics) q.logistics.distanceSurcharge += 300;
    return q;
  });
  testTamper("logistics setupTeardownFee", (q) => {
    if (q.logistics) q.logistics.setupTeardownFee += 400;
    return q;
  });

  // Ingredient manifest items
  testTamper("ingredientManifest quantity", (q) => {
    if (q.ingredientManifest && q.ingredientManifest.length > 0) {
      q.ingredientManifest[0].quantity += 10;
    }
    return q;
  });
  testTamper("ingredientManifest unitCost", (q) => {
    if (q.ingredientManifest && q.ingredientManifest.length > 0) {
      q.ingredientManifest[0].unitCost += 5;
    }
    return q;
  });
  testTamper("ingredientManifest totalCost", (q) => {
    if (q.ingredientManifest && q.ingredientManifest.length > 0) {
      q.ingredientManifest[0].totalCost += 50;
    }
    return q;
  });

  // ----------------------------------------------------------------------------
  // SECTION 3: Atomic Concurrency & Duplicate Approval Protection
  // ----------------------------------------------------------------------------
  console.log("\nSection 3: Atomic Concurrency & Duplicate Approval Protection");

  {
    // Clear default repository
    defaultSessionRepository.clear();

    const session = createVoiceBookingSession("+919444455555", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    const token = await createSessionToken({
      uid: "usr_concurrency_barista_1",
      email: "barista1@brew.cafe",
      displayName: "Barista 1",
      role: "barista",
      sid: "sess_barista_concurrency_1",
    });

    const createApprovalRequest = () =>
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

    // Fire 2 concurrent approval requests simultaneously via Promise.all
    const [res1, res2] = await Promise.all([
      approveRouteHandler(createApprovalRequest()),
      approveRouteHandler(createApprovalRequest()),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 409],
      "Exactly one concurrent request succeeds (HTTP 200) and the other fails (HTTP 409 Conflict)"
    );

    // Verify session state in repository is confirmed
    const updatedSession = await defaultSessionRepository.getById(session.id);
    assert(updatedSession, "Session must exist in repo");
    assert.strictEqual(updatedSession.state, "booking_confirmed", "Session confirmed");
    assert(updatedSession.staffApprovalAudit !== null, "Audit record committed");
    assert.strictEqual(
      updatedSession.staffApprovalAudit?.staffIdentity,
      "usr_concurrency_barista_1",
      "Authorized staff ID preserved"
    );
    console.log("  ✓ Concurrent approvals via Promise.all serialized: exactly one 200 and one 409");

    // Repeated approval attempt on confirmed session must return HTTP 409
    const repeatedRes = await approveRouteHandler(createApprovalRequest());
    assert.strictEqual(repeatedRes.status, 409, "Subsequent approval attempt returns HTTP 409 Conflict");
    const repeatedJson = await repeatedRes.json();
    assert(
      repeatedJson.error.includes("already been approved"),
      "Error explains session already approved"
    );
    console.log("  ✓ Repeated approval attempt on confirmed booking returns HTTP 409 Conflict");
  }

  // ----------------------------------------------------------------------------
  // SECTION 4: Spoofed Client Identity & Role Resistance
  // ----------------------------------------------------------------------------
  console.log("\nSection 4: Spoofed Client Identity & Role Resistance");

  {
    const session = createVoiceBookingSession("+919777788888", "en");
    session.state = "awaiting_staff_approval";
    session.requirements.customerConfirmed = true;
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    const genuineToken = await createSessionToken({
      uid: "usr_genuine_barista_99",
      email: "genuine@brew.cafe",
      displayName: "Genuine Staff",
      role: "barista",
      sid: "sess_genuine_99",
    });

    const spoofReq = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${genuineToken}`,
        // Attempting to inject spoofed staff identity / role via headers
        "x-staff-id": "mallory_hacker",
        "x-staff-role": "admin",
      },
      body: JSON.stringify({
        sessionId: session.id,
        // Attempting to inject spoofed parameters via payload
        staffIdentity: "mallory_hacker",
        staffRole: "super_admin",
        staffApprovalId: "client_forged_approval_id_007",
      }),
    });

    const res = await approveRouteHandler(spoofReq);
    assert.strictEqual(res.status, 200, "Approval succeeds using trusted session identity");
    const json = await res.json();
    const audit = json.session.staffApprovalAudit;

    assert.strictEqual(
      audit.staffIdentity,
      "usr_genuine_barista_99",
      "Client-spoofed staff identity is completely ignored in favor of verified session"
    );
    assert.strictEqual(
      audit.staffRole,
      "barista",
      "Client-spoofed role is completely ignored in favor of verified session"
    );
    assert.notStrictEqual(
      audit.staffApprovalId,
      "client_forged_approval_id_007",
      "Client-supplied audit ID is replaced with authoritative server ID"
    );
    assert(audit.staffApprovalId.startsWith("appr_"), "Audit ID has authoritative server prefix");
    console.log("  ✓ Client-spoofed staff identity, role, and approval ID successfully neutralized");
  }

  // ----------------------------------------------------------------------------
  // SECTION 5: HMAC Secret Environment Policy & Fail-Closed Behavior
  // ----------------------------------------------------------------------------
  console.log("\nSection 5: HMAC Secret Environment Policy & Fail-Closed Behavior");

  {
    // Save current environment state
    const originalSecret = process.env.QUOTATION_SNAPSHOT_SECRET;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalRender = process.env.RENDER;

    try {
      // Simulate deployed production/cloud environment
      delete process.env.QUOTATION_SNAPSHOT_SECRET;
      Object.assign(process.env, { NODE_ENV: "production", RENDER: "true" });

      assert.throws(
        () => {
          getSnapshotHmacSecret();
        },
        /QUOTATION_SNAPSHOT_SECRET environment variable is missing or mandatory in production/,
        "getSnapshotHmacSecret must throw in production/deployed environment without secret"
      );

      const snapshot = {
        guestCount: 100,
        eventDate: "2026-12-10",
        startTime: "10:00",
        durationHours: 3,
        venueAddress: "Hitec City",
        selectedTier: "STANDARD" as const,
        eventType: "corporate",
        hash: "a".repeat(64),
        generatedAt: new Date().toISOString(),
      };
      const quote = generateVoiceBookingQuotation(baseReqs);
      const integrityRes = verifyQuotationIntegrity(snapshot, baseReqs, quote);
      assert.strictEqual(integrityRes.isMatch, false, "Integrity check must fail closed");
      assert(
        integrityRes.reason && integrityRes.reason.includes("server HMAC secret is not configured in production"),
        "Integrity check reason explains missing production HMAC secret"
      );
      console.log("  ✓ Missing HMAC secret in deployed staging/cloud environment fails closed immediately");
    } finally {
      // Restore environment
      process.env.QUOTATION_SNAPSHOT_SECRET = originalSecret;
      Object.assign(process.env, { NODE_ENV: originalNodeEnv });
      if (originalRender !== undefined) {
        process.env.RENDER = originalRender;
      } else {
        delete process.env.RENDER;
      }
    }
  }

  // Local/test-only development fallback permitted
  {
    const originalSecret = process.env.QUOTATION_SNAPSHOT_SECRET;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.QUOTATION_SNAPSHOT_SECRET;
      Object.assign(process.env, { NODE_ENV: "test" });
      const devSecret = getSnapshotHmacSecret();
      assert(
        typeof devSecret === "string" && devSecret.length > 0,
        "Local dev fallback secret must be provided"
      );
      console.log("  ✓ Local/test development fallback permitted when outside deployed environments");
    } finally {
      process.env.QUOTATION_SNAPSHOT_SECRET = originalSecret;
      Object.assign(process.env, { NODE_ENV: originalNodeEnv });
    }
  }

  // Dual-secret key rotation window verification
  {
    const oldSecret = "old-rotation-key-32-chars-long-1";
    const newSecret = "new-rotation-key-32-chars-long-2";

    // Create snapshot with old key
    process.env.QUOTATION_SNAPSHOT_SECRET = oldSecret;
    const oldSnapshot = createQuotationSnapshot(baseReqs);

    // Rotate keys: set primary to newSecret, previous to oldSecret
    process.env.QUOTATION_SNAPSHOT_SECRET = newSecret;
    process.env.QUOTATION_SNAPSHOT_SECRET_PREVIOUS = oldSecret;

    const quote = generateVoiceBookingQuotation(baseReqs);
    const rotationRes = verifyQuotationIntegrity(oldSnapshot, baseReqs, quote);
    assert.strictEqual(
      rotationRes.isMatch,
      true,
      "Snapshot signed with previous secret validates successfully during rotation window"
    );

    // Snapshot signed with unknown 3rd secret fails
    process.env.QUOTATION_SNAPSHOT_SECRET = "third-secret-that-does-not-match!";
    delete process.env.QUOTATION_SNAPSHOT_SECRET_PREVIOUS;
    const invalidRes = verifyQuotationIntegrity(oldSnapshot, baseReqs, quote);
    assert.strictEqual(
      invalidRes.isMatch,
      false,
      "Snapshot signed with unknown key fails closed"
    );
    console.log("  ✓ Primary and previous key rotation window verified successfully");

    // Reset back to test secret
    process.env.QUOTATION_SNAPSHOT_SECRET = TEST_SECRET;
  }

  console.log("\n==================================================================");
  console.log("  PHASE 6.2.4.2 SUITE SUMMARY: ALL ADVERSARIAL TESTS PASSED");
  console.log("==================================================================");
}

runPhase6242Tests().catch((err) => {
  console.error("Unhandled error in Phase 6.2.4.2 verification suite:", err);
  process.exit(1);
});
