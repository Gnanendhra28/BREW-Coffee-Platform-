// Policy, Idempotency & State Machine Engine for Agent 4: 🎪 Event Booking Concierge

import { QuoteStatus, BookingStatus } from "./types";

// Master Idempotency Registry: key -> record
const IDEMPOTENCY_REGISTRY = new Map<string, unknown>();

// Master Resource Schedule Registry: dateSlot -> bookingId
// e.g. "2026-10-15:MORNING" or "2026-10-15:AFTERNOON" or "2026-10-15:ALL_DAY"
const RESERVED_SCHEDULE_SLOTS = new Map<string, string>();

export interface ScheduleIntervalEntry {
  bookingId: string;
  timeSlot: string;
  startMinutes: number;
  endMinutes: number;
  source?: string;
}

// Master Resource Schedule Interval Registry: eventDate -> list of booked intervals
const RESERVED_SCHEDULE_INTERVALS = new Map<string, ScheduleIntervalEntry[]>();

/**
 * Parses a standard time slot string ("HH:mm-HH:mm") into start and end minute offsets.
 * Validates 24h format and enforces that endMinutes > startMinutes and does not exceed 1440.
 */
export function parseTimeSlot(timeSlot: string): { startMinutes: number; endMinutes: number } | null {
  if (!timeSlot || typeof timeSlot !== "string") return null;
  const match = timeSlot.trim().match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const startH = parseInt(match[1], 10);
  const startM = parseInt(match[2], 10);
  const endH = parseInt(match[3], 10);
  const endM = parseInt(match[4], 10);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (endMinutes <= startMinutes || endMinutes > 24 * 60) return null;
  return { startMinutes, endMinutes };
}

/**
 * Checks whether two time slot intervals overlap.
 * Returns true if and only if: startA < endB and startB < endA.
 */
export function areTimeSlotsOverlapping(slotA: string, slotB: string): boolean {
  if (slotA.trim() === slotB.trim()) return true;
  const parsedA = parseTimeSlot(slotA);
  const parsedB = parseTimeSlot(slotB);
  if (!parsedA || !parsedB) {
    // If not standard HH:mm-HH:mm, fall back to exact equality
    return slotA.trim().toUpperCase() === slotB.trim().toUpperCase();
  }
  return parsedA.startMinutes < parsedB.endMinutes && parsedB.startMinutes < parsedA.endMinutes;
}

const VALID_QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["CALCULATING", "CANCELLED"],
  CALCULATING: ["READY", "CANCELLED"],
  READY: ["SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  SENT: ["VIEWED", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  VIEWED: ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

const VALID_BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PAYMENT_PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Validates state transitions for quotations.
 */
export function isValidQuoteTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  const allowed = VALID_QUOTE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Validates state transitions for bookings.
 */
export function isValidBookingTransition(from: BookingStatus, to: BookingStatus): boolean {
  const allowed = VALID_BOOKING_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Generates an idempotency key for booking confirmation.
 */
export function generateBookingIdempotencyKey(
  customerId: string,
  quoteId: string,
  quoteVersion: number,
  tierId: string
): string {
  return `${customerId}:${quoteId}:V${quoteVersion}:${tierId}:BOOKING_CONFIRM`;
}

/**
 * Checks if an operation with this idempotency key has already been executed.
 */
export function isBookingActionDuplicate<T = unknown>(key: string): { isDuplicate: boolean; existingRecord?: T } {
  if (IDEMPOTENCY_REGISTRY.has(key)) {
    return { isDuplicate: true, existingRecord: IDEMPOTENCY_REGISTRY.get(key) as T };
  }
  return { isDuplicate: false };
}

/**
 * Registers an executed action under an idempotency key.
 */
export function registerIdempotentAction<T = unknown>(key: string, record: T): void {
  IDEMPOTENCY_REGISTRY.set(key, record);
}

/**
 * Checks if a specific date and time slot is available for van reservation.
 * Enforces both exact slot-key matches and overlapping interval conflicts on the same date.
 */
export function checkSlotAvailability(eventDate: string, timeSlot: string): {
  isAvailable: boolean;
  conflictingBookingId?: string;
} {
  const cleanDate = eventDate.trim();
  const cleanSlot = timeSlot.trim();
  const slotKey = `${cleanDate}:${cleanSlot}`;

  // 1. Direct exact-slot check
  if (RESERVED_SCHEDULE_SLOTS.has(slotKey)) {
    return {
      isAvailable: false,
      conflictingBookingId: RESERVED_SCHEDULE_SLOTS.get(slotKey),
    };
  }

  // 2. Interval overlap check across all reservations on the same date
  const parsed = parseTimeSlot(cleanSlot);
  if (parsed) {
    const intervals = RESERVED_SCHEDULE_INTERVALS.get(cleanDate) || [];
    for (const entry of intervals) {
      if (parsed.startMinutes < entry.endMinutes && entry.startMinutes < parsed.endMinutes) {
        return {
          isAvailable: false,
          conflictingBookingId: entry.bookingId,
        };
      }
    }
  }

  return { isAvailable: true };
}

/**
 * Reserves a date and time slot atomically in the local in-memory registry.
 * Registers both the exact slot string and interval bounds for overlap detection.
 */
export function reserveSlot(
  eventDate: string,
  timeSlot: string,
  bookingId: string,
  source?: "voice_booking" | "manual_request" | string
): boolean {
  const cleanDate = eventDate.trim();
  const cleanSlot = timeSlot.trim();
  const slotKey = `${cleanDate}:${cleanSlot}`;

  const availability = checkSlotAvailability(cleanDate, cleanSlot);
  if (!availability.isAvailable) {
    return false; // Already reserved or overlapping
  }

  RESERVED_SCHEDULE_SLOTS.set(slotKey, bookingId);

  const parsed = parseTimeSlot(cleanSlot);
  if (parsed) {
    const intervals = RESERVED_SCHEDULE_INTERVALS.get(cleanDate) || [];
    intervals.push({
      bookingId,
      timeSlot: cleanSlot,
      startMinutes: parsed.startMinutes,
      endMinutes: parsed.endMinutes,
      source,
    });
    RESERVED_SCHEDULE_INTERVALS.set(cleanDate, intervals);
  }

  return true;
}

/**
 * Releases a reserved slot (e.g. on cancellation).
 */
export function releaseSlot(eventDate: string, timeSlot: string): void {
  const cleanDate = eventDate.trim();
  const cleanSlot = timeSlot.trim();
  const slotKey = `${cleanDate}:${cleanSlot}`;
  RESERVED_SCHEDULE_SLOTS.delete(slotKey);

  const intervals = RESERVED_SCHEDULE_INTERVALS.get(cleanDate);
  if (intervals) {
    const updated = intervals.filter((i) => i.timeSlot !== cleanSlot);
    if (updated.length > 0) {
      RESERVED_SCHEDULE_INTERVALS.set(cleanDate, updated);
    } else {
      RESERVED_SCHEDULE_INTERVALS.delete(cleanDate);
    }
  }
}

/**
 * Clears registry (used in test isolation).
 */
export function clearPolicyRegistries(): void {
  IDEMPOTENCY_REGISTRY.clear();
  RESERVED_SCHEDULE_SLOTS.clear();
  RESERVED_SCHEDULE_INTERVALS.clear();
}
