/**
 * BREW Coffee Platform — Phase 6.6.5.1 Controlled Test Authorization & Outbound Safety
 *
 * Provides defense-in-depth authorization, allowlisting, single-call leasing,
 * and independent voice consent verification for controlled real-voice tests.
 *
 * INVARIANTS:
 * 1. Server-Side Allowlist Enforcement: Only normalized E.164 numbers explicitly listed
 *    in VOICE_TEST_WHITELIST_PHONES can receive test calls when allowlist is active.
 * 2. Single-Call Atomic Consumption: Each test authorization can only initiate exactly ONE
 *    outbound call attempt. Consumption is atomic; concurrent workers cannot duplicate calls.
 * 3. Fail-Closed Expiry: Expired, revoked, or consumed authorizations fail closed immediately.
 * 4. Independent Voice Consent: Voice consent must be verified independently of WhatsApp consent.
 * 5. Emergency Shutdown: If VOICE_BOOKING_ENABLED=false, all live dialing is unconditionally blocked.
 * 6. Audit & Privacy: Authorizations, attempts, and outcomes are audited with masked phone numbers.
 *    No PII, secrets, tokens, or audio content are ever logged. Audio recording is strictly prohibited.
 */

import { isVoiceBookingEnabled, maskPhoneNumber } from "../config";
import { normalizePhoneNumber, hasActiveConsent } from "../consent";
import { ConsentRecord, ConsentRepository } from "../types";
import { getAdminFirestore, Timestamp } from "../../firebaseAdmin";

export interface VoiceTestAuthorizationRecord {
  authorizationId: string;
  authorizedPhone: string; // Normalized E.164 (e.g. +919876543210)
  approvedBy: string; // Operator / Staff identity
  approvedAt: string; // ISO
  expiresAt: string; // ISO
  consumedAt: string | null;
  consumedByAttemptId: string | null;
  purpose: string;
  status: "active" | "consumed" | "expired" | "revoked";
  metadata?: Record<string, unknown>;
}

export interface VoiceTestAuditRecord {
  auditId: string;
  authorizationId: string;
  attemptId: string;
  timestamp: string;
  phoneNumberMasked: string;
  outcome: "authorized" | "rejected" | "consumed" | "uncertain";
  reason?: string;
}

export class VoiceTestAuthorizationError extends Error {
  public readonly code: string;
  public readonly isCertainRejection: boolean;

  constructor(message: string, code: string, isCertainRejection = true) {
    super(message);
    this.name = "VoiceTestAuthorizationError";
    this.code = code;
    this.isCertainRejection = isCertainRejection;
  }
}

/**
 * Parses and returns the list of normalized E.164 phone numbers allowed for controlled tests.
 */
export function getVoiceTestWhitelistPhones(): string[] {
  const raw = process.env.VOICE_TEST_WHITELIST_PHONES;
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => normalizePhoneNumber(p))
    .filter((p): p is string => p !== null);
}

/**
 * Checks if a given destination phone number is on the test allowlist.
 */
export function isAuthorizedTestNumber(phone: string): boolean {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return false;

  const whitelist = getVoiceTestWhitelistPhones();
  if (whitelist.length === 0) {
    // If no whitelist is configured, no test numbers are authorized
    return false;
  }

  return whitelist.includes(normalized);
}

/**
 * Verifies that independent voice consent exists for the specified phone number.
 * Strictly forbids relying on WhatsApp consent to authorize voice calls.
 */
export async function verifyIndependentVoiceConsent(params: {
  consentRepository: ConsentRepository;
  phoneNumber: string;
  evaluatedAt?: string;
}): Promise<ConsentRecord> {
  const normalized = normalizePhoneNumber(params.phoneNumber);
  if (!normalized) {
    throw new VoiceTestAuthorizationError(
      "Invalid phone number format for voice consent verification.",
      "INVALID_PHONE_NUMBER"
    );
  }

  let consentRecords: ConsentRecord[] = [];
  try {
    consentRecords = await params.consentRepository.findByPhone(normalized);
  } catch {
    throw new VoiceTestAuthorizationError(
      "Failed to retrieve consent records from repository.",
      "CONSENT_REPOSITORY_ERROR"
    );
  }

  // Verify active voice consent for voice_booking
  const isActive = hasActiveConsent(consentRecords, "voice", "voice_booking");
  if (!isActive) {
    const masked = maskPhoneNumber(normalized);
    throw new VoiceTestAuthorizationError(
      `Voice consent missing: No valid voice opt-in consent record found for ${masked}. WhatsApp consent cannot authorize voice calls.`,
      "VOICE_CONSENT_MISSING"
    );
  }

  // Find the latest valid grant record
  const validVoiceConsent = consentRecords
    .filter(
      (record) =>
        record.channel === "voice" &&
        record.purpose === "voice_booking" &&
        record.granted &&
        record.eventType === "grant"
    )
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];

  if (!validVoiceConsent) {
    const masked = maskPhoneNumber(normalized);
    throw new VoiceTestAuthorizationError(
      `Voice consent missing: No valid voice opt-in consent record found for ${masked}. WhatsApp consent cannot authorize voice calls.`,
      "VOICE_CONSENT_MISSING"
    );
  }

  return validVoiceConsent;
}

/**
 * Interface for managing single-use test authorizations.
 */
export interface VoiceTestAuthorizationRegistry {
  createAuthorization(record: Omit<VoiceTestAuthorizationRecord, "status" | "consumedAt" | "consumedByAttemptId">): Promise<VoiceTestAuthorizationRecord>;
  getAuthorization(authorizationId: string): Promise<VoiceTestAuthorizationRecord | null>;
  consumeAuthorization(params: {
    authorizationId: string;
    attemptId: string;
    phoneNumber: string;
    nowMs?: number;
  }): Promise<VoiceTestAuthorizationRecord>;
  revokeAuthorization(authorizationId: string, revokedBy: string, reason: string): Promise<boolean>;
  recordAudit(audit: VoiceTestAuditRecord): Promise<void>;
}

/**
 * In-Memory single-use test authorization registry for deterministic testing.
 */
export class InMemoryVoiceTestAuthorizationRegistry implements VoiceTestAuthorizationRegistry {
  private records = new Map<string, VoiceTestAuthorizationRecord>();
  private audits: VoiceTestAuditRecord[] = [];

  async createAuthorization(
    record: Omit<VoiceTestAuthorizationRecord, "status" | "consumedAt" | "consumedByAttemptId">
  ): Promise<VoiceTestAuthorizationRecord> {
    const normalizedPhone = normalizePhoneNumber(record.authorizedPhone);
    if (!normalizedPhone) {
      throw new VoiceTestAuthorizationError(
        "Invalid phone number for test authorization.",
        "INVALID_PHONE_NUMBER"
      );
    }

    const fullRecord: VoiceTestAuthorizationRecord = {
      ...record,
      authorizedPhone: normalizedPhone,
      consumedAt: null,
      consumedByAttemptId: null,
      status: "active",
    };
    this.records.set(record.authorizationId, fullRecord);
    return { ...fullRecord };
  }

  async getAuthorization(authorizationId: string): Promise<VoiceTestAuthorizationRecord | null> {
    const found = this.records.get(authorizationId);
    return found ? { ...found } : null;
  }

  async consumeAuthorization(params: {
    authorizationId: string;
    attemptId: string;
    phoneNumber: string;
    nowMs?: number;
  }): Promise<VoiceTestAuthorizationRecord> {
    const record = this.records.get(params.authorizationId);
    if (!record) {
      throw new VoiceTestAuthorizationError(
        `Authorization '${params.authorizationId}' not found.`,
        "AUTHORIZATION_NOT_FOUND"
      );
    }

    const now = params.nowMs ?? Date.now();
    const nowIso = new Date(now).toISOString();

    // 1. Verify phone match
    const normalizedTarget = normalizePhoneNumber(params.phoneNumber);
    if (normalizedTarget !== record.authorizedPhone) {
      throw new VoiceTestAuthorizationError(
        `Authorization phone mismatch: expected ${maskPhoneNumber(record.authorizedPhone)}, got ${maskPhoneNumber(params.phoneNumber)}.`,
        "AUTHORIZATION_PHONE_MISMATCH"
      );
    }

    // 2. Verify approval status
    if (!record.approvedBy || record.approvedBy.trim().length === 0) {
      throw new VoiceTestAuthorizationError(
        `Authorization '${params.authorizationId}' lacks required staff approval.`,
        "AUTHORIZATION_NOT_APPROVED"
      );
    }

    // 3. Verify active status & expiry
    if (record.status === "revoked") {
      throw new VoiceTestAuthorizationError(
        `Authorization '${params.authorizationId}' has been revoked.`,
        "AUTHORIZATION_REVOKED"
      );
    }

    if (new Date(record.expiresAt).getTime() <= now) {
      record.status = "expired";
      throw new VoiceTestAuthorizationError(
        `Authorization '${params.authorizationId}' expired at ${record.expiresAt}.`,
        "AUTHORIZATION_EXPIRED"
      );
    }

    // 4. Single-call limit enforcement
    if (record.consumedAt !== null || record.status === "consumed") {
      throw new VoiceTestAuthorizationError(
        `Authorization '${params.authorizationId}' has already been consumed by attempt '${record.consumedByAttemptId}'. Single-call limit enforced.`,
        "AUTHORIZATION_ALREADY_CONSUMED"
      );
    }

    // Atomic claim
    record.consumedAt = nowIso;
    record.consumedByAttemptId = params.attemptId;
    record.status = "consumed";

    return { ...record };
  }

  async revokeAuthorization(
    authorizationId: string,
    revokedBy: string,
    reason: string
  ): Promise<boolean> {
    const record = this.records.get(authorizationId);
    if (!record) return false;
    record.status = "revoked";
    record.metadata = { ...record.metadata, revokedBy, revocationReason: reason };
    return true;
  }

  async recordAudit(audit: VoiceTestAuditRecord): Promise<void> {
    this.audits.push({ ...audit });
  }

  getAudits(): VoiceTestAuditRecord[] {
    return [...this.audits];
  }
}

/**
 * Firestore distributed single-use test authorization registry.
 */
export class FirestoreVoiceTestAuthorizationRegistry implements VoiceTestAuthorizationRegistry {
  private collectionName: string;

  constructor(collectionName = "voice_test_authorizations") {
    this.collectionName = collectionName;
  }

  async createAuthorization(
    record: Omit<VoiceTestAuthorizationRecord, "status" | "consumedAt" | "consumedByAttemptId">
  ): Promise<VoiceTestAuthorizationRecord> {
    const db = getAdminFirestore();
    if (!db) {
      throw new VoiceTestAuthorizationError(
        "Firestore unavailable for test authorization creation.",
        "INFRASTRUCTURE_FAILURE"
      );
    }

    const normalizedPhone = normalizePhoneNumber(record.authorizedPhone);
    if (!normalizedPhone) {
      throw new VoiceTestAuthorizationError(
        "Invalid phone number format for authorization.",
        "INVALID_PHONE_NUMBER"
      );
    }

    const docRef = db.collection(this.collectionName).doc(record.authorizationId);
    const fullRecord: VoiceTestAuthorizationRecord = {
      ...record,
      authorizedPhone: normalizedPhone,
      consumedAt: null,
      consumedByAttemptId: null,
      status: "active",
    };

    await docRef.set({
      ...fullRecord,
      expireAt: Timestamp.fromDate(new Date(record.expiresAt)),
    });

    return fullRecord;
  }

  async getAuthorization(authorizationId: string): Promise<VoiceTestAuthorizationRecord | null> {
    const db = getAdminFirestore();
    if (!db) return null;

    const doc = await db.collection(this.collectionName).doc(authorizationId).get();
    if (!doc.exists) return null;
    return doc.data() as VoiceTestAuthorizationRecord;
  }

  async consumeAuthorization(params: {
    authorizationId: string;
    attemptId: string;
    phoneNumber: string;
    nowMs?: number;
  }): Promise<VoiceTestAuthorizationRecord> {
    const db = getAdminFirestore();
    if (!db) {
      throw new VoiceTestAuthorizationError(
        "Firestore unavailable for atomic authorization consumption.",
        "INFRASTRUCTURE_FAILURE"
      );
    }

    const docRef = db.collection(this.collectionName).doc(params.authorizationId);
    const now = params.nowMs ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const normalizedTarget = normalizePhoneNumber(params.phoneNumber);

    return await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) {
        throw new VoiceTestAuthorizationError(
          `Authorization '${params.authorizationId}' not found.`,
          "AUTHORIZATION_NOT_FOUND"
        );
      }

      const record = snapshot.data() as VoiceTestAuthorizationRecord;

      if (record.authorizedPhone !== normalizedTarget) {
        throw new VoiceTestAuthorizationError(
          `Authorization phone mismatch: expected ${maskPhoneNumber(record.authorizedPhone)}, got ${maskPhoneNumber(params.phoneNumber)}.`,
          "AUTHORIZATION_PHONE_MISMATCH"
        );
      }

      if (!record.approvedBy || record.approvedBy.trim().length === 0) {
        throw new VoiceTestAuthorizationError(
          `Authorization '${params.authorizationId}' lacks required staff approval.`,
          "AUTHORIZATION_NOT_APPROVED"
        );
      }

      if (record.status === "revoked") {
        throw new VoiceTestAuthorizationError(
          `Authorization '${params.authorizationId}' has been revoked.`,
          "AUTHORIZATION_REVOKED"
        );
      }

      if (new Date(record.expiresAt).getTime() <= now) {
        transaction.update(docRef, { status: "expired" });
        throw new VoiceTestAuthorizationError(
          `Authorization '${params.authorizationId}' expired at ${record.expiresAt}.`,
          "AUTHORIZATION_EXPIRED"
        );
      }

      if (record.consumedAt !== null || record.status === "consumed") {
        throw new VoiceTestAuthorizationError(
          `Authorization '${params.authorizationId}' has already been consumed by attempt '${record.consumedByAttemptId}'. Single-call limit enforced.`,
          "AUTHORIZATION_ALREADY_CONSUMED"
        );
      }

      const updatedRecord: VoiceTestAuthorizationRecord = {
        ...record,
        consumedAt: nowIso,
        consumedByAttemptId: params.attemptId,
        status: "consumed",
      };

      transaction.update(docRef, {
        consumedAt: nowIso,
        consumedByAttemptId: params.attemptId,
        status: "consumed",
      });

      return updatedRecord;
    });
  }

  async revokeAuthorization(
    authorizationId: string,
    _revokedBy: string,
    reason: string
  ): Promise<boolean> {
    const db = getAdminFirestore();
    if (!db) return false;

    const docRef = db.collection(this.collectionName).doc(authorizationId);
    await docRef.update({
      status: "revoked",
      revocationReason: reason,
      revokedAt: new Date().toISOString(),
    });
    return true;
  }

  async recordAudit(audit: VoiceTestAuditRecord): Promise<void> {
    const db = getAdminFirestore();
    if (!db) return;

    await db.collection("voice_test_audits").doc(audit.auditId).set({
      ...audit,
      timestamp: Timestamp.fromDate(new Date(audit.timestamp)),
    });
  }
}

/**
 * Top-level validation gate that enforces all safety restrictions prior to outbound dialing.
 */
export async function validateTestDialingSafety(params: {
  phoneNumber: string;
  attemptId: string;
  testAuthorizationId?: string;
  isTestMode?: boolean;
  authorizationRegistry?: VoiceTestAuthorizationRegistry;
  consentRepository?: ConsentRepository;
  nowMs?: number;
}): Promise<{
  isAuthorized: boolean;
  authorizedRecord?: VoiceTestAuthorizationRecord;
}> {
  const normalizedPhone = normalizePhoneNumber(params.phoneNumber);
  if (!normalizedPhone) {
    throw new VoiceTestAuthorizationError(
      "Invalid destination phone number format.",
      "INVALID_PHONE_NUMBER"
    );
  }
  const maskedPhone = maskPhoneNumber(normalizedPhone);

  // 1. Emergency Safety Gate: Global Voice Booking Feature Flag
  if (!isVoiceBookingEnabled()) {
    throw new VoiceTestAuthorizationError(
      "Telephony dispatch forbidden: Voice booking is disabled by policy (VOICE_BOOKING_ENABLED=false).",
      "VOICE_BOOKING_DISABLED"
    );
  }

  const whitelist = getVoiceTestWhitelistPhones();
  const isWhitelistActive = whitelist.length > 0 || params.isTestMode === true || process.env.VOICE_TEST_MODE === "true";

  // 2. Allowlist Enforcement
  if (isWhitelistActive) {
    if (!whitelist.includes(normalizedPhone)) {
      throw new VoiceTestAuthorizationError(
        `Destination number ${maskedPhone} is not in the authorized test whitelist (VOICE_TEST_WHITELIST_PHONES).`,
        "UNAUTHORIZED_TEST_NUMBER"
      );
    }
  }

  // 3. Independent Voice Consent Verification (if repository provided)
  if (params.consentRepository) {
    await verifyIndependentVoiceConsent({
      consentRepository: params.consentRepository,
      phoneNumber: normalizedPhone,
      evaluatedAt: params.nowMs ? new Date(params.nowMs).toISOString() : undefined,
    });
  }

  // 4. Single-Call Test Authorization Consumption (if authorization provided)
  let authorizedRecord: VoiceTestAuthorizationRecord | undefined;
  if (params.testAuthorizationId && params.authorizationRegistry) {
    authorizedRecord = await params.authorizationRegistry.consumeAuthorization({
      authorizationId: params.testAuthorizationId,
      attemptId: params.attemptId,
      phoneNumber: normalizedPhone,
      nowMs: params.nowMs,
    });
  } else if (params.isTestMode === true || process.env.VOICE_TEST_MODE === "true") {
    // In strict test mode, a valid testAuthorizationId is mandatory
    throw new VoiceTestAuthorizationError(
      "Test mode requires an explicit testAuthorizationId.",
      "AUTHORIZATION_REQUIRED"
    );
  }

  return {
    isAuthorized: true,
    authorizedRecord,
  };
}
