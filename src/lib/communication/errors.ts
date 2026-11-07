/**
 * BREW Coffee Platform — Phase 6.1 Communication Domain Errors
 */

export class CommunicationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "CommunicationError";
  }
}

export class InvalidPhoneNumberError extends CommunicationError {
  constructor(message = "Phone number is invalid or cannot be normalized to E.164") {
    super(message, "INVALID_PHONE_NUMBER");
    this.name = "InvalidPhoneNumberError";
  }
}

export class InvalidConsentTimestampError extends CommunicationError {
  constructor(
    message = "Timestamp must be a strictly valid ISO 8601 UTC formatted string ending in 'Z' (e.g. YYYY-MM-DDTHH:mm:ss.sssZ)"
  ) {
    super(message, "INVALID_TIMESTAMP");
    this.name = "InvalidConsentTimestampError";
  }
}

export class ConsentMissingError extends CommunicationError {
  constructor(message = "Explicit consent has not been granted for this channel and purpose") {
    super(message, "CONSENT_MISSING");
    this.name = "ConsentMissingError";
  }
}

export class ConsentRevokedError extends CommunicationError {
  constructor(message = "Customer has revoked consent for this channel and purpose") {
    super(message, "CONSENT_REVOKED");
    this.name = "ConsentRevokedError";
  }
}

export class DndBlockedError extends CommunicationError {
  constructor(message = "Communication is blocked by active Do-Not-Contact (DND) registration") {
    super(message, "DND_ACTIVE");
    this.name = "DndBlockedError";
  }
}

export class OutsideCallingHoursError extends CommunicationError {
  constructor(message = "Voice call attempted outside authorized calling window (09:00 - 20:00 IST)") {
    super(message, "OUTSIDE_CALLING_HOURS");
    this.name = "OutsideCallingHoursError";
  }
}

export class FeatureDisabledError extends CommunicationError {
  constructor(message = "Voice booking and automated communication is disabled via feature flag") {
    super(message, "FEATURE_DISABLED");
    this.name = "FeatureDisabledError";
  }
}

export class ProviderIdempotencyConflictError extends CommunicationError {
  constructor(
    message = "Provider idempotency conflict: key already used with conflicting payload."
  ) {
    super(message, "IDEMPOTENCY_CONFLICT");
    this.name = "ProviderIdempotencyConflictError";
  }
}

export class StaleClaimError extends CommunicationError {
  constructor(
    message = "Outbox delivery claim is stale, owned by another worker, or lease has expired."
  ) {
    super(message, "STALE_CLAIM");
    this.name = "StaleClaimError";
  }
}

export class WhatsAppCloudApiError extends CommunicationError {
  public readonly statusCode: number;
  public readonly metaErrorCode?: number;
  public readonly metaErrorSubcode?: number;
  public readonly metaErrorType?: string;
  public readonly isRetryable: boolean;
  public readonly fbtraceId?: string;

  constructor(
    message: string,
    options: {
      statusCode: number;
      code?: number;
      subcode?: number;
      type?: string;
      isRetryable?: boolean;
      fbtraceId?: string;
    }
  ) {
    // Sanitize any bearer tokens or authorization headers from the message string
    const sanitized = message
      .replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, "Bearer [REDACTED]")
      .replace(/EAAG[A-Za-z0-9]+/gi, "[REDACTED_TOKEN]");

    super(sanitized, "WHATSAPP_CLOUD_API_ERROR");
    this.name = "WhatsAppCloudApiError";
    this.statusCode = options.statusCode;
    this.metaErrorCode = options.code;
    this.metaErrorSubcode = options.subcode;
    this.metaErrorType = options.type;
    this.fbtraceId = options.fbtraceId;
    this.isRetryable = options.isRetryable ?? (options.statusCode >= 500 || options.code === 130429);
  }
}
