/**
 * BREW Coffee Platform — Phase 6.6.1 Voice Call Attempt Foundation Types
 *
 * Provider-independent lifecycle types for asynchronous outbound voice calls.
 * Decouples short-lived outbox deliveries from multi-minute PSTN telephone calls.
 */

export type VoiceCallAttemptStatus =
  | "initiated"
  | "ringing"
  | "answered"
  | "in_progress"
  | "completed"
  | "busy"
  | "no_answer"
  | "failed"
  | "cancelled";

export const VOICE_CALL_STATUS_RANKS: Readonly<Record<VoiceCallAttemptStatus, number>> = {
  initiated: 1,
  ringing: 2,
  answered: 3,
  in_progress: 4,
  completed: 5,
  busy: 5,
  no_answer: 5,
  failed: 5,
  cancelled: 5,
};

export const TERMINAL_VOICE_CALL_STATUSES: readonly VoiceCallAttemptStatus[] = [
  "completed",
  "busy",
  "no_answer",
  "failed",
  "cancelled",
] as const;

export function isTerminalVoiceCallStatus(status: VoiceCallAttemptStatus): boolean {
  return (TERMINAL_VOICE_CALL_STATUSES as readonly string[]).includes(status);
}

export type VoiceCallInitiationState =
  | "pending" // Registered before provider request
  | "in_flight" // Carrier request actively dispatched
  | "accepted" // Carrier accepted; providerCallId confirmed
  | "uncertain" // Carrier request timed out / network lost; outcome unknown, redial blocked
  | "rejected"; // Carrier definitively rejected request without placing call

export interface TerminalConflictRecord {
  conflictingStatus: VoiceCallAttemptStatus;
  receivedAt: string;
  reason: string;
  rawProviderMetadata?: Record<string, unknown>;
}

export interface VoiceCallAttemptRecord {
  id: string; // Internal attempt ID (e.g. "att_del_..._call1")
  deliveryId: string; // Associated outbox delivery record ID
  sessionId: string; // Associated VoiceBookingSession ID
  phoneNumberMasked: string; // Safe masked phone number, never raw E.164 (e.g. "+91 98*** ***10")
  channel: "voice";
  provider: string; // e.g. "mock", "exotel"
  direction: "outbound";
  status: VoiceCallAttemptStatus;
  statusRank: number; // 1 to 5 for monotonic ordering
  isTerminal: boolean;
  initiationState: VoiceCallInitiationState;
  claimOwner?: string | null; // Worker ID currently holding initiation claim
  claimToken?: string | null; // Claim token from outbox delivery
  leaseExpiresAt?: string | null; // Initiation claim lease expiration timestamp
  uncertainAt?: string | null; // Timestamp if initiation outcome became uncertain
  uncertainReason?: string | null; // Sanitized reason why initiation outcome is uncertain
  terminalConflict?: TerminalConflictRecord | null; // Preserved conflicting terminal event for reconciliation
  providerCallId: string | null; // Provider identifier attached on or after carrier acceptance
  initiatedAt: string; // Strict ISO 8601 UTC
  ringingAt?: string | null;
  answeredAt?: string | null;
  completedAt?: string | null;
  durationSeconds?: number | null;
  errorCode?: string | null; // Safe sanitized error code (e.g. "CARRIER_BUSY", "CALL_TIMEOUT")
  errorMessage?: string | null; // Safe sanitized error description
  rawProviderMetadata?: Record<string, unknown>;
  createdAt: string; // Strict ISO 8601 UTC
  updatedAt: string; // Strict ISO 8601 UTC
}

export interface CreateVoiceCallAttemptParams {
  id: string;
  deliveryId: string;
  sessionId: string;
  phoneNumberMasked: string;
  provider: string;
  providerCallId?: string | null;
  claimOwner?: string | null;
  claimToken?: string | null;
  leaseExpiresAt?: string | null;
  initiationState?: VoiceCallInitiationState;
  initiatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateVoiceCallAttemptStatusParams {
  status: VoiceCallAttemptStatus;
  timestamp?: string; // Event occurrence timestamp in ISO 8601 UTC
  durationSeconds?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  rawProviderMetadata?: Record<string, unknown>;
}

export type VoiceCallAttemptUpdateOutcome =
  | "updated"
  | "idempotent_duplicate"
  | "ignored_out_of_order"
  | "terminal_conflict";

export interface VoiceCallAttemptUpdateResult {
  outcome: VoiceCallAttemptUpdateOutcome;
  attempt: VoiceCallAttemptRecord;
  reason?: string;
}

export interface CorrelateWebhookParams {
  attemptId: string;
  providerCallId: string;
  provider: string;
  sessionId: string;
  status: VoiceCallAttemptStatus;
  timestamp?: string; // Strict ISO 8601 UTC
  durationSeconds?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  rawProviderMetadata?: Record<string, unknown>;
}

export interface VoiceCallAttemptRepository {
  createAttempt(params: CreateVoiceCallAttemptParams): Promise<VoiceCallAttemptRecord>;
  getById(id: string): Promise<VoiceCallAttemptRecord | null>;
  getByProviderCallId(providerCallId: string): Promise<VoiceCallAttemptRecord | null>;
  attachProviderCallId(id: string, providerCallId: string, timestamp?: string): Promise<VoiceCallAttemptRecord>;
  markInitiationAccepted(
    id: string,
    providerCallId: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord>;
  markInitiationUncertain(
    id: string,
    reason: string,
    message?: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord>;
  markInitiationRejected(
    id: string,
    errorCode: string,
    errorMessage?: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord>;
  recoverExpiredInitiation(
    id: string,
    now: Date,
    reason?: string
  ): Promise<VoiceCallAttemptRecord | null>;
  correlateWebhookByAttemptId(
    params: CorrelateWebhookParams
  ): Promise<VoiceCallAttemptUpdateResult>;
  updateStatus(id: string, params: UpdateVoiceCallAttemptStatusParams): Promise<VoiceCallAttemptUpdateResult>;
  updateStatusByProviderCallId(
    providerCallId: string,
    params: UpdateVoiceCallAttemptStatusParams
  ): Promise<VoiceCallAttemptUpdateResult>;
}
