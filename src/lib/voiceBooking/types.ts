/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking Types
 * Strongly typed domain entities for the multilingual AI conversation engine.
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

export interface BookingRequirements {
  guestCount: number | null;
  eventDate: string | null; // YYYY-MM-DD
  startTime: string | null; // HH:mm
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
  ): Promise<Partial<BookingRequirements>>;
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
