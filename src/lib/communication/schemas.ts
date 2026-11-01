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
 * Validates ISO 8601 UTC date-time string, explicitly rejecting invalid or unparseable timestamps.
 */
export const IsoUtcDateTimeSchema = z.string().refine((val) => {
  if (!val || typeof val !== "string") return false;
  const time = Date.parse(val);
  return !isNaN(time);
}, "Timestamp must be a valid parseable ISO 8601 date string");

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
  metadata: z.record(z.string(), z.unknown()).optional(),
});
