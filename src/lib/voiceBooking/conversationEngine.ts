/**
 * BREW Coffee Platform — Phase 6.2 AI Conversation Engine
 * Orchestrates multi-turn conversation intelligence for the AI Voice Booking Agent.
 * Enforces clean boundaries: LLM extracts entities, while deterministic engines compute pricing
 * and separate staff approval controls official booking confirmation.
 */

import {
  BookingRequirements,
  ConversationMessage,
  ConversationTurnResult,
  ExtractionProvider,
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
  formatQuotationMessage,
  generateVoiceBookingQuotation,
} from "./quotationAdapter";
import { MockExtractionProvider } from "./providers/extractionProvider";
import { InMemoryVoiceSessionRepository } from "./repositories/sessionRepository";

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
  return {
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
    },
    quotation: null,
    conversationHistory: [],
    createdAt: now,
    updatedAt: now,
    staffApprovalId: null,
    metadata: {},
  };
}

/**
 * Returns initial greeting message when a voice call/session begins.
 */
export function getInitialGreeting(language: SupportedLanguage = "en"): string {
  return GREETINGS[language] || GREETINGS.en;
}

/**
 * Merges newly extracted requirements into the session's cumulative requirements.
 */
function mergeRequirements(
  current: BookingRequirements,
  extracted: Partial<BookingRequirements>
): BookingRequirements {
  const updated: BookingRequirements = {
    ...current,
    guestCount: extracted.guestCount ?? current.guestCount,
    eventDate: extracted.eventDate ?? current.eventDate,
    startTime: extracted.startTime ?? current.startTime,
    durationHours: extracted.durationHours ?? current.durationHours,
    venueAddress: extracted.venueAddress ?? current.venueAddress,
    eventType: extracted.eventType ?? current.eventType,
    selectedTier: extracted.selectedTier ?? current.selectedTier,
    handoffRequested: extracted.handoffRequested ?? current.handoffRequested,
    customerConfirmed: extracted.customerConfirmed ?? current.customerConfirmed,
    confidenceScore: extracted.confidenceScore ?? current.confidenceScore,
  };

  if (extracted.beveragePreferences && extracted.beveragePreferences.length > 0) {
    const combined = new Set([
      ...current.beveragePreferences,
      ...extracted.beveragePreferences,
    ]);
    updated.beveragePreferences = Array.from(combined);
  }

  updated.missingFields = getMissingMandatoryFields(updated);
  return updated;
}

/**
 * Single turn conversation processor for voice booking.
 */
export async function processConversationTurn(
  session: VoiceBookingSession,
  userUtterance: string,
  dependencies?: {
    extractionProvider?: ExtractionProvider;
    sessionRepository?: VoiceSessionRepository;
  }
): Promise<ConversationTurnResult> {
  const provider = dependencies?.extractionProvider || defaultExtractionProvider;
  const repository = dependencies?.sessionRepository || defaultSessionRepository;

  const userTimestamp = new Date().toISOString();

  // 1. Language & Code-Switching Detection
  if (provider.detectLanguage) {
    const langDetection = await provider.detectLanguage(userUtterance, session.language);
    if (langDetection.confidence >= 0.8 && langDetection.language !== session.language) {
      session.language = langDetection.language;
    }
  }

  // 2. Append user message to conversation history
  const userMsg: ConversationMessage = {
    id: `msg_u_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    role: "user",
    content: userUtterance,
    language: session.language,
    timestamp: userTimestamp,
  };
  session.conversationHistory.push(userMsg);

  const lowerUtterance = userUtterance.toLowerCase();

  // 3. Fast-path: Immediate cancellation check
  if (
    lowerUtterance === "cancel" ||
    lowerUtterance === "cancel booking" ||
    lowerUtterance.includes("radd karo") ||
    lowerUtterance.includes("cancel cheyyandi")
  ) {
    session.state = transitionVoiceBookingState(session.state, "cancelled");
    const assistantResponse = CANCELLED_MESSAGES[session.language];
    session.conversationHistory.push({
      id: `msg_a_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      role: "assistant",
      content: assistantResponse,
      language: session.language,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    await repository.save(session);
    return {
      session,
      assistantResponse,
      language: session.language,
      extractedRequirements: session.requirements,
      state: session.state,
      quotation: session.quotation,
      clarificationNeeded: [],
      handoffTriggered: false,
    };
  }

  // 4. Extract structured entities via provider
  const extracted = await provider.extractRequirements(
    userUtterance,
    session.requirements,
    session.language
  );

  // 5. Fast-path: Human Handoff Request
  if (extracted.handoffRequested) {
    session.requirements.handoffRequested = true;
    session.state = transitionVoiceBookingState(session.state, "human_handoff");
    const assistantResponse = HANDOFF_MESSAGES[session.language];
    session.conversationHistory.push({
      id: `msg_a_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      role: "assistant",
      content: assistantResponse,
      language: session.language,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    await repository.save(session);
    return {
      session,
      assistantResponse,
      language: session.language,
      extractedRequirements: session.requirements,
      state: session.state,
      quotation: session.quotation,
      clarificationNeeded: [],
      handoffTriggered: true,
    };
  }

  // 6. Merge extracted entities into session requirements
  session.requirements = mergeRequirements(session.requirements, extracted);
  let assistantResponse = "";

  // 7. State Machine Execution & Turn Response Logic
  switch (session.state) {
    case "created":
    case "language_selected":
    case "collecting_requirements": {
      if (session.state === "created") {
        session.state = transitionVoiceBookingState(session.state, "collecting_requirements");
      } else if (session.state === "language_selected") {
        session.state = transitionVoiceBookingState(session.state, "collecting_requirements");
      }

      if (session.requirements.missingFields.length > 0) {
        // Still missing mandatory fields: prompt for next missing field
        const nextMissing = session.requirements.missingFields[0];
        assistantResponse = getPromptForNextMissingField(nextMissing, session.language);
      } else {
        // All mandatory fields collected: Transition to details_collected
        session.state = transitionVoiceBookingState(session.state, "details_collected", {
          requirements: session.requirements,
        });

        // Deterministic Quotation Generation
        const quotation = generateVoiceBookingQuotation(session.requirements, session.id);
        session.quotation = quotation;

        // Transition through presentation to awaiting confirmation
        session.state = transitionVoiceBookingState(session.state, "quotation_presented");
        session.state = transitionVoiceBookingState(session.state, "awaiting_customer_confirmation");

        assistantResponse = formatQuotationMessage(quotation, session.language);
      }
      break;
    }

    case "details_collected": {
      const quotation = generateVoiceBookingQuotation(session.requirements, session.id);
      session.quotation = quotation;
      session.state = transitionVoiceBookingState(session.state, "quotation_presented");
      session.state = transitionVoiceBookingState(session.state, "awaiting_customer_confirmation");
      assistantResponse = formatQuotationMessage(quotation, session.language);
      break;
    }

    case "quotation_presented": {
      session.state = transitionVoiceBookingState(session.state, "awaiting_customer_confirmation");
      assistantResponse = session.quotation
        ? formatQuotationMessage(session.quotation, session.language)
        : GREETINGS[session.language];
      break;
    }

    case "awaiting_customer_confirmation": {
      if (extracted.customerConfirmed) {
        // Customer explicitly confirmed quotation!
        // Transition to customer_confirmed, and IMMEDIATELY to awaiting_staff_approval.
        // NOTE: Direct transition to booking_confirmed is prohibited by state machine.
        session.requirements.customerConfirmed = true;
        session.state = transitionVoiceBookingState(session.state, "customer_confirmed");
        session.state = transitionVoiceBookingState(session.state, "awaiting_staff_approval");
        assistantResponse = CONFIRMATION_AWAITING_STAFF_APPROVAL[session.language];
      } else if (
        lowerUtterance.includes("no") ||
        lowerUtterance.includes("nahi") ||
        lowerUtterance.includes("nahin") ||
        lowerUtterance.includes("kaadhu") ||
        lowerUtterance.includes("vaddu") ||
        lowerUtterance.includes("decline")
      ) {
        session.state = transitionVoiceBookingState(session.state, "customer_declined");
        assistantResponse = DECLINED_MESSAGES[session.language];
      } else {
        // Customer may want changes or asked for clarification
        assistantResponse =
          session.language === "hi"
            ? "क्या आप इनमें से कोई पैकेज कन्फ़र्म करना चाहेंगे? या आप विवरण बदलना चाहते हैं?"
            : session.language === "te"
            ? "మీరు ఈ ప్యాకేజీలలో దేనినైనా నిర్ధారించాలనుకుంటున్నారా? లేదా వివరాలు మార్చాలనుకుంటున్నారా?"
            : "Would you like to confirm one of these packages, or would you like to modify any event details?";
      }
      break;
    }

    case "awaiting_staff_approval": {
      assistantResponse = CONFIRMATION_AWAITING_STAFF_APPROVAL[session.language];
      break;
    }

    case "booking_confirmed": {
      assistantResponse =
        session.language === "hi"
          ? "आपकी बुकिंग पहले ही स्टाफ़ द्वारा स्वीकृत और कन्फ़र्म हो चुकी है।"
          : session.language === "te"
          ? "మీ బుకింగ్ ఇప్పటికే సిబ్బందిచే ఆమోదించబడింది మరియు నిర్ధారించబడింది."
          : "Your booking has already been reviewed and confirmed by our staff team.";
      break;
    }

    default: {
      assistantResponse = GREETINGS[session.language];
      break;
    }
  }

  // 8. Append assistant response to history
  const assistantMsg: ConversationMessage = {
    id: `msg_a_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
    role: "assistant",
    content: assistantResponse,
    language: session.language,
    timestamp: new Date().toISOString(),
  };
  session.conversationHistory.push(assistantMsg);
  session.updatedAt = new Date().toISOString();

  // 9. Persist session
  await repository.save(session);

  return {
    session,
    assistantResponse,
    language: session.language,
    extractedRequirements: session.requirements,
    state: session.state,
    quotation: session.quotation,
    clarificationNeeded: session.requirements.missingFields,
    handoffTriggered: session.state === "human_handoff",
  };
}

/**
 * Administrative action: Authorizes staff approval for a pending booking.
 * Strictly enforces that only a session in 'awaiting_staff_approval' can transition to 'booking_confirmed'.
 */
export async function approveBookingByStaff(
  sessionId: string,
  staffApprovalId: string,
  repository: VoiceSessionRepository = defaultSessionRepository
): Promise<VoiceBookingSession> {
  const session = await repository.getById(sessionId);
  if (!session) {
    throw new Error(`Voice booking session not found: ${sessionId}`);
  }

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

  await repository.save(session);
  return session;
}
