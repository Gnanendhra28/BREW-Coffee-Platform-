/**
 * BREW Coffee Platform — Phase 6.2.4.1 Verification Suite
 * Quotation Integrity and Approval Audit Remediation
 * 
 * Validates:
 * 1. Snapshot HMAC-SHA256 generation using QUOTATION_SNAPSHOT_SECRET.
 * 2. Snapshot HMAC-SHA256 verification with valid signature.
 * 3. Tampered snapshot HMAC signature (even by 1 char) fails closed in constant time.
 * 4. Tampered snapshot payload fields with original signature fails closed.
 * 5. Missing QUOTATION_SNAPSHOT_SECRET in production fails closed immediately.
 * 6. Zero-downtime key rotation via QUOTATION_SNAPSHOT_SECRET_PREVIOUS.
 * 7. Untrusted / unknown quotation tier is strictly rejected.
 * 8. Tier validation fails closed when activeQuotation is missing or has empty tiers (no global allowlist fallback).
 * 9. Selected tier existing in activeQuotation's actual tier list passes.
 * 10. Authoritative quotation protection: tampered tier totalAmount detected via quoteEngine recomputation.
 * 11. Authoritative quotation protection: tampered pricePerGuest or guestCount in active quotation detected.
 * 12. Staff approval generates authoritative server-side approval audit ID (client IDs treated as correlation only).
 * 13. Duplicate staff approval on already confirmed booking fails closed with HTTP 409 Conflict.
 * 14. End-to-end approval via route handler derives trusted context without redundant lookups and produces immutable audit record.
 */

import assert from "assert";
import { NextRequest } from "next/server";
import {
  BookingRequirements,
  createQuotationSnapshot,
  verifyQuotationIntegrity,
  generateVoiceBookingQuotation,
  getSnapshotHmacSecret,
  computeSnapshotHmac,
  buildCanonicalSnapshotPayload,
  createVoiceBookingSession,
  approveBookingByStaff,
  InMemoryVoiceSessionRepository,
} from "../src/lib/voiceBooking";
import {
  createSessionToken,
} from "../src/lib/authTokens";
import {
  deriveTrustedStaffAuthorizationContext,
} from "../src/lib/auth/adminAuth";
import { POST as approveRouteHandler } from "../src/app/api/voice-booking/approve/route";
import { POST as adminApproveRouteHandler } from "../src/app/api/admin/voice-bookings/approve/route";

async function runPhase6241Tests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.4.1 Quotation Integrity & Approval Audit");
  console.log("==================================================================");

  const baseReqs: BookingRequirements = {
    guestCount: 100,
    eventDate: "2026-11-20",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "Jubilee Hills, Hyderabad",
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

  const TEST_SECRET = "test-quotation-secret-key-32-chars-long!";
  process.env.QUOTATION_SNAPSHOT_SECRET = TEST_SECRET;

  // ----------------------------------------------------------------------------
  // Test 1: Snapshot HMAC-SHA256 generation using QUOTATION_SNAPSHOT_SECRET
  // ----------------------------------------------------------------------------
  console.log("\nTest 1: Snapshot HMAC-SHA256 generation using QUOTATION_SNAPSHOT_SECRET");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    assert(typeof snapshot.hash === "string", "Snapshot hash must be a string");
    assert(/^[0-9a-f]{64}$/i.test(snapshot.hash), "Generated HMAC is 64 hex characters");

    // Manually compute HMAC to verify exact match
    const canonical = buildCanonicalSnapshotPayload({
      guestCount: snapshot.guestCount,
      eventDate: snapshot.eventDate,
      startTime: snapshot.startTime,
      durationHours: snapshot.durationHours,
      venueAddress: snapshot.venueAddress,
      selectedTier: snapshot.selectedTier,
      eventType: snapshot.eventType,
    });
    const expectedHmac = computeSnapshotHmac(canonical, TEST_SECRET);
    assert.strictEqual(snapshot.hash, expectedHmac, "Snapshot signature matches expected HMAC-SHA256");
    console.log("  ✓ Snapshot HMAC generated correctly with configured secret");
  }

  // ----------------------------------------------------------------------------
  // Test 2: Snapshot HMAC-SHA256 verification with valid signature succeeds
  // ----------------------------------------------------------------------------
  console.log("\nTest 2: Snapshot HMAC-SHA256 verification with valid signature succeeds");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);
    const result = verifyQuotationIntegrity(snapshot, baseReqs, quote);
    assert.strictEqual(result.isMatch, true, "Valid snapshot and requirements verify successfully");
    assert.strictEqual(result.mismatchedFields.length, 0, "No mismatched fields for valid snapshot");
    console.log("  ✓ Valid snapshot verified successfully");
  }

  // ----------------------------------------------------------------------------
  // Test 3: Tampered snapshot HMAC signature fails closed in constant time
  // ----------------------------------------------------------------------------
  console.log("\nTest 3: Tampered snapshot HMAC signature fails closed");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    // Tamper with just 1 hex character in the signature
    const lastChar = snapshot.hash[63];
    const tamperedChar = lastChar === "a" ? "b" : "a";
    const tamperedHash = snapshot.hash.substring(0, 63) + tamperedChar;

    const tamperedSnapshot = { ...snapshot, hash: tamperedHash };
    const quote = generateVoiceBookingQuotation(baseReqs);
    const result = verifyQuotationIntegrity(tamperedSnapshot, baseReqs, quote);
    assert.strictEqual(result.isMatch, false, "1-character tampered signature is rejected");
    assert(result.mismatchedFields.includes("hash"), "Identifies 'hash' mismatch");
    assert(
      (result.reason || "").includes("hash integrity check failed"),
      "Reason indicates hash integrity check failure"
    );
    console.log("  ✓ Tampered signature strictly rejected");
  }

  // ----------------------------------------------------------------------------
  // Test 4: Tampered snapshot payload fields with original signature fails closed
  // ----------------------------------------------------------------------------
  console.log("\nTest 4: Tampered snapshot payload fields with original signature fails closed");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    // An attacker alters snapshot payload fields while keeping original signature
    const tamperedSnapshot = { ...snapshot, guestCount: 50 };
    const quote = generateVoiceBookingQuotation(baseReqs);
    const result = verifyQuotationIntegrity(tamperedSnapshot, baseReqs, quote);
    assert.strictEqual(result.isMatch, false, "Tampered payload with stale signature rejected");
    assert(result.mismatchedFields.includes("hash"), "Detects hash signature invalidation");
    console.log("  ✓ Tampered payload with original signature rejected");
  }

  // ----------------------------------------------------------------------------
  // Test 5: Missing QUOTATION_SNAPSHOT_SECRET in production fails closed immediately
  // ----------------------------------------------------------------------------
  console.log("\nTest 5: Missing QUOTATION_SNAPSHOT_SECRET in production fails closed immediately");
  {
    const originalEnv = process.env.NODE_ENV;
    const originalSecret = process.env.QUOTATION_SNAPSHOT_SECRET;
    const envRecord = process.env as Record<string, string | undefined>;

    try {
      envRecord.NODE_ENV = "production";
      delete process.env.QUOTATION_SNAPSHOT_SECRET;

      // In production with missing secret, getSnapshotHmacSecret must throw
      assert.throws(
        () => getSnapshotHmacSecret(),
        /QUOTATION_SNAPSHOT_SECRET environment variable is missing/,
        "getSnapshotHmacSecret throws in production when secret is unset"
      );

      // createQuotationSnapshot must throw in production if secret is missing
      assert.throws(
        () => createQuotationSnapshot(baseReqs),
        /QUOTATION_SNAPSHOT_SECRET environment variable is missing/,
        "createQuotationSnapshot throws in production when secret is unset"
      );

      // verifyQuotationIntegrity must fail closed with isMatch: false
      const dummySnapshot = {
        guestCount: 100,
        eventDate: "2026-11-20",
        startTime: "14:00",
        durationHours: 3,
        venueAddress: "Jubilee Hills",
        selectedTier: "STANDARD" as const,
        eventType: "corporate",
        hash: "a".repeat(64),
        generatedAt: new Date().toISOString(),
      };
      const quote = generateVoiceBookingQuotation(baseReqs);
      const result = verifyQuotationIntegrity(dummySnapshot, baseReqs, quote);
      assert.strictEqual(result.isMatch, false, "Verification fails closed in production without secret");
      assert(result.mismatchedFields.includes("hash"), "Identifies hash mismatch due to missing secret");
      console.log("  ✓ Fail closed verified in production when secret is unconfigured");
    } finally {
      envRecord.NODE_ENV = originalEnv;
      process.env.QUOTATION_SNAPSHOT_SECRET = originalSecret;
    }
  }

  // ----------------------------------------------------------------------------
  // Test 6: Zero-downtime key rotation via QUOTATION_SNAPSHOT_SECRET_PREVIOUS
  // ----------------------------------------------------------------------------
  console.log("\nTest 6: Zero-downtime key rotation via QUOTATION_SNAPSHOT_SECRET_PREVIOUS");
  {
    const oldSecret = "old-secret-prior-to-key-rotation-32ch!";
    const newSecret = "new-active-secret-after-key-rotation!";

    // Generate snapshot under old secret
    process.env.QUOTATION_SNAPSHOT_SECRET = oldSecret;
    const oldSnapshot = createQuotationSnapshot(baseReqs);

    // Rotate keys: set new active secret and previous secret
    process.env.QUOTATION_SNAPSHOT_SECRET = newSecret;
    process.env.QUOTATION_SNAPSHOT_SECRET_PREVIOUS = oldSecret;

    // Snapshot signed with previous secret should still verify during rotation window
    const quote = generateVoiceBookingQuotation(baseReqs);
    const rotationResult = verifyQuotationIntegrity(oldSnapshot, baseReqs, quote);
    assert.strictEqual(rotationResult.isMatch, true, "Snapshot signed with previous secret verifies during rotation");

    // New snapshot signed with new secret also verifies
    const newSnapshot = createQuotationSnapshot(baseReqs);
    const newResult = verifyQuotationIntegrity(newSnapshot, baseReqs, quote);
    assert.strictEqual(newResult.isMatch, true, "Snapshot signed with new active secret verifies");

    // Snapshot signed with completely unknown secret fails
    process.env.QUOTATION_SNAPSHOT_SECRET = "third-secret-1234567890123456789012!";
    const unknownSnapshot = createQuotationSnapshot(baseReqs);
    process.env.QUOTATION_SNAPSHOT_SECRET = newSecret;
    // Primary is newSecret, previous is oldSecret. unknownSnapshot was signed with third secret
    const invalidResult = verifyQuotationIntegrity(unknownSnapshot, baseReqs, quote);
    assert.strictEqual(invalidResult.isMatch, false, "Snapshot signed with unknown key fails");

    // Cleanup rotation env
    delete process.env.QUOTATION_SNAPSHOT_SECRET_PREVIOUS;
    process.env.QUOTATION_SNAPSHOT_SECRET = TEST_SECRET;
    console.log("  ✓ Dual-secret key rotation window successfully verified");
  }

  // ----------------------------------------------------------------------------
  // Test 7: Untrusted / unknown quotation tier is strictly rejected
  // ----------------------------------------------------------------------------
  console.log("\nTest 7: Untrusted / unknown quotation tier is strictly rejected");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);

    const invalidTierReqs: BookingRequirements = {
      ...baseReqs,
      selectedTier: "DIAMOND_EXCLUSIVE_TIER" as unknown as "BASIC",
    };

    const result = verifyQuotationIntegrity(snapshot, invalidTierReqs, quote);
    assert.strictEqual(result.isMatch, false, "Unknown quotation tier is rejected");
    assert(result.mismatchedFields.includes("selectedTier"), "Identifies selectedTier mismatch");
    console.log("  ✓ Unknown tier strictly rejected");
  }

  // ----------------------------------------------------------------------------
  // Test 8: Tier validation fails closed when activeQuotation is missing or has empty tiers
  // ----------------------------------------------------------------------------
  console.log("\nTest 8: Tier validation fails closed when activeQuotation is missing/empty (no allowlist fallback)");
  {
    const reqsNoTier = { ...baseReqs, selectedTier: null };
    const snapshotNullTier = createQuotationSnapshot(reqsNoTier);

    // Customer requests PREMIUM
    const reqsSelectedPremium = { ...reqsNoTier, selectedTier: "PREMIUM" as const };

    // 8a. activeQuotation is missing (null/undefined)
    const resultMissingQuote = verifyQuotationIntegrity(snapshotNullTier, reqsSelectedPremium, null);
    assert.strictEqual(resultMissingQuote.isMatch, false, "Missing activeQuotation fails closed on tier selection");
    assert(resultMissingQuote.mismatchedFields.includes("selectedTier"), "Rejects tier selection when quote is missing");

    // 8b. activeQuotation has empty tiers array
    const emptyTiersQuote = {
      ...generateVoiceBookingQuotation(reqsNoTier),
      tiers: [],
    };
    const resultEmptyTiers = verifyQuotationIntegrity(snapshotNullTier, reqsSelectedPremium, emptyTiersQuote);
    assert.strictEqual(resultEmptyTiers.isMatch, false, "Empty quote tiers fails closed on tier selection");
    assert(resultEmptyTiers.mismatchedFields.includes("selectedTier"), "Rejects tier selection when tiers array is empty");
    console.log("  ✓ Tier validation fails closed without falling back to global allowlist");
  }

  // ----------------------------------------------------------------------------
  // Test 9: Selected tier existing in activeQuotation's actual tier list passes
  // ----------------------------------------------------------------------------
  console.log("\nTest 9: Selected tier existing in activeQuotation's actual tier list passes");
  {
    const reqsNoTier = { ...baseReqs, selectedTier: null };
    const quote = generateVoiceBookingQuotation(reqsNoTier);

    // Customer selects BASIC (which is present in quote.tiers)
    const reqsSelectedBasic = { ...reqsNoTier, selectedTier: "BASIC" as const };
    quote.selectedTier = quote.tiers.find((t) => t.tierId === "BASIC");
    const snapshotBasic = createQuotationSnapshot(reqsSelectedBasic);
    const result = verifyQuotationIntegrity(snapshotBasic, reqsSelectedBasic, quote);
    assert.strictEqual(result.isMatch, true, "Selected tier in active quote verifies successfully");
    assert.strictEqual(result.mismatchedFields.length, 0, "No mismatches for valid tier selection");
    console.log("  ✓ Actual active tier selection succeeds");
  }

  // ----------------------------------------------------------------------------
  // Test 10: Authoritative quotation protection: tampered tier totalAmount detected
  // ----------------------------------------------------------------------------
  console.log("\nTest 10: Authoritative quotation protection: tampered tier totalAmount detected");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);

    // An attacker in memory tampers with the tier totalAmount (e.g. from ₹26,000 to ₹1,000)
    const tamperedQuote = JSON.parse(JSON.stringify(quote));
    tamperedQuote.tiers[0].totalAmount = 1000;

    const result = verifyQuotationIntegrity(snapshot, baseReqs, tamperedQuote);
    assert.strictEqual(result.isMatch, false, "Tampered tier totalAmount is detected and rejected");
    assert(
      result.mismatchedFields.includes("quotation_pricing_mismatch"),
      "Flags quotation_pricing_mismatch"
    );
    console.log("  ✓ Tampered tier totalAmount detected via authoritative quoteEngine recomputation");
  }

  // ----------------------------------------------------------------------------
  // Test 11: Authoritative quotation protection: tampered pricePerGuest or guestCount detected
  // ----------------------------------------------------------------------------
  console.log("\nTest 11: Authoritative quotation protection: tampered pricePerGuest / guestCount detected");
  {
    const snapshot = createQuotationSnapshot(baseReqs);
    const quote = generateVoiceBookingQuotation(baseReqs);

    // Tamper with pricePerGuest
    const tamperedPriceQuote = JSON.parse(JSON.stringify(quote));
    tamperedPriceQuote.tiers[1].pricePerGuest = 50;

    const priceResult = verifyQuotationIntegrity(snapshot, baseReqs, tamperedPriceQuote);
    assert.strictEqual(priceResult.isMatch, false, "Tampered pricePerGuest is detected");
    assert(priceResult.mismatchedFields.includes("quotation_pricing_mismatch"), "Flags pricePerGuest tampering");

    // Tamper with quotation guestCount
    const tamperedGuestQuote = JSON.parse(JSON.stringify(quote));
    tamperedGuestQuote.guestCount = 10;

    const guestResult = verifyQuotationIntegrity(snapshot, baseReqs, tamperedGuestQuote);
    assert.strictEqual(guestResult.isMatch, false, "Tampered quotation guestCount is detected");
    assert(guestResult.mismatchedFields.includes("quotation_pricing_mismatch"), "Flags guestCount tampering");
    console.log("  ✓ All authoritative pricing tampering vectors detected and rejected");
  }

  // ----------------------------------------------------------------------------
  // Test 12: Staff approval generates authoritative server-side approval audit ID
  // ----------------------------------------------------------------------------
  console.log("\nTest 12: Staff approval generates authoritative server-side approval audit ID");
  {
    const { defaultSessionRepository } = await import("../src/lib/voiceBooking");
    const session = createVoiceBookingSession("+919555544444", "en");
    session.state = "awaiting_staff_approval";
    session.requirements = { ...baseReqs, customerConfirmed: true };
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    const token = await createSessionToken({
      uid: "usr_lead_barista_44",
      email: "leadbarista@brew.cafe",
      displayName: "Lead Barista",
      role: "barista",
      sid: "sess_barista_sid_44",
    });

    const clientSuppliedAuditId = "client_forged_approval_id_999";
    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${token}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
        staffApprovalId: clientSuppliedAuditId,
      }),
    });

    const res = await approveRouteHandler(req);
    assert.strictEqual(res.status, 200, "Route returns 200 OK");
    const json = await res.json();

    // The server MUST NOT use the client-supplied ID as the authoritative staffApprovalId
    assert.notStrictEqual(
      json.session.staffApprovalId,
      clientSuppliedAuditId,
      "Server-derived staffApprovalId does not equal client-supplied ID"
    );
    assert(
      /^appr_\d+_[0-9a-f]{12}$/.test(json.session.staffApprovalId),
      "Server generates secure, formatted approval audit ID"
    );
    assert.strictEqual(json.session.staffApprovalAudit.staffIdentity, "usr_lead_barista_44", "Verified staff identity preserved");
    assert.strictEqual(json.session.staffApprovalAudit.staffRole, "barista", "Verified staff role preserved");
    console.log("  ✓ Authoritative server-side audit ID generated; client ID treated as correlation only");
  }

  // ----------------------------------------------------------------------------
  // Test 13: Duplicate staff approval on already confirmed booking fails closed
  // ----------------------------------------------------------------------------
  console.log("\nTest 13: Duplicate staff approval on already confirmed booking fails closed");
  {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919777788888", "en");
    session.state = "awaiting_staff_approval";
    session.requirements = { ...baseReqs, customerConfirmed: true };
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await repo.save(session);

    const token = await createSessionToken({
      uid: "usr_fleet_lead_77",
      email: "fleetlead@brew.cafe",
      displayName: "Fleet Lead",
      role: "fleet_admin",
      sid: "sess_fleet_77",
    });

    const authContext = await deriveTrustedStaffAuthorizationContext({
      tokenOrRequest: token,
    });

    // First approval: succeeds and transitions to booking_confirmed
    const firstApproval = await approveBookingByStaff(session.id, authContext, repo);
    assert.strictEqual(firstApproval.state, "booking_confirmed", "First approval succeeds");
    assert(firstApproval.staffApprovalAudit !== null, "Audit record attached");

    // Second approval attempt via domain engine: must throw duplicate approval error
    await assert.rejects(
      async () => {
        await approveBookingByStaff(session.id, authContext, repo);
      },
      /already been approved and confirmed. Duplicate approval rejected/,
      "Domain engine strictly rejects duplicate approval"
    );

    // Second approval attempt via HTTP endpoint: must return HTTP 409 Conflict
    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${token}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
      }),
    });

    // Provide pre-populated session in defaultSessionRepository
    const { defaultSessionRepository } = await import("../src/lib/voiceBooking");
    await defaultSessionRepository.save(firstApproval);

    const httpResponse = await approveRouteHandler(req);
    assert.strictEqual(httpResponse.status, 409, "Duplicate approval returns HTTP 409 Conflict");
    const httpJson = await httpResponse.json();
    assert(
      httpJson.error.includes("already been approved"),
      "HTTP error message clearly indicates booking is already approved"
    );
    console.log("  ✓ Duplicate staff approval fails closed with HTTP 409 Conflict");
  }

  // ----------------------------------------------------------------------------
  // Test 14: End-to-end approval via route handler without redundant lookups
  // ----------------------------------------------------------------------------
  console.log("\nTest 14: End-to-end approval via route handler without redundant lookups");
  {
    const { defaultSessionRepository } = await import("../src/lib/voiceBooking");
    const session = createVoiceBookingSession("+919111122222", "en");
    session.state = "awaiting_staff_approval";
    session.requirements = { ...baseReqs, customerConfirmed: true };
    session.quotation = generateVoiceBookingQuotation(baseReqs);
    session.quotationSnapshot = createQuotationSnapshot(baseReqs);
    await defaultSessionRepository.save(session);

    const baristaToken = await createSessionToken({
      uid: "usr_barista_e2e_88",
      email: "barista88@brew.cafe",
      displayName: "Barista 88",
      role: "barista",
      sid: "sess_barista_e2e_88",
    });

    const req = new NextRequest("http://localhost:3000/api/voice-booking/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${baristaToken}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
        staffApprovalId: "client_correlation_tag_123",
      }),
    });

    const res = await approveRouteHandler(req);
    assert.strictEqual(res.status, 200, "Route returns HTTP 200 OK");
    const json = await res.json();
    assert.strictEqual(json.success, true, "Response reports success: true");
    assert.strictEqual(json.session.state, "booking_confirmed", "Session state confirmed");
    assert(json.session.staffApprovalAudit, "Session contains staffApprovalAudit");

    const audit = json.session.staffApprovalAudit;
    assert.strictEqual(audit.staffIdentity, "usr_barista_e2e_88", "Audit preserves verified staffIdentity");
    assert.strictEqual(audit.staffRole, "barista", "Audit preserves verified staffRole");
    assert.notStrictEqual(audit.staffApprovalId, "client_correlation_tag_123", "Audit ID is server-generated");
    assert(audit.staffApprovalId.startsWith("appr_"), "Audit ID has server prefix");

    // Also verify the admin route alias behaves identically
    const adminReq = new NextRequest("http://localhost:3000/api/admin/voice-bookings/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `brew_session=${baristaToken}`,
      },
      body: JSON.stringify({
        sessionId: session.id,
      }),
    });
    const adminRes = await adminApproveRouteHandler(adminReq);
    // Already approved from previous call, must return HTTP 409 Conflict
    assert.strictEqual(adminRes.status, 409, "Admin route alias returns HTTP 409 Conflict on duplicate");
    console.log("  ✓ Both route handlers verified end-to-end with verified session");
  }

  console.log("\n==================================================================");
  console.log("  PHASE 6.2.4.1 SUITE SUMMARY: ALL 14 TESTS PASSED");
  console.log("==================================================================");
}

runPhase6241Tests().catch((err) => {
  console.error("Unhandled error in Phase 6.2.4.1 verification suite:", err);
  process.exit(1);
});
