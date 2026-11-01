/**
 * BREW Coffee Platform — Phase 6.2.1 Voice Booking Types
 * Strongly typed domain entities for the multilingual AI conversation engine.
 * Hardened with explicit confirmation intents, patch models, and extraction results.
 */

import { EventQuotationRecord } from "../eventBookingConcierge/types";

export type VoiceBookingState =
  | "created"
  | "language_selected"
  | "collecting_requirements"
  | "details_collected"
  | "quotation_presented"
  | "awaiting_customer_confirmation"
  | "customer_confirmed"
  | "awaiting_staff_approval"
  | "booking_confirmed"
  | "customer_declined"
  | "human_handoff"
  | "cancelled"
  | "failed";

export type SupportedLanguage = "en" | "hi" | "te";

export type ConfirmationIntent =
  | "positive_acceptance"
  | "rejection"
  | "clarification_requested"
  | "modification_requested"
  | "ambiguous";

export interface RequirementCorrectionRecord {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  action: "update" | "clear";
  timestamp: string; // Strict ISO UTC
  source: string;
}

export interface BookingRequirements {
  guestCount: number | null;
  eventDate: string | null; // Real calendar date YYYY-MM-DD
  startTime: string | null; // 24-hr format HH:mm
  durationHours: number | null; // 1 to 12
  venueAddress: string | null;
  eventType: string | null;
  beveragePreferences: string[];
  selectedTier: "BASIC" | "STANDARD" | "PREMIUM" | null;
  handoffRequested: boolean;
  customerConfirmed: boolean;
  confidenceScore: number;
  missingFields: string[];
  unresolvedQuestions: string[];
  corrections?: RequirementCorrectionRecord[];
}

export type FieldPatchAction = "set" | "update" | "clear" | "keep" | "uncertain";

export interface RequirementFieldPatch<T> {
  action: FieldPatchAction;
  value?: T;
  previousValue?: T;
  confidence?: number;
  reason?: string;
}

export interface BookingRequirementsPatch {
  guestCount?: RequirementFieldPatch<number>;
  eventDate?: RequirementFieldPatch<string>;
  startTime?: RequirementFieldPatch<string>;
  durationHours?: RequirementFieldPatch<number>;
  venueAddress?: RequirementFieldPatch<string>;
  eventType?: RequirementFieldPatch<string>;
  beveragePreferences?: RequirementFieldPatch<string[]>;
  selectedTier?: RequirementFieldPatch<"BASIC" | "STANDARD" | "PREMIUM">;
  handoffRequested?: RequirementFieldPatch<boolean>;
  confirmationIntent?: RequirementFieldPatch<ConfirmationIntent>;
}

export type ExtractionStatus =
  | "success"
  | "invalid_response"
  | "api_failure"
  | "low_confidence"
  | "service_unavailable";

export type ExtractionSource = "gemini" | "mock";

export interface StructuredExtractionResult {
  status: ExtractionStatus;
  source: ExtractionSource;
  data: Partial<BookingRequirements> | null;
  confidenceScore: number;
  confirmationIntent?: ConfirmationIntent;
  clearedFields?: string[];
  error?: string;
  rawResponse?: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  language: SupportedLanguage;
  timestamp: string; // Strict ISO 8601 UTC ending in Z
}

export interface VoiceBookingSession {
  id: string;
  phoneNumber: string; // E.164
  language: SupportedLanguage;
  state: VoiceBookingState;
  requirements: BookingRequirements;
  quotation: EventQuotationRecord | null;
  conversationHistory: ConversationMessage[];
  createdAt: string; // Strict ISO 8601 UTC
  updatedAt: string; // Strict ISO 8601 UTC
  staffApprovalId: string | null;
  metadata: Record<string, unknown>;
}

export interface ConversationTurnResult {
  session: VoiceBookingSession;
  assistantResponse: string;
  language: SupportedLanguage;
  extractedRequirements: BookingRequirements;
  state: VoiceBookingState;
  quotation: EventQuotationRecord | null;
  clarificationNeeded: string[];
  handoffTriggered: boolean;
  extractionResult?: StructuredExtractionResult;
}

export interface LanguageDetectionResult {
  language: SupportedLanguage;
  confidence: number;
  detectedScript: "latin" | "devanagari" | "telugu";
}

export interface ExtractionProvider {
  extractRequirements(
    text: string,
    current: BookingRequirements,
    language: SupportedLanguage
  ): Promise<StructuredExtractionResult>;
  detectLanguage?(
    text: string,
    currentLanguage?: SupportedLanguage
  ): Promise<LanguageDetectionResult>;
}

export interface VoiceSessionRepository {
  getById(id: string): Promise<VoiceBookingSession | null>;
  save(session: VoiceBookingSession): Promise<void>;
  getByPhoneNumber(phone: string): Promise<VoiceBookingSession | null>;
}
