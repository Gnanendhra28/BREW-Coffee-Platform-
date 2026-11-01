/**
 * BREW Coffee Platform — Phase 6.1.1 Communication Policy Engine
 * Evaluates feature flags, consent grants, DND multi-scope suppression, and calling-hour policies.
 * Provides both pure functional rule evaluation and secure server-side orchestration boundaries.
 */

import {
  ConsentRecord,
  ConsentRepository,
  DndRecord,
  DndRepository,
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
} from "./types";
import { isVoiceBookingEnabled, maskPhoneNumber } from "./config";
import { normalizePhoneNumber, hasActiveConsent } from "./consent";
import { isChannelBlockedByDnd, isChannelBlockedByDndScopes } from "./dnd";

export const CALLING_HOURS_TIMEZONE = "Asia/Kolkata";
export const CALLING_HOURS_START_HOUR = 9; // 09:00:00 IST
export const CALLING_HOURS_END_HOUR = 20; // 20:00:00 IST (Calls must initiate before 20:00:00)

/**
 * Extracts current time in Asia/Kolkata timezone independent of host server environment.
 */
export function getIstTimeParts(date: Date): {
  hour: number;
  minute: number;
  second: number;
  totalSeconds: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CALLING_HOURS_TIMEZONE,
    hour12: false,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

  const parts = formatter.formatToParts(date);
  let hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const second = parseInt(parts.find((p) => p.type === "second")?.value || "0", 10);

  return {
    hour,
    minute,
    second,
    totalSeconds: hour * 3600 + minute * 60 + second,
  };
}

/**
 * Checks whether the given date/time falls within authorized voice calling hours (09:00 - 20:00 IST).
 * 
 * Boundary conditions:
 * - 08:59:59 IST -> false (Outside window)
 * - 09:00:00 IST -> true (Window opens)
 * - 19:59:59 IST -> true (Window active)
 * - 20:00:00 IST -> false (Window closed cutoff)
 * - 20:00:01 IST -> false (Outside window)
 */
export function isWithinCallingHours(date: Date = new Date()): boolean {
  const { totalSeconds } = getIstTimeParts(date);
  const startSeconds = CALLING_HOURS_START_HOUR * 3600;
  const endSeconds = CALLING_HOURS_END_HOUR * 3600;

  return totalSeconds >= startSeconds && totalSeconds < endSeconds;
}

export interface PolicyEvaluationOptions {
  checkFeatureFlag?: boolean; // Defaults to true
}

/**
 * Pure evaluation function checking whether an outbound communication can be dispatched.
 * Receives pre-loaded records for direct unit testing of policy rules.
 */
export function evaluateCommunicationPolicy(
  request: PolicyEvaluationRequest,
  context: {
    consentRecords: ConsentRecord[];
    dndRecord?: DndRecord | null;
    activeDndScopes?: DndRecord[];
  },
  options: PolicyEvaluationOptions = {}
): PolicyEvaluationResult {
  const evaluatedAt = (request.currentTime || new Date()).toISOString();
  const shouldCheckFlag = options.checkFeatureFlag !== false;

  // 1. Feature Flag Check
  if (shouldCheckFlag && !isVoiceBookingEnabled()) {
    return {
      status: "blocked",
      reason: "FEATURE_DISABLED",
      details: "Voice booking and outbound communication is disabled via feature flag.",
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(request.phoneNumber),
    };
  }

  // 2. Phone Number Normalization
  const normalizedPhone = normalizePhoneNumber(request.phoneNumber);
  if (!normalizedPhone) {
    return {
      status: "blocked",
      reason: "INVALID_PHONE_NUMBER",
      details: "The provided phone number is invalid or cannot be normalized to E.164.",
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(request.phoneNumber),
    };
  }

  // 3. Do-Not-Contact (DND) Check
  const dndBlocked = context.activeDndScopes
    ? isChannelBlockedByDndScopes(context.activeDndScopes, request.channel)
    : isChannelBlockedByDnd(context.dndRecord, request.channel);

  if (dndBlocked) {
    return {
      status: "blocked",
      reason: "DND_ACTIVE",
      details: `Outbound ${request.channel} communication is suppressed by active DND registration.`,
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(normalizedPhone),
    };
  }

  // 4. Consent Evaluation
  const hasConsent = hasActiveConsent(
    context.consentRecords,
    request.channel,
    request.purpose
  );

  if (!hasConsent) {
    const matchingRecords = context.consentRecords.filter(
      (r) => r.channel === request.channel && r.purpose === request.purpose
    );
    const wasRevoked = matchingRecords.some(
      (r) => r.eventType === "revoke" || r.revokedAt || !r.granted
    );

    if (wasRevoked) {
      return {
        status: "blocked",
        reason: "CONSENT_REVOKED",
        details: `Customer has explicitly revoked consent for ${request.channel} ${request.purpose}.`,
        evaluatedAt,
        channel: request.channel,
        purpose: request.purpose,
        phoneNumberMasked: maskPhoneNumber(normalizedPhone),
      };
    }

    if (request.purpose === "marketing") {
      return {
        status: "blocked",
        reason: "MARKETING_CONSENT_REQUIRED",
        details: "Marketing communications require explicit, unbundled marketing consent.",
        evaluatedAt,
        channel: request.channel,
        purpose: request.purpose,
        phoneNumberMasked: maskPhoneNumber(normalizedPhone),
      };
    }

    return {
      status: "blocked",
      reason: "CONSENT_MISSING",
      details: `No active consent record found for ${request.channel} ${request.purpose}.`,
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(normalizedPhone),
    };
  }

  // 5. Calling-Hour Boundaries (Voice ONLY)
  if (request.channel === "voice") {
    const evalTime = request.currentTime || new Date();
    if (!isWithinCallingHours(evalTime)) {
      return {
        status: "blocked",
        reason: "OUTSIDE_CALLING_HOURS",
        details: "Voice calls are restricted to 09:00 - 20:00 IST in accordance with calling-hour policy.",
        evaluatedAt,
        channel: request.channel,
        purpose: request.purpose,
        phoneNumberMasked: maskPhoneNumber(normalizedPhone),
      };
    }
  }

  // 6. Policy Allowed
  return {
    status: "allowed",
    reason: "ALLOWED",
    details: "All communication policies, consent records, and timing constraints are satisfied.",
    evaluatedAt,
    channel: request.channel,
    purpose: request.purpose,
    phoneNumberMasked: maskPhoneNumber(normalizedPhone),
  };
}

/**
 * Secure Server-Side Orchestration Boundary
 * 
 * Responsibilities:
 * 1. Normalizes the incoming phone number.
 * 2. Loads consent history from repository using the normalized number.
 * 3. Loads all active DND scopes from repository using the normalized number.
 * 4. Verifies data integrity: checks that returned records match the requested phone number.
 * 5. Evaluates policy (feature flag, DND, consent, calling hours).
 * 6. Returns structured decision without calling any external provider.
 */
export async function orchestrateCommunicationPolicy(
  request: PolicyEvaluationRequest,
  dependencies: {
    consentRepository: ConsentRepository;
    dndRepository: DndRepository;
  },
  options: PolicyEvaluationOptions = {}
): Promise<PolicyEvaluationResult> {
  const evaluatedAt = (request.currentTime || new Date()).toISOString();

  // 1. Feature Flag Check
  if (options.checkFeatureFlag !== false && !isVoiceBookingEnabled()) {
    return {
      status: "blocked",
      reason: "FEATURE_DISABLED",
      details: "Voice booking and outbound communication is disabled via feature flag.",
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(request.phoneNumber),
    };
  }

  // 2. Normalize Phone Number
  const normalizedPhone = normalizePhoneNumber(request.phoneNumber);
  if (!normalizedPhone) {
    return {
      status: "blocked",
      reason: "INVALID_PHONE_NUMBER",
      details: "The provided phone number is invalid or cannot be normalized to E.164.",
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(request.phoneNumber),
    };
  }

  // 3. Load DND Scopes from Repository
  let activeDndScopes: DndRecord[] = [];
  try {
    activeDndScopes = await dependencies.dndRepository.findActiveScopes(normalizedPhone);
  } catch (err) {
    return {
      status: "blocked",
      reason: "REPOSITORY_INTEGRITY_MISMATCH",
      details: `Failed to retrieve DND records from repository: ${err instanceof Error ? err.message : String(err)}`,
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(normalizedPhone),
    };
  }

  // Security Check: Verify repository phone number integrity
  const dndPhoneMismatch = activeDndScopes.some((r) => r.phoneNumber !== normalizedPhone);
  if (dndPhoneMismatch) {
    return {
      status: "blocked",
      reason: "REPOSITORY_INTEGRITY_MISMATCH",
      details: "Security violation: DND repository returned records belonging to a different phone number.",
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(normalizedPhone),
    };
  }

  // 4. Load Consent Events from Repository
  let consentEvents: ConsentRecord[] = [];
  try {
    consentEvents = await dependencies.consentRepository.findByPhone(normalizedPhone);
  } catch (err) {
    return {
      status: "blocked",
      reason: "REPOSITORY_INTEGRITY_MISMATCH",
      details: `Failed to retrieve consent records from repository: ${err instanceof Error ? err.message : String(err)}`,
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(normalizedPhone),
    };
  }

  // Security Check: Verify consent repository phone number integrity
  const consentPhoneMismatch = consentEvents.some((r) => r.phoneNumber !== normalizedPhone);
  if (consentPhoneMismatch) {
    return {
      status: "blocked",
      reason: "REPOSITORY_INTEGRITY_MISMATCH",
      details: "Security violation: Consent repository returned records belonging to a different phone number.",
      evaluatedAt,
      channel: request.channel,
      purpose: request.purpose,
      phoneNumberMasked: maskPhoneNumber(normalizedPhone),
    };
  }

  // 5. Evaluate pure policy with authoritative repository data
  return evaluateCommunicationPolicy(
    request,
    {
      consentRecords: consentEvents,
      activeDndScopes,
    },
    options
  );
}
