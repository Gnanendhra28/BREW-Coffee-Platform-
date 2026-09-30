// Booking Execution Engine for Agent 4: 🎪 Event Booking Concierge
// Converts accepted quotations into confirmed calendar bookings with double-booking prevention.

import {
  EventQuotationRecord,
  BookingRecord,
} from "./types";
import {
  generateBookingIdempotencyKey,
  isBookingActionDuplicate,
  registerIdempotentAction,
  checkSlotAvailability,
  reserveSlot,
} from "./policy";

// Master Active Bookings Registry: bookingId -> BookingRecord
const BOOKINGS_STORE = new Map<string, BookingRecord>();

/**
 * Creates a confirmed booking from an approved quotation with atomic resource reservation.
 */
export function createBookingFromQuote(params: {
  quote: EventQuotationRecord;
  selectedTierId?: "BASIC" | "STANDARD" | "PREMIUM";
  timeSlot?: string;
  notes?: string;
}): {
  success: boolean;
  booking?: BookingRecord;
  isDuplicate?: boolean;
  error?: string;
} {
  const { quote } = params;
  const tierId = params.selectedTierId || quote.selectedTier?.tierId || "STANDARD";
  const selectedTier = quote.tiers.find((t) => t.tierId === tierId) || quote.tiers[1];

  // 1. Expiration Check
  if (Date.now() > quote.expiresAt) {
    return {
      success: false,
      error: `Quotation '${quote.versionId}' expired at ${new Date(
        quote.expiresAt
      ).toISOString()}. Please generate a fresh quotation.`,
    };
  }

  // 2. Status Validation
  if (quote.status === "EXPIRED" || quote.status === "CANCELLED" || quote.status === "REJECTED") {
    return {
      success: false,
      error: `Cannot accept quotation currently in terminal '${quote.status}' status.`,
    };
  }

  // 3. Idempotency Check
  const idempotencyKey = generateBookingIdempotencyKey(
    quote.customerId,
    quote.quoteId,
    quote.quoteVersion,
    tierId
  );

  const dupCheck = isBookingActionDuplicate<BookingRecord>(idempotencyKey);
  if (dupCheck.isDuplicate && dupCheck.existingRecord) {
    return {
      success: true,
      booking: dupCheck.existingRecord,
      isDuplicate: true,
    };
  }

  // 4. Double-Booking & Resource Availability Check
  const timeSlot = params.timeSlot || `${quote.startTime}-${quote.endTime}`;
  const slotAvailability = checkSlotAvailability(quote.eventDate, timeSlot);

  if (!slotAvailability.isAvailable) {
    return {
      success: false,
      error: `Resource collision: The date slot '${quote.eventDate} (${timeSlot})' is already booked by reservation #${slotAvailability.conflictingBookingId}.`,
    };
  }

  // 5. Atomic Reservation
  const bookingId = `book-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const reserved = reserveSlot(quote.eventDate, timeSlot, bookingId);
  if (!reserved) {
    return {
      success: false,
      error: `Failed to reserve slot '${quote.eventDate} (${timeSlot})' due to simultaneous booking race condition.`,
    };
  }

  // 6. Construct Confirmed Booking Record
  const booking: BookingRecord = {
    bookingId,
    quoteId: quote.quoteId,
    quoteVersion: quote.quoteVersion,
    versionId: quote.versionId,
    customerId: quote.customerId,
    organization: quote.organization,
    eventDate: quote.eventDate,
    startTime: quote.startTime,
    endTime: quote.endTime,
    timeSlot,
    selectedTier,
    guestCount: quote.guestCount,
    location: quote.location,
    status: "CONFIRMED",
    assignedBaristas: Array.from(
      { length: selectedTier.staffAssigned },
      (_, i) => `Barista-Lead-${i + 1}`
    ),
    allocatedEquipment: [
      "Van Espresso Station #1",
      ...(quote.guestCount > 200 ? ["Van Espresso Station #2"] : []),
      "Commercial Microfoam Steamer",
    ],
    totalAmount: selectedTier.totalAmount,
    paymentStatus: "PENDING", // Crucial: Never mark paid without actual payment gateway webhook!
    createdAt: Date.now(),
    confirmedAt: Date.now(),
    idempotencyKey,
  };

  quote.status = "ACCEPTED";
  registerIdempotentAction(idempotencyKey, booking);
  BOOKINGS_STORE.set(bookingId, booking);

  return {
    success: true,
    booking,
  };
}

export function getBookingById(bookingId: string): BookingRecord | null {
  return BOOKINGS_STORE.get(bookingId) || null;
}

export function getAllBookings(): BookingRecord[] {
  return Array.from(BOOKINGS_STORE.values());
}

export function clearBookingsStore(): void {
  BOOKINGS_STORE.clear();
}
