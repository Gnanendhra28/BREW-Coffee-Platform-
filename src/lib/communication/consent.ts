/**
 * BREW Coffee Platform — Phase 6.1.1 Consent Engine & Event History
 * Pure functions for phone normalization, consent event verification, and audit trail generation.
 */

import {
  CommunicationChannel,
  CommunicationPurpose,
  ConsentRecord,
} from "./types";
import { ConsentRecordSchema, PhoneNumberSchema } from "./schemas";
import { InvalidPhoneNumberError } from "./errors";

/**
 * Normalizes an arbitrary phone string into canonical E.164 format.
 * Defaults 10-digit Indian numbers (starting with 6-9) to '+91'.
 * Returns null if normalization fails or format is invalid.
 */
export function normalizePhoneNumber(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  // Remove spaces, hyphens, parentheses, and tabs
  const cleaned = raw.replace(/[\s\-\(\)\.]/g, "").trim();

  // If already starts with '+', validate E.164 pattern
  if (cleaned.startsWith("+")) {
    const parsed = PhoneNumberSchema.safeParse(cleaned);
    return parsed.success ? parsed.data : null;
  }

  // Handle standard 10-digit Indian mobile numbers (starting with 6, 7, 8, or 9)
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }

  // Handle 11-digit with leading zero (e.g. 09876543210)
  if (/^0[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned.slice(1)}`;
  }

  // Handle 12-digit with 91 country code without '+' (e.g. 919876543210)
  if (/^91[6-9]\d{9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  return null;
}

/**
 * Validates whether a normalized phone string matches strict E.164.
 * Throws InvalidPhoneNumberError if invalid.
 */
export function assertValidPhoneNumber(phone: string): string {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) {
    throw new InvalidPhoneNumberError(
      `Phone number "${phone}" is invalid and cannot be normalized to E.164 format.`
    );
  }
  return normalized;
}

/**
 * Validates an ISO 8601 UTC timestamp string, throwing an Error if invalid.
 */
export function assertValidTimestamp(timestamp: string): number {
  if (!timestamp || typeof timestamp !== "string") {
    throw new Error(`Invalid timestamp format: "${timestamp}"`);
  }
  const timeMs = Date.parse(timestamp);
  if (isNaN(timeMs)) {
    throw new Error(`Timestamp "${timestamp}" cannot be parsed as a valid date`);
  }
  return timeMs;
}

/**
 * Creates a validated, auditable ConsentRecord representing an explicit GRANT event.
 */
export function createConsentRecord(params: {
  phoneNumber: string;
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  consentText: string;
  consentVersion?: string;
  enquiryId?: string;
  timestamp?: string;
}): ConsentRecord {
  const normalizedPhone = assertValidPhoneNumber(params.phoneNumber);
  const nowUtc = params.timestamp || new Date().toISOString();
  assertValidTimestamp(nowUtc);

  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const id = `consent_grant_${Date.now()}_${randomSuffix}`;

  const record: ConsentRecord = {
    id,
    phoneNumber: normalizedPhone,
    channel: params.channel,
    purpose: params.purpose,
    eventType: "grant",
    granted: true,
    consentText: params.consentText.trim(),
    consentVersion: params.consentVersion || "v1.0",
    timestamp: nowUtc,
    enquiryId: params.enquiryId,
  };

  return ConsentRecordSchema.parse(record);
}

/**
 * Creates a validated ConsentRecord representing an explicit REVOCATION event.
 * Represents a distinct historical event with its own timestamp and reason.
 */
export function createRevocationRecord(params: {
  phoneNumber: string;
  channel: CommunicationChannel;
  purpose: CommunicationPurpose;
  reason?: string;
  enquiryId?: string;
  timestamp?: string;
}): ConsentRecord {
  const normalizedPhone = assertValidPhoneNumber(params.phoneNumber);
  const nowUtc = params.timestamp || new Date().toISOString();
  assertValidTimestamp(nowUtc);

  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const id = `consent_revoke_${Date.now()}_${randomSuffix}`;

  const record: ConsentRecord = {
    id,
    phoneNumber: normalizedPhone,
    channel: params.channel,
    purpose: params.purpose,
    eventType: "revoke",
    granted: false,
    consentText: "Consent revoked by customer request",
    consentVersion: "v1.0",
    timestamp: nowUtc,
    reason: params.reason || "customer_requested_opt_out",
    enquiryId: params.enquiryId,
    revokedAt: nowUtc,
    revocationReason: params.reason || "customer_requested_opt_out",
  };

  return ConsentRecordSchema.parse(record);
}

/**
 * Helper to revoke an existing consent record by generating a distinct revocation event.
 */
export function revokeConsentRecord(
  existing: ConsentRecord,
  reason = "customer_requested_opt_out",
  revokedAt?: string
): ConsentRecord {
  return createRevocationRecord({
    phoneNumber: existing.phoneNumber,
    channel: existing.channel,
    purpose: existing.purpose,
    reason,
    enquiryId: existing.enquiryId,
    timestamp: revokedAt,
  });
}

/**
 * Checks if a specific consent record represents a revocation or was revoked.
 */
export function isConsentRevoked(record: ConsentRecord): boolean {
  return record.eventType === "revoke" || !record.granted || Boolean(record.revokedAt);
}

/**
 * Determines whether active consent exists for a given channel and purpose across historical events.
 * 
 * Rules:
 * 1. Filters records strictly matching the requested channel and purpose.
 * 2. Validates timestamps, rejecting any corrupt or invalid timestamp entries.
 * 3. Sorts events by timestamp descending.
 * 4. Deterministic Tie-Breaking Rule for Concurrent Timestamps:
 *    - Safety-First Rule: If two events share the exact same timestamp millisecond,
 *      a "revoke" event ALWAYS takes precedence over a "grant" event.
 *    - Tertiary: Lexicographical ID comparison descending.
 * 5. The latest valid event in the sorted sequence dictates active consent:
 *    - If eventType === "grant" and granted === true -> ACTIVE (true).
 *    - If eventType === "revoke" or granted === false -> INACTIVE (false).
 * 6. An older grant event submitted after a newer revocation is sorted after the revocation and cannot override it.
 * 7. A genuinely new explicit grant event after revocation restores consent for that exact channel and purpose.
 * 8. A grant for channel A / purpose A has zero effect on channel B / purpose B.
 */
export function hasActiveConsent(
  records: ConsentRecord[],
  channel: CommunicationChannel,
  purpose: CommunicationPurpose
): boolean {
  if (!records || records.length === 0) return false;

  // 1. Filter matching channel and purpose
  const relevantRecords = records.filter(
    (r) => r.channel === channel && r.purpose === purpose
  );

  if (relevantRecords.length === 0) return false;

  // 2. Filter out records with invalid timestamps
  const validRecords = relevantRecords.filter((r) => {
    try {
      assertValidTimestamp(r.timestamp);
      return true;
    } catch {
      return false;
    }
  });

  if (validRecords.length === 0) return false;

  // 3. Sort descending with deterministic tie-breaking
  const sorted = [...validRecords].sort((a, b) => {
    const timeA = Date.parse(a.timestamp);
    const timeB = Date.parse(b.timestamp);

    // Primary: timestamp descending
    if (timeB !== timeA) {
      return timeB - timeA;
    }

    // Secondary (Deterministic Tie-Breaker): Safety-First Precedence
    // A revocation event ALWAYS beats a grant event at the exact same timestamp
    if (a.eventType !== b.eventType) {
      return a.eventType === "revoke" ? -1 : 1;
    }

    // Tertiary: Lexicographical ID comparison descending
    return b.id.localeCompare(a.id);
  });

  const latest = sorted[0];

  // Latest event dictates consent
  if (latest.eventType === "revoke" || !latest.granted) {
    return false;
  }

  return latest.eventType === "grant" && latest.granted === true;
}
