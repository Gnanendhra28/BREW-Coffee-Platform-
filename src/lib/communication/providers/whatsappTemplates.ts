/**
 * BREW Coffee Platform — Phase 6.4 / 6.4.1 WhatsApp Standard Templates
 * 
 * Provides type-safe parameter builders for official Meta WhatsApp pre-approved
 * transactional templates:
 * 1. Booking Confirmation (`booking_confirmed_v1`): exactly 5 parameters
 *    [bookingId, eventDate, guestCount, location, tierName]
 * 2. Booking Status Updates (`booking_under_review_v1`, `booking_status_update_v1`, etc.): exactly 3 parameters
 *    [bookingId, status, details]
 * 3. Booking Event Reminders (`booking_reminder_v1`): exactly 4 parameters
 *    [bookingId, eventDate, startTime, location]
 * 
 * In accordance with Phase 6.4.1 requirements, template builders validate all authoritative
 * inputs and NEVER fabricate missing booking details.
 */

import { WhatsAppTemplateParams } from "../types";

export interface BookingConfirmationParamsInput {
  to: string;
  bookingId: string;
  eventDate: string;
  guestCount: number;
  location: string;
  tierName: string;
  language?: string;
  idempotencyKey?: string;
}

export interface BookingStatusUpdateParamsInput {
  to: string;
  bookingId: string;
  status: string;
  details: string;
  language?: string;
  idempotencyKey?: string;
}

export interface BookingReminderParamsInput {
  to: string;
  bookingId: string;
  eventDate: string;
  startTime: string;
  location: string;
  language?: string;
  idempotencyKey?: string;
}

/**
 * Builds template parameters for booking confirmation message.
 * Conforms to Meta Graph API template format with exactly 5 body parameters:
 * 1: bookingId
 * 2: eventDate
 * 3: guestCount
 * 4: location
 * 5: tierName
 */
export function buildBookingConfirmationTemplate(
  input: BookingConfirmationParamsInput
): WhatsAppTemplateParams {
  if (!input.bookingId || !input.bookingId.trim()) {
    throw new Error("Authoritative bookingId is required for booking confirmation template");
  }
  if (!input.eventDate || !input.eventDate.trim()) {
    throw new Error("Authoritative eventDate is required for booking confirmation template");
  }
  if (typeof input.guestCount !== "number" || input.guestCount <= 0 || !Number.isFinite(input.guestCount)) {
    throw new Error("Authoritative positive guestCount is required for booking confirmation template");
  }
  if (!input.location || !input.location.trim()) {
    throw new Error("Authoritative location is required for booking confirmation template");
  }
  if (!input.tierName || !input.tierName.trim()) {
    throw new Error("Authoritative tierName is required for booking confirmation template");
  }

  return {
    to: input.to,
    templateName: "booking_confirmed_v1",
    language: input.language || "en",
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: input.bookingId.trim() },
          { type: "text", text: input.eventDate.trim() },
          { type: "text", text: `${input.guestCount} Guests` },
          { type: "text", text: input.location.trim() },
          { type: "text", text: input.tierName.trim() },
        ],
      },
    ],
    enquiryId: input.bookingId.trim(),
    idempotencyKey: input.idempotencyKey,
  };
}

/**
 * Builds template parameters for booking status updates (under review, approved, modified).
 * Conforms to Meta Graph API template format with exactly 3 body parameters:
 * 1: bookingId
 * 2: status
 * 3: details
 */
export function buildBookingStatusUpdateTemplate(
  input: BookingStatusUpdateParamsInput
): WhatsAppTemplateParams {
  if (!input.bookingId || !input.bookingId.trim()) {
    throw new Error("Authoritative bookingId is required for booking status update template");
  }
  if (!input.status || !input.status.trim()) {
    throw new Error("Authoritative status is required for booking status update template");
  }
  if (!input.details || !input.details.trim()) {
    throw new Error("Authoritative details message is required for booking status update template");
  }

  return {
    to: input.to,
    templateName: "booking_status_update_v1",
    language: input.language || "en",
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: input.bookingId.trim() },
          { type: "text", text: input.status.trim() },
          { type: "text", text: input.details.trim() },
        ],
      },
    ],
    enquiryId: input.bookingId.trim(),
    idempotencyKey: input.idempotencyKey,
  };
}

/**
 * Builds template parameters for upcoming event reminders (e.g. 24h prior to dispatch).
 * Conforms to Meta Graph API template format with exactly 4 body parameters:
 * 1: bookingId
 * 2: eventDate
 * 3: startTime
 * 4: location
 */
export function buildBookingReminderTemplate(
  input: BookingReminderParamsInput
): WhatsAppTemplateParams {
  if (!input.bookingId || !input.bookingId.trim()) {
    throw new Error("Authoritative bookingId is required for booking reminder template");
  }
  if (!input.eventDate || !input.eventDate.trim()) {
    throw new Error("Authoritative eventDate is required for booking reminder template");
  }
  if (!input.startTime || !input.startTime.trim()) {
    throw new Error("Authoritative startTime is required for booking reminder template");
  }
  if (!input.location || !input.location.trim()) {
    throw new Error("Authoritative location is required for booking reminder template");
  }

  return {
    to: input.to,
    templateName: "booking_reminder_v1",
    language: input.language || "en",
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: input.bookingId.trim() },
          { type: "text", text: input.eventDate.trim() },
          { type: "text", text: input.startTime.trim() },
          { type: "text", text: input.location.trim() },
        ],
      },
    ],
    enquiryId: input.bookingId.trim(),
    idempotencyKey: input.idempotencyKey,
  };
}
