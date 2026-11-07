/**
 * BREW Coffee Platform — Phase 6.6.1 Voice Call Attempt Foundation Schemas
 *
 * Zod validation schemas for provider-independent voice call attempts.
 */

import { z } from "zod";

export const VoiceCallAttemptStatusSchema = z.enum([
  "initiated",
  "ringing",
  "answered",
  "in_progress",
  "completed",
  "busy",
  "no_answer",
  "failed",
  "cancelled",
]);

export const VoiceCallInitiationStateSchema = z.enum([
  "pending",
  "in_flight",
  "accepted",
  "uncertain",
  "rejected",
]);

export const TerminalConflictRecordSchema = z.object({
  conflictingStatus: VoiceCallAttemptStatusSchema,
  receivedAt: z.string().datetime(),
  reason: z.string().min(1),
  rawProviderMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const VoiceCallAttemptRecordSchema = z.object({
  id: z.string().min(1),
  deliveryId: z.string().min(1),
  sessionId: z.string().min(1),
  phoneNumberMasked: z.string().min(1),
  channel: z.literal("voice"),
  provider: z.string().min(1),
  direction: z.literal("outbound"),
  status: VoiceCallAttemptStatusSchema,
  statusRank: z.number().int().min(1).max(5),
  isTerminal: z.boolean(),
  initiationState: VoiceCallInitiationStateSchema,
  claimOwner: z.string().nullable().optional(),
  claimToken: z.string().nullable().optional(),
  leaseExpiresAt: z.string().datetime().nullable().optional(),
  uncertainAt: z.string().datetime().nullable().optional(),
  uncertainReason: z.string().nullable().optional(),
  terminalConflict: TerminalConflictRecordSchema.nullable().optional(),
  providerCallId: z.string().nullable(),
  initiatedAt: z.string().datetime(),
  ringingAt: z.string().datetime().nullable().optional(),
  answeredAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  durationSeconds: z.number().int().min(0).nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  rawProviderMetadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CreateVoiceCallAttemptParamsSchema = z.object({
  id: z.string().min(1),
  deliveryId: z.string().min(1),
  sessionId: z.string().min(1),
  phoneNumberMasked: z.string().min(1),
  provider: z.string().min(1),
  providerCallId: z.string().nullable().optional(),
  claimOwner: z.string().nullable().optional(),
  claimToken: z.string().nullable().optional(),
  leaseExpiresAt: z.string().datetime().nullable().optional(),
  initiationState: VoiceCallInitiationStateSchema.optional(),
  initiatedAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateVoiceCallAttemptStatusParamsSchema = z.object({
  status: VoiceCallAttemptStatusSchema,
  timestamp: z.string().datetime().optional(),
  durationSeconds: z.number().int().min(0).nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  rawProviderMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const CorrelateWebhookParamsSchema = z.object({
  attemptId: z.string().min(1),
  providerCallId: z.string().min(1),
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  status: VoiceCallAttemptStatusSchema,
  timestamp: z.string().datetime().optional(),
  durationSeconds: z.number().int().min(0).nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  rawProviderMetadata: z.record(z.string(), z.unknown()).optional(),
});
