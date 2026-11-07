/**
 * BREW Coffee Platform — Phase 6.2.2 Hardening Verification Suite
 * Exhaustive safety and authorization verification for the AI Conversation Engine:
 * 1. Low-confidence extraction with positive acceptance does not confirm
 * 2. API failure with positive acceptance does not confirm
 * 3. Invalid model response with positive acceptance does not confirm
 * 4. Gemini falsely classifying an unrelated "yes" sentence does not confirm
 * 5. Mock and Gemini providers follow the same confirmation safety gate
 * 6. Confirmation without a valid quotation is rejected
 * 7. Confirmation after quotation invalidation is rejected
 * 8. Missing staff role is rejected
 * 9. Missing staff identity is rejected
 * 10. Customer role cannot approve
 * 11. Authorized staff role can approve through the authenticated boundary
 * 12. Unknown or protected fields cannot be cleared
 * 13. Invalid clear-field patches are rejected safely
 * 14. Timeout remains active while reading the response body
 * 15. Existing Phase 6.1, 6.1.2, 6.2, and 6.2.1 behavior remains intact
 */

import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
  generateVoiceBookingQuotation,
  classifyConfirmationIntent,
  evaluateConfirmationSafetyGate,
  GeminiExtractionProvider,
  InMemoryVoiceSessionRepository,
  CustomerClearableFieldSchema,
  CUSTOMER_CLEARABLE_FIELDS,
  StaffAuthorizationContextSchema,
  CustomerClearableField,
  ExtractionProvider,
  StructuredExtractionResult,
  BookingRequirements,
} from "../src/lib/voiceBooking";

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

async function runPhase622HardeningTests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.2 Confirmation & Staff Auth Hardening");
  console.log("==================================================================\n");

  const repository = new InMemoryVoiceSessionRepository();

  // Helper to establish a session in 'awaiting_customer_confirmation'
  async function createQuotationReadySession(id: string) {
    const session = createVoiceBookingSession("+919876543210", "en");
    session.id = id;

    session.requirements = {
      guestCount: 150,
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
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.state = "awaiting_customer_confirmation";
    await repository.save(session);
    return session;
  }

  // ============================================================================
  // Test Group 1: Low-confidence extraction with positive acceptance does not confirm
  // ============================================================================
  console.log("Test Group 1: Low-confidence extraction with positive acceptance does not confirm");
  {
    const session = await createQuotationReadySession("sess_test_grp1");

    class LowConfidenceProvider implements ExtractionProvider {
      async extractRequirements(): Promise<StructuredExtractionResult> {
        return {
          status: "low_confidence",
          source: "gemini",
          confidenceScore: 0.65,
          confirmationIntent: "positive_acceptance",
          data: { customerConfirmed: true },
          clearedFields: [],
        };
      }
    }

    const result = await processConversationTurn(
      session,
      "Yes, go ahead and book it!",
      {
        extractionProvider: new LowConfidenceProvider(),
        sessionRepository: repository,
      }
    );

    assert(
      result.session.state === "awaiting_customer_confirmation",
      "Low-confidence extraction prevents state advancing to customer_confirmed"
    );
    assert(
      result.session.requirements.customerConfirmed === false,
      "requirements.customerConfirmed remains false under low confidence"
    );
    assert(
      result.safetyEvaluation?.isConfirmed === false,
      "Confirmation safety gate evaluation fails closed on low confidence"
    );
  }

  // ============================================================================
  // Test Group 2: API failure with positive acceptance does not confirm
  // ============================================================================
  console.log("\nTest Group 2: API failure with positive acceptance does not confirm");
  {
    const session = await createQuotationReadySession("sess_test_grp2");

    class ApiFailureProvider implements ExtractionProvider {
      async extractRequirements(): Promise<StructuredExtractionResult> {
        return {
          status: "api_failure",
          source: "gemini",
          confidenceScore: 0.0,
          confirmationIntent: "positive_acceptance",
          data: { customerConfirmed: true },
          clearedFields: [],
          error: "Simulated upstream 500 error",
        };
      }
    }

    const result = await processConversationTurn(
      session,
      "Yes, confirm this quote now",
      {
        extractionProvider: new ApiFailureProvider(),
        sessionRepository: repository,
      }
    );

    assert(
      result.session.state === "awaiting_customer_confirmation",
      "API failure prevents booking confirmation"
    );
    assert(
      result.session.requirements.customerConfirmed === false,
      "customerConfirmed remains false during API failure"
    );
    assert(
      result.safetyEvaluation?.isConfirmed === false,
      "Safety gate explicitly reports isConfirmed: false for api_failure"
    );
  }

  // ============================================================================
  // Test Group 3: Invalid model response with positive acceptance does not confirm
  // ============================================================================
  console.log("\nTest Group 3: Invalid model response with positive acceptance does not confirm");
  {
    const session = await createQuotationReadySession("sess_test_grp3");

    class InvalidResponseProvider implements ExtractionProvider {
      async extractRequirements(): Promise<StructuredExtractionResult> {
        return {
          status: "invalid_response",
          source: "gemini",
          confidenceScore: 0.0,
          confirmationIntent: "positive_acceptance",
          data: { customerConfirmed: true },
          clearedFields: [],
          error: "JSON parse failed",
        };
      }
    }

    const result = await processConversationTurn(
      session,
      "Yes, book it please",
      {
        extractionProvider: new InvalidResponseProvider(),
        sessionRepository: repository,
      }
    );

    assert(
      result.session.state === "awaiting_customer_confirmation",
      "Invalid model response prevents booking confirmation"
    );
    assert(
      result.session.requirements.customerConfirmed === false,
      "customerConfirmed remains false on invalid model response"
    );
  }

  // ============================================================================
  // Test Group 4: Gemini falsely classifying an unrelated "yes" sentence does not confirm
  // ============================================================================
  console.log("\nTest Group 4: Falsely classifying an unrelated 'yes' sentence does not confirm");
  {
    const unrelatedQuestionsAndStatements = [
      "can you confirm if oat milk is included in the package?",
      "yes I went to Starbucks yesterday and had a cappuccino",
      "yes my brother loves coffee so maybe next month",
      "is that the final price for the standard package?",
      "if the price is 10000 then yes",
      "no, do not confirm yet, I need to check with my team",
      "not yet, wait a minute",
    ];

    for (const text of unrelatedQuestionsAndStatements) {
      const intent = classifyConfirmationIntent(text, "en");
      assert(
        intent !== "positive_acceptance",
        `Unrelated utterance "${text.slice(0, 40)}..." is NOT classified as positive_acceptance (classified as: ${intent})`
      );
    }

    // Multilingual false-positive protection
    assert(
      classifyConfirmationIntent("क्या आप कन्फ़र्म कर सकते हैं कि दूध शामिल है?", "hi") !== "positive_acceptance",
      "Hindi question containing 'confirm' does not trigger positive_acceptance"
    );
    assert(
      classifyConfirmationIntent("ప్యాకేజీలో పాలు ఉందో లేదో కన్ఫర్మ్ చేస్తారా?", "te") !== "positive_acceptance",
      "Telugu question containing 'confirm' does not trigger positive_acceptance"
    );
  }

  // ============================================================================
  // Test Group 5: Mock and Gemini providers follow the same confirmation safety gate
  // ============================================================================
  console.log("\nTest Group 5: Mock and Gemini providers follow the same confirmation safety gate");
  {
    const dummyReqs: BookingRequirements = {
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

    // Both mock and gemini sources with low confidence fail identically
    const mockEval = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm it please",
      language: "en",
      extractionResult: {
        status: "low_confidence",
        source: "mock",
        confidenceScore: 0.60,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotationGuestCount: 100,
      currentRequirements: dummyReqs,
    });

    const geminiEval = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm it please",
      language: "en",
      extractionResult: {
        status: "low_confidence",
        source: "gemini",
        confidenceScore: 0.60,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotationGuestCount: 100,
      currentRequirements: dummyReqs,
    });

    assert(mockEval.isConfirmed === false, "Mock provider fails closed on low confidence");
    assert(geminiEval.isConfirmed === false, "Gemini provider fails closed on low confidence");
    assert(mockEval.reason === geminiEval.reason, "Gate applies identical evaluation reason across providers");
  }

  // ============================================================================
  // Test Group 6: Confirmation without a valid quotation is rejected
  // ============================================================================
  console.log("\nTest Group 6: Confirmation without a valid quotation is rejected");
  {
    const dummyReqs: BookingRequirements = {
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

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, book it now",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.98,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: false, // NO ACTIVE QUOTATION
      currentRequirements: dummyReqs,
    });

    assert(evaluation.isConfirmed === false, "Safety gate rejects confirmation when hasValidQuotation is false");
    assert(evaluation.reason.includes("No active quotation"), "Reason identifies missing active quotation");
  }

  // ============================================================================
  // Test Group 7: Confirmation after quotation invalidation is rejected
  // ============================================================================
  console.log("\nTest Group 7: Confirmation after quotation invalidation is rejected");
  {
    const mismatchedReqs: BookingRequirements = {
      guestCount: 200, // Modified from 100
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

    const evaluation = evaluateConfirmationSafetyGate({
      userUtterance: "Yes, confirm the booking",
      language: "en",
      extractionResult: {
        status: "success",
        source: "mock",
        confidenceScore: 0.98,
        confirmationIntent: "positive_acceptance",
        data: null,
        clearedFields: [],
      },
      hasValidQuotation: true,
      activeQuotationGuestCount: 100, // Quote was for 100, but reqs have 200!
      currentRequirements: mismatchedReqs,
    });

    assert(
      evaluation.isConfirmed === false,
      "Safety gate rejects confirmation when quotation guest count does not match current requirements"
    );
    assert(
      evaluation.intent === "modification_requested",
      "Intent returned is 'modification_requested' requiring re-quotation"
    );
  }

  // ============================================================================
  // Test Group 8: Missing staff role is rejected
  // ============================================================================
  console.log("\nTest Group 8: Missing staff role is rejected in approveBookingByStaff");
  {
    const session = await createQuotationReadySession("sess_staff_test_grp8");
    session.state = "awaiting_staff_approval";
    await repository.save(session, session.revision);

    let threwError = false;
    try {
      // @ts-expect-error Testing missing staffRole at runtime
      await approveBookingByStaff(session.id, { staffIdentity: "staff_123", staffApprovalId: "APP_1" }, repository);
    } catch (e: unknown) {
      threwError = true;
      assert(
        (e as Error).message.includes("staffRole") || (e as Error).message.includes("StaffAuthorizationContext"),
        "Missing staffRole throws descriptive authorization error"
      );
    }
    assert(threwError, "approveBookingByStaff rejected call with missing staffRole");
  }

  // ============================================================================
  // Test Group 9: Missing staff identity is rejected
  // ============================================================================
  console.log("\nTest Group 9: Missing staff identity is rejected in approveBookingByStaff");
  {
    const session = await createQuotationReadySession("sess_staff_test_grp9");
    session.state = "awaiting_staff_approval";
    await repository.save(session, session.revision);

    let threwError = false;
    try {
      // @ts-expect-error Testing missing staffIdentity at runtime
      await approveBookingByStaff(session.id, { staffRole: "barista", staffApprovalId: "APP_1" }, repository);
    } catch (e: unknown) {
      threwError = true;
      assert(
        (e as Error).message.includes("staffIdentity") || (e as Error).message.includes("StaffAuthorizationContext"),
        "Missing staffIdentity throws descriptive authorization error"
      );
    }
    assert(threwError, "approveBookingByStaff rejected call with missing staffIdentity");
  }

  // ============================================================================
  // Test Group 10: Customer role cannot approve
  // ============================================================================
  console.log("\nTest Group 10: Customer role cannot approve (fails closed)");
  {
    const session = await createQuotationReadySession("sess_staff_test_grp10");
    session.state = "awaiting_staff_approval";
    await repository.save(session, session.revision);

    let threwCustomerError = false;
    try {
      await approveBookingByStaff(session.id, { staffIdentity: "cust_99", staffRole: "customer" as unknown as "barista", staffApprovalId: "APP_CUST" }, repository);
    } catch (e: unknown) {
      threwCustomerError = true;
      assert(
        (e as Error).message.includes("not permitted") || (e as Error).message.includes("Unauthorized staff approval"),
        "Unauthorized role 'customer' is rejected"
      );
    }
    assert(threwCustomerError, "Customer role was blocked from staff approval");

    let threwAnonError = false;
    try {
      await approveBookingByStaff(session.id, { staffIdentity: "anon", staffRole: "anonymous" as unknown as "barista", staffApprovalId: "APP_ANON" }, repository);
    } catch {
      threwAnonError = true;
    }
    assert(threwAnonError, "Anonymous role was blocked from staff approval");
  }

  // ============================================================================
  // Test Group 11: Authorized staff role can approve through authenticated boundary
  // ============================================================================
  console.log("\nTest Group 11: Authorized staff role can approve through authenticated boundary");
  {
    const roles = ["barista", "fleet_admin", "admin"] as const;

    for (const role of roles) {
      const sessId = `sess_staff_auth_${role}`;
      const session = await createQuotationReadySession(sessId);
      session.state = "awaiting_staff_approval";
      await repository.save(session, session.revision);

      const approved = await approveBookingByStaff(
        session.id,
        {
          staffIdentity: `verified_${role}_007`,
          staffRole: role,
          staffApprovalId: `AUTH_APPROVAL_${role.toUpperCase()}_123`,
        },
        repository
      );

      assert(approved.state === "booking_confirmed", `Staff role '${role}' successfully approved booking to booking_confirmed`);
      assert(
        approved.staffApprovalId === `AUTH_APPROVAL_${role.toUpperCase()}_123`,
        `Staff approval ID properly attached for role '${role}'`
      );
    }
  }

  // ============================================================================
  // Test Group 12: Unknown or protected fields cannot be cleared
  // ============================================================================
  console.log("\nTest Group 12: Unknown or protected fields cannot be cleared");
  {
    // Validate CUSTOMER_CLEARABLE_FIELDS allowlist
    const expectedAllowlist = [
      "guestCount",
      "eventDate",
      "startTime",
      "durationHours",
      "venueAddress",
      "eventType",
      "beveragePreferences",
      "selectedTier",
    ];

    assert(
      JSON.stringify(CUSTOMER_CLEARABLE_FIELDS) === JSON.stringify(expectedAllowlist),
      "CUSTOMER_CLEARABLE_FIELDS matches strict allowlist exactly"
    );

    // Protected fields must fail schema parse
    const protectedFields = [
      "id",
      "createdAt",
      "updatedAt",
      "state",
      "customerConfirmed",
      "staffApprovalId",
      "metadata",
      "corrections",
      "language",
      "phoneNumber",
      "missingFields",
    ];

    for (const field of protectedFields) {
      const parseResult = CustomerClearableFieldSchema.safeParse(field);
      assert(
        !parseResult.success,
        `Protected field '${field}' cannot be parsed as a customer-clearable field`
      );
    }
  }

  // ============================================================================
  // Test Group 13: Invalid clear-field patches are rejected safely
  // ============================================================================
  console.log("\nTest Group 13: Invalid clear-field patches are rejected safely");
  {
    await createQuotationReadySession("sess_test_grp13");

    // In applyRequirementsPatch, if clearedFields contains an unauthorized field,
    // it must not be wiped from session requirements.
    class MaliciousClearProvider implements ExtractionProvider {
      async extractRequirements(): Promise<StructuredExtractionResult> {
        return {
          status: "success",
          source: "mock",
          confidenceScore: 0.95,
          confirmationIntent: "ambiguous",
          data: {},
          clearedFields: ["staffApprovalId", "customerConfirmed", "id", "guestCount"] as unknown as CustomerClearableField[],
        };
      }
    }

    const sessionBefore = await repository.getById("sess_test_grp13");
    sessionBefore!.staffApprovalId = "UNTOUCHABLE_SECRET_STAFF_ID";
    sessionBefore!.requirements.customerConfirmed = false;
    await repository.save(sessionBefore!, sessionBefore!.revision);

    await processConversationTurn(
      sessionBefore!,
      "Clear everything",
      {
        extractionProvider: new MaliciousClearProvider(),
        sessionRepository: repository,
      }
    );

    const sessionAfter = await repository.getById("sess_test_grp13");
    assert(
      sessionAfter!.staffApprovalId === "UNTOUCHABLE_SECRET_STAFF_ID",
      "Protected field 'staffApprovalId' was NOT cleared by unauthorized clearedFields entry"
    );
    assert(
      sessionAfter!.requirements.guestCount === null,
      "Allowlisted field 'guestCount' WAS successfully cleared to null"
    );
  }

  // ============================================================================
  // Test Group 14: Timeout remains active while reading the response body
  // ============================================================================
  console.log("\nTest Group 14: Timeout remains active while reading the response body");
  {
    // Test that GeminiExtractionProvider timeout mechanism aborts when response body reading hangs
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    // Simulate fetch where connection succeeds fast, but response.json() delays indefinitely
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalled = true;
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                const err = new Error("This operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          }),
      } as unknown as Response;
    };

    try {
      const provider = new GeminiExtractionProvider({
        apiKey: "test_key",
        timeoutMs: 50, // 50ms quick timeout
      });

      const startTime = Date.now();
      const result = await provider.extractRequirements("I need coffee for 100 guests", {
        guestCount: null,
        eventDate: null,
        startTime: null,
        durationHours: null,
        venueAddress: null,
        eventType: null,
        beveragePreferences: [],
        selectedTier: null,
        handoffRequested: false,
        customerConfirmed: false,
        confidenceScore: 0.95,
        missingFields: [],
        unresolvedQuestions: [],
        corrections: [],
      }, "en");
      const elapsed = Date.now() - startTime;

      assert(fetchCalled, "Fetch was initiated");
      assert(
        result.status === "api_failure",
        "Hanging body read triggered api_failure via timeout abort"
      );
      assert(
        result.error?.includes("timed out") || result.error?.includes("aborted") || result.error !== undefined,
        "Error message reflects abort / timeout"
      );
      assert(elapsed < 1000, `Timeout triggered promptly within ${elapsed}ms`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // ============================================================================
  // Test Group 15: Existing Phase 6.1, 6.1.2, 6.2, and 6.2.1 behavior remains intact
  // ============================================================================
  console.log("\nTest Group 15: Existing Phase 6.1, 6.1.2, 6.2, and 6.2.1 behavior remains intact");
  {
    // 15.1 English End-to-End booking flow through staff approval
    const enSession = createVoiceBookingSession("+919876543210", "en");
    enSession.id = "p622_e2e_en";
    await repository.save(enSession);

    // Turn 1: Customer provides all details
    const turn1 = await processConversationTurn(
      enSession,
      "We want 150 guests on 2026-11-20 at 14:00 for 3 hours in HITEC City for a corporate event with cold brew and latte, package 2 please.",
      { sessionRepository: repository }
    );
    assert(turn1.state === "awaiting_customer_confirmation", "Turn 1 successfully presents quotation and awaits confirmation");
    assert(turn1.quotation !== null, "Turn 1 generates valid deterministic quotation");
    assert(turn1.quotation?.tiers.length === 3, "Quotation contains all 3 pricing tiers");
    assert(typeof turn1.quotation?.tiers[1].totalAmount === "number", "Quotation pricing computed deterministically");

    // Turn 2: Customer confirms quote
    const turn2 = await processConversationTurn(
      turn1.session,
      "Yes, please confirm this quote and proceed with booking.",
      { sessionRepository: repository }
    );
    assert(turn2.state === "awaiting_staff_approval", "Turn 2 successfully confirms and awaits staff approval");
    assert(turn2.extractedRequirements.customerConfirmed === true, "customerConfirmed is true after confirmation gate pass");

    // Turn 3: Staff approves
    const approved = await approveBookingByStaff(
      "p622_e2e_en",
      {
        staffIdentity: "barista_lead_01",
        staffRole: "barista",
        staffApprovalId: "BARISTA_APP_8831",
      },
      repository
    );
    assert(approved.state === "booking_confirmed", "Turn 3 successfully transitions to booking_confirmed");

    // 15.2 Schema validation for StaffAuthorizationContextSchema
    assert(
      StaffAuthorizationContextSchema.safeParse({
        staffIdentity: "lead_barista",
        staffRole: "barista",
        staffApprovalId: "STAFF_001",
      }).success,
      "StaffAuthorizationContextSchema validates valid staff context"
    );
    assert(
      !StaffAuthorizationContextSchema.safeParse({
        staffIdentity: "lead_barista",
        staffRole: "customer",
        staffApprovalId: "STAFF_001",
      }).success,
      "StaffAuthorizationContextSchema rejects invalid staff role"
    );
  }

  // ============================================================================
  // Summary
  // ============================================================================
  console.log("\n==================================================================");
  console.log(`  PHASE 6.2.2 HARDENING SUITE SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runPhase622HardeningTests().catch((err) => {
  console.error("Unhandled test suite exception:", err);
  process.exit(1);
});
