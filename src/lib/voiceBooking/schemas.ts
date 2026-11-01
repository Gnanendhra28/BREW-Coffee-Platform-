/**
 * BREW Coffee Platform — Phase 6.2.2 Voice Booking Schemas
 * Runtime Zod validation for conversation state, booking requirements, extraction payloads,
 * messages, and sessions. Hardened with customer-clearable allowlist and staff authorization schema.
 */

import { z } from "zod";
import { PhoneNumberSchema, isValidStrictIsoUtc } from "../communication/schemas";
import { CUSTOMER_CLEARABLE_FIELDS } from "./types";

/**
 * Validates real calendar dates in YYYY-MM-DD format:
 * - Checks Gregorian calendar leap years, 30/31 day month boundaries.
 * - Rejects Feb 29 on non-leap years, Feb 30, April 31, etc.
 */
export function isValidCalendarDate(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Validates 24-hour time in HH:mm format (00:00 to 23:59).
 */
export function isValidTime24(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(val);
  return match !== null;
}

export const VoiceBookingStateSchema = z.enum([
  "created",
  "language_selected",
  "collecting_requirements",
  "details_collected",
  "quotation_presented",
  "awaiting_customer_confirmation",
  "customer_confirmed",
  "awaiting_staff_approval",
  "booking_confirmed",
  "customer_declined",
  "human_handoff",
  "cancelled",
  "failed",
]);

export const SupportedLanguageSchema = z.enum(["en", "hi", "te"]);

export const StrictIsoUtcSchema = z.string().refine(isValidStrictIsoUtc, {
  message: "Timestamp must be a valid ISO 8601 UTC string ending with 'Z' (e.g. 2026-11-01T10:00:00.000Z)",
});

export const CalendarDateSchema = z.string().refine(isValidCalendarDate, {
  message: "Event date must be a real calendar date in YYYY-MM-DD format (e.g. 2026-12-15)",
});

export const Time24Schema = z.string().refine(isValidTime24, {
  message: "Start time must be in 24-hour HH:mm format between 00:00 and 23:59",
});

export const ConfirmationIntentSchema = z.enum([
  "positive_acceptance",
  "rejection",
  "clarification_requested",
  "modification_requested",
  "ambiguous",
]);

export const CustomerClearableFieldSchema = z.enum(CUSTOMER_CLEARABLE_FIELDS);

export const StaffAuthorizationContextSchema = z.object({
  staffIdentity: z.string().trim().min(1, "Staff identity cannot be empty"),
  staffRole: z.enum(["barista", "fleet_admin", "admin"]),
  staffApprovalId: z.string().trim().min(1, "Staff approval ID cannot be empty"),
});

export const RequirementCorrectionRecordSchema = z.object({
  field: z.string().min(1),
  previousValue: z.unknown(),
  newValue: z.unknown(),
  action: z.enum(["update", "clear"]),
  timestamp: StrictIsoUtcSchema,
  source: z.string().min(1),
});

export const BookingRequirementsSchema = z.object({
  guestCount: z
    .number()
    .int()
    .min(10, "Minimum guest count is 10")
    .max(1000, "Maximum guest count is 1000")
    .nullable(),
  eventDate: CalendarDateSchema.nullable(),
  startTime: Time24Schema.nullable(),
  durationHours: z
    .number()
    .min(1, "Minimum duration is 1 hour")
    .max(12, "Maximum duration is 12 hours")
    .nullable(),
  venueAddress: z
    .string()
    .trim()
    .min(3, "Venue address must be at least 3 characters")
    .nullable(),
  eventType: z.string().trim().nullable(),
  beveragePreferences: z.array(z.string().trim()),
  selectedTier: z.enum(["BASIC", "STANDARD", "PREMIUM"]).nullable(),
  handoffRequested: z.boolean(),
  customerConfirmed: z.boolean(),
  confidenceScore: z.number().min(0).max(1),
  missingFields: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  corrections: z.array(RequirementCorrectionRecordSchema).optional().default([]),
});

/**
 * Strict schema for Gemini model extraction output.
 * Rejects unexpected properties, enforces calendar correctness, bounds, and typed enums.
 * Rejects clearing of protected internal fields.
 */
export const GeminiExtractionOutputSchema = z
  .object({
    guestCount: z
      .number()
      .int()
      .min(10, "Minimum guest count is 10")
      .max(1000, "Maximum guest count is 1000")
      .nullable(),
    eventDate: CalendarDateSchema.nullable(),
    startTime: Time24Schema.nullable(),
    durationHours: z.number().min(1).max(12).nullable(),
    venueAddress: z.string().trim().min(3).nullable(),
    eventType: z.string().trim().nullable(),
    beveragePreferences: z.array(z.string().trim()),
    selectedTier: z.enum(["BASIC", "STANDARD", "PREMIUM"]).nullable(),
    handoffRequested: z.boolean(),
    customerConfirmed: z.boolean(),
    confirmationIntent: ConfirmationIntentSchema.nullable().default(null),
    confidenceScore: z.number().min(0).max(1).optional().default(1.0),
    clearedFields: z.array(CustomerClearableFieldSchema).optional().default([]),
  })
  .strict();

export const ConversationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  language: SupportedLanguageSchema,
  timestamp: StrictIsoUtcSchema,
});

export const QuotationMaterialSnapshotSchema = z.object({
  guestCount: z.number().int().min(10, "Minimum guest count is 10").max(1000, "Maximum guest count is 1000"),
  eventDate: CalendarDateSchema,
  startTime: Time24Schema,
  durationHours: z.number().min(1, "Minimum duration is 1 hour").max(12, "Maximum duration is 12 hours"),
  venueAddress: z.string().trim().min(3, "Venue address must be at least 3 characters"),
  selectedTier: z.enum(["BASIC", "STANDARD", "PREMIUM"]).nullable(),
  eventType: z.string().trim().nullable(),
  hash: z.string().min(1),
  generatedAt: StrictIsoUtcSchema,
});

export const VoiceBookingSessionSchema = z.object({
  id: z.string().min(1),
  phoneNumber: PhoneNumberSchema,
  language: SupportedLanguageSchema,
  state: VoiceBookingStateSchema,
  requirements: BookingRequirementsSchema,
  quotation: z.any().nullable(),
  quotationSnapshot: QuotationMaterialSnapshotSchema.nullable().optional().default(null),
  conversationHistory: z.array(ConversationMessageSchema),
  createdAt: StrictIsoUtcSchema,
  updatedAt: StrictIsoUtcSchema,
  staffApprovalId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
