/**
 * BREW Coffee Platform — Phase 6.1.1 Communication Domain Types
 * Strongly typed domain models for consent events, DND multi-scope records, policy orchestration, and provider interfaces.
 */

export type CommunicationChannel = "voice" | "whatsapp";

export type CommunicationPurpose =
  | "voice_booking"
  | "transactional_update"
  | "marketing";

export type ConsentEventType = "grant" | "revoke";

/**
 * Validated consent event capturing distinct grant or revocation actions.
 * Consent is determined by the latest valid event for (phoneNumber, channel, purpose).
 */
export interface ConsentRecord {
  id: string;
  phoneNumber: string; // E.164 format, e.g. +919876543210
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  eventType: ConsentEventType;
  granted: boolean; // true if eventType === "grant", false if eventType === "revoke"
  consentText: string;
  consentVersion: string;
  timestamp: string; // ISO 8601 UTC
  enquiryId?: string;
  reason?: string; // Opt-out reason for revocations
  revokedAt?: string; // Kept for backward compatibility
  revocationReason?: string; // Kept for backward compatibility
}

export type DndScope = "all" | "voice" | "whatsapp";

export type DndSource = "voice" | "whatsapp" | "web" | "manual";

/**
 * Validated Do-Not-Contact (DND) suppression entry for an active scope.
 */
export interface DndRecord {
  id: string;
  phoneNumber: string; // E.164 format
  scope: DndScope;
  reason: string;
  createdAt: string; // ISO 8601 UTC
  sourceChannel?: DndSource;
}

/**
 * Diagnostic audit log record for DND registrations and administrative removals.
 * Preserves event history with masked phone numbers to protect customer privacy.
 */
export interface DndAuditEvent {
  id: string;
  action: "REGISTER_DND" | "REMOVE_DND";
  phoneNumberMasked: string; // E.164 masked, e.g. +91******3210
  scope: DndScope;
  reason: string;
  justification?: string;
  performedBy?: string; // system or admin identifier
  timestamp: string; // ISO 8601 UTC
}

export type PolicyDecisionStatus = "allowed" | "blocked" | "requires_review";

export type PolicyReasonCode =
  | "FEATURE_DISABLED"
  | "INVALID_PHONE_NUMBER"
  | "DND_ACTIVE"
  | "CONSENT_MISSING"
  | "CONSENT_REVOKED"
  | "MARKETING_CONSENT_REQUIRED"
  | "OUTSIDE_CALLING_HOURS"
  | "REPOSITORY_INTEGRITY_MISMATCH"
  | "ALLOWED";

export interface PolicyEvaluationRequest {
  phoneNumber: string;
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  enquiryId?: string;
  currentTime?: Date;
}

export interface PolicyEvaluationResult {
  status: PolicyDecisionStatus;
  reason: PolicyReasonCode;
  details: string;
  evaluatedAt: string;
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  phoneNumberMasked: string; // Safe representation, e.g. +91******3210
}

/* ========================================================================== */
/* Voice Provider Interfaces (Simulation-Aware)                               */
/* ========================================================================== */

export type VoiceLanguage = "en" | "hi" | "te";

export interface VoiceSessionParams {
  sessionId: string;
  phoneNumber: string;
  language: VoiceLanguage;
  enquiryId?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceSessionResult {
  sessionId: string;
  providerCallId: string;
  status: "simulated_initiated" | "simulated_failed" | "initiated" | "failed";
  startedAt: string;
  isSimulated: boolean;
  providerMode: "mock" | "simulated" | "production";
}

export type VoiceCallStatus =
  | "simulated_queued"
  | "simulated_ringing"
  | "simulated_in_progress"
  | "simulated_completed"
  | "simulated_failed"
  | "simulated_busy"
  | "simulated_no_answer"
  | "simulated_ended"
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "failed"
  | "busy"
  | "no_answer";

export interface VoiceSessionStatusResult {
  sessionId: string;
  providerCallId: string;
  status: VoiceCallStatus;
  durationSeconds?: number;
  isSimulated: boolean;
  providerMode: "mock" | "simulated" | "production";
}

export interface VoiceSessionEndResult {
  sessionId: string;
  status: "ended" | "simulated_ended";
  endedAt: string;
  isSimulated: boolean;
  providerMode: "mock" | "simulated" | "production";
}

export interface VoiceProvider {
  readonly providerName: string;
  startSession(params: VoiceSessionParams): Promise<VoiceSessionResult>;
  getStatus(sessionId: string): Promise<VoiceSessionStatusResult>;
  endSession(sessionId: string, reason?: string): Promise<VoiceSessionEndResult>;
}

/* ========================================================================== */
/* WhatsApp Provider Interfaces (Simulation-Aware)                            */
/* ========================================================================== */

export interface WhatsAppTemplateParameter {
  type: "text" | "currency" | "date_time" | "document";
  text?: string;
  document?: {
    link: string;
    filename?: string;
  };
}

export interface WhatsAppTemplateComponent {
  type: "header" | "body" | "button";
  subType?: "url" | "quick_reply";
  index?: number;
  parameters: WhatsAppTemplateParameter[];
}

export interface WhatsAppTemplateParams {
  to: string; // E.164
  templateName: string;
  language: string;
  components: WhatsAppTemplateComponent[];
  enquiryId?: string;
  metadata?: Record<string, unknown>;
}

export type WhatsAppMessageStatus =
  | "simulated_accepted"
  | "simulated_sent"
  | "simulated_delivered"
  | "simulated_read"
  | "simulated_failed"
  | "accepted"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export interface WhatsAppSendResult {
  messageId: string;
  status: WhatsAppMessageStatus;
  dispatchedAt: string;
  isSimulated: boolean;
  providerMode: "mock" | "simulated" | "production";
}

export interface WhatsAppMessageStatusResult {
  messageId: string;
  status: WhatsAppMessageStatus;
  timestamp: string;
  isSimulated: boolean;
  providerMode: "mock" | "simulated" | "production";
}

export interface WhatsAppProvider {
  readonly providerName: string;
  sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult>;
  getMessageStatus(messageId: string): Promise<WhatsAppMessageStatusResult>;
}

/* ========================================================================== */
/* Repository Interfaces                                                      */
/* ========================================================================== */

export interface ConsentRepository {
  save(record: ConsentRecord): Promise<void>;
  findByPhone(phoneNumber: string): Promise<ConsentRecord[]>;
  getActiveConsent(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose
  ): Promise<ConsentRecord | null>;
  revoke(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose,
    reason: string,
    timestamp?: string
  ): Promise<ConsentRecord>;
}

export interface DndRepository {
  save(entry: DndRecord): Promise<void>;
  findByPhone(phoneNumber: string): Promise<DndRecord | null>;
  findActiveScopes(phoneNumber: string): Promise<DndRecord[]>;
  removeScope(
    phoneNumber: string,
    scope: DndScope,
    justification: string,
    performedBy?: string
  ): Promise<boolean>;
  remove(phoneNumber: string, justification: string): Promise<boolean>;
  getAuditHistory(): ReadonlyArray<DndAuditEvent>;
}
