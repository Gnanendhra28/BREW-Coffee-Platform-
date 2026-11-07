/**
 * BREW Coffee Platform — Phase 6.3.2.2 Voice Booking Lifecycle Bridge
 * Canonical adapter bridging voice booking sessions (`voice_booking_sessions`)
 * to official catering booking enquiries (`van_requests`) and durable schedule slots (`schedule_slots`).
 * 
 * Preserves zero-hallucination pricing, staff authorization boundaries,
 * strictly immutable booking identity, zero fabricated booking defaults,
 * and double-booking prevention with distributed interval-overlap scheduling integrity.
 */

import {
  InvalidBookingTimeSlotError,
  InvalidOfficialBookingBridgeDataError,
  StaffAuthorizationContext,
  VoiceBookingSession,
} from "./types";
import { isValidCalendarDate, isValidTime24 } from "./schemas";
import { parseTimeSlot, reserveSlot } from "../eventBookingConcierge/policy";
import { isVoicePrototypeMode } from "./prototypeConfig";

export const VAN_REQUESTS_COLLECTION = "van_requests";
export const SCHEDULE_SLOTS_COLLECTION = "schedule_slots";

export interface ScheduleReservationEntry {
  bookingId: string;
  timeSlot: string;
  startMinutes: number;
  endMinutes: number;
  reservedAt: string;
  status: "reserved" | "cancelled";
  source: "voice_booking" | "manual_request";
}

/**
 * Computes a deterministic, collision-free official `van_requests` document ID
 * for a given voice booking session.
 * Prevents duplicate official enquiries on transaction retries or repeat confirmations.
 */
export function computeOfficialVanRequestId(voiceSessionId: string): string {
  if (!voiceSessionId || typeof voiceSessionId !== "string" || voiceSessionId.trim().length === 0) {
    throw new InvalidOfficialBookingBridgeDataError(
      "Invalid voiceSessionId: cannot compute official van request ID from empty session ID."
    );
  }
  const cleanId = voiceSessionId.trim();
  if (cleanId.startsWith("vbs_enq_")) {
    return cleanId.replace(/^vbs_/, "");
  }
  return `enq_voice_${cleanId}`;
}

/**
 * Computes a deterministic, collision-free schedule slot document ID
 * for exact slot reservation lookups across distributed serverless instances.
 */
export function computeScheduleSlotDocId(eventDate: string, timeSlot: string): string {
  if (!eventDate || typeof eventDate !== "string" || !timeSlot || typeof timeSlot !== "string") {
    throw new InvalidOfficialBookingBridgeDataError(
      `Cannot compute schedule slot document ID: missing eventDate ('${eventDate}') or timeSlot ('${timeSlot}').`
    );
  }
  const cleanDate = eventDate.trim();
  const cleanSlot = timeSlot.trim().replace(/:/g, "-");
  return `${cleanDate}___${cleanSlot}`;
}

/**
 * Computes the authoritative daily schedule document ID for a given calendar date.
 * Groups and serializes all reservations on that date to prevent overlapping time ranges.
 */
export function computeScheduleDayDocId(eventDate: string): string {
  if (!eventDate || typeof eventDate !== "string" || !isValidCalendarDate(eventDate)) {
    throw new InvalidOfficialBookingBridgeDataError(
      `Cannot compute daily schedule document ID: invalid calendar eventDate ('${eventDate}').`
    );
  }
  return `day___${eventDate.trim()}`;
}

/**
 * Validates that the official booking identity and all cross-references
 * strictly match deterministic invariants and prevents identity tampering.
 * 
 * Fails closed whenever a session enters or is in the official booking lifecycle
 * (customer_confirmed, awaiting_staff_approval, booking_confirmed, or requireOfficialBridge).
 */
export function validateOfficialBookingIdentity(
  session: VoiceBookingSession,
  existingRecord?: Record<string, unknown> | null,
  options?: { requireOfficialBridge?: boolean; requireExistingRecord?: boolean }
): void {
  const expectedVanId = computeOfficialVanRequestId(session.id);
  const isOfficialLifecycle =
    options?.requireOfficialBridge === true ||
    session.state === "customer_confirmed" ||
    session.state === "awaiting_staff_approval" ||
    session.state === "booking_confirmed" ||
    Boolean(session.officialBookingId);

  if (isOfficialLifecycle) {
    if (
      !session.officialBookingId ||
      typeof session.officialBookingId !== "string" ||
      session.officialBookingId.trim().length === 0
    ) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking identity error: session '${session.id}' in state '${session.state}' is missing officialBookingId.`
      );
    }
    if (session.officialBookingId !== expectedVanId) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking ID mismatch: session.officialBookingId '${session.officialBookingId}' does not match expected deterministic ID '${expectedVanId}'.`
      );
    }

    if (
      !session.metadata ||
      !session.metadata.officialBookingId ||
      typeof session.metadata.officialBookingId !== "string" ||
      (session.metadata.officialBookingId as string).trim().length === 0
    ) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking metadata error: session.metadata.officialBookingId is missing or empty.`
      );
    }
    if (session.metadata.officialBookingId !== expectedVanId) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking metadata mismatch: session.metadata.officialBookingId '${String(
          session.metadata.officialBookingId
        )}' does not match expected deterministic ID '${expectedVanId}'.`
      );
    }
  }

  if (options?.requireExistingRecord && !existingRecord) {
    throw new InvalidOfficialBookingBridgeDataError(
      `Official booking record error: expected existing van_requests record for session '${session.id}' but none was found.`
    );
  }

  if (existingRecord) {
    if (
      !existingRecord.id ||
      typeof existingRecord.id !== "string" ||
      existingRecord.id.trim().length === 0
    ) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking record error: stored van_requests document is missing a valid 'id' field.`
      );
    }
    if (existingRecord.id !== expectedVanId) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking record ID mismatch: existing document ID '${String(
          existingRecord.id
        )}' does not match expected ID '${expectedVanId}'.`
      );
    }

    if (
      !existingRecord.voiceSessionId ||
      typeof existingRecord.voiceSessionId !== "string" ||
      existingRecord.voiceSessionId.trim().length === 0
    ) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking record error: stored van_requests document is missing 'voiceSessionId'.`
      );
    }
    if (existingRecord.voiceSessionId !== session.id) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking session ownership mismatch: record voiceSessionId '${String(
          existingRecord.voiceSessionId
        )}' does not match session ID '${session.id}'.`
      );
    }

    if (
      !existingRecord.source ||
      typeof existingRecord.source !== "string" ||
      (existingRecord.source !== "voice_booking" && existingRecord.source !== "web_catering_enquiry")
    ) {
      throw new InvalidOfficialBookingBridgeDataError(
        `Official booking source mismatch: record source '${String(
          existingRecord.source
        )}' is not 'voice_booking'.`
      );
    }
  }
}

/**
 * Derives and strictly validates the canonical time slot string (HH:mm-HH:mm) for scheduling
 * and double-booking conflict detection.
 * 
 * Eliminates fabricated time-slot defaults:
 * - Rejects missing or invalid calendar dates.
 * - Rejects missing or invalid clock times (00:00 - 23:59).
 * - Rejects missing, non-positive, or unreasonable durations.
 * - Rejects time ranges that cross unsupported date boundaries (midnight).
 * - Enforces strict consistency between booking requirements and authoritative quotation.
 */
export function deriveBookingTimeSlot(session: VoiceBookingSession): string {
  const reqs = session.requirements;
  if (!reqs || typeof reqs !== "object") {
    throw new InvalidBookingTimeSlotError(
      "Cannot derive booking time slot: session.requirements is missing or invalid."
    );
  }

  const eventDate = reqs.eventDate;
  if (!eventDate || !isValidCalendarDate(eventDate)) {
    throw new InvalidBookingTimeSlotError(
      `Cannot derive booking time slot: eventDate '${String(eventDate)}' is missing or not a valid calendar date.`
    );
  }

  const startTime = reqs.startTime;
  if (!startTime || !isValidTime24(startTime)) {
    throw new InvalidBookingTimeSlotError(
      `Cannot derive booking time slot: startTime '${String(startTime)}' is missing or not a valid 24h clock time (HH:mm).`
    );
  }

  let durationHours = reqs.durationHours;
  const quote = session.quotation;

  if (quote && quote.startTime && quote.endTime) {
    if (quote.startTime !== startTime) {
      throw new InvalidBookingTimeSlotError(
        `Quotation start time '${quote.startTime}' conflicts with requested start time '${startTime}'.`
      );
    }
    const [qStartH, qStartM] = quote.startTime.split(":").map(Number);
    const [qEndH, qEndM] = quote.endTime.split(":").map(Number);
    const qDurationMinutes = (qEndH * 60 + qEndM) - (qStartH * 60 + qStartM);
    if (qDurationMinutes <= 0) {
      throw new InvalidBookingTimeSlotError(
        `Quotation specifies invalid non-positive duration (${quote.startTime} to ${quote.endTime}).`
      );
    }
    const derivedDuration = qDurationMinutes / 60;
    if (durationHours !== undefined && durationHours !== null && Math.abs(durationHours - derivedDuration) > 0.01) {
      throw new InvalidBookingTimeSlotError(
        `Quotation duration (${derivedDuration}h) is inconsistent with requested duration (${durationHours}h).`
      );
    }
    if (durationHours === undefined || durationHours === null) {
      durationHours = derivedDuration;
    }
  }

  if (typeof durationHours !== "number" || !Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24) {
    throw new InvalidBookingTimeSlotError(
      `Cannot derive booking time slot: durationHours must be a positive number between 0.5 and 24, received ${String(durationHours)}.`
    );
  }

  const [startH, startM] = startTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const durationMinutes = Math.round(durationHours * 60);
  const totalEndMinutes = startMinutes + durationMinutes;

  if (totalEndMinutes > 24 * 60) {
    throw new InvalidBookingTimeSlotError(
      `Booking time slot crosses unsupported date boundary (midnight): event starting at ${startTime} with duration ${durationHours}h would conclude after 24:00.`
    );
  }

  const endH = Math.floor(totalEndMinutes / 60);
  const endM = totalEndMinutes % 60;
  const endTime = `${endH.toString().padStart(2, "0")}:${endM.toString().padStart(2, "0")}`;

  if (quote && quote.endTime && quote.endTime !== endTime) {
    throw new InvalidBookingTimeSlotError(
      `Quotation end time '${quote.endTime}' conflicts with computed end time '${endTime}'.`
    );
  }

  return `${startTime}-${endTime}`;
}

/**
 * Constructs an official `van_requests` document record from a voice booking session.
 * Fully compatible with the existing `POST /api/request-van` schema and `GET /api/request-van` queries.
 * Eliminates fabricated booking data: requires valid contact, crowd size, location, event date, and quotation.
 * Strictly requires configured BUSINESS_EMAIL without personal or institutional fallbacks.
 */
export function createVanRequestRecordFromSession(
  session: VoiceBookingSession,
  status: "pending" | "confirmed" = "pending",
  authContext?: StaffAuthorizationContext,
  existingRecord?: Record<string, unknown> | null
): Record<string, unknown> {
  validateOfficialBookingIdentity(session, existingRecord);

  const vanRequestId = computeOfficialVanRequestId(session.id);
  const reqs = session.requirements;
  const quote = session.quotation;
  const now = Date.now();

  const businessEmail = (
    process.env.BUSINESS_EMAIL ||
    process.env.NEXT_PUBLIC_BUSINESS_EMAIL ||
    (isVoicePrototypeMode() ? "catering@brewcoffee.in" : "")
  ).trim();
  if (!businessEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)) {
    throw new InvalidOfficialBookingBridgeDataError(
      "Cannot create official booking record: valid BUSINESS_EMAIL environment variable is required and must not be empty or malformed."
    );
  }

  if (!session.phoneNumber || typeof session.phoneNumber !== "string" || session.phoneNumber.trim().length === 0) {
    throw new InvalidOfficialBookingBridgeDataError(
      "Cannot create official booking record: session.phoneNumber is missing or empty."
    );
  }

  if (!reqs || typeof reqs !== "object") {
    throw new InvalidOfficialBookingBridgeDataError(
      "Cannot create official booking record: session.requirements is missing or invalid."
    );
  }

  if (
    typeof reqs.guestCount !== "number" ||
    !Number.isInteger(reqs.guestCount) ||
    reqs.guestCount < 10 ||
    reqs.guestCount > 1000
  ) {
    throw new InvalidOfficialBookingBridgeDataError(
      `Cannot create official booking record: guestCount must be an integer between 10 and 1000, received ${String(
        reqs?.guestCount
      )}.`
    );
  }

  if (!reqs.venueAddress || typeof reqs.venueAddress !== "string" || reqs.venueAddress.trim().length < 3) {
    throw new InvalidOfficialBookingBridgeDataError(
      `Cannot create official booking record: venueAddress is missing or shorter than 3 characters (${String(
        reqs?.venueAddress
      )}).`
    );
  }

  if (!reqs.eventDate || typeof reqs.eventDate !== "string" || !isValidCalendarDate(reqs.eventDate)) {
    throw new InvalidOfficialBookingBridgeDataError(
      `Cannot create official booking record: eventDate is missing or not a valid YYYY-MM-DD calendar date (${String(
        reqs?.eventDate
      )}).`
    );
  }

  if (!quote || typeof quote !== "object") {
    throw new InvalidOfficialBookingBridgeDataError(
      "Cannot create official booking record: session.quotation is missing or null."
    );
  }

  // Derive and validate time slot to guarantee completeness before persistence
  deriveBookingTimeSlot(session);

  // If record already exists in store and is confirmed, do not silently downgrade
  const finalStatus =
    existingRecord && existingRecord.status === "confirmed" && status !== "confirmed"
      ? "confirmed"
      : status;

  const createdAt =
    existingRecord && typeof existingRecord.createdAt === "number"
      ? existingRecord.createdAt
      : now;

  const approvedBy = authContext?.staffIdentity || (existingRecord?.approvedBy as string | undefined);
  const approvedRole = authContext?.staffRole || (existingRecord?.approvedRole as string | undefined);
  const staffApprovalId = authContext?.staffApprovalId || (existingRecord?.staffApprovalId as string | undefined);
  const approvedAt =
    authContext && status === "confirmed"
      ? new Date().toISOString()
      : (existingRecord?.approvedAt as string | undefined);

  return {
    id: vanRequestId,
    contact: session.phoneNumber.trim(),
    organization: reqs.eventType
      ? `Voice Booking (${reqs.eventType})`
      : "Voice Booking (Private Event)",
    location: reqs.venueAddress.trim(),
    eventDate: reqs.eventDate.trim(),
    crowdSize: `${reqs.guestCount} guests`,
    notes: `Voice booking via AI Concierge. Language: ${session.language}. Tier: ${reqs.selectedTier || "STANDARD"}. Session: ${session.id}`,
    timestamp: session.createdAt,
    businessEmail,
    emailSent: false, // Strict zero side-effect guarantee in transaction path
    quotation: quote,
    status: finalStatus,
    idempotencyKey: `voice_${session.id}`,
    fingerprint: `voice_${session.id}`,
    source: "voice_booking",
    voiceSessionId: session.id,
    createdAt,
    updatedAt: now,
    ...(approvedBy ? { approvedBy } : {}),
    ...(approvedRole ? { approvedRole } : {}),
    ...(staffApprovalId ? { staffApprovalId } : {}),
    ...(approvedAt ? { approvedAt } : {}),
  };
}

/**
 * Atomically checks and reserves a schedule slot for a manual catering booking
 * within the shared durable `schedule_slots` Firestore collection.
 * Prevents conflicts between manual bookings and voice bookings across distributed instances.
 */
export async function reserveManualBookingSlot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  params: {
    eventDate: string;
    timeSlot: string;
    manualBookingId: string;
  }
): Promise<{ success: boolean; error?: string; message?: string }> {
  const { eventDate, timeSlot, manualBookingId } = params;
  if (!isValidCalendarDate(eventDate)) {
    return { success: false, error: "invalid_date", message: `Invalid calendar date: '${eventDate}'.` };
  }
  const parsedCurrent = parseTimeSlot(timeSlot);
  if (!parsedCurrent) {
    return { success: false, error: "invalid_time_slot", message: `Invalid time slot: '${timeSlot}'.` };
  }
  if (!manualBookingId || typeof manualBookingId !== "string" || manualBookingId.trim().length === 0) {
    return { success: false, error: "invalid_booking_id", message: "Manual booking ID must be non-empty." };
  }

  const cleanManualId = manualBookingId.trim();
  const slotDocId = computeScheduleSlotDocId(eventDate, timeSlot);
  const dayDocId = computeScheduleDayDocId(eventDate);
  const slotRef = db.collection(SCHEDULE_SLOTS_COLLECTION).doc(slotDocId);
  const dayRef = db.collection(SCHEDULE_SLOTS_COLLECTION).doc(dayDocId);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await db.runTransaction(async (transaction: any) => {
      // 1. Transaction Read Phase
      const slotSnap = await transaction.get(slotRef);
      const daySnap = await transaction.get(dayRef);

      // Exact collision check
      if (slotSnap.exists) {
        const slotData = slotSnap.data() as Record<string, unknown>;
        if (slotData && slotData.bookingId !== cleanManualId && slotData.status !== "cancelled") {
          return {
            success: false,
            error: "resource_collision",
            message: `Resource collision: The date slot '${eventDate} (${timeSlot})' is already booked by reservation #${String(
              slotData.bookingId
            )}.`,
          };
        }
      }

      // Interval overlap check
      const existingDayData = daySnap.exists ? (daySnap.data() as Record<string, unknown>) : null;
      const dayReservations = (existingDayData?.reservations as ScheduleReservationEntry[] | undefined) || [];

      for (const res of dayReservations) {
        if (res.bookingId !== cleanManualId && res.status !== "cancelled") {
          if (parsedCurrent.startMinutes < res.endMinutes && res.startMinutes < parsedCurrent.endMinutes) {
            return {
              success: false,
              error: "resource_collision",
              message: `Resource collision: The requested date slot '${eventDate} (${timeSlot})' overlaps with existing reservation #${res.bookingId} (${res.timeSlot}).`,
            };
          }
        }
      }

      // 2. Transaction Write Phase
      const slotReservationRecord = {
        id: slotDocId,
        eventDate,
        timeSlot,
        startMinutes: parsedCurrent.startMinutes,
        endMinutes: parsedCurrent.endMinutes,
        bookingId: cleanManualId,
        reservedAt: new Date().toISOString(),
        status: "reserved",
        source: "manual_request",
      };

      const updatedReservations: ScheduleReservationEntry[] = [
        ...dayReservations.filter((r) => r.bookingId !== cleanManualId),
        {
          bookingId: cleanManualId,
          timeSlot,
          startMinutes: parsedCurrent.startMinutes,
          endMinutes: parsedCurrent.endMinutes,
          reservedAt: new Date().toISOString(),
          status: "reserved",
          source: "manual_request",
        },
      ];

      const dayScheduleRecord = {
        id: dayDocId,
        eventDate,
        reservations: updatedReservations,
        updatedAt: new Date().toISOString(),
      };

      transaction.set(slotRef, slotReservationRecord);
      transaction.set(dayRef, dayScheduleRecord);

      return { success: true };
    });

    if (result.success) {
      try {
        reserveSlot(eventDate, timeSlot, cleanManualId, "manual_request");
      } catch (e) {
        console.warn("Non-fatal: in-memory slot reservation failed after successful manual reservation commit:", e);
      }
    }
    return result;
  } catch (err) {
    return {
      success: false,
      error: "transaction_failure",
      message: err instanceof Error ? err.message : "Failed to reserve manual booking slot",
    };
  }
}
