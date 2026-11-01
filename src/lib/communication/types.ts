/**
 * BREW Coffee Platform — Phase 6.1 Communication Domain Types
 * Strongly typed domain models for consent, DND, policy, and provider interfaces.
 */

export type CommunicationChannel = "voice" | "whatsapp";

export type CommunicationPurpose =
  | "voice_booking"
  | "transactional_update"
  | "marketing";

/**
 * Validated consent record capturing independent channel/purpose grants.
 */
export interface ConsentRecord {
  id: string;
  phoneNumber: string; // E.164 format, e.g. +919876543210
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  granted: boolean;
  consentText: string;
  consentVersion: string;
  timestamp: string; // ISO 8601 UTC
  enquiryId?: string;
  revokedAt?: string; // ISO 8601 UTC
  revocationReason?: string;
}

export type DndScope = "all" | "voice" | "whatsapp";

export type DndSource = "voice" | "whatsapp" | "web" | "manual";

/**
 * Validated Do-Not-Contact (DND) suppression entry.
 */
export interface DndRecord {
  id: string;
  phoneNumber: string; // E.164 format
  scope: DndScope;
  reason: string;
  createdAt: string; // ISO 8601 UTC
  sourceChannel?: DndSource;
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
/* Voice Provider Interfaces                                                 */
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
  status: "initiated" | "failed";
  startedAt: string;
}

export type VoiceCallStatus =
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
}

export interface VoiceSessionEndResult {
  sessionId: string;
  status: "ended";
  endedAt: string;
}

export interface VoiceProvider {
  readonly providerName: string;
  startSession(params: VoiceSessionParams): Promise<VoiceSessionResult>;
  getStatus(sessionId: string): Promise<VoiceSessionStatusResult>;
  endSession(sessionId: string, reason?: string): Promise<VoiceSessionEndResult>;
}

/* ========================================================================== */
/* WhatsApp Provider Interfaces                                              */
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

export type WhatsAppMessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

export interface WhatsAppSendResult {
  messageId: string;
  status: WhatsAppMessageStatus;
  dispatchedAt: string;
}

export interface WhatsAppMessageStatusResult {
  messageId: string;
  status: WhatsAppMessageStatus;
  timestamp: string;
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
    reason: string
  ): Promise<ConsentRecord>;
}

export interface DndRepository {
  save(entry: DndRecord): Promise<void>;
  findByPhone(phoneNumber: string): Promise<DndRecord | null>;
  remove(phoneNumber: string, justification: string): Promise<boolean>;
}
