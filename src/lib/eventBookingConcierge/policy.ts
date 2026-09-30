// Policy, Idempotency & State Machine Engine for Agent 4: 🎪 Event Booking Concierge

import { QuoteStatus, BookingStatus } from "./types";

// Master Idempotency Registry: key -> record
const IDEMPOTENCY_REGISTRY = new Map<string, any>();

// Master Resource Schedule Registry: dateSlot -> bookingId
// e.g. "2026-10-15:MORNING" or "2026-10-15:AFTERNOON" or "2026-10-15:ALL_DAY"
const RESERVED_SCHEDULE_SLOTS = new Map<string, string>();

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
export function isBookingActionDuplicate(key: string): { isDuplicate: boolean; existingRecord?: any } {
  if (IDEMPOTENCY_REGISTRY.has(key)) {
    return { isDuplicate: true, existingRecord: IDEMPOTENCY_REGISTRY.get(key) };
  }
  return { isDuplicate: false };
}

/**
 * Registers an executed action under an idempotency key.
 */
export function registerIdempotentAction(key: string, record: any): void {
  IDEMPOTENCY_REGISTRY.set(key, record);
}

/**
 * Checks if a specific date and time slot is available for van reservation.
 */
export function checkSlotAvailability(eventDate: string, timeSlot: string): {
  isAvailable: boolean;
  conflictingBookingId?: string;
} {
  const slotKey = `${eventDate}:${timeSlot}`;
  if (RESERVED_SCHEDULE_SLOTS.has(slotKey)) {
    return {
      isAvailable: false,
      conflictingBookingId: RESERVED_SCHEDULE_SLOTS.get(slotKey),
    };
  }
  return { isAvailable: true };
}

/**
 * Reserves a date and time slot atomically.
 */
export function reserveSlot(eventDate: string, timeSlot: string, bookingId: string): boolean {
  const slotKey = `${eventDate}:${timeSlot}`;
  if (RESERVED_SCHEDULE_SLOTS.has(slotKey)) {
    return false; // Already reserved
  }
  RESERVED_SCHEDULE_SLOTS.set(slotKey, bookingId);
  return true;
}

/**
 * Releases a reserved slot (e.g. on cancellation).
 */
export function releaseSlot(eventDate: string, timeSlot: string): void {
  const slotKey = `${eventDate}:${timeSlot}`;
  RESERVED_SCHEDULE_SLOTS.delete(slotKey);
}

/**
 * Clears registry (used in test isolation).
 */
export function clearPolicyRegistries(): void {
  IDEMPOTENCY_REGISTRY.clear();
  RESERVED_SCHEDULE_SLOTS.clear();
}
