/**
 * BREW Coffee Platform — Phase 6.1.1 Communication Schemas
 * Runtime validation for phone numbers, consent events, DND multi-scope records, and provider payloads.
 */

import { z } from "zod";

/**
 * Standard E.164 phone number format:
 * Begins with '+', followed by 1 to 3 digit country code and 7 to 14 digit subscriber number.
 */
export const PhoneNumberSchema = z
  .string()
  .trim()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "Phone number must be a valid E.164 formatted string (e.g. +919876543210)"
  );

export const CommunicationChannelSchema = z.enum(["voice", "whatsapp"]);

export const CommunicationPurposeSchema = z.enum([
  "voice_booking",
  "transactional_update",
  "marketing",
]);

export const ConsentEventTypeSchema = z.enum(["grant", "revoke"]);

/**
 * Validates strictly formatted ISO 8601 UTC date-time string:
 * - Format: YYYY-MM-DDTHH:mm:ss.sssZ or YYYY-MM-DDTHH:mm:ssZ (must end strictly in 'Z').
 * - Rejects date-only strings, offsets (+05:30, -04:00), missing timezones.
 * - Rejects invalid calendar dates (Feb 30, April 31, non-leap Feb 29).
 * - Rejects invalid time units (hours > 23, minutes > 59, seconds > 59).
 */
export function isValidStrictIsoUtc(val: unknown): val is string {
  if (!val || typeof val !== "string") return false;

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(val);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);
  const msStr = match[7] || "0";
  const ms = parseInt(msStr.padEnd(3, "0"), 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59 || ms > 999) return false;

  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (isNaN(d.getTime())) return false;

  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second
  );
}

export const IsoUtcDateTimeSchema = z.string().refine(
  isValidStrictIsoUtc,
  "Timestamp must be a strictly valid ISO 8601 UTC date-time string ending in 'Z' (e.g. 2026-11-01T10:00:00.000Z)"
);

export const ConsentRecordSchema = z.object({
  id: z.string().min(8, "Consent ID must be at least 8 characters"),
  phoneNumber: PhoneNumberSchema,
  channel: CommunicationChannelSchema,
  purpose: CommunicationPurposeSchema,
  eventType: ConsentEventTypeSchema,
  granted: z.boolean(),
  consentText: z.string().min(1, "Consent text is required"),
  consentVersion: z.string().min(1, "Consent version is required"),
  timestamp: IsoUtcDateTimeSchema,
  enquiryId: z.string().optional(),
  reason: z.string().optional(),
  revokedAt: IsoUtcDateTimeSchema.optional(),
  revocationReason: z.string().optional(),
});

export const DndScopeSchema = z.enum(["all", "voice", "whatsapp"]);

export const DndSourceSchema = z.enum(["voice", "whatsapp", "web", "manual"]);

export const DndRecordSchema = z.object({
  id: z.string().min(6),
  phoneNumber: PhoneNumberSchema,
  scope: DndScopeSchema,
  reason: z.string().min(3),
  createdAt: IsoUtcDateTimeSchema,
  sourceChannel: DndSourceSchema.optional(),
});

export const DndAuditEventSchema = z.object({
  id: z.string().min(6),
  action: z.enum(["REGISTER_DND", "REMOVE_DND"]),
  phoneNumberMasked: z.string().min(6),
  scope: DndScopeSchema,
  reason: z.string().min(1),
  justification: z.string().optional(),
  performedBy: z.string().optional(),
  timestamp: IsoUtcDateTimeSchema,
});

export const PolicyEvaluationRequestSchema = z.object({
  phoneNumber: PhoneNumberSchema,
  channel: CommunicationChannelSchema,
  purpose: CommunicationPurposeSchema,
  enquiryId: z.string().optional(),
  currentTime: z.date().optional(),
});

export const VoiceLanguageSchema = z.enum(["en", "hi", "te"]);

export const VoiceSessionParamsSchema = z.object({
  sessionId: z.string().min(5),
  phoneNumber: PhoneNumberSchema,
  language: VoiceLanguageSchema,
  enquiryId: z.string().optional(),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  testAuthorizationId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const WhatsAppTemplateParameterSchema = z.object({
  type: z.enum(["text", "currency", "date_time", "document"]),
  text: z.string().optional(),
  document: z
    .object({
      link: z.string().url(),
      filename: z.string().optional(),
    })
    .optional(),
});

export const WhatsAppTemplateComponentSchema = z.object({
  type: z.enum(["header", "body", "button"]),
  subType: z.enum(["url", "quick_reply"]).optional(),
  index: z.number().int().min(0).optional(),
  parameters: z.array(WhatsAppTemplateParameterSchema).default([]),
});

export const WhatsAppTemplateParamsSchema = z.object({
  to: PhoneNumberSchema,
  templateName: z.string().min(3),
  language: z.string().min(2),
  components: z.array(WhatsAppTemplateComponentSchema).default([]),
  enquiryId: z.string().optional(),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/* ========================================================================== */
/* Outbox & Transactional Delivery Schemas (Phase 6.3.3)                       */
/* ========================================================================== */

export const BookingLifecycleEventTypeSchema = z.enum([
  "booking_created",
  "booking_awaiting_staff_approval",
  "booking_confirmed",
  "booking_declined",
  "booking_cancelled",
  "booking_human_handoff",
  "booking_reminder",
]);

export const DeliveryStatusSchema = z.enum([
  "pending",
  "processing",
  "dispatched",
  "blocked",
  "failed",
  "permanently_failed",
]);

export const CommunicationDeliveryRecordSchema = z.object({
  id: z.string().min(8),
  eventId: z.string().min(8),
  sessionId: z.string().min(5),
  officialBookingId: z.string().optional(),
  eventType: BookingLifecycleEventTypeSchema,
  channel: CommunicationChannelSchema,
  purpose: z.literal("transactional_update"),
  status: DeliveryStatusSchema,
  phoneNumberMasked: z.string().min(6),
  templateName: z.string().optional(),
  templateLanguage: z.string().optional(),
  templateParams: z.record(z.string(), z.unknown()).optional(),
  attemptCount: z.number().int().min(0),
  callAttemptCount: z.number().int().min(0).optional(),
  currentAttemptId: z.string().nullable().optional(),
  maxAttempts: z.number().int().default(3),
  claimOwner: z.string().nullable().optional(),
  claimToken: z.string().nullable().optional(),
  claimedAt: IsoUtcDateTimeSchema.nullable().optional(),
  leaseExpiresAt: IsoUtcDateTimeSchema.nullable().optional(),
  nextRetryAt: IsoUtcDateTimeSchema.nullable().optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      message: z.string(),
      isRetryable: z.boolean(),
      occurredAt: IsoUtcDateTimeSchema,
      attempt: z.number().int().optional(),
    })
    .nullable()
    .optional(),
  policyResult: z
    .object({
      status: z.enum(["allowed", "blocked", "error"]),
      reason: z.string(),
      details: z.string(),
      evaluatedAt: IsoUtcDateTimeSchema,
    })
    .nullable()
    .optional(),
  providerResult: z
    .object({
      providerCallId: z.string().optional(),
      providerMessageId: z.string().optional(),
      status: z.string(),
      callOutcome: z.enum(["answered", "no_answer", "busy", "failed"]).optional(),
      isSimulated: z.boolean(),
      providerMode: z.string(),
      completedAt: IsoUtcDateTimeSchema,
    })
    .nullable()
    .optional(),
  createdAt: IsoUtcDateTimeSchema,
  updatedAt: IsoUtcDateTimeSchema,
}).superRefine((data, ctx) => {
  if (data.status === "processing") {
    if (
      !data.claimToken ||
      typeof data.claimToken !== "string" ||
      data.claimToken.trim().length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claimToken"],
        message:
          "A non-empty claimToken is required whenever delivery status is 'processing'",
      });
    }
  }
});

export const OutboxEventRecordSchema = z.object({
  id: z.string().min(8),
  sessionId: z.string().min(5),
  officialBookingId: z.string().optional(),
  eventType: BookingLifecycleEventTypeSchema,
  sessionRevision: z.number().int().min(1),
  deliveryIds: z.array(z.string().min(8)),
  createdAt: IsoUtcDateTimeSchema,
});
