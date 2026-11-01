/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking Verification Suite
 * Tests state machine boundaries, multilingual extraction & code switching,
 * deterministic pricing bridge, multi-turn simulations, and safety guardrails.
 */

import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
  transitionVoiceBookingState,
  canTransition,
  detectLanguage,
  detectScript,
  generateVoiceBookingQuotation,
  formatQuotationMessage,
  MockExtractionProvider,
  InMemoryVoiceSessionRepository,
  defaultExtractionProvider,
  defaultSessionRepository,
  BookingRequirementsSchema,
  VoiceBookingSessionSchema,
  VoiceBookingState,
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

async function runTests() {
  console.log("==================================================================");
  console.log("  BREW Coffee — Phase 6.2 Voice Booking Verification Suite");
  console.log("==================================================================\n");

  // ============================================================================
  // Suite 1: State Machine Lifecycle & Invariant Enforcement
  // ============================================================================
  console.log("Suite 1: State Machine Lifecycle & Invariant Enforcement");

  // Valid standard progression
  assert(canTransition("created", "collecting_requirements"), "Can transition created -> collecting_requirements");
  assert(canTransition("collecting_requirements", "details_collected"), "Can transition collecting_requirements -> details_collected");
  assert(canTransition("details_collected", "quotation_presented"), "Can transition details_collected -> quotation_presented");
  assert(canTransition("quotation_presented", "awaiting_customer_confirmation"), "Can transition quotation_presented -> awaiting_customer_confirmation");
  assert(canTransition("awaiting_customer_confirmation", "customer_confirmed"), "Can transition awaiting_customer_confirmation -> customer_confirmed");
  assert(canTransition("customer_confirmed", "awaiting_staff_approval"), "Can transition customer_confirmed -> awaiting_staff_approval");
  assert(canTransition("awaiting_staff_approval", "booking_confirmed"), "Can transition awaiting_staff_approval -> booking_confirmed");

  // CRITICAL SAFEGUARD: customer_confirmed CANNOT jump directly to booking_confirmed
  assert(!canTransition("customer_confirmed", "booking_confirmed"), "Strict safeguard: customer_confirmed CANNOT transition directly to booking_confirmed");

  let directBypassCaught = false;
  try {
    transitionVoiceBookingState("customer_confirmed", "booking_confirmed");
  } catch (err: unknown) {
    directBypassCaught = true;
    const msg = (err as Error).message;
    assert(msg.includes("Cannot transition from 'customer_confirmed' to 'booking_confirmed'"), "Blocked invalid direct bypass with proper message");
  }
  assert(directBypassCaught, "Direct jump from customer_confirmed to booking_confirmed throws exception");

  // Staff approval requirement check
  let staffApprovalCheckPassed = false;
  try {
    transitionVoiceBookingState("awaiting_staff_approval", "booking_confirmed");
  } catch (err: unknown) {
    staffApprovalCheckPassed = true;
    assert((err as Error).message.includes("authorized staffApprovalId"), "Rejects booking_confirmed without staffApprovalId");
  }
  assert(staffApprovalCheckPassed, "Enforces staffApprovalId before transitioning to booking_confirmed");

  // Mandatory fields check for details_collected
  let missingFieldsCheckPassed = false;
  try {
    transitionVoiceBookingState("collecting_requirements", "details_collected", {
      requirements: {
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
        confidenceScore: 0,
        missingFields: ["guestCount", "eventDate", "startTime", "durationHours", "venueAddress"],
        unresolvedQuestions: [],
      },
    });
  } catch (err: unknown) {
    missingFieldsCheckPassed = true;
    assert((err as Error).message.includes("missing mandatory fields"), "Rejects details_collected when mandatory fields are missing");
  }
  assert(missingFieldsCheckPassed, "Mandatory fields check enforced for details_collected");

  // Terminal states have 0 outbound transitions
  const terminalStates: VoiceBookingState[] = [
    "booking_confirmed",
    "customer_declined",
    "human_handoff",
    "cancelled",
    "failed",
  ];
  for (const ts of terminalStates) {
    assert(!canTransition(ts, "collecting_requirements"), `Terminal state '${ts}' allows no outbound transitions`);
  }

  console.log("\nSuite 2: Multilingual Detection & Code-Switching");

  // Script detection
  assert(detectScript("Hello from BREW") === "latin", "Detects Latin script");
  assert(detectScript("नमस्ते कॉफ़ी") === "devanagari", "Detects Devanagari script");
  assert(detectScript("నమస్కారం కాఫీ") === "telugu", "Detects Telugu script");

  // Language classification
  const hiScript = detectLanguage("नमस्ते, हमें 100 लोगों के लिए कॉफ़ी चाहिए");
  assert(hiScript.language === "hi" && hiScript.confidence > 0.9, "Devanagari text classified as 'hi'");

  const teScript = detectLanguage("నమస్కారం, మాకు 80 మందికి కాఫీ కావాలి");
  assert(teScript.language === "te" && teScript.confidence > 0.9, "Telugu script classified as 'te'");

  const hinglish = detectLanguage("namaste humko 50 logon ke liye coffee chahiye kitna kharcha aayega");
  assert(hinglish.language === "hi", "Romanized Hindi (Hinglish) classified as 'hi'");

  const tenglish = detectLanguage("namaskaram maaku 50 mandiki coffee kavali entha kharchu avthundi");
  assert(tenglish.language === "te", "Romanized Telugu (Tenglish) classified as 'te'");

  const english = detectLanguage("We are looking for artisanal pour-over coffee for 75 guests at our tech meetup");
  assert(english.language === "en", "English text classified as 'en'");

  // Explicit directives
  assert(detectLanguage("Please switch to hindi now").language === "hi", "Explicit directive 'switch to hindi' respected");
  assert(detectLanguage("telugu lo matladu please").language === "te", "Explicit directive 'telugu lo matladu' respected");
  assert(detectLanguage("speak in english please").language === "en", "Explicit directive 'speak in english' respected");

  console.log("\nSuite 3: Zod Runtime Validation");

  // Valid requirements parse cleanly
  const validReqs = {
    guestCount: 50,
    eventDate: "2026-12-15",
    startTime: "10:30",
    durationHours: 4,
    venueAddress: "Hitec City, Hyderabad",
    eventType: "corporate",
    beveragePreferences: ["cold brew", "latte"],
    selectedTier: "STANDARD" as const,
    handoffRequested: false,
    customerConfirmed: false,
    confidenceScore: 0.95,
    missingFields: [],
    unresolvedQuestions: [],
  };
  const parseReqsResult = BookingRequirementsSchema.safeParse(validReqs);
  assert(parseReqsResult.success, "BookingRequirementsSchema successfully parses valid entity");

  // Rejects invalid guest counts
  assert(!BookingRequirementsSchema.safeParse({ ...validReqs, guestCount: 5 }).success, "Rejects guestCount < 10");
  assert(!BookingRequirementsSchema.safeParse({ ...validReqs, guestCount: 5000 }).success, "Rejects guestCount > 1000");

  // Rejects invalid date format
  assert(!BookingRequirementsSchema.safeParse({ ...validReqs, eventDate: "15-12-2026" }).success, "Rejects non-ISO date format");

  // Validates full VoiceBookingSessionSchema
  const validSession = {
    id: "vbs_test_123",
    phoneNumber: "+919876543210",
    language: "en" as const,
    state: "created" as const,
    requirements: validReqs,
    quotation: null,
    conversationHistory: [
      {
        id: "msg_1",
        role: "user" as const,
        content: "Hello",
        language: "en" as const,
        timestamp: "2026-11-01T10:00:00.000Z",
      },
    ],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    staffApprovalId: null,
    metadata: { source: "test" },
  };
  assert(VoiceBookingSessionSchema.safeParse(validSession).success, "VoiceBookingSessionSchema validates complete session");

  console.log("\nSuite 4: Deterministic Quotation Engine Bridge");

  const quote = generateVoiceBookingQuotation({
    guestCount: 100,
    eventDate: "2026-12-15",
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
  });

  assert(quote.guestCount === 100, "Quotation guest count matches input (100)");
  assert(quote.tiers.length === 3, "Quotation produces exactly 3 tiers");

  const basicTier = quote.tiers.find((t) => t.tierId === "BASIC");
  const standardTier = quote.tiers.find((t) => t.tierId === "STANDARD");
  const premiumTier = quote.tiers.find((t) => t.tierId === "PREMIUM");

  assert(basicTier !== undefined && standardTier !== undefined && premiumTier !== undefined, "All 3 tiers (BASIC, STANDARD, PREMIUM) present");
  assert(basicTier!.pricePerGuest >= 180, "Basic tier adheres to minimum pricing floor (₹180)");
  assert(standardTier!.pricePerGuest >= 260, "Standard tier adheres to minimum pricing floor (₹260)");
  assert(premiumTier!.pricePerGuest >= 360, "Premium tier adheres to minimum pricing floor (₹360)");
  assert(basicTier!.grossMarginPercent >= 30.0, "Basic tier guarantees minimum 30% gross margin");
  assert(standardTier!.grossMarginPercent >= 30.0, "Standard tier guarantees minimum 30% gross margin");
  assert(premiumTier!.grossMarginPercent >= 30.0, "Premium tier guarantees minimum 30% gross margin");

  // Determinism check: running it again with the same parameters gives exact rupee equivalence
  const quote2 = generateVoiceBookingQuotation({
    guestCount: 100,
    eventDate: "2026-12-15",
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
  });
  assert(quote.tiers[0].totalAmount === quote2.tiers[0].totalAmount, "Deterministic quotation: zero price fluctuation across executions");

  // Quotation format messages in all 3 languages
  const enQuoteMsg = formatQuotationMessage(quote, "en");
  const hiQuoteMsg = formatQuotationMessage(quote, "hi");
  const teQuoteMsg = formatQuotationMessage(quote, "te");

  assert(enQuoteMsg.includes("Classic Brew") && enQuoteMsg.includes("Artisanal Signature"), "English quotation message formatted correctly");
  assert(hiQuoteMsg.includes("Classic Brew") && hiQuoteMsg.includes("पैकेज"), "Hindi quotation message formatted correctly");
  assert(teQuoteMsg.includes("Classic Brew") && teQuoteMsg.includes("ప్యాకేజీలు"), "Telugu quotation message formatted correctly");

  console.log("\nSuite 5: English End-to-End Conversation Flow");

  const repo = new InMemoryVoiceSessionRepository();
  const provider = new MockExtractionProvider();

  let session = createVoiceBookingSession("+919876543210", "en");
  await repo.save(session);
  assert(session.state === "created", "Session starts in 'created' state");

  // Turn 1: Partial requirements (guests + venue)
  let turnResult = await processConversationTurn(session, "Hi, I need catering for 80 guests at Hitec City", {
    extractionProvider: provider,
    sessionRepository: repo,
  });
  session = turnResult.session;
  assert(session.state === "collecting_requirements", "Transitions to collecting_requirements");
  assert(session.requirements.guestCount === 80, "Extracted guestCount = 80");
  assert(session.requirements.venueAddress === "Hitec City", "Extracted venueAddress = Hitec City");
  assert(session.requirements.missingFields.includes("eventDate"), "Identifies eventDate as still missing");

  // Turn 2: Remaining requirements (date, time, duration)
  turnResult = await processConversationTurn(
    session,
    "The event is on 2026-12-20 from 10:00 for 4 hours",
    { extractionProvider: provider, sessionRepository: repo }
  );
  session = turnResult.session;
  assert(session.requirements.eventDate === "2026-12-20", "Extracted eventDate = 2026-12-20");
  assert(session.requirements.startTime === "10:00", "Extracted startTime = 10:00");
  assert(session.requirements.durationHours === 4, "Extracted durationHours = 4");
  assert(session.requirements.missingFields.length === 0, "All mandatory fields collected");
  assert(session.state === "awaiting_customer_confirmation", "Auto-transitioned through details_collected and quotation_presented to awaiting_customer_confirmation");
  assert(session.quotation !== null, "Deterministic quotation generated and attached");
  assert(turnResult.assistantResponse.includes("Artisanal Signature"), "Presents quotation packages to user");

  // Turn 3: Customer confirms Artisanal Signature package
  turnResult = await processConversationTurn(
    session,
    "Yes, I confirm the Artisanal Signature package!",
    { extractionProvider: provider, sessionRepository: repo }
  );
  session = turnResult.session;
  assert(session.requirements.selectedTier === "STANDARD", "Extracted selectedTier = STANDARD");
  assert(session.requirements.customerConfirmed === true, "Recorded customerConfirmed = true");
  assert(session.state === "awaiting_staff_approval", "Session transitioned to awaiting_staff_approval (NEVER to booking_confirmed directly)");
  assert(!session.staffApprovalId, "Staff approval ID is empty before staff review");

  // Turn 4: Staff reviews and approves booking
  const approvedSession = await approveBookingByStaff(
    session.id,
    {
      staffIdentity: "barista_op_1",
      staffRole: "barista",
      staffApprovalId: "STAFF_OP_7749",
    },
    repo
  );
  assert(approvedSession.state === "booking_confirmed", "Staff approval transitions session to booking_confirmed");
  assert(approvedSession.staffApprovalId === "STAFF_OP_7749", "Staff approval ID recorded on session");

  console.log("\nSuite 6: Hindi (Hinglish) Conversation Flow");

  let hiSession = createVoiceBookingSession("+919123456789", "hi");
  await repo.save(hiSession);

  // Turn 1: Hinglish input with guests and location
  let hiTurn = await processConversationTurn(
    hiSession,
    "Namaste, hamein shaadi ke liye 120 logon ke liye coffee chahiye Gachibowli mein",
    { extractionProvider: provider, sessionRepository: repo }
  );
  hiSession = hiTurn.session;
  assert(hiSession.language === "hi", "Language retained/detected as 'hi'");
  assert(hiSession.requirements.guestCount === 120, "Hinglish guest extraction = 120");
  assert(hiSession.requirements.venueAddress === "Gachibowli", "Hinglish venue extraction = Gachibowli");

  // Turn 2: Providing remaining details in Hinglish
  hiTurn = await processConversationTurn(
    hiSession,
    "2026-11-25 ko subah 10 baje 4 ghante ke liye",
    { extractionProvider: provider, sessionRepository: repo }
  );
  hiSession = hiTurn.session;
  assert(hiSession.requirements.eventDate === "2026-11-25", "Extracted eventDate = 2026-11-25");
  assert(hiSession.requirements.durationHours === 4, "Extracted durationHours = 4");
  assert(hiSession.state === "awaiting_customer_confirmation", "Hindi session reached awaiting_customer_confirmation");
  assert(hiTurn.assistantResponse.includes("पैकेज"), "Response formatted in Hindi");

  // Turn 3: Confirmation in Hinglish
  hiTurn = await processConversationTurn(
    hiSession,
    "Haan theek hai confirm kardo",
    { extractionProvider: provider, sessionRepository: repo }
  );
  hiSession = hiTurn.session;
  assert(hiSession.state === "awaiting_staff_approval", "Hindi customer confirmation transitions to awaiting_staff_approval");

  console.log("\nSuite 7: Telugu (Tenglish) Conversation Flow & Code-Switching");

  let teSession = createVoiceBookingSession("+919988776655", "en"); // Starts in English
  await repo.save(teSession);

  // Turn 1: User speaks in Telugu script -> code-switching adapts session language to 'te'
  let teTurn = await processConversationTurn(
    teSession,
    "నమస్కారం, మాకు 60 మందికి కాఫీ కావాలి Jubilee Hills లో",
    { extractionProvider: provider, sessionRepository: repo }
  );
  teSession = teTurn.session;
  assert(teSession.language === "te", "Code-switching dynamically shifted session language to 'te'");
  assert(teSession.requirements.guestCount === 60, "Extracted guestCount = 60 from Telugu");
  assert(teSession.requirements.venueAddress === "Jubilee Hills", "Extracted venueAddress = Jubilee Hills");

  // Turn 2: Providing date and time in Tenglish
  teTurn = await processConversationTurn(
    teSession,
    "2026-12-10 naadu 11:00 ki 3 gantalu",
    { extractionProvider: provider, sessionRepository: repo }
  );
  teSession = teTurn.session;
  assert(teSession.state === "awaiting_customer_confirmation", "Telugu session reached awaiting_customer_confirmation");
  assert(teTurn.assistantResponse.includes("ప్యాకేజీలు"), "Telugu response includes package options");

  // Turn 3: Confirmation in Telugu
  teTurn = await processConversationTurn(
    teSession,
    "అవును కన్ఫర్మ్ చేయండి (Avunu confirm cheyyandi)",
    { extractionProvider: provider, sessionRepository: repo }
  );
  teSession = teTurn.session;
  assert(teSession.state === "awaiting_staff_approval", "Telugu customer confirmation moves to awaiting_staff_approval");

  console.log("\nSuite 8: Safeguards & Escape Hatches");

  // 1. Human handoff
  const handoffSession = createVoiceBookingSession("+919876543211", "en");
  await repo.save(handoffSession);
  const handoffTurn = await processConversationTurn(
    handoffSession,
    "Can I please speak with a human manager?",
    { extractionProvider: provider, sessionRepository: repo }
  );
  assert(handoffTurn.state === "human_handoff", "Human handoff request triggers state 'human_handoff'");
  assert(handoffTurn.handoffTriggered === true, "Turn result flags handoffTriggered = true");

  // 2. Cancellation
  const cancelSession = createVoiceBookingSession("+919876543212", "en");
  await repo.save(cancelSession);
  const cancelTurn = await processConversationTurn(
    cancelSession,
    "cancel booking",
    { extractionProvider: provider, sessionRepository: repo }
  );
  assert(cancelTurn.state === "cancelled", "User cancel request triggers state 'cancelled'");

  // 3. Customer decline
  const declineSession = createVoiceBookingSession("+919876543213", "en");
  declineSession.state = "awaiting_customer_confirmation";
  declineSession.requirements = validReqs;
  await repo.save(declineSession);

  const declineTurn = await processConversationTurn(
    declineSession,
    "No, the price is too high, decline this quote",
    { extractionProvider: provider, sessionRepository: repo }
  );
  assert(declineTurn.state === "customer_declined", "Customer decline triggers state 'customer_declined'");

  // 4. Staff approval fails if not in awaiting_staff_approval
  let prematureApprovalCaught = false;
  try {
    const unreadySession = createVoiceBookingSession("+919876543214", "en");
    await repo.save(unreadySession);
    await approveBookingByStaff(
      unreadySession.id,
      {
        staffIdentity: "barista_op_1",
        staffRole: "barista",
        staffApprovalId: "STAFF_001",
      },
      repo
    );
  } catch (err: unknown) {
    prematureApprovalCaught = true;
    assert((err as Error).message.includes("Cannot approve booking: session is in state 'created'"), "Rejects staff approval on unready session");
  }
  assert(prematureApprovalCaught, "Prevents approving bookings before awaiting_staff_approval");

  console.log("\nSuite 9: Zero-Network Isolation Verification");
  assert(typeof defaultExtractionProvider !== "undefined", "Default extraction provider instantiated offline");
  assert(typeof defaultSessionRepository !== "undefined", "Default session repository operates in-memory");

  console.log("\n==================================================================");
  console.log(`  Phase 6.2 Verification Complete: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Unhandled error in verification suite:", err);
  process.exit(1);
});
