/**
 * BREW Coffee Platform — Phase 6.1 Communication Policy Engine
 * Evaluates feature flags, consent grants, DND suppression, and calling-hour policies.
 */

import {
  ConsentRecord,
  DndRecord,
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
} from "./types";
import { isVoiceBookingEnabled, maskPhoneNumber } from "./config";
import { normalizePhoneNumber, hasActiveConsent } from "./consent";
import { isChannelBlockedByDnd } from "./dnd";

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
 * Evaluates whether an outbound communication can be dispatched.
 * 
 * Checks in sequence:
 * 1. Feature Flag: Must be explicitly enabled (VOICE_BOOKING_ENABLED=true).
 * 2. Phone Validity: Must normalize to E.164.
 * 3. Do-Not-Contact (DND): Must not be blocked by an active DND entry.
 * 4. Consent: Must have active, unrevoked consent for the exact (channel, purpose).
 * 5. Calling Hours: Applies ONLY to voice calls in Asia/Kolkata (09:00 - 20:00 IST).
 */
export function evaluateCommunicationPolicy(
  request: PolicyEvaluationRequest,
  context: {
    consentRecords: ConsentRecord[];
    dndRecord?: DndRecord | null;
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
  if (isChannelBlockedByDnd(context.dndRecord, request.channel)) {
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
    // Check if customer explicitly opted out/revoked
    const matchingRecords = context.consentRecords.filter(
      (r) => r.channel === request.channel && r.purpose === request.purpose
    );
    const wasRevoked = matchingRecords.some((r) => r.revokedAt);

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
