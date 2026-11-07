/**
 * BREW Coffee Platform — Phase 6.2.2 Voice Booking Types
 * Strongly typed domain entities for the multilingual AI conversation engine.
 * Hardened with fail-closed staff authorization, deterministic confirmation safety gate,
 * and strict customer-clearable field controls.
 */

import { EventQuotationRecord } from "../eventBookingConcierge/types";
import { CommunicationDeliveryRecord } from "../communication/types";

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

export const TERMINAL_VOICE_STATES = [
  "booking_confirmed",
  "customer_declined",
  "human_handoff",
  "cancelled",
  "failed",
] as const;

export type TerminalVoiceState = (typeof TERMINAL_VOICE_STATES)[number];

export function isTerminalVoiceState(state: VoiceBookingState): boolean {
  return (TERMINAL_VOICE_STATES as readonly string[]).includes(state);
}

export class OptimisticConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticConcurrencyConflictError";
    Object.setPrototypeOf(this, OptimisticConcurrencyConflictError.prototype);
  }
}

export class TerminalSessionImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSessionImmutableError";
    Object.setPrototypeOf(this, TerminalSessionImmutableError.prototype);
  }
}

export class InvalidOfficialBookingBridgeDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOfficialBookingBridgeDataError";
    Object.setPrototypeOf(this, InvalidOfficialBookingBridgeDataError.prototype);
  }
}

export class InvalidBookingTimeSlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBookingTimeSlotError";
    Object.setPrototypeOf(this, InvalidBookingTimeSlotError.prototype);
  }
}

export class IncompleteSessionLookupError extends Error {
  public readonly phoneNumber: string;
  public readonly scannedCount: number;

  constructor(phoneNumber: string, scannedCount: number) {
    super(
      `Session lookup for phone '${phoneNumber}' was truncated after scanning ${scannedCount} sessions. Additional records exist beyond the scan budget.`
    );
    this.name = "IncompleteSessionLookupError";
    this.phoneNumber = phoneNumber;
    this.scannedCount = scannedCount;
    Object.setPrototypeOf(this, IncompleteSessionLookupError.prototype);
  }
}

export const DEFAULT_MAX_SCAN_BUDGET = 100;
export const HARD_MAX_SCAN_BUDGET = 500;

export class InvalidSessionLookupBudgetError extends Error {
  public readonly rawValue: unknown;
  public readonly reason: string;

  constructor(rawValue: unknown, reason: string) {
    super(
      `Invalid session lookup budget '${String(rawValue)}': ${reason}. Budget must be a positive integer between 1 and ${HARD_MAX_SCAN_BUDGET}.`
    );
    this.name = "InvalidSessionLookupBudgetError";
    this.rawValue = rawValue;
    this.reason = reason;
    Object.setPrototypeOf(this, InvalidSessionLookupBudgetError.prototype);
  }
}

export function validateScanBudget(rawBudget: unknown): number {
  if (rawBudget === undefined) {
    return DEFAULT_MAX_SCAN_BUDGET;
  }
  if (typeof rawBudget !== "number") {
    throw new InvalidSessionLookupBudgetError(
      rawBudget,
      typeof rawBudget === "object" && rawBudget === null
        ? "Value is null"
        : `Expected number, received ${typeof rawBudget}`
    );
  }
  if (!Number.isFinite(rawBudget)) {
    throw new InvalidSessionLookupBudgetError(rawBudget, "Value is not finite (NaN or Infinity)");
  }
  if (!Number.isInteger(rawBudget)) {
    throw new InvalidSessionLookupBudgetError(rawBudget, "Value must be an integer, received float");
  }
  if (rawBudget <= 0) {
    throw new InvalidSessionLookupBudgetError(rawBudget, "Value must be greater than zero");
  }
  if (rawBudget > HARD_MAX_SCAN_BUDGET) {
    throw new InvalidSessionLookupBudgetError(
      rawBudget,
      `Value exceeds hard maximum scan budget of ${HARD_MAX_SCAN_BUDGET}`
    );
  }
  return rawBudget;
}

export class VoiceSessionLookupIntegrityError extends Error {
  public readonly maskedPhoneNumber: string;
  public readonly documentId: string;
  public readonly reason: string;

  constructor(maskedPhoneNumber: string, documentId: string, reason: string) {
    super(
      `Lookup integrity violation for phone '${maskedPhoneNumber}' on document '${documentId}': ${reason}. Failing closed to prevent corrupted or inconsistent session recovery.`
    );
    this.name = "VoiceSessionLookupIntegrityError";
    this.maskedPhoneNumber = maskedPhoneNumber;
    this.documentId = documentId;
    this.reason = reason;
    Object.setPrototypeOf(this, VoiceSessionLookupIntegrityError.prototype);
  }
}

export function maskVoicePhoneNumber(phone?: string): string {
  if (!phone || typeof phone !== "string") return "+91******0000";
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return "****";
  return `${trimmed.substring(0, 3)}****${trimmed.substring(trimmed.length - 4)}`;
}

export type SupportedLanguage = "en" | "hi" | "te";

export type ConfirmationIntent =
  | "positive_acceptance"
  | "rejection"
  | "clarification_requested"
  | "modification_requested"
  | "ambiguous";

export const CUSTOMER_CLEARABLE_FIELDS = [
  "guestCount",
  "eventDate",
  "startTime",
  "durationHours",
  "venueAddress",
  "eventType",
  "beveragePreferences",
  "selectedTier",
] as const;

export type CustomerClearableField = (typeof CUSTOMER_CLEARABLE_FIELDS)[number];

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

export interface QuotationMaterialSnapshot {
  guestCount: number;
  eventDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  durationHours: number;
  venueAddress: string;
  selectedTier: "BASIC" | "STANDARD" | "PREMIUM" | null;
  eventType: string | null;
  hash: string; // Canonical SHA-256 hash of material fields
  generatedAt: string; // Strict ISO 8601 UTC
}

export interface QuotationIntegrityResult {
  isMatch: boolean;
  mismatchedFields: string[];
  reason?: string;
}

export interface ConfirmationSafetyEvaluation {
  isConfirmed: boolean;
  intent: ConfirmationIntent;
  reason: string;
  integrityResult?: QuotationIntegrityResult;
}

export interface StaffAuthorizationContext {
  staffIdentity: string; // Authenticated staff operator identifier from server session
  staffRole: "barista" | "fleet_admin" | "admin" | string; // Verified role from RBAC
  staffApprovalId: string; // Audit identifier for the approval event
}

export interface StaffApprovalAuditRecord {
  staffIdentity: string;
  staffRole: "barista" | "fleet_admin" | "admin";
  staffApprovalId: string;
  approvedAt: string; // Strict ISO 8601 UTC
  sessionId: string;
}

export interface StaffRejectionAuthorizationContext {
  staffIdentity: string; // Authenticated staff operator identifier from server session
  staffRole: "barista" | "fleet_admin" | "admin" | string; // Verified role from RBAC
  staffRejectionId: string; // Audit identifier for the rejection event
  reason: string; // Mandatory operational rejection reason
  customerFacingReason?: string; // Optional sanitized message shown to customer
}

export interface StaffRejectionAuditRecord {
  staffIdentity: string;
  staffRole: "barista" | "fleet_admin" | "admin";
  staffRejectionId: string;
  rejectedAt: string; // Strict ISO 8601 UTC
  sessionId: string;
  reason: string;
  customerFacingReason?: string;
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
  quotationSnapshot: QuotationMaterialSnapshot | null;
  conversationHistory: ConversationMessage[];
  createdAt: string; // Strict ISO 8601 UTC
  updatedAt: string; // Strict ISO 8601 UTC
  revision: number; // Concurrency revision counter (monotonic integer >= 1)
  staffApprovalId: string | null;
  staffApprovalAudit?: StaffApprovalAuditRecord | null;
  staffRejectionAudit?: StaffRejectionAuditRecord | null;
  officialBookingId?: string | null;
  metadata: Record<string, unknown>;
  lastProcessedTurnIndex?: number | null;
  processedTurnIds?: string[];
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
  safetyEvaluation?: ConfirmationSafetyEvaluation;
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

export interface AtomicApprovalResult {
  success: boolean;
  session?: VoiceBookingSession;
  officialBooking?: Record<string, unknown>;
  error?: "session_not_found" | "already_approved" | "invalid_state";
  message?: string;
}

export interface AtomicRejectionResult {
  success: boolean;
  session?: VoiceBookingSession;
  officialBooking?: Record<string, unknown>;
  error?: "session_not_found" | "already_processed" | "invalid_state";
  message?: string;
}

export interface VoiceSessionLookupOptions {
  activeOnly?: boolean;
  maxScanBudget?: number;
}

export interface VoiceSessionRepository {
  readonly isDurable?: boolean;
  readonly storageType?: "firestore" | "memory" | string;
  getById(id: string): Promise<VoiceBookingSession | null>;
  save(session: VoiceBookingSession, expectedRevision?: number): Promise<void>;
  saveWithOutbox(
    session: VoiceBookingSession,
    expectedRevision: number,
    outboxDeliveries: CommunicationDeliveryRecord[]
  ): Promise<void>;
  getByPhoneNumber(
    phone: string,
    options?: VoiceSessionLookupOptions
  ): Promise<VoiceBookingSession | null>;
  atomicApproveBooking(
    sessionId: string,
    authContext: StaffAuthorizationContext,
    transitionFn: (
      session: VoiceBookingSession,
      authContext: StaffAuthorizationContext
    ) => VoiceBookingSession
  ): Promise<AtomicApprovalResult>;
  atomicRejectBooking?(
    sessionId: string,
    authContext: StaffRejectionAuthorizationContext,
    transitionFn: (
      session: VoiceBookingSession,
      authContext: StaffRejectionAuthorizationContext
    ) => VoiceBookingSession
  ): Promise<AtomicRejectionResult>;
  getOfficialBooking?(id: string): Promise<Record<string, unknown> | null>;
  getOutboxDeliveries?(sessionId?: string): Promise<CommunicationDeliveryRecord[]>;
  getAllSessions?(): Promise<VoiceBookingSession[]>;
}
