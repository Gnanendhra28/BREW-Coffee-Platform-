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
