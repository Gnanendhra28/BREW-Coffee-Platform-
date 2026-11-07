/**
 * BREW Coffee Platform — Phase 6.3.4.2 Safe Customer & Staff Status Visibility
 *
 * Exposes minimal, privacy-safe status fields for voice call lifecycles.
 * Strictly guarantees that unmasked phone numbers, internal tokens, provider
 * credentials, and session payloads are never exposed to public or staff callers.
 */

import { CommunicationDeliveryRecord, MockVoiceCallOutcome } from "./types";
import { VoiceBookingSession } from "../voiceBooking/types";

export interface SafeCallAttemptStatus {
  callAttemptStatus: "pending" | "answered" | "no_answer" | "busy" | "failed" | "blocked";
  lastAttemptAt: string | null;
  attemptCount: number;
  staffFollowUpRequired: boolean;
}

/**
 * Derives a sanitized, public-safe status view of a voice booking call attempt.
 * Does not expose raw phone numbers, claim tokens, or sensitive internal data.
 */
export function extractSafeCallStatus(
  session: Pick<VoiceBookingSession, "metadata">,
  delivery?: Pick<
    CommunicationDeliveryRecord,
    "status" | "attemptCount" | "updatedAt" | "lastError" | "providerResult"
  > | null
): SafeCallAttemptStatus {
  const meta = session.metadata || {};

  const attemptCount =
    typeof meta.attemptCount === "number"
      ? meta.attemptCount
      : delivery?.attemptCount ?? 0;

  const lastAttemptAt =
    typeof meta.lastAttemptAt === "string"
      ? meta.lastAttemptAt
      : delivery?.updatedAt ?? null;

  const staffFollowUpRequired =
    typeof meta.staffFollowUpRequired === "boolean"
      ? meta.staffFollowUpRequired
      : delivery?.status === "permanently_failed";

  let callAttemptStatus: SafeCallAttemptStatus["callAttemptStatus"] = "pending";

  const outcome = (delivery?.providerResult?.callOutcome as MockVoiceCallOutcome | undefined);

  if (
    meta.callAttemptStatus === "answered" ||
    outcome === "answered" ||
    delivery?.status === "dispatched"
  ) {
    callAttemptStatus = "answered";
  } else if (meta.callAttemptStatus === "no_answer" || outcome === "no_answer") {
    callAttemptStatus = "no_answer";
  } else if (meta.callAttemptStatus === "busy" || outcome === "busy") {
    callAttemptStatus = "busy";
  } else if (
    meta.callAttemptStatus === "failed" ||
    outcome === "failed" ||
    delivery?.status === "failed" ||
    delivery?.status === "permanently_failed"
  ) {
    callAttemptStatus = "failed";
  } else if (meta.callAttemptStatus === "blocked" || delivery?.status === "blocked") {
    callAttemptStatus = "blocked";
  }

  return {
    callAttemptStatus,
    lastAttemptAt,
    attemptCount,
    staffFollowUpRequired,
  };
}

export interface SafeCustomerVoiceSessionView {
  sessionId: string;
  officialBookingId: string | null;
  state: VoiceBookingSession["state"];
  language: VoiceBookingSession["language"];
  requirements: {
    eventType: string | null;
    guestCount: number | null;
    eventDate: string | null;
    startTime: string | null;
    durationHours: number | null;
    venueAddress: string | null;
    selectedTier: string | null;
    customerConfirmed: boolean;
    missingFields: string[];
  };
  quotation: {
    eventType: string;
    estimatedGuests: number;
    guestCount?: number;
    recommendedTier: string | null;
    tiers: Array<{
      tierId: string;
      name: string;
      pricePerGuest: number;
      totalAmount: number;
      perks: string[];
      isRecommended: boolean;
      tagline?: string;
      staffAssigned?: number;
      equipmentSummary?: string;
    }>;
  } | null;
  conversationHistory: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    language: VoiceBookingSession["language"];
    timestamp: string;
  }>;
  callStatus: SafeCallAttemptStatus;
  staffApprovalStatus: "approved" | "awaiting_approval" | "pending" | "declined";
  staffApprovalAudit: {
    approvedAt: string;
    staffRole: string;
  } | null;
  customerFacingRejectionReason?: string;
  isSimulatedDemo: true;
  updatedAt: string;
}

/**
 * Transforms an authoritative VoiceBookingSession into a sanitized, safe public projection.
 * Strips raw phone numbers, claim tokens, and provider credentials.
 */
export function toSafeCustomerVoiceSessionView(
  session: VoiceBookingSession
): SafeCustomerVoiceSessionView {
  const callStatus = extractSafeCallStatus(session);

  let staffApprovalStatus: SafeCustomerVoiceSessionView["staffApprovalStatus"] = "pending";
  if (session.state === "booking_confirmed" || session.staffApprovalAudit) {
    staffApprovalStatus = "approved";
  } else if (session.state === "awaiting_staff_approval") {
    staffApprovalStatus = "awaiting_approval";
  } else if (session.state === "customer_declined" || session.state === "cancelled") {
    staffApprovalStatus = "declined";
  }

  const quotation = session.quotation
    ? {
        eventType: session.quotation.eventType,
        estimatedGuests: session.quotation.guestCount,
        guestCount: session.quotation.guestCount,
        recommendedTier: session.quotation.selectedTier?.name || null,
        tiers: (session.quotation.tiers || []).map((t) => ({
          tierId: t.tierId,
          name: t.name,
          pricePerGuest: t.pricePerGuest,
          totalAmount: t.totalAmount,
          perks: t.perks || [],
          isRecommended: Boolean(t.isRecommended),
          tagline: t.tagline,
          staffAssigned: t.staffAssigned,
          equipmentSummary: t.equipmentSummary,
        })),
      }
    : null;

  return {
    sessionId: session.id,
    officialBookingId: session.officialBookingId || null,
    state: session.state,
    language: session.language,
    requirements: {
      eventType: session.requirements.eventType,
      guestCount: session.requirements.guestCount,
      eventDate: session.requirements.eventDate,
      startTime: session.requirements.startTime,
      durationHours: session.requirements.durationHours,
      venueAddress: session.requirements.venueAddress,
      selectedTier: session.requirements.selectedTier,
      customerConfirmed: Boolean(session.requirements.customerConfirmed),
      missingFields: session.requirements.missingFields || [],
    },
    quotation,
    conversationHistory: (session.conversationHistory || []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      language: m.language,
      timestamp: m.timestamp,
    })),
    callStatus,
    staffApprovalStatus,
    staffApprovalAudit: session.staffApprovalAudit
      ? {
          approvedAt: session.staffApprovalAudit.approvedAt,
          staffRole: session.staffApprovalAudit.staffRole,
        }
      : null,
    customerFacingRejectionReason:
      typeof session.metadata?.customerFacingRejectionReason === "string"
        ? session.metadata.customerFacingRejectionReason
        : session.staffRejectionAudit?.customerFacingReason || undefined,
    isSimulatedDemo: true,
    updatedAt: session.updatedAt,
  };
}
