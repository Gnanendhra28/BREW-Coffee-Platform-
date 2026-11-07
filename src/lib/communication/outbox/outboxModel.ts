/**
 * BREW Coffee Platform — Phase 6.3.3 Communication Outbox Model & Helpers
 * Deterministic identity generators and transition delivery record construction.
 */

import {
  BookingLifecycleEventType,
  CommunicationChannel,
  CommunicationDeliveryRecord,
} from "../types";
import { CommunicationDeliveryRecordSchema } from "../schemas";
import { VoiceBookingSession } from "../../voiceBooking/types";
import { maskPhoneNumber } from "../config";
import { computeOfficialVanRequestId } from "../../voiceBooking/vanRequestBridge";

/**
 * Deterministically computes an outbox event ID from lifecycle event type, session ID, and revision.
 * Format: evt_{eventType}_{sessionId}_r{revision}
 */
export function computeOutboxEventId(
  eventType: BookingLifecycleEventType,
  sessionId: string,
  revision: number
): string {
  const sanitizedType = eventType.replace(/[^a-zA-Z0-9_]/g, "_");
  const sanitizedSession = sessionId.replace(/[^a-zA-Z0-9_]/g, "_");
  return `evt_${sanitizedType}_${sanitizedSession}_r${revision}`;
}

/**
 * Deterministically computes a channel delivery ID from event ID and channel.
 * Format: del_{eventId}_{channel}
 */
export function computeOutboxDeliveryId(
  eventId: string,
  channel: CommunicationChannel
): string {
  return `del_${eventId}_${channel}`;
}

/**
 * Resolves the effective logical call attempt count for a delivery record.
 * Distinguishes genuine provider call attempts from concurrency lease claims.
 * For legacy records where callAttemptCount is missing, cleanly falls back to attemptCount
 * to guarantee attempts remain strictly bounded rather than silently granting unlimited retries.
 */
export function getEffectiveCallAttemptCount(record: {
  callAttemptCount?: number;
  attemptCount: number;
}): number {
  return typeof record.callAttemptCount === "number"
    ? record.callAttemptCount
    : (record.attemptCount || 0);
}

/**
 * Maps a voice booking session state to its corresponding outbox lifecycle event type.
 * Returns null if the state is intermediate/non-notifying.
 */
export function mapSessionStateToOutboxEvent(
  state: VoiceBookingSession["state"]
): BookingLifecycleEventType | null {
  switch (state) {
    case "created":
      return "booking_created";
    case "awaiting_staff_approval":
      return "booking_awaiting_staff_approval";
    case "booking_confirmed":
      return "booking_confirmed";
    case "customer_declined":
      return "booking_declined";
    case "cancelled":
      return "booking_cancelled";
    case "human_handoff":
      return "booking_human_handoff";
    default:
      return null;
  }
}

/**
 * Constructs validated, deterministic communication delivery records for a session state transition.
 *
 * Channel Distribution:
 * - booking_created                 -> [voice] (initiates outbound AI requirement gathering call)
 * - booking_awaiting_staff_approval -> [whatsapp]
 * - booking_confirmed               -> [whatsapp, voice] (independent delivery records)
 * - booking_declined                -> [whatsapp]
 * - booking_cancelled               -> [whatsapp]
 * - booking_human_handoff           -> [whatsapp]
 */
export function createOutboxDeliveriesForTransition(
  session: VoiceBookingSession,
  nowIso?: string
): CommunicationDeliveryRecord[] {
  const eventType = mapSessionStateToOutboxEvent(session.state);
  if (!eventType) {
    return [];
  }

  const timestamp = nowIso || new Date().toISOString();
  const eventId = computeOutboxEventId(eventType, session.id, session.revision);
  const officialBookingId =
    session.officialBookingId || computeOfficialVanRequestId(session.id);
  const maskedPhone = maskPhoneNumber(session.phoneNumber);

  const channels: CommunicationChannel[] =
    eventType === "booking_created"
      ? ["voice"]
      : eventType === "booking_confirmed"
      ? ["whatsapp", "voice"]
      : ["whatsapp"];

  return channels.map((channel) => {
    const deliveryId = computeOutboxDeliveryId(eventId, channel);

    const templateName =
      channel === "whatsapp"
        ? eventType === "booking_confirmed"
          ? "booking_confirmed_v1"
          : eventType === "booking_awaiting_staff_approval"
          ? "booking_under_review_v1"
          : eventType === "booking_cancelled"
          ? "booking_cancelled_v1"
          : eventType === "booking_declined"
          ? "booking_declined_v1"
          : eventType === "booking_reminder"
          ? "booking_reminder_v1"
          : "booking_handoff_v1"
        : undefined;

    const deliveryRecord: CommunicationDeliveryRecord = {
      id: deliveryId,
      eventId,
      sessionId: session.id,
      officialBookingId,
      eventType,
      channel,
      purpose: "transactional_update",
      status: "pending",
      phoneNumberMasked: maskedPhone,
      templateName,
      templateLanguage: session.language,
      templateParams: {
        bookingId: officialBookingId,
        eventDate: session.requirements.eventDate || "",
        guestCount: session.requirements.guestCount || 0,
        location: session.requirements.venueAddress || "",
        venueAddress: session.requirements.venueAddress || "",
        tierName: session.requirements.selectedTier || session.quotation?.selectedTier || "",
        startTime: session.requirements.startTime || "",
        status: session.state,
      },
      attemptCount: 0,
      callAttemptCount: 0,
      currentAttemptId: null,
      maxAttempts: 3,
      claimOwner: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      lastError: null,
      policyResult: null,
      providerResult: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return CommunicationDeliveryRecordSchema.parse(deliveryRecord);
  });
}

/**
 * Constructs an outbox delivery record specifically for an upcoming event reminder.
 */
export function createReminderDeliveryForSession(
  session: VoiceBookingSession,
  nowIso?: string
): CommunicationDeliveryRecord {
  const timestamp = nowIso || new Date().toISOString();
  const eventId = computeOutboxEventId("booking_reminder", session.id, session.revision);
  const deliveryId = computeOutboxDeliveryId(eventId, "whatsapp");
  const officialBookingId = session.officialBookingId || computeOfficialVanRequestId(session.id);
  const maskedPhone = maskPhoneNumber(session.phoneNumber);

  const deliveryRecord: CommunicationDeliveryRecord = {
    id: deliveryId,
    eventId,
    sessionId: session.id,
    officialBookingId,
    eventType: "booking_reminder",
    channel: "whatsapp",
    purpose: "transactional_update",
    status: "pending",
    phoneNumberMasked: maskedPhone,
    templateName: "booking_reminder_v1",
    templateLanguage: session.language,
    templateParams: {
      bookingId: officialBookingId,
      eventDate: session.requirements.eventDate || "",
      guestCount: session.requirements.guestCount || 0,
      startTime: session.requirements.startTime || "",
      venueAddress: session.requirements.venueAddress || "",
      location: session.requirements.venueAddress || "",
    },
    attemptCount: 0,
    callAttemptCount: 0,
    currentAttemptId: null,
    maxAttempts: 3,
    claimOwner: null,
    claimToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    nextRetryAt: null,
    lastError: null,
    policyResult: null,
    providerResult: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return CommunicationDeliveryRecordSchema.parse(deliveryRecord);
}
