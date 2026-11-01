/**
 * BREW Coffee Platform — Phase 6.1 Consent Engine & Pure Rules
 * Pure functions for phone normalization, consent verification, and audit trail generation.
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
 * Creates a validated, auditable ConsentRecord.
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
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const id = `consent_${Date.now()}_${randomSuffix}`;

  const record: ConsentRecord = {
    id,
    phoneNumber: normalizedPhone,
    channel: params.channel,
    purpose: params.purpose,
    granted: true,
    consentText: params.consentText.trim(),
    consentVersion: params.consentVersion || "v1.0",
    timestamp: nowUtc,
    enquiryId: params.enquiryId,
  };

  return ConsentRecordSchema.parse(record);
}

/**
 * Revokes an existing consent record, returning an updated record.
 */
export function revokeConsentRecord(
  existing: ConsentRecord,
  reason = "customer_requested_opt_out",
  revokedAt?: string
): ConsentRecord {
  const updated: ConsentRecord = {
    ...existing,
    revokedAt: revokedAt || new Date().toISOString(),
    revocationReason: reason,
  };

  return ConsentRecordSchema.parse(updated);
}

/**
 * Checks if a specific consent record has been revoked.
 */
export function isConsentRevoked(record: ConsentRecord): boolean {
  return Boolean(record.revokedAt);
}

/**
 * Determines whether active consent exists for a given channel and purpose across all historical records.
 * 
 * Rules:
 * 1. Filters records strictly matching the requested channel and purpose.
 * 2. Orders records by timestamp descending (most recent action wins).
 * 3. If the most recent record was revoked or had granted: false, returns FALSE.
 * 4. A prior grant cannot override a later revocation.
 * 5. Granting transactional consent (voice_booking, transactional_update) NEVER satisfies marketing.
 */
export function hasActiveConsent(
  records: ConsentRecord[],
  channel: CommunicationChannel,
  purpose: CommunicationPurpose
): boolean {
  if (!records || records.length === 0) return false;

  // Filter matching records for the specific channel and purpose
  const relevantRecords = records.filter(
    (r) => r.channel === channel && r.purpose === purpose
  );

  if (relevantRecords.length === 0) return false;

  // Sort by effective event timestamp descending (newest first).
  // A revocation event's timestamp is its revokedAt date.
  const sorted = [...relevantRecords].sort((a, b) => {
    const timeA = new Date(a.revokedAt || a.timestamp).getTime();
    const timeB = new Date(b.revokedAt || b.timestamp).getTime();
    return timeB - timeA;
  });

  const latest = sorted[0];

  // If latest action was revoked or not granted, consent is inactive
  if (latest.revokedAt || !latest.granted) {
    return false;
  }

  // Check grant status
  return latest.granted === true;
}
