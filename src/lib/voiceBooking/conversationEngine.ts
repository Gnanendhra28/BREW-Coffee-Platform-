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
  StaffApprovalAuditRecord,
  StaffAuthorizationContext,
  StaffRejectionAuditRecord,
  StaffRejectionAuthorizationContext,
  StructuredExtractionResult,
  SupportedLanguage,
  VoiceBookingSession,
  VoiceSessionRepository,
} from "./types";
import { EventQuotationRecord } from "../eventBookingConcierge/types";
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
import { isVoicePrototypeMode } from "./prototypeConfig";
import { FirestoreVoiceSessionRepository } from "./repositories/firestoreSessionRepository";
import { computeOfficialVanRequestId } from "./vanRequestBridge";
import { createOutboxDeliveriesForTransition } from "../communication/outbox/outboxModel";
import { ClaimContext, CommunicationDeliveryRecord } from "../communication/types";
import { CommunicationOutboxRepository } from "../communication/outbox/outboxRepository";
import {
  ConversationMessageSchema,
  CustomerClearableFieldSchema,
  StaffAuthorizationContextSchema,
  StaffRejectionAuthorizationContextSchema,
  VoiceBookingSessionSchema,
} from "./schemas";

export interface ConversationTurnClaimFencing {
  outboxRepository: CommunicationOutboxRepository;
  deliveryId: string;
  claimContext: ClaimContext;
  now?: Date;
}

export const defaultExtractionProvider = new MockExtractionProvider();

interface GlobalWithVoiceSessionRepo {
  __brew_voice_session_repository?: InMemoryVoiceSessionRepository;
}
const gVoice = globalThis as unknown as GlobalWithVoiceSessionRepo;
if (!gVoice.__brew_voice_session_repository) {
  gVoice.__brew_voice_session_repository = new InMemoryVoiceSessionRepository();
}
export const defaultSessionRepository = gVoice.__brew_voice_session_repository;

let activeRepositoryOverride: VoiceSessionRepository | null = null;

/**
 * Explicitly sets or resets the global repository override.
 * Primarily intended for testing and dependency injection.
 * In genuine production environments, setting an in-memory repository is strictly rejected.
 */
export function setVoiceSessionRepository(repo: VoiceSessionRepository | null): void {
  if (
    process.env.NODE_ENV === "production" &&
    repo &&
    repo.constructor.name === "InMemoryVoiceSessionRepository"
  ) {
    throw new Error(
      "Security violation: In-memory repository override is strictly prohibited in production environment."
    );
  }
  activeRepositoryOverride = repo;
}

/**
 * Returns the authoritative VoiceSessionRepository based on runtime configuration.
 * - In zero-cost prototype mode or local dev, returns defaultSessionRepository.
 * - In production integration or when VOICE_BOOKING_STORAGE === "firestore", returns FirestoreVoiceSessionRepository.
 * - In local test / development environments without firestore override, returns defaultSessionRepository.
 * - Throws fail-closed error if Firestore credentials are missing in production.
 */
export function getVoiceSessionRepository(): VoiceSessionRepository {
  if (activeRepositoryOverride) {
    return activeRepositoryOverride;
  }

  // Zero-cost prototype mode: use singleton in-memory repository without paid/external requirements
  if (isVoicePrototypeMode()) {
    return defaultSessionRepository;
  }

  if (process.env.NODE_ENV === "production") {
    return new FirestoreVoiceSessionRepository();
  }

  const forceFirestore = process.env.VOICE_BOOKING_STORAGE === "firestore";
  if (forceFirestore) {
    return new FirestoreVoiceSessionRepository();
  }

  return defaultSessionRepository;
}

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
    revision: 1,
    staffApprovalId: null,
    staffApprovalAudit: null,
    officialBookingId: null,
    metadata: {},
    lastProcessedTurnIndex: null,
    processedTurnIds: [],
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
  activeQuotation?: EventQuotationRecord | null;
  activeQuotationGuestCount?: number;
  currentRequirements: BookingRequirements;
  quotationSnapshot?: QuotationMaterialSnapshot | null;
}): ConfirmationSafetyEvaluation {
  const {
    userUtterance,
    language,
    extractionResult,
    hasValidQuotation,
    activeQuotation,
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
  // Strict requirement: a missing snapshot CANNOT bypass the confirmation safety gate (fail closed)
  if (!quotationSnapshot) {
    return {
      isConfirmed: false,
      intent: "modification_requested",
      reason: "Missing quotation snapshot: quotation must be regenerated before confirmation.",
      integrityResult: {
        isMatch: false,
        mismatchedFields: ["snapshot_missing"],
        reason: "No quotation snapshot exists for this session. Re-quotation required.",
      },
    };
  }

  // Compares all 7 material fields (guestCount, eventDate, startTime, durationHours, venueAddress, selectedTier, eventType)
  // and validates the canonical SHA-256 hash. Rejects if requirements diverged from the presented quotation.
  const integrity = verifyQuotationIntegrity(quotationSnapshot, currentRequirements, activeQuotation);
  if (!integrity.isMatch) {
    return {
      isConfirmed: false,
      intent: "modification_requested",
      reason: integrity.reason || `Quotation snapshot integrity check failed. Material fields modified: ${integrity.mismatchedFields.join(", ")}. Re-quotation required.`,
      integrityResult: integrity,
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
        if (key !== "selectedTier") {
          materialChangeOccurred = true;
        }
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

export interface ProcessConversationTurnOptions {
  extractionProvider?: ExtractionProvider;
  sessionRepository?: VoiceSessionRepository;
  callerPhoneNumber?: string;
  claimFencing?: ConversationTurnClaimFencing;
  turnIndex?: number;
  turnId?: string;
}

/**
 * Single turn conversation processor for voice booking.
 * Enforces session immutability, runtime schema validation, and customer confirmation integrity.
 */
export async function processConversationTurn(
  session: VoiceBookingSession,
  userUtterance: string,
  dependencies?: ProcessConversationTurnOptions
): Promise<ConversationTurnResult> {
  // 1. Session Boundary Validation: validate incoming session without mutating caller's object
  // Handle legacy sessions missing quotationSnapshot by normalizing to null (fails closed at confirmation gate)
  const sessionToValidate = {
    ...session,
    quotationSnapshot: session.quotationSnapshot ?? null,
  };
  const sessionValidation = VoiceBookingSessionSchema.safeParse(sessionToValidate);
  if (!sessionValidation.success) {
    throw new Error(
      `Invalid VoiceBookingSession provided: ${sessionValidation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }

  // Deep clone session to guarantee strict immutability of the caller's argument
  const activeSession: VoiceBookingSession = JSON.parse(JSON.stringify(sessionValidation.data));
  const initialRevision = activeSession.revision;

  // Caller phone number authorization check if provided
  if (dependencies?.callerPhoneNumber && activeSession.phoneNumber !== dependencies.callerPhoneNumber) {
    throw new Error(
      `Security violation: Caller phone number '${dependencies.callerPhoneNumber}' does not match session owner '${activeSession.phoneNumber}'.`
    );
  }

  // Resolve stable turn identity derived deterministically from session ID and script position
  const effectiveTurnIndex =
    typeof dependencies?.turnIndex === "number"
      ? dependencies.turnIndex
      : typeof activeSession.lastProcessedTurnIndex === "number"
      ? activeSession.lastProcessedTurnIndex + 1
      : activeSession.conversationHistory.filter((m) => m.role === "user").length;

  const effectiveTurnId =
    dependencies?.turnId || `${activeSession.id}_turn_${effectiveTurnIndex}`;

  const userMsgId = `msg_u_${effectiveTurnId}`;
  const assistantMsgId = `msg_a_${effectiveTurnId}`;

  // Deduplication check: return existing state without duplicate messages or state mutations
  const isTurnAlreadyProcessed =
    (Array.isArray(activeSession.processedTurnIds) && activeSession.processedTurnIds.includes(effectiveTurnId)) ||
    (typeof activeSession.lastProcessedTurnIndex === "number" &&
      typeof dependencies?.turnIndex === "number" &&
      dependencies.turnIndex <= activeSession.lastProcessedTurnIndex) ||
    activeSession.conversationHistory.some((m) => m.id === userMsgId);

  if (isTurnAlreadyProcessed) {
    const existingAssistantMsg = activeSession.conversationHistory.find(
      (m) => m.id === assistantMsgId
    );
    const assistantResponse =
      existingAssistantMsg?.content ||
      activeSession.conversationHistory.filter((m) => m.role === "assistant").slice(-1)[0]?.content ||
      "";

    return {
      session: activeSession,
      assistantResponse,
      language: activeSession.language,
      extractedRequirements: activeSession.requirements,
      state: activeSession.state,
      quotation: activeSession.quotation,
      clarificationNeeded: activeSession.requirements.missingFields,
      handoffTriggered: activeSession.state === "human_handoff",
    };
  }

  const provider = dependencies?.extractionProvider || defaultExtractionProvider;
  const repository = dependencies?.sessionRepository || getVoiceSessionRepository();
  const userTimestamp = new Date().toISOString();

  const markTurnProgress = (targetSession: VoiceBookingSession) => {
    targetSession.lastProcessedTurnIndex = effectiveTurnIndex;
    if (!Array.isArray(targetSession.processedTurnIds)) {
      targetSession.processedTurnIds = [];
    }
    if (!targetSession.processedTurnIds.includes(effectiveTurnId)) {
      targetSession.processedTurnIds.push(effectiveTurnId);
    }
    if (!targetSession.metadata) {
      targetSession.metadata = {};
    }
    targetSession.metadata.lastProcessedTurnIndex = effectiveTurnIndex;
    targetSession.metadata.lastProcessedTurnId = effectiveTurnId;
    targetSession.metadata.processedTurnIds = [...targetSession.processedTurnIds];
  };

  const persistTurnSession = async (
    targetSession: VoiceBookingSession,
    outboxDeliveries: CommunicationDeliveryRecord[]
  ) => {
    if (dependencies?.claimFencing) {
      const { outboxRepository, deliveryId, claimContext, now } = dependencies.claimFencing;
      const evalNow = now || new Date();
      await outboxRepository.mutateSessionWithClaimFencing(
        deliveryId,
        claimContext,
        targetSession.id,
        evalNow,
        () => targetSession,
        repository,
        outboxDeliveries
      );
    } else if (outboxDeliveries.length > 0) {
      await repository.saveWithOutbox(targetSession, initialRevision, outboxDeliveries);
    } else {
      await repository.save(targetSession, initialRevision);
    }
  };

  // 2. Language & Code-Switching Detection
  if (provider.detectLanguage) {
    const langDetection = await provider.detectLanguage(userUtterance, activeSession.language);
    if (langDetection.confidence >= 0.8 && langDetection.language !== activeSession.language) {
      activeSession.language = langDetection.language;
    }
  }

  // 3. Append validated user message to conversation history with stable ID
  const userMsg: ConversationMessage = ConversationMessageSchema.parse({
    id: userMsgId,
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
      id: assistantMsgId,
      role: "assistant",
      content: assistantResponse,
      language: activeSession.language,
      timestamp: new Date().toISOString(),
    });
    activeSession.conversationHistory.push(assistantMsg);
    markTurnProgress(activeSession);
    activeSession.updatedAt = new Date().toISOString();
    const validated = VoiceBookingSessionSchema.parse(activeSession);
    const outboxDeliveries = createOutboxDeliveriesForTransition(validated);
    await persistTurnSession(validated, outboxDeliveries);
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
      id: assistantMsgId,
      role: "assistant",
      content: assistantResponse,
      language: activeSession.language,
      timestamp: new Date().toISOString(),
    });
    activeSession.conversationHistory.push(assistantMsg);
    markTurnProgress(activeSession);
    activeSession.updatedAt = new Date().toISOString();
    const validated = VoiceBookingSessionSchema.parse(activeSession);
    const outboxDeliveries = createOutboxDeliveriesForTransition(validated);
    await persistTurnSession(validated, outboxDeliveries);
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
      // Tier reflection: if customer selected an available tier, reflect in active quotation and snapshot
      if (activeSession.quotation && activeSession.requirements.selectedTier) {
        const matchingTier = activeSession.quotation.tiers.find(
          (t) => t.tierId === activeSession.requirements.selectedTier
        );
        if (matchingTier) {
          activeSession.quotation.selectedTier = matchingTier;
          if (
            activeSession.quotationSnapshot &&
            activeSession.quotationSnapshot.selectedTier !== matchingTier.tierId
          ) {
            activeSession.quotationSnapshot = createQuotationSnapshot(
              activeSession.requirements,
              activeSession.quotationSnapshot.generatedAt
            );
          }
        }
      }

      // DETERMINISTIC CONFIRMATION SAFETY GATE:
      // Applies the exact same safety criteria regardless of whether Mock or Gemini was used.
      // Rejects low confidence, provider errors, and ambiguous statements.
      safetyEvaluation = evaluateConfirmationSafetyGate({
        userUtterance,
        language: activeSession.language,
        extractionResult,
        hasValidQuotation: activeSession.quotation !== null,
        activeQuotation: activeSession.quotation,
        activeQuotationGuestCount: activeSession.quotation?.guestCount,
        currentRequirements: activeSession.requirements,
        quotationSnapshot: activeSession.quotationSnapshot,
      });

      if (safetyEvaluation.isConfirmed) {
        // If selectedTier was null, bind to the quotation's recommended/standard tier upon confirmation
        if (!activeSession.requirements.selectedTier && activeSession.quotation) {
          const defaultTier =
            activeSession.quotation.selectedTier ||
            activeSession.quotation.tiers.find((t) => t.isRecommended) ||
            activeSession.quotation.tiers[1] ||
            activeSession.quotation.tiers[0];
          if (defaultTier) {
            activeSession.requirements.selectedTier = defaultTier.tierId;
            activeSession.quotation.selectedTier = defaultTier;
            if (activeSession.quotationSnapshot) {
              activeSession.quotationSnapshot = createQuotationSnapshot(
                activeSession.requirements,
                activeSession.quotationSnapshot.generatedAt
              );
            }
          }
        }
        // Unambiguous positive acceptance of currently presented quotation
        activeSession.requirements.customerConfirmed = true;
        activeSession.state = transitionVoiceBookingState(activeSession.state, "customer_confirmed");
        activeSession.state = transitionVoiceBookingState(activeSession.state, "awaiting_staff_approval");

        // Link official booking record (enq_voice_${sessionId})
        const officialBookingId = computeOfficialVanRequestId(activeSession.id);
        activeSession.officialBookingId = officialBookingId;
        if (!activeSession.metadata) activeSession.metadata = {};
        activeSession.metadata.officialBookingId = officialBookingId;
        activeSession.metadata.bookingSource = "voice_booking";

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
      } else if (activeSession.requirements.selectedTier && activeSession.quotation) {
        const selectedTierObj = activeSession.quotation.tiers.find(
          (t) => t.tierId === activeSession.requirements.selectedTier
        );
        activeSession.requirements.customerConfirmed = false;
        if (selectedTierObj) {
          assistantResponse =
            activeSession.language === "hi"
              ? `आपने ${selectedTierObj.name} पैकेज चुना है (₹${selectedTierObj.pricePerGuest}/मेहमान, कुल: ₹${selectedTierObj.totalAmount.toLocaleString("en-IN")})। क्या आप स्टाफ़ समीक्षा और शेड्यूलिंग के लिए इस बुकिंग अनुरोध को कन्फ़र्म करना चाहते हैं?`
              : activeSession.language === "te"
              ? `మీరు ${selectedTierObj.name} ప్యాకేజీని ఎంచుకున్నారు (₹${selectedTierObj.pricePerGuest}/అతిథికి, మొత్తం: ₹${selectedTierObj.totalAmount.toLocaleString("en-IN")}). మీరు స్టాఫ్ సమీక్ష మరియు షెడ్యూలింగ్ కోసం ఈ బుకింగ్ అభ్యర్థనను నిర్ధారించాలనుకుంటున్నారా?`
              : `You have selected the ${selectedTierObj.name} package at ₹${selectedTierObj.pricePerGuest}/guest (Total: ₹${selectedTierObj.totalAmount.toLocaleString("en-IN")}). Would you like to confirm this booking request for staff review and scheduling?`;
        } else {
          assistantResponse =
            activeSession.language === "hi"
              ? "आगे बढ़ने के लिए, कृपया स्पष्ट रूप से बताएं कि क्या आप Classic Brew, Artisanal Signature, या VIP Bar में से कोई पैकेज कन्फ़र्म करना चाहते हैं, या कोई बदलाव करना चाहते हैं।"
              : activeSession.language === "te"
              ? "ముందుకు సాగడానికి, దయచేసి Classic Brew, Artisanal Signature, లేదా VIP Bar ప్యాకేజీలలో దేనినైనా నిర్ధారించాలనుకుంటున్నారా లేదా మార్పులు చేయాలనుకుంటున్నారా స్పష్టంగా తెలియజేయండి."
              : "To proceed with booking, please clearly confirm if you would like to accept one of our catering packages (Classic Brew, Artisanal Signature, or VIP Bar), or if you would like to make changes.";
        }
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
      if (!activeSession.officialBookingId) {
        const officialBookingId = computeOfficialVanRequestId(activeSession.id);
        activeSession.officialBookingId = officialBookingId;
        if (!activeSession.metadata) activeSession.metadata = {};
        activeSession.metadata.officialBookingId = officialBookingId;
        activeSession.metadata.bookingSource = "voice_booking";
      }
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

  // 9. Append validated assistant response to history with stable ID
  const assistantMsg: ConversationMessage = ConversationMessageSchema.parse({
    id: assistantMsgId,
    role: "assistant",
    content: assistantResponse,
    language: activeSession.language,
    timestamp: new Date().toISOString(),
  });
  activeSession.conversationHistory.push(assistantMsg);
  markTurnProgress(activeSession);
  activeSession.updatedAt = new Date().toISOString();

  // 10. Validate and persist session
  const finalSession = VoiceBookingSessionSchema.parse(activeSession);
  const outboxDeliveries = createOutboxDeliveriesForTransition(finalSession);
  await persistTurnSession(finalSession, outboxDeliveries);

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
 * Drives a simulated multi-turn voice booking conversation sequentially.
 * Re-fetches current session state between turns, applies extraction, validates
 * state transitions, and enforces claim fencing if configured.
 * Automatically skips previously completed turns and resumes from the first unprocessed turn.
 */
export async function simulateVoiceConversation(
  session: VoiceBookingSession,
  utterances: string[],
  dependencies?: {
    extractionProvider?: ExtractionProvider;
    sessionRepository?: VoiceSessionRepository;
    claimFencing?: ConversationTurnClaimFencing;
  }
): Promise<{
  finalSession: VoiceBookingSession;
  turnResults: ConversationTurnResult[];
}> {
  const repository = dependencies?.sessionRepository || getVoiceSessionRepository();
  const turnResults: ConversationTurnResult[] = [];
  let currentSession = session;

  for (let i = 0; i < utterances.length; i++) {
    const utterance = utterances[i];

    // Reload latest state from repository for subsequent turn
    const latest = await repository.getById(currentSession.id);
    if (latest) {
      currentSession = latest;
    }

    // If session reached a terminal state or awaiting_staff_approval, stop processing further turns
    if (
      currentSession.state === "booking_confirmed" ||
      currentSession.state === "customer_declined" ||
      currentSession.state === "cancelled" ||
      currentSession.state === "failed" ||
      currentSession.state === "awaiting_staff_approval"
    ) {
      break;
    }

    const turnId = `${currentSession.id}_turn_${i}`;
    const isAlreadyProcessed =
      (Array.isArray(currentSession.processedTurnIds) && currentSession.processedTurnIds.includes(turnId)) ||
      (typeof currentSession.lastProcessedTurnIndex === "number" && currentSession.lastProcessedTurnIndex >= i) ||
      currentSession.conversationHistory.some((m) => m.id === `msg_u_${turnId}`);

    if (isAlreadyProcessed) {
      continue;
    }

    const result = await processConversationTurn(currentSession, utterance, {
      extractionProvider: dependencies?.extractionProvider,
      sessionRepository: repository,
      claimFencing: dependencies?.claimFencing,
      turnIndex: i,
      turnId,
    });

    turnResults.push(result);
    currentSession = result.session;
  }

  return {
    finalSession: currentSession,
    turnResults,
  };
}

/**
 * Internal state machine transition for staff booking approval.
 * Private implementation: callers must invoke `approveBookingByStaff` with authenticated staff credentials.
 */
function executeStaffApprovalTransition(
  session: VoiceBookingSession,
  authContext: StaffAuthorizationContext
): VoiceBookingSession {
  // Prevent duplicate approval: sessions already confirmed or audited must fail closed
  const hasExistingAudit = Boolean(session.staffApprovalAudit);
  if (session.state === "booking_confirmed" || hasExistingAudit) {
    throw new Error(
      `Cannot approve booking: session '${session.id}' has already been approved and confirmed. Duplicate approval rejected.`
    );
  }

  if (session.state !== "awaiting_staff_approval") {
    throw new Error(
      `Cannot approve booking: session is in state '${session.state}', expected 'awaiting_staff_approval'.`
    );
  }

  // Mandatory quotation integrity verification: Fail closed on missing, altered, or tampered snapshot
  if (!session.quotationSnapshot) {
    throw new Error(
      `Cannot approve booking: session '${session.id}' is missing mandatory quotationSnapshot.`
    );
  }

  const integrity = verifyQuotationIntegrity(
    session.quotationSnapshot,
    session.requirements,
    session.quotation
  );

  if (!integrity.isMatch) {
    throw new Error(
      `Cannot approve booking: quotation integrity verification failed (${
        integrity.reason || integrity.mismatchedFields.join(", ")
      }). Tampered or stale quotation detected.`
    );
  }

  const approvedAt = new Date().toISOString();
  const staffApprovalAudit: StaffApprovalAuditRecord = {
    staffIdentity: authContext.staffIdentity,
    staffRole: authContext.staffRole as "barista" | "fleet_admin" | "admin",
    staffApprovalId: authContext.staffApprovalId,
    approvedAt,
    sessionId: session.id,
  };

  session.state = transitionVoiceBookingState(session.state, "booking_confirmed", {
    staffApprovalId: authContext.staffApprovalId,
  });
  session.staffApprovalId = authContext.staffApprovalId;
  session.staffApprovalAudit = staffApprovalAudit;
  session.updatedAt = approvedAt;

  const officialBookingId = session.officialBookingId || computeOfficialVanRequestId(session.id);
  session.officialBookingId = officialBookingId;
  if (!session.metadata) session.metadata = {};
  session.metadata.officialBookingId = officialBookingId;
  session.metadata.bookingSource = "voice_booking";

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
  repository: VoiceSessionRepository = getVoiceSessionRepository()
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

  // MANDATORY ATOMIC APPROVAL:
  // Every repository implementation MUST support atomic conditional approval.
  // The non-atomic getById()/save() fallback is eliminated to prevent race conditions.
  if (typeof repository.atomicApproveBooking !== "function") {
    throw new Error(
      "Repository contract violation: repository does not implement mandatory atomicApproveBooking. Non-atomic approval is prohibited to prevent race conditions."
    );
  }

  const result = await repository.atomicApproveBooking(
    sessionId,
    schemaResult.data,
    executeStaffApprovalTransition
  );
  if (!result.success) {
    if (result.error === "session_not_found") {
      throw new Error(result.message || `Voice booking session not found: ${sessionId}`);
    }
    throw new Error(result.message || `Cannot approve booking for session: ${sessionId}`);
  }
  return result.session!;
}

/**
 * Internal state machine transition for staff booking rejection.
 * Private implementation: callers must invoke `rejectBookingByStaff` with authenticated staff credentials.
 */
function executeStaffRejectionTransition(
  session: VoiceBookingSession,
  authContext: StaffRejectionAuthorizationContext
): VoiceBookingSession {
  // Prevent duplicate action: sessions already confirmed or audited must fail closed
  if (session.state === "booking_confirmed" || session.staffApprovalAudit) {
    throw new Error(
      `Cannot reject booking: session '${session.id}' has already been approved and confirmed. Conflict rejected.`
    );
  }

  if (session.state === "customer_declined" || session.staffRejectionAudit) {
    throw new Error(
      `Cannot reject booking: session '${session.id}' has already been rejected. Duplicate rejection rejected.`
    );
  }

  if (session.state !== "awaiting_staff_approval") {
    throw new Error(
      `Cannot reject booking: session is in state '${session.state}', expected 'awaiting_staff_approval'.`
    );
  }

  const rejectedAt = new Date().toISOString();
  const staffRejectionAudit: StaffRejectionAuditRecord = {
    staffIdentity: authContext.staffIdentity,
    staffRole: authContext.staffRole as "barista" | "fleet_admin" | "admin",
    staffRejectionId: authContext.staffRejectionId,
    rejectedAt,
    sessionId: session.id,
    reason: authContext.reason.trim(),
    customerFacingReason: authContext.customerFacingReason?.trim(),
  };

  session.state = transitionVoiceBookingState(session.state, "customer_declined");
  session.staffRejectionAudit = staffRejectionAudit;
  session.updatedAt = rejectedAt;

  if (!session.metadata) session.metadata = {};
  session.metadata.staffRejectionReason = authContext.reason.trim();
  session.metadata.customerFacingRejectionReason =
    authContext.customerFacingReason?.trim() ||
    "We are unable to accommodate your booking request for the selected date and time. Please contact our concierge team for alternative slots.";
  session.metadata.rejectedBy = authContext.staffIdentity;
  session.metadata.rejectedAt = rejectedAt;

  return VoiceBookingSessionSchema.parse(session);
}

/**
 * Administrative action: Authorizes staff rejection for a pending booking.
 * Requires a valid operational rejection reason and verified staff credentials.
 */
export async function rejectBookingByStaff(
  sessionId: string,
  authContext: StaffRejectionAuthorizationContext,
  repository: VoiceSessionRepository = getVoiceSessionRepository()
): Promise<VoiceBookingSession> {
  if (!authContext || typeof authContext !== "object") {
    throw new Error(
      "Staff authorization failure: missing StaffRejectionAuthorizationContext. Unauthenticated rejections are prohibited."
    );
  }

  if (
    authContext.staffRole &&
    typeof authContext.staffRole === "string" &&
    !AUTHORIZED_STAFF_ROLES.has(authContext.staffRole)
  ) {
    throw new Error(
      `Unauthorized staff rejection attempt: role '${authContext.staffRole}' is not permitted to reject catering bookings. Permitted roles: barista, fleet_admin, admin.`
    );
  }

  const schemaResult = StaffRejectionAuthorizationContextSchema.safeParse(authContext);
  if (!schemaResult.success) {
    const errorDetails = schemaResult.error.issues
      .map((i) => `${i.path.join(".") || "context"}: ${i.message}`)
      .join("; ");
    throw new Error(`Staff authorization failure: invalid StaffRejectionAuthorizationContext (${errorDetails})`);
  }

  const { staffIdentity, staffRole, staffRejectionId, reason } = schemaResult.data;

  if (!staffIdentity || staffIdentity.trim().length === 0) {
    throw new Error("Staff authorization failure: missing or empty authenticated staffIdentity.");
  }

  if (!staffRole || staffRole.trim().length === 0) {
    throw new Error("Staff authorization failure: missing authenticated staffRole.");
  }

  if (!AUTHORIZED_STAFF_ROLES.has(staffRole)) {
    throw new Error(
      `Unauthorized staff rejection attempt: role '${staffRole}' is not permitted to reject catering bookings. Permitted roles: barista, fleet_admin, admin.`
    );
  }

  if (!staffRejectionId || staffRejectionId.trim().length === 0) {
    throw new Error("Staff authorization failure: missing staffRejectionId audit identifier.");
  }

  if (!reason || reason.trim().length < 3) {
    throw new Error("Staff rejection failure: a valid rejection reason (minimum 3 characters) is required.");
  }

  if (typeof repository.atomicRejectBooking !== "function") {
    throw new Error(
      "Repository contract violation: repository does not implement mandatory atomicRejectBooking. Non-atomic rejection is prohibited to prevent race conditions."
    );
  }

  const result = await repository.atomicRejectBooking(
    sessionId,
    schemaResult.data,
    executeStaffRejectionTransition
  );

  if (!result.success) {
    if (result.error === "session_not_found") {
      throw new Error(result.message || `Voice booking session not found: ${sessionId}`);
    }
    throw new Error(result.message || `Cannot reject booking for session: ${sessionId}`);
  }

  return result.session!;
}
