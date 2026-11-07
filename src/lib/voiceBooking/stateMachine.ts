/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking State Machine
 * Deterministic 13-state conversation lifecycle manager and transition validator.
 * Enforces human-in-the-loop safeguards: customer confirmation CANNOT bypass staff approval.
 */

import { VoiceBookingState, BookingRequirements } from "./types";

export const MANDATORY_REQUIREMENT_FIELDS: Array<keyof BookingRequirements> = [
  "guestCount",
  "eventDate",
  "startTime",
  "durationHours",
  "venueAddress",
];

export const VALID_TRANSITIONS: Record<VoiceBookingState, VoiceBookingState[]> = {
  created: [
    "language_selected",
    "collecting_requirements",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  language_selected: [
    "collecting_requirements",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  collecting_requirements: [
    "collecting_requirements",
    "details_collected",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  details_collected: [
    "quotation_presented",
    "collecting_requirements",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  quotation_presented: [
    "awaiting_customer_confirmation",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  awaiting_customer_confirmation: [
    "customer_confirmed",
    "customer_declined",
    "collecting_requirements",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  // CRITICAL SAFEGUARD: customer_confirmed can ONLY transition to awaiting_staff_approval (or exit paths)
  // Direct jump to booking_confirmed is strictly forbidden!
  customer_confirmed: [
    "awaiting_staff_approval",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  awaiting_staff_approval: [
    "booking_confirmed",
    "customer_declined",
    "human_handoff",
    "cancelled",
    "failed",
  ],
  booking_confirmed: [],
  customer_declined: [],
  human_handoff: [],
  cancelled: [],
  failed: [],
};

/**
 * Checks if a transition between two states is structurally permitted.
 */
export function canTransition(current: VoiceBookingState, next: VoiceBookingState): boolean {
  const allowed = VALID_TRANSITIONS[current] || [];
  return allowed.includes(next);
}

/**
 * Calculates which mandatory booking fields are still missing.
 */
export function getMissingMandatoryFields(requirements: BookingRequirements): string[] {
  const missing: string[] = [];
  if (requirements.guestCount === null || requirements.guestCount === undefined) {
    missing.push("guestCount");
  }
  if (!requirements.eventDate) {
    missing.push("eventDate");
  }
  if (!requirements.startTime) {
    missing.push("startTime");
  }
  if (requirements.durationHours === null || requirements.durationHours === undefined) {
    missing.push("durationHours");
  }
  if (!requirements.venueAddress || requirements.venueAddress.trim().length === 0) {
    missing.push("venueAddress");
  }
  return missing;
}

export interface TransitionContext {
  requirements?: BookingRequirements;
  staffApprovalId?: string | null;
}

/**
 * Validates and executes a state transition, enforcing domain invariants.
 * Throws an Error if transition is invalid or requirements are missing.
 */
export function transitionVoiceBookingState(
  current: VoiceBookingState,
  next: VoiceBookingState,
  context?: TransitionContext
): VoiceBookingState {
  if (current === next && current === "collecting_requirements") {
    return current;
  }

  if (!canTransition(current, next)) {
    throw new Error(
      `Illegal VoiceBookingState transition: Cannot transition from '${current}' to '${next}'.`
    );
  }

  // Invariant 1: Transitioning to 'details_collected' requires all mandatory fields to be resolved.
  if (next === "details_collected") {
    if (!context?.requirements) {
      throw new Error("Cannot transition to 'details_collected' without requirements context.");
    }
    const missing = getMissingMandatoryFields(context.requirements);
    if (missing.length > 0) {
      throw new Error(
        `Cannot transition to 'details_collected': missing mandatory fields [${missing.join(", ")}].`
      );
    }
  }

  // Invariant 2: Transitioning to 'booking_confirmed' requires a valid staffApprovalId.
  if (next === "booking_confirmed") {
    if (!context?.staffApprovalId || context.staffApprovalId.trim().length === 0) {
      throw new Error(
        "Cannot transition to 'booking_confirmed' without an authorized staffApprovalId."
      );
    }
  }

  return next;
}
