/**
 * BREW Coffee Platform — Phase 6.2.1 Hardening Verification Suite
 * Exhaustive safety and reliability verification for conversation engine hardening:
 * 1. Strict Gemini response validation & security (no key in URL, bounded timeout, .strict() schema)
 * 2. Quotation validation without fabricated defaults
 * 3. Structured patch model, customer corrections, and stale quote invalidation
 * 4. Confirmation intent classification (English, Hindi, Telugu, Hinglish, Tenglish, false-positive protection)
 * 5. Session boundaries, immutability, caller authentication, and staff approval RBAC
 */

import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
  generateVoiceBookingQuotation,
  validateQuotationRequirements,
  classifyConfirmationIntent,
  createQuotationSnapshot,
  GeminiExtractionProvider,
  MockExtractionProvider,
  InMemoryVoiceSessionRepository,
  GeminiExtractionOutputSchema,
  isValidCalendarDate,
  isValidTime24,
  BookingRequirements,
  VoiceBookingSession,
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

async function runHardeningTests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2.1 Conversation Engine Hardening Suite");
  console.log("==================================================================\n");

  // ============================================================================
  // Suite 1: Strict Gemini Response Validation & Security
  // ============================================================================
  console.log("Suite 1: Strict Gemini Response Validation & Security");

  // 1.1 Valid structured output parses cleanly
  const validGeminiOutput = {
    guestCount: 150,
    eventDate: "2026-11-20",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "HITEC City, Hyderabad",
    eventType: "corporate",
    beveragePreferences: ["cold brew", "latte"],
    selectedTier: "STANDARD" as const,
    handoffRequested: false,
    customerConfirmed: true,
    confirmationIntent: "positive_acceptance" as const,
    confidenceScore: 0.98,
    clearedFields: [],
  };
  assert(
    GeminiExtractionOutputSchema.safeParse(validGeminiOutput).success,
    "Valid Gemini structured output passes strict schema validation"
  );

  // 1.2 Rejection of invalid guest counts
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, guestCount: 5 }).success,
    "Rejects guest count < 10"
  );
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, guestCount: 1500 }).success,
    "Rejects guest count > 1000"
  );

  // 1.3 Rejection of impossible calendar dates
  assert(!isValidCalendarDate("2026-02-30"), "Calendar check: Feb 30 is impossible");
  assert(!isValidCalendarDate("2026-04-31"), "Calendar check: April 31 is impossible");
  assert(!isValidCalendarDate("2025-02-29"), "Calendar check: Feb 29 on non-leap year 2025 is impossible");
  assert(isValidCalendarDate("2024-02-29"), "Calendar check: Feb 29 on leap year 2024 is valid");
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, eventDate: "2026-02-30" }).success,
    "Gemini schema strictly rejects impossible calendar date '2026-02-30'"
  );

  // 1.4 Rejection of invalid 24-hour time
  assert(!isValidTime24("25:00"), "25:00 rejected as invalid time");
  assert(!isValidTime24("12:60"), "12:60 rejected as invalid time");
  assert(isValidTime24("00:00") && isValidTime24("23:59"), "Valid 24h boundaries accepted");
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, startTime: "24:30" }).success,
    "Gemini schema rejects invalid start time"
  );

  // 1.5 Rejection of invalid duration
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, durationHours: 0 }).success,
    "Rejects duration < 1 hour"
  );
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, durationHours: 14 }).success,
    "Rejects duration > 12 hours"
  );

  // 1.6 Rejection of invalid service tier
  assert(
    !GeminiExtractionOutputSchema.safeParse({ ...validGeminiOutput, selectedTier: "SUPER_VIP" }).success,
    "Rejects unrecognized tier 'SUPER_VIP'"
  );

  // 1.7 Strict rejection of unexpected/hallucinated model fields
  const hallucinatedModelOutput = {
    ...validGeminiOutput,
    fabricatedDiscount: 50,
    aiGeneratedPrice: 10000,
  };
  const strictResult = GeminiExtractionOutputSchema.safeParse(hallucinatedModelOutput);
  assert(!strictResult.success, "Strict schema rejects unexpected hallucinated model fields");

  // 1.8 Gemini provider fail-closed in production when credentials missing
  const prevEnv = process.env.NODE_ENV;
  const prevKey = process.env.GEMINI_API_KEY;
  const prevModel = process.env.VOICE_AGENT_MODEL;

  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.GEMINI_API_KEY;
    delete process.env.VOICE_AGENT_MODEL;

    const geminiProd = new GeminiExtractionProvider();
    const result = await geminiProd.extractRequirements("I need 50 guests", {} as BookingRequirements, "en");
    assert(result.status === "service_unavailable", "Production Gemini provider returns 'service_unavailable' when credentials missing");
    assert(result.source === "gemini", "Does not falsely claim mock fallback as successful gemini extraction");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
    if (prevKey) process.env.GEMINI_API_KEY = prevKey;
    if (prevModel) process.env.VOICE_AGENT_MODEL = prevModel;
  }

  // ============================================================================
  // Suite 2: Quotation Input Validation Without Fabricated Defaults
  // ============================================================================
  console.log("\nSuite 2: Quotation Input Validation Without Fabricated Defaults");

  const baseReqs: BookingRequirements = {
    guestCount: 100,
    eventDate: "2026-12-20",
    startTime: "10:00",
    durationHours: 4,
    venueAddress: "Hitec City, Hyderabad",
    eventType: "corporate",
    beveragePreferences: [],
    selectedTier: null,
    handoffRequested: false,
    customerConfirmed: false,
    confidenceScore: 1.0,
    missingFields: [],
    unresolvedQuestions: [],
  };

  // 2.1 Rejects missing event date (no silent default '2026-12-15')
  const missingDateValidation = validateQuotationRequirements({ ...baseReqs, eventDate: null });
  assert(!missingDateValidation.isValid && missingDateValidation.errors.some((e) => e.includes("eventDate is required")), "Rejects missing event date without applying fabricated default");

  // 2.2 Rejects missing duration (no silent default 4 hours)
  const missingDurationValidation = validateQuotationRequirements({ ...baseReqs, durationHours: null });
  assert(!missingDurationValidation.isValid && missingDurationValidation.errors.some((e) => e.includes("durationHours is required")), "Rejects missing duration without applying fabricated default");

  // 2.3 Rejects missing start time (no silent default 10:00)
  const missingTimeValidation = validateQuotationRequirements({ ...baseReqs, startTime: null });
  assert(!missingTimeValidation.isValid && missingTimeValidation.errors.some((e) => e.includes("startTime is required")), "Rejects missing start time without applying fabricated default");

  // 2.4 Rejects impossible calendar date
  const impossibleDateValidation = validateQuotationRequirements({ ...baseReqs, eventDate: "2026-04-31" });
  assert(!impossibleDateValidation.isValid && impossibleDateValidation.errors.some((e) => e.includes("not a valid calendar date")), "Rejects impossible calendar date in quotation validation");

  // 2.5 Rejects multi-day midnight wrapping
  const midnightWrapValidation = validateQuotationRequirements({ ...baseReqs, startTime: "22:00", durationHours: 4 });
  assert(!midnightWrapValidation.isValid && midnightWrapValidation.errors.some((e) => e.includes("crosses midnight")), "Rejects service durations crossing midnight into the next day");

  // 2.6 Valid quote remains deterministic
  const quoteA = generateVoiceBookingQuotation(baseReqs);
  const quoteB = generateVoiceBookingQuotation(baseReqs);
  assert(quoteA.tiers[1].totalAmount === quoteB.tiers[1].totalAmount, "Deterministic pricing produces identical numbers without variance");

  // ============================================================================
  // Suite 3: Requirement Merging, Customer Corrections & Quote Invalidation
  // ============================================================================
  console.log("\nSuite 3: Requirement Merging, Customer Corrections & Quote Invalidation");

  const repo = new InMemoryVoiceSessionRepository();
  const provider = new MockExtractionProvider();

  let session = createVoiceBookingSession("+919876543210", "en");
  await repo.save(session);

  // Turn 1: Initial details
  let turn = await processConversationTurn(session, "We need coffee for 60 guests at Hitec City on 2026-12-15 from 10:00 for 3 hours", {
    extractionProvider: provider,
    sessionRepository: repo,
  });
  session = turn.session;
  assert(session.state === "awaiting_customer_confirmation", "Session reached awaiting_customer_confirmation with initial quote");
  assert(session.quotation !== null, "Quotation generated for 60 guests");
  const initialQuoteAmount = session.quotation!.tiers[1].totalAmount;

  // Turn 2: Customer modifies guest count from 60 to 120
  turn = await processConversationTurn(session, "Actually we need to change guests to 120 people instead of 60", {
    extractionProvider: provider,
    sessionRepository: repo,
  });
  session = turn.session;
  assert(session.requirements.guestCount === 120, "Guest count corrected to 120");
  assert(session.requirements.corrections !== undefined && session.requirements.corrections.length > 0, "Recorded correction in audit trail");
  assert(session.requirements.corrections![0].field === "guestCount", "Audit trail identifies 'guestCount' as corrected field");
  assert(session.requirements.corrections![0].previousValue === 60, "Audit trail records previous value 60");
  assert(session.requirements.corrections![0].newValue === 120, "Audit trail records new value 120");
  assert(session.quotation!.tiers[1].totalAmount !== initialQuoteAmount, "Previous quotation was invalidated and recalculated with new guest count");

  // Turn 3: Customer explicitly clears date
  turn = await processConversationTurn(session, "Please clear the date, we are rescheduling", {
    extractionProvider: provider,
    sessionRepository: repo,
  });
  session = turn.session;
  assert(session.requirements.eventDate === null, "Event date explicitly cleared to null");
  assert(session.quotation === null, "Quotation invalidated when mandatory date cleared");
  assert(session.state === "collecting_requirements", "Transitioned back to collecting_requirements");
  assert(session.requirements.missingFields.includes("eventDate"), "eventDate re-added to missingFields");

  // Turn 4: Low-confidence extraction does NOT overwrite valid existing value
  const mockLowConfidenceProvider = {
    detectLanguage: provider.detectLanguage.bind(provider),
    extractRequirements: async () => ({
      status: "low_confidence" as const,
      source: "gemini" as const,
      data: { guestCount: 30 },
      confidenceScore: 0.4,
    }),
  };
  turn = await processConversationTurn(session, "maybe 30 people?", {
    extractionProvider: mockLowConfidenceProvider,
    sessionRepository: repo,
  });
  session = turn.session;
  assert(session.requirements.guestCount === 120, "Valid guestCount (120) preserved against low-confidence overwrite (30)");

  // ============================================================================
  // Suite 4: Strengthened Confirmation Intent Classification
  // ============================================================================
  console.log("\nSuite 4: Strengthened Confirmation Intent Classification");

  // 4.1 False-positive protection: Unrelated sentence containing "yes" MUST NOT confirm booking
  assert(
    classifyConfirmationIntent("Yes, my colleague mentioned BREW last month, but can you tell me what coffee beans you use?", "en") === "clarification_requested",
    "Unrelated sentence with 'yes' classified as clarification question, NOT acceptance"
  );
  assert(
    classifyConfirmationIntent("Yes, we had an event in Mumbai last year, but this year it's Hyderabad", "en") === "ambiguous",
    "Conversational 'yes' in narrative context classified as ambiguous, NOT acceptance"
  );
  assert(
    classifyConfirmationIntent("Yeah ok, but does the van require separate power sockets?", "en") === "clarification_requested",
    "'Yeah ok' before a question classified as clarification, NOT acceptance"
  );

  // 4.2 Explicit Positive Confirmation Across Languages
  assert(classifyConfirmationIntent("Yes, please confirm the Artisanal Signature package", "en") === "positive_acceptance", "English explicit confirmation classified as positive_acceptance");
  assert(classifyConfirmationIntent("I confirm this quotation", "en") === "positive_acceptance", "English 'I confirm' classified as positive_acceptance");
  assert(classifyConfirmationIntent("Haan theek hai confirm kardo", "hi") === "positive_acceptance", "Hinglish explicit confirmation classified as positive_acceptance");
  assert(classifyConfirmationIntent("हाँ, यह पैकेज कन्फ़र्म कर दीजिए", "hi") === "positive_acceptance", "Hindi script explicit confirmation classified as positive_acceptance");
  assert(classifyConfirmationIntent("Avunu confirm cheyyandi", "te") === "positive_acceptance", "Tenglish explicit confirmation classified as positive_acceptance");
  assert(classifyConfirmationIntent("అవును, ఈ ప్యాకేజీని కన్ఫర్మ్ చేయండి", "te") === "positive_acceptance", "Telugu script explicit confirmation classified as positive_acceptance");

  // 4.3 Explicit Rejection
  assert(classifyConfirmationIntent("No, please cancel this booking", "en") === "rejection", "English cancellation classified as rejection");
  assert(classifyConfirmationIntent("Yeh bohot mehenga hai, nahi chahiye", "hi") === "rejection", "Hindi rejection classified as rejection");
  assert(classifyConfirmationIntent("Kaadhu, vaddu", "te") === "rejection", "Telugu rejection classified as rejection");

  // 4.4 Ambiguous confirmation test in session flow
  const confSession = createVoiceBookingSession("+919111222333", "en");
  confSession.state = "awaiting_customer_confirmation";
  confSession.requirements = { ...baseReqs };
  confSession.quotation = quoteA;
  confSession.quotationSnapshot = createQuotationSnapshot(baseReqs);
  await repo.save(confSession);

  // Customer responds ambiguously
  const ambiguousTurn = await processConversationTurn(
    confSession,
    "Yes, I see the prices, but maybe let me check with my team first",
    { extractionProvider: provider, sessionRepository: repo }
  );
  assert(ambiguousTurn.state === "awaiting_customer_confirmation", "Ambiguous response DOES NOT transition to staff approval");
  assert(ambiguousTurn.session.requirements.customerConfirmed === false, "Customer confirmation remains false");
  assert(ambiguousTurn.assistantResponse.includes("please clearly confirm"), "Prompts customer for explicit clarification");

  // Customer responds with explicit acceptance
  const confirmedTurn = await processConversationTurn(
    ambiguousTurn.session,
    "Yes, please confirm the Artisanal Signature package!",
    { extractionProvider: provider, sessionRepository: repo }
  );
  assert(confirmedTurn.state === "awaiting_staff_approval", "Explicit acceptance transitions to awaiting_staff_approval");
  assert(confirmedTurn.session.requirements.customerConfirmed === true, "Customer confirmation recorded true");

  // ============================================================================
  // Suite 5: Session Boundaries, Immutability & RBAC Staff Approval
  // ============================================================================
  console.log("\nSuite 5: Session Boundaries, Immutability & RBAC Staff Approval");

  // 5.1 Immutability check: caller's session object is NOT mutated
  const originalSession = createVoiceBookingSession("+919777888999", "en");
  await repo.save(originalSession);
  const originalState = originalSession.state;
  const originalHistoryLength = originalSession.conversationHistory.length;

  await processConversationTurn(originalSession, "Hello, I want coffee for 50 people", {
    extractionProvider: provider,
    sessionRepository: repo,
  });

  assert(originalSession.state === originalState, "Caller's original session state was NOT mutated");
  assert(originalSession.conversationHistory.length === originalHistoryLength, "Caller's original history was NOT mutated");

  // 5.2 Malformed session input rejected safely
  let malformedCaught = false;
  try {
    await processConversationTurn({ id: "invalid" } as unknown as VoiceBookingSession, "Hi", {
      extractionProvider: provider,
      sessionRepository: repo,
    });
  } catch (err: unknown) {
    malformedCaught = true;
    assert((err as Error).message.includes("Invalid VoiceBookingSession provided"), "Malformed session object rejected by schema guard");
  }
  assert(malformedCaught, "Session boundary rejects malformed input safely");

  // 5.3 Caller identity verification: Phone number mismatch rejected
  let mismatchCaught = false;
  try {
    const authorizedSession = createVoiceBookingSession("+919000111222", "en");
    await repo.save(authorizedSession);
    await processConversationTurn(authorizedSession, "Hi", {
      extractionProvider: provider,
      sessionRepository: repo,
      callerPhoneNumber: "+919999999999", // Spoofed caller
    });
  } catch (err: unknown) {
    mismatchCaught = true;
    assert((err as Error).message.includes("Security violation: Caller phone number"), "Rejects caller phone number mismatch");
  }
  assert(mismatchCaught, "Caller phone authorization check enforced");

  // 5.4 Staff Approval RBAC: Unauthorized role rejected
  let unauthorizedRoleCaught = false;
  try {
    const pendingSession = createVoiceBookingSession("+919333444555", "en");
    pendingSession.state = "awaiting_staff_approval";
    await repo.save(pendingSession);

    await approveBookingByStaff(
      pendingSession.id,
      {
        staffIdentity: "cust_123",
        staffRole: "customer",
        staffApprovalId: "STAFF_001",
      },
      repo
    );
  } catch (err: unknown) {
    unauthorizedRoleCaught = true;
    assert((err as Error).message.includes("Unauthorized staff approval attempt"), "Rejects approval when caller role is not staff");
  }
  assert(unauthorizedRoleCaught, "Staff RBAC enforced: customer role blocked from approving booking");

  // 5.5 Staff Approval RBAC: Authorized role accepted
  const pendingSession2 = createVoiceBookingSession("+919333444556", "en");
  pendingSession2.state = "awaiting_staff_approval";
  await repo.save(pendingSession2);

  const approved = await approveBookingByStaff(
    pendingSession2.id,
    {
      staffIdentity: "barista_007",
      staffRole: "barista",
      staffApprovalId: "STAFF_BARISTA_44",
    },
    repo
  );
  assert(approved.state === "booking_confirmed", "Authorized barista role successfully approves booking");
  assert(approved.staffApprovalId === "STAFF_BARISTA_44", "Recorded authorized staff approval ID");

  console.log("\n==================================================================");
  console.log(`  Phase 6.2.1 Hardening Complete: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runHardeningTests().catch((err) => {
  console.error("Unhandled error in hardening suite:", err);
  process.exit(1);
});
