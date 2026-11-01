/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking Schemas
 * Runtime Zod validation for conversation state, booking requirements, messages, and sessions.
 */

import { z } from "zod";
import { PhoneNumberSchema, isValidStrictIsoUtc } from "../communication/schemas";

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

export const BookingRequirementsSchema = z.object({
  guestCount: z
    .number()
    .int()
    .min(10, "Minimum guest count is 10")
    .max(1000, "Maximum guest count is 1000")
    .nullable(),
  eventDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Event date must be in YYYY-MM-DD format")
    .nullable(),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Start time must be in 24-hour HH:mm format")
    .nullable(),
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
});

export const ConversationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  language: SupportedLanguageSchema,
  timestamp: StrictIsoUtcSchema,
});

export const VoiceBookingSessionSchema = z.object({
  id: z.string().min(1),
  phoneNumber: PhoneNumberSchema,
  language: SupportedLanguageSchema,
  state: VoiceBookingStateSchema,
  requirements: BookingRequirementsSchema,
  quotation: z.any().nullable(),
  conversationHistory: z.array(ConversationMessageSchema),
  createdAt: StrictIsoUtcSchema,
  updatedAt: StrictIsoUtcSchema,
  staffApprovalId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
