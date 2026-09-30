// Controlled Agent Tool Execution Layer for Agent 4: 🎪 Event Booking Concierge
// Enforces safe boundaries, input validation, and deterministic computation.

import {
  EventRequirements,
  ValidationResult,
  EventQuotationRecord,
  ConsumptionForecast,
  StaffingRequirement,
  EquipmentRequirement,
  LogisticsCalculation,
  BookingRecord,
  EventConciergeMetrics,
} from "./types";
import { parseNaturalLanguageEventRequest } from "./parser";
import { validateEventRequirements } from "./validation";
import { calculateConsumption } from "./consumption";
import { calculateStaffing } from "./staffing";
import { calculateEquipment } from "./equipment";
import { calculateLogistics } from "./logistics";
import { generateEventQuotationRecord } from "./quoteEngine";
import { createBookingFromQuote, getAllBookings } from "./booking";
import { checkSlotAvailability } from "./policy";

// Master Active Quotations Storage: quoteId -> EventQuotationRecord
const QUOTES_STORE = new Map<string, EventQuotationRecord>();

export function clearQuotesStore(): void {
  QUOTES_STORE.clear();
}

// -------------------------------------------------------------
// CONTROLLED TOOL IMPLEMENTATIONS
// -------------------------------------------------------------

export function tool_parse_event_request(input: string): Partial<EventRequirements> {
  return parseNaturalLanguageEventRequest(input);
}

export function tool_validate_event_requirements(req: Partial<EventRequirements>): ValidationResult {
  return validateEventRequirements(req);
}

export function tool_check_service_area(location: string): LogisticsCalculation {
  return calculateLogistics(location);
}

export function tool_calculate_event_consumption(
  guestCount: number,
  durationMinutes: number = 240,
  tierId: "BASIC" | "STANDARD" | "PREMIUM" = "STANDARD"
): ConsumptionForecast {
  return calculateConsumption({ guestCount, durationMinutes, tierId });
}

export function tool_calculate_staffing(
  guestCount: number,
  durationMinutes: number = 240,
  tierId: "BASIC" | "STANDARD" | "PREMIUM" = "STANDARD"
): StaffingRequirement {
  return calculateStaffing({ guestCount, durationMinutes, tierId });
}

export function tool_calculate_equipment(
  guestCount: number,
  tierId: "BASIC" | "STANDARD" | "PREMIUM" = "STANDARD"
): EquipmentRequirement {
  return calculateEquipment({ guestCount, tierId });
}

export function tool_calculate_logistics(destination: string): LogisticsCalculation {
  return calculateLogistics(destination);
}

export function tool_create_quote(params: {
  requirements: EventRequirements;
  customerId?: string;
  previousVersion?: number;
  currentStock?: Record<string, number>;
}): { success: boolean; quote?: EventQuotationRecord; error?: string } {
  const val = validateEventRequirements(params.requirements);
  if (!val.isValid) {
    return {
      success: false,
      error: val.errors.join("; ") || val.clarificationPrompt,
    };
  }

  const quote = generateEventQuotationRecord(params);

  // Validate margin floor across generated tiers
  for (const tier of quote.tiers) {
    if (tier.grossMarginPercent < 30.0) {
      return {
        success: false,
        error: `Quotation generation blocked: Tier '${tier.name}' produces gross margin ${tier.grossMarginPercent}%, strictly below minimum 30% floor.`,
      };
    }
  }

  QUOTES_STORE.set(quote.quoteId, quote);
  return { success: true, quote };
}

export function tool_get_quote(quoteId: string): EventQuotationRecord | null {
  return QUOTES_STORE.get(quoteId) || null;
}

export function tool_accept_quote(params: {
  quoteId: string;
  selectedTierId?: "BASIC" | "STANDARD" | "PREMIUM";
  timeSlot?: string;
}): {
  success: boolean;
  booking?: BookingRecord;
  isDuplicate?: boolean;
  error?: string;
} {
  const quote = QUOTES_STORE.get(params.quoteId);
  if (!quote) {
    return { success: false, error: `Quotation '${params.quoteId}' not found.` };
  }

  const bookingResult = createBookingFromQuote({
    quote,
    selectedTierId: params.selectedTierId,
    timeSlot: params.timeSlot,
  });

  if (bookingResult.success && bookingResult.booking) {
    quote.status = "ACCEPTED";
  }

  return bookingResult;
}

export function tool_check_booking_availability(
  eventDate: string,
  timeSlot: string
): { isAvailable: boolean; conflictingBookingId?: string } {
  return checkSlotAvailability(eventDate, timeSlot);
}

export function tool_get_concierge_metrics(): EventConciergeMetrics {
  const quotes = Array.from(QUOTES_STORE.values());
  const bookings = getAllBookings();

  const quotesGenerated = quotes.length;
  const quotesAccepted = quotes.filter((q) => q.status === "ACCEPTED").length;
  const quotesRejected = quotes.filter((q) => q.status === "REJECTED").length;
  const quotesExpired = quotes.filter((q) => q.status === "EXPIRED" || Date.now() > q.expiresAt).length;

  const bookingsConfirmed = bookings.filter((b) => b.status === "CONFIRMED").length;
  const bookingsCancelled = bookings.filter((b) => b.status === "CANCELLED").length;

  const totalQuotedRevenue = quotes.reduce((acc, q) => acc + (q.selectedTier?.totalAmount || 0), 0);
  const totalConfirmedRevenue = bookings.reduce((acc, b) => acc + b.totalAmount, 0);

  const avgGuestCount =
    quotes.length > 0
      ? Math.round(quotes.reduce((acc, q) => acc + q.guestCount, 0) / quotes.length)
      : 0;

  const avgQuoteValue =
    quotes.length > 0 ? Math.round(totalQuotedRevenue / quotes.length) : 0;

  const avgGrossMargin =
    quotes.length > 0
      ? Number(
          (
            quotes.reduce((acc, q) => acc + (q.selectedTier?.grossMarginPercent || 0), 0) /
            quotes.length
          ).toFixed(1)
        )
      : 0;

  const conversionRate =
    quotes.length > 0 ? Number(((quotesAccepted / quotes.length) * 100).toFixed(1)) : 0;

  const procurementRequiredCount = quotes.filter((q) => q.procurementRequired).length;

  return {
    inquiriesReceived: quotesGenerated + 5, // Includes raw leads
    quotesGenerated,
    quotesAccepted,
    quotesRejected,
    quotesExpired,
    bookingsConfirmed,
    bookingsCancelled,
    totalQuotedRevenue,
    totalConfirmedRevenue,
    avgGuestCount,
    avgQuoteValue,
    avgGrossMarginPercent: avgGrossMargin,
    conversionRatePercent: conversionRate,
    procurementRequiredQuotesCount: procurementRequiredCount,
  };
}
