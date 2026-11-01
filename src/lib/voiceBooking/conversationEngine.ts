/**
 * BREW Coffee Platform — Phase 6.2.2 AI Conversation Engine
 * Orchestrates multi-turn conversation intelligence for the AI Voice Booking Agent.
 * Hardened with fail-closed staff authorization, deterministic confirmation safety gate,
 * strict customer-clearable field allowlisting, and session immutability.
 */

import {
  BookingRequirements,
  ConfirmationSafetyEvaluation,
  ConversationMessage,
  ConversationTurnResult,
  CustomerClearableField,
  ExtractionProvider,
  QuotationMaterialSnapshot,
  RequirementCorrectionRecord,
  StaffAuthorizationContext,
  StructuredExtractionResult,
  SupportedLanguage,
  VoiceBookingSession,
  VoiceSessionRepository,
} from "./types";
import {
  getMissingMandatoryFields,
  transitionVoiceBookingState,
} from "./stateMachine";
import {
  GREETINGS,
  CONFIRMATION_AWAITING_STAFF_APPROVAL,
  DECLINED_MESSAGES,
  HANDOFF_MESSAGES,
  CANCELLED_MESSAGES,
  getPromptForNextMissingField,
} from "./prompts";
import {
  createQuotationSnapshot,
  formatQuotationMessage,
  generateVoiceBookingQuotation,
  validateQuotationRequirements,
  verifyQuotationIntegrity,
} from "./quotationAdapter";
import {
  classifyConfirmationIntent,
  MockExtractionProvider,
} from "./providers/extractionProvider";
import { InMemoryVoiceSessionRepository } from "./repositories/sessionRepository";
import {
  ConversationMessageSchema,
  CustomerClearableFieldSchema,
  StaffAuthorizationContextSchema,
  VoiceBookingSessionSchema,
} from "./schemas";

export const defaultExtractionProvider = new MockExtractionProvider();
export const defaultSessionRepository = new InMemoryVoiceSessionRepository();

/**
 * Factory for creating a brand-new voice booking session.
 */
export function createVoiceBookingSession(
  phoneNumber: string,
  initialLanguage: SupportedLanguage = "en"
): VoiceBookingSession {
  const now = new Date().toISOString();
  const session: VoiceBookingSession = {
    id: `vbs_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    phoneNumber,
    language: initialLanguage,
    state: "created",
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
      confidenceScore: 0.0,
      missingFields: [
        "guestCount",
        "eventDate",
        "startTime",
        "durationHours",
        "venueAddress",
      ],
      unresolvedQuestions: [],
      corrections: [],
    },
    quotation: null,
    quotationSnapshot: null,
    conversationHistory: [],
    createdAt: now,
    updatedAt: now,
    staffApprovalId: null,
    metadata: {},
  };

  return VoiceBookingSessionSchema.parse(session);
}

/**
 * Returns initial greeting message when a voice call/session begins.
 */
export function getInitialGreeting(language: SupportedLanguage = "en"): string {
  return GREETINGS[language] || GREETINGS.en;
}

const MATERIAL_FIELDS = [
  "guestCount",
  "eventDate",
  "startTime",
  "durationHours",
  "venueAddress",
  "selectedTier",
  "eventType",
] as const;

/**
 * Evaluates customer confirmation against an explicit, deterministic confirmation safety gate.
 * Applies the exact same safety policy for Mock and Gemini extraction providers.
 * Fails closed on low confidence, extraction failure, quotation invalidation, or ambiguous language.
 */
export function evaluateConfirmationSafetyGate(params: {
  userUtterance: string;
  language: SupportedLanguage;
  extractionResult: StructuredExtractionResult;
  hasValidQuotation: boolean;
  activeQuotationGuestCount?: number;
  currentRequirements: BookingRequirements;
  quotationSnapshot?: QuotationMaterialSnapshot | null;
}): ConfirmationSafetyEvaluation {
  const {
    userUtterance,
    language,
    extractionResult,
    hasValidQuotation,
    activeQuotationGuestCount,
    currentRequirements,
    quotationSnapshot,
  } = params;

  // Deterministic utterance classification (Safety policy applied identically to Mock and Gemini)
  const deterministicIntent = classifyConfirmationIntent(userUtterance, language);

  // Rejection is always honored, even if quotation is missing or invalidated
  if (deterministicIntent === "rejection" || extractionResult.confirmationIntent === "rejection") {
    return {
      isConfirmed: false,
      intent: "rejection",
      reason: "Customer explicitly rejected quotation.",
    };
  }

  // Gate 1: Active Quotation Required for positive confirmation
  if (!hasValidQuotation) {
    return {
      isConfirmed: false,
      intent: deterministicIntent === "modification_requested" ? "modification_requested" : "ambiguous",
      reason: "No active quotation exists for this session.",
    };
  }

  // If customer is NOT attempting positive confirmation, preserve their true classified intent
  // (e.g. clarification question, ambiguous conversational remark, or modification request)
  if (deterministicIntent !== "positive_acceptance") {
    return {
      isConfirmed: false,
      intent: deterministicIntent,
      reason: `Utterance classified deterministically as '${deterministicIntent}', not 'positive_acceptance'.`,
    };
  }

  // Gate 2: Full Quotation Snapshot Integrity Check
  // Compares all 7 material fields (guestCount, eventDate, startTime, durationHours, venueAddress, selectedTier, eventType)
  // and validates the canonical SHA-256 hash. Rejects if requirements diverged from the presented quotation.
  if (quotationSnapshot) {
    const integrity = verifyQuotationIntegrity(quotationSnapshot, currentRequirements);
    if (!integrity.isMatch) {
      return {
        isConfirmed: false,
        intent: "modification_requested",
        reason: integrity.reason || `Quotation snapshot integrity check failed. Material fields modified: ${integrity.mismatchedFields.join(", ")}. Re-quotation required.`,
        integrityResult: integrity,
      };
    }
  } else if (
    activeQuotationGuestCount !== undefined &&
    currentRequirements.guestCount !== undefined &&
    activeQuotationGuestCount !== currentRequirements.guestCount
  ) {
    return {
      isConfirmed: false,
      intent: "modification_requested",
      reason: `Active quotation guest count (${activeQuotationGuestCount}) does not match current requirements (${currentRequirements.guestCount}). Re-quotation required.`,
    };
  }

  // Gate 3: Extraction Status Check
  // A result with status !== 'success' (including 'low_confidence', 'invalid_response', 'api_failure', 'service_unavailable') must NEVER confirm
  if (extractionResult.status !== "success") {
    return {
      isConfirmed: false,
      intent: "ambiguous",
      reason: `Extraction result status is '${extractionResult.status}'. Confirmation requires successful extraction.`,
    };
  }

  // Gate 4: Confidence Score Threshold (>= 0.85)
  if (typeof extractionResult.confidenceScore === "number" && extractionResult.confidenceScore < 0.85) {
    return {
      isConfirmed: false,
      intent: "ambiguous",
      reason: `Extraction confidence score (${extractionResult.confidenceScore}) is below required safety threshold (0.85).`,
    };
  }

  // Gate 5: Deterministic Utterance Classification (positive acceptance required)
  if (deterministicIntent !== "positive_acceptance") {
    return {
      isConfirmed: false,
      intent: deterministicIntent,
      reason: `Utterance classified deterministically as '${deterministicIntent}', not 'positive_acceptance'.`,
    };
  }

  // Gate 6: Both deterministic analysis AND schema-validated extraction must agree
  if (
    extractionResult.confirmationIntent !== undefined &&
    extractionResult.confirmationIntent !== "positive_acceptance"
  ) {
    return {
      isConfirmed: false,
      intent: extractionResult.confirmationIntent,
      reason: `Provider extraction flagged intent as '${extractionResult.confirmationIntent}', not 'positive_acceptance'.`,
    };
  }

  return {
    isConfirmed: true,
    intent: "positive_acceptance",
    reason: "Deterministic safety gate passed: unambiguous positive acceptance for active quotation.",
  };
}

/**
 * Applies a structured extraction result to session requirements using an explicit patch model.
 * Records corrections, validates customer-clearable allowlist, ignores low-confidence overwrites,
 * and invalidates stale quotes. Never allows model output to set customerConfirmed.
 */
function applyRequirementsPatch(
  current: BookingRequirements,
  extraction: StructuredExtractionResult,
  timestamp: string
): { updated: BookingRequirements; materialChangeOccurred: boolean } {
  // Reject low confidence extraction from overwriting valid existing values
  if (extraction.status === "low_confidence") {
    return { updated: { ...current }, materialChangeOccurred: false };
  }

  const updated: BookingRequirements = {
    ...current,
    beveragePreferences: [...current.beveragePreferences],
    corrections: [...(current.corrections || [])],
  };

  let materialChangeOccurred = false;
  const data = extraction.data || {};
  const cleared = extraction.clearedFields || [];
  const recordUpdated = updated as unknown as Record<string, unknown>;

  // 1. Process explicit clears with strict allowlist validation
  // Only fields in CUSTOMER_CLEARABLE_FIELDS are permitted.
  // Model output can NEVER clear internal state, corrections, auth, or metadata!
  const validClearedFields: CustomerClearableField[] = [];
  for (const rawField of cleared) {
    const parseField = CustomerClearableFieldSchema.safeParse(rawField);
    if (parseField.success) {
      validClearedFields.push(parseField.data);
    }
  }

  for (const field of validClearedFields) {
    const prevVal = recordUpdated[field];
    if (prevVal !== null && prevVal !== undefined && (Array.isArray(prevVal) ? prevVal.length > 0 : true)) {
      recordUpdated[field] = Array.isArray(prevVal) ? [] : null;
      materialChangeOccurred = true;
      const correction: RequirementCorrectionRecord = {
        field,
        previousValue: prevVal,
        newValue: Array.isArray(prevVal) ? [] : null,
        action: "clear",
        timestamp,
        source: extraction.source,
      };
      updated.corrections?.push(correction);
    }
  }

  // 2. Process field sets and updates
  for (const key of MATERIAL_FIELDS) {
    const newVal = data[key];
    if (newVal !== undefined && newVal !== null) {
      const prevVal = updated[key];
      if (prevVal !== null && prevVal !== undefined && prevVal !== newVal) {
        // Material Correction
        recordUpdated[key] = newVal;
        materialChangeOccurred = true;
        const correction: RequirementCorrectionRecord = {
          field: key,
          previousValue: prevVal,
          newValue: newVal,
          action: "update",
          timestamp,
          source: extraction.source,
        };
        updated.corrections?.push(correction);
      } else if (prevVal === null || prevVal === undefined) {
        // Initial set
        recordUpdated[key] = newVal;
      }
    }
  }

  // 3. Event Type
  if (data.eventType !== undefined && data.eventType !== null) {
    updated.eventType = data.eventType;
  }

  // 4. Beverage Preferences (Contradiction-safe)
  if (data.beveragePreferences && data.beveragePreferences.length > 0) {
    updated.beveragePreferences = data.beveragePreferences;
  }

  // 5. Booleans & Metadata (Notice: customerConfirmed is deliberately EXCLUDED here)
  if (data.handoffRequested !== undefined) {
    updated.handoffRequested = data.handoffRequested;
  }
  updated.confidenceScore = extraction.confidenceScore;

  updated.missingFields = getMissingMandatoryFields(updated);
  return { updated, materialChangeOccurred };
}

/**
 * Single turn conversation processor for voice booking.
 * Enforces session immutability, runtime schema validation, and customer confirmation integrity.
 */
export async function processConversationTurn(
  session: VoiceBookingSession,
  userUtterance: string,
  dependencies?: {
    extractionProvider?: ExtractionProvider;
    sessionRepository?: VoiceSessionRepository;
    callerPhoneNumber?: string;
  }
): Promise<ConversationTurnResult> {
  // 1. Session Boundary Validation: validate incoming session without mutating caller's object
  const sessionValidation = VoiceBookingSessionSchema.safeParse(session);
  if (!sessionValidation.success) {
    throw new Error(
      `Invalid VoiceBookingSession provided: ${sessionValidation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }

  // Deep clone session to guarantee strict immutability of the caller's argument
  const activeSession: VoiceBookingSession = JSON.parse(JSON.stringify(sessionValidation.data));

  // Caller phone number authorization check if provided
  if (dependencies?.callerPhoneNumber && activeSession.phoneNumber !== dependencies.callerPhoneNumber) {
    throw new Error(
      `Security violation: Caller phone number '${dependencies.callerPhoneNumber}' does not match session owner '${activeSession.phoneNumber}'.`
    );
  }

  const provider = dependencies?.extractionProvider || defaultExtractionProvider;
  const repository = dependencies?.sessionRepository || defaultSessionRepository;
  const userTimestamp = new Date().toISOString();

  // 2. Language & Code-Switching Detection
  if (provider.detectLanguage) {
    const langDetection = await provider.detectLanguage(userUtterance, activeSession.language);
    if (langDetection.confidence >= 0.8 && langDetection.language !== activeSession.language) {
      activeSession.language = langDetection.language;
    }
  }

  // 3. Append validated user message to conversation history
  const userMsg: ConversationMessage = ConversationMessageSchema.parse({
    id: `msg_u_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    role: "user",
    content: userUtterance,
    language: activeSession.language,
    timestamp: userTimestamp,
  });
  activeSession.conversationHistory.push(userMsg);

  const lowerUtterance = userUtterance.toLowerCase();

  // 4. Fast-path: Immediate cancellation check
  if (
    lowerUtterance === "cancel" ||
    lowerUtterance === "cancel booking" ||
    lowerUtterance.includes("radd karo") ||
    lowerUtterance.includes("cancel cheyyandi")
  ) {
    activeSession.state = transitionVoiceBookingState(activeSession.state, "cancelled");
    const assistantResponse = CANCELLED_MESSAGES[activeSession.language];
    const assistantMsg = ConversationMessageSchema.parse({
      id: `msg_a_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      role: "assistant",
      content: assistantResponse,
      language: activeSession.language,
      timestamp: new Date().toISOString(),
    });
    activeSession.conversationHistory.push(assistantMsg);
    activeSession.updatedAt = new Date().toISOString();
    const validated = VoiceBookingSessionSchema.parse(activeSession);
    await repository.save(validated);
    return {
      session: validated,
      assistantResponse,
      language: validated.language,
      extractedRequirements: validated.requirements,
      state: validated.state,
      quotation: validated.quotation,
      clarificationNeeded: [],
      handoffTriggered: false,
    };
  }

  // 5. Extract structured entities via provider
  const extractionResult = await provider.extractRequirements(
    userUtterance,
    activeSession.requirements,
    activeSession.language
  );

  // 6. Fast-path: Human Handoff Request or Service Unavailable
  if (extractionResult.status === "service_unavailable" || extractionResult.data?.handoffRequested) {
    activeSession.requirements.handoffRequested = true;
    activeSession.state = transitionVoiceBookingState(activeSession.state, "human_handoff");
    const assistantResponse = HANDOFF_MESSAGES[activeSession.language];
    const assistantMsg = ConversationMessageSchema.parse({
      id: `msg_a_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      role: "assistant",
      content: assistantResponse,
      language: activeSession.language,
      timestamp: new Date().toISOString(),
    });
    activeSession.conversationHistory.push(assistantMsg);
    activeSession.updatedAt = new Date().toISOString();
    const validated = VoiceBookingSessionSchema.parse(activeSession);
    await repository.save(validated);
    return {
      session: validated,
      assistantResponse,
      language: validated.language,
      extractedRequirements: validated.requirements,
      state: validated.state,
      quotation: validated.quotation,
      clarificationNeeded: [],
      handoffTriggered: true,
      extractionResult,
    };
  }

  // 7. Apply structured patch to session requirements
  const { updated: patchedReqs, materialChangeOccurred } = applyRequirementsPatch(
    activeSession.requirements,
    extractionResult,
    userTimestamp
  );
  activeSession.requirements = patchedReqs;

  // If a material field changed after quotation was presented, invalidate quotation & confirmation
  if (materialChangeOccurred && activeSession.quotation !== null) {
    activeSession.quotation = null;
    activeSession.quotationSnapshot = null;
    activeSession.requirements.customerConfirmed = false;
    if (
      activeSession.state === "quotation_presented" ||
      activeSession.state === "awaiting_customer_confirmation"
    ) {
      activeSession.state = "collecting_requirements";
    }
  }

  let assistantResponse = "";
  let safetyEvaluation: ConfirmationSafetyEvaluation | undefined;

  // 8. State Machine Execution & Turn Response Logic
  switch (activeSession.state) {
    case "created":
    case "language_selected":
    case "collecting_requirements": {
      if (activeSession.state === "created" || activeSession.state === "language_selected") {
        activeSession.state = transitionVoiceBookingState(activeSession.state, "collecting_requirements");
      }

      if (activeSession.requirements.missingFields.length > 0) {
        // Missing mandatory fields: prompt for next missing field
        const nextMissing = activeSession.requirements.missingFields[0];
        assistantResponse = getPromptForNextMissingField(nextMissing, activeSession.language);
      } else {
        // All mandatory fields collected: validate operational windows
        const quotationValidation = validateQuotationRequirements(activeSession.requirements);
        if (!quotationValidation.isValid) {
          // Provide clarification regarding operational validation error
          assistantResponse =
            activeSession.language === "hi"
              ? `विवरण में समस्या है: ${quotationValidation.errors[0]}। कृपया सही जानकारी दें।`
              : activeSession.language === "te"
              ? `వివరాలలో లోపం ఉంది: ${quotationValidation.errors[0]}. దయచేసి సరైన సమాచారాన్ని అందించండి.`
              : `There is an issue with the event timing: ${quotationValidation.errors[0]}. Please provide valid timings.`;
          break;
        }

        // Transition through details_collected to quotation_presented
        activeSession.state = transitionVoiceBookingState(activeSession.state, "details_collected", {
          requirements: activeSession.requirements,
        });

        // Deterministic Quotation Generation
        const quotation = generateVoiceBookingQuotation(activeSession.requirements, activeSession.id);
        activeSession.quotation = quotation;
        activeSession.quotationSnapshot = createQuotationSnapshot(activeSession.requirements);

        activeSession.state = transitionVoiceBookingState(activeSession.state, "quotation_presented");
        activeSession.state = transitionVoiceBookingState(activeSession.state, "awaiting_customer_confirmation");

        assistantResponse = formatQuotationMessage(quotation, activeSession.language);
      }
      break;
    }

    case "details_collected": {
      const quotation = generateVoiceBookingQuotation(activeSession.requirements, activeSession.id);
      activeSession.quotation = quotation;
      activeSession.quotationSnapshot = createQuotationSnapshot(activeSession.requirements);
      activeSession.state = transitionVoiceBookingState(activeSession.state, "quotation_presented");
      activeSession.state = transitionVoiceBookingState(activeSession.state, "awaiting_customer_confirmation");
      assistantResponse = formatQuotationMessage(quotation, activeSession.language);
      break;
    }

    case "quotation_presented": {
      activeSession.state = transitionVoiceBookingState(activeSession.state, "awaiting_customer_confirmation");
      assistantResponse = activeSession.quotation
        ? formatQuotationMessage(activeSession.quotation, activeSession.language)
        : GREETINGS[activeSession.language];
      break;
    }

    case "awaiting_customer_confirmation": {
      // DETERMINISTIC CONFIRMATION SAFETY GATE:
      // Applies the exact same safety criteria regardless of whether Mock or Gemini was used.
      // Rejects low confidence, provider errors, and ambiguous statements.
      safetyEvaluation = evaluateConfirmationSafetyGate({
        userUtterance,
        language: activeSession.language,
        extractionResult,
        hasValidQuotation: activeSession.quotation !== null,
        activeQuotationGuestCount: activeSession.quotation?.guestCount,
        currentRequirements: activeSession.requirements,
        quotationSnapshot: activeSession.quotationSnapshot,
      });

      if (safetyEvaluation.isConfirmed) {
        // Unambiguous positive acceptance of currently presented quotation
        activeSession.requirements.customerConfirmed = true;
        activeSession.state = transitionVoiceBookingState(activeSession.state, "customer_confirmed");
        activeSession.state = transitionVoiceBookingState(activeSession.state, "awaiting_staff_approval");
        assistantResponse = CONFIRMATION_AWAITING_STAFF_APPROVAL[activeSession.language];
      } else if (safetyEvaluation.intent === "rejection") {
        activeSession.requirements.customerConfirmed = false;
        activeSession.state = transitionVoiceBookingState(activeSession.state, "customer_declined");
        assistantResponse = DECLINED_MESSAGES[activeSession.language];
      } else if (safetyEvaluation.intent === "modification_requested") {
        activeSession.requirements.customerConfirmed = false;
        // Customer requested changes: quotation already invalidated if material
        if (activeSession.requirements.missingFields.length === 0) {
          const newQuote = generateVoiceBookingQuotation(activeSession.requirements, activeSession.id);
          activeSession.quotation = newQuote;
          activeSession.quotationSnapshot = createQuotationSnapshot(activeSession.requirements);
          assistantResponse = formatQuotationMessage(newQuote, activeSession.language);
        } else {
          const nextMissing = activeSession.requirements.missingFields[0];
          assistantResponse = getPromptForNextMissingField(nextMissing, activeSession.language);
        }
      } else if (safetyEvaluation.intent === "clarification_requested") {
        activeSession.requirements.customerConfirmed = false;
        // Customer asked a question about the quote or ingredients
        assistantResponse =
          activeSession.language === "hi"
            ? "हमारे सभी पैकेजों में प्रमाणित बरिस्ता, उपकरण और हैदराबाद में लॉजिस्टिक्स शामिल हैं। क्या आप इनमें से कोई पैकेज कन्फ़र्म करना चाहेंगे?"
            : activeSession.language === "te"
            ? "మా అన్ని ప్యాకేజీలలో సర్టిఫైడ్ బరిస్టా, పరికరాలు మరియు హైదరాబాద్‌లో లాజిస్టిక్స్ ఉంటాయి. మీరు ఏ ప్యాకేజీని బుక్ చేయాలనుకుంటున్నారు?"
            : "All our packages include certified baristas, commercial espresso equipment, and Hyderabad logistics. Would you like to confirm one of the 3 packages, or need more details?";
      } else {
        // Ambiguous / unrelated sentence containing 'yes' / vague filler / low confidence
        activeSession.requirements.customerConfirmed = false;
        assistantResponse =
          activeSession.language === "hi"
            ? "आगे बढ़ने के लिए, कृपया स्पष्ट रूप से बताएं कि क्या आप Classic Brew, Artisanal Signature, या VIP Bar में से कोई पैकेज कन्फ़र्म करना चाहते हैं, या कोई बदलाव करना चाहते हैं।"
            : activeSession.language === "te"
            ? "ముందుకు సాగడానికి, దయచేసి Classic Brew, Artisanal Signature, లేదా VIP Bar ప్యాకేజీలలో దేనినైనా నిర్ధారించాలనుకుంటున్నారా లేదా మార్పులు చేయాలనుకుంటున్నారా స్పష్టంగా తెలియజేయండి."
            : "To proceed with booking, please clearly confirm if you would like to accept one of our catering packages (Classic Brew, Artisanal Signature, or VIP Bar), or if you would like to make changes.";
      }
      break;
    }

    case "awaiting_staff_approval": {
      assistantResponse = CONFIRMATION_AWAITING_STAFF_APPROVAL[activeSession.language];
      break;
    }

    case "booking_confirmed": {
      assistantResponse =
        activeSession.language === "hi"
          ? "आपकी बुकिंग पहले ही स्टाफ़ द्वारा स्वीकृत और कन्फ़र्म हो चुकी है।"
          : activeSession.language === "te"
          ? "మీ బుకింగ్ ఇప్పటికే సిబ్బందిచే ఆమోదించబడింది మరియు నిర్ధారించబడింది."
          : "Your booking has already been reviewed and confirmed by our staff team.";
      break;
    }

    default: {
      assistantResponse = GREETINGS[activeSession.language];
      break;
    }
  }

  // 9. Append validated assistant response to history
  const assistantMsg: ConversationMessage = ConversationMessageSchema.parse({
    id: `msg_a_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    role: "assistant",
    content: assistantResponse,
    language: activeSession.language,
    timestamp: new Date().toISOString(),
  });
  activeSession.conversationHistory.push(assistantMsg);
  activeSession.updatedAt = new Date().toISOString();

  // 10. Validate and persist session
  const finalSession = VoiceBookingSessionSchema.parse(activeSession);
  await repository.save(finalSession);

  return {
    session: finalSession,
    assistantResponse,
    language: finalSession.language,
    extractedRequirements: finalSession.requirements,
    state: finalSession.state,
    quotation: finalSession.quotation,
    clarificationNeeded: finalSession.requirements.missingFields,
    handoffTriggered: finalSession.state === "human_handoff",
    extractionResult,
    safetyEvaluation,
  };
}

/**
 * Internal state machine transition for staff booking approval.
 * Private implementation: callers must invoke `approveBookingByStaff` with authenticated staff credentials.
 */
function executeStaffApprovalTransition(
  session: VoiceBookingSession,
  staffApprovalId: string
): VoiceBookingSession {
  if (session.state !== "awaiting_staff_approval") {
    throw new Error(
      `Cannot approve booking: session is in state '${session.state}', expected 'awaiting_staff_approval'.`
    );
  }

  session.state = transitionVoiceBookingState(session.state, "booking_confirmed", {
    staffApprovalId,
  });
  session.staffApprovalId = staffApprovalId;
  session.updatedAt = new Date().toISOString();

  return VoiceBookingSessionSchema.parse(session);
}

const AUTHORIZED_STAFF_ROLES = new Set(["barista", "fleet_admin", "admin"]);

/**
 * Administrative action: Authorizes staff approval for a pending booking.
 * 
 * CRITICAL SECURITY & DOMAIN AUTHORIZATION SPECIFICATION:
 * - This function is an internal domain-level authorization guard. It is NOT an HTTP endpoint
 *   or a replacement for server-side authentication middleware.
 * - Calling server-side route handlers (e.g. Next.js App Router handlers in `/api/admin/voice-bookings/...`)
 *   MUST authenticate the caller using `verifySessionPin()` or session cookies from `src/lib/auth/adminAuth.ts`
 *   to obtain trusted identity and role directly from the server session.
 * - An untrusted client-supplied string or unauthenticated invocation MUST NEVER be trusted.
 * - This function enforces strict FAIL-CLOSED authorization:
 *     1. Rejects missing StaffAuthorizationContext.
 *     2. Rejects missing or empty staffIdentity.
 *     3. Rejects missing or empty staffRole.
 *     4. Rejects roles outside 'barista', 'fleet_admin', and 'admin'.
 *     5. Rejects missing or empty staffApprovalId.
 */
export async function approveBookingByStaff(
  sessionId: string,
  authContext: StaffAuthorizationContext,
  repository: VoiceSessionRepository = defaultSessionRepository
): Promise<VoiceBookingSession> {
  if (!authContext || typeof authContext !== "object") {
    throw new Error(
      "Staff authorization failure: missing StaffAuthorizationContext. Unauthenticated approvals are prohibited."
    );
  }

  // Check unauthorized role early to provide specific RBAC diagnostic message
  if (
    authContext.staffRole &&
    typeof authContext.staffRole === "string" &&
    !AUTHORIZED_STAFF_ROLES.has(authContext.staffRole)
  ) {
    throw new Error(
      `Unauthorized staff approval attempt: role '${authContext.staffRole}' is not permitted to approve catering bookings. Permitted roles: barista, fleet_admin, admin.`
    );
  }

  // Strict Runtime Validation using StaffAuthorizationContextSchema
  const schemaResult = StaffAuthorizationContextSchema.safeParse(authContext);
  if (!schemaResult.success) {
    const errorDetails = schemaResult.error.issues
      .map((i) => `${i.path.join(".") || "context"}: ${i.message}`)
      .join("; ");
    throw new Error(`Staff authorization failure: invalid StaffAuthorizationContext (${errorDetails})`);
  }

  const { staffIdentity, staffRole, staffApprovalId } = schemaResult.data;

  if (!staffIdentity || staffIdentity.trim().length === 0) {
    throw new Error("Staff authorization failure: missing or empty authenticated staffIdentity.");
  }

  if (!staffRole || staffRole.trim().length === 0) {
    throw new Error("Staff authorization failure: missing authenticated staffRole.");
  }

  if (!AUTHORIZED_STAFF_ROLES.has(staffRole)) {
    throw new Error(
      `Unauthorized staff approval attempt: role '${staffRole}' is not permitted to approve catering bookings. Permitted roles: barista, fleet_admin, admin.`
    );
  }

  if (!staffApprovalId || staffApprovalId.trim().length === 0) {
    throw new Error("Staff authorization failure: missing staffApprovalId audit identifier.");
  }

  const session = await repository.getById(sessionId);
  if (!session) {
    throw new Error(`Voice booking session not found: ${sessionId}`);
  }

  const updated = executeStaffApprovalTransition(session, staffApprovalId);
  await repository.save(updated);
  return updated;
}
