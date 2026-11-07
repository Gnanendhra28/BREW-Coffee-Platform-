// Zod Schema Validation & Guardrails for Autonomous AI Agents
// Prevents LLM hallucinations, enforces structured outputs, and secures agent contracts.

import { z } from "zod";

// 1. Master Customer Barista Agent Schema (/api/barista-chat)
export const BaristaChatResponseSchema = z.object({
  replyText: z.string().min(5, "Reply text must be at least 5 characters"),
  recommendedItemIds: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  quickReplies: z.array(z.string()).min(1).default([
    "Suggest a dessert pairing",
    "Something iced instead",
    "Explore Full Menu",
  ]),
});

export type BaristaChatResponse = z.infer<typeof BaristaChatResponseSchema>;

// 2. Barista & Fleet Operations Copilot Schema (/api/barista-ops-chat)
export const ParkingSpotSchema = z.object({
  id: z.string(),
  spotName: z.string(),
  city: z.string(),
  address: z.string(),
  recommendedHours: z.string().optional(),
  whyThisSpot: z.string().optional(),
  expectedFootfall: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  bestCategoryFocus: z.string().optional(),
});

export const ImprovementPlanSchema = z.object({
  focusArea: z.string(),
  summary: z.string(),
  actionItems: z.array(z.string()),
  targetMetric: z.string().optional(),
});

export const BaristaOpsChatResponseSchema = z.object({
  replyText: z.string().min(5, "Ops reply text must be at least 5 characters"),
  recommendedSpots: z.array(ParkingSpotSchema).default([]),
  improvementPlan: ImprovementPlanSchema.optional().nullable(),
  quickReplies: z.array(z.string()).default([
    "Best evening parking spot?",
    "Analyze low ratings",
    "Rain contingency plan",
  ]),
});

export type BaristaOpsChatResponse = z.infer<typeof BaristaOpsChatResponseSchema>;

// 3. Weather & Flash Deal Dynamic Surge Pricing Agent Schema
export const FlashDealSchema = z.object({
  id: z.string().default(() => `deal-${Date.now()}`),
  isActive: z.boolean().default(true),
  title: z.string().min(3),
  tagline: z.string().min(3),
  discountPercent: z.number().min(5).max(75),
  triggerReason: z.enum(["weather", "bakery_spoilage_prevention", "manual"]).default("weather"),
  beverageName: z.string(),
  pastryName: z.string(),
  originalPrice: z.number().positive(),
  dealPrice: z.number().positive(),
  expiresAt: z.number().positive(),
});

export type FlashDealOutput = z.infer<typeof FlashDealSchema>;

// 4. Autonomous Event Quoter Agent Schema
export const EventQuotationTierSchema = z.object({
  name: z.enum(["Classic Brew", "Artisanal Signature", "VIP Unlimited Bar"]),
  pricePerGuest: z.number().positive(),
  totalAmount: z.number().positive(),
  perks: z.array(z.string()),
  isRecommended: z.boolean().optional(),
});

export const EventQuotationSchema = z.object({
  organization: z.string(),
  location: z.string(),
  estimatedCrowd: z.number().int().positive(),
  baristasAssigned: z.number().int().positive(),
  vanOperationalHours: z.string(),
  powerRequirement: z.string().default("16A Single Phase (or Van Internal Silent Inverter)"),
  ingredientAllocation: z.object({
    coffeeBeansKg: z.number().positive(),
    milkLiters: z.number().positive(),
    cupsCount: z.number().int().positive(),
    pastriesCount: z.number().int().positive(),
  }),
  tiers: z.array(EventQuotationTierSchema).min(1),
  travelDistanceFee: z.number().nonnegative().default(1500),
  terms: z.string().default("Includes complete curbside bar setup, outdoor QR board, live barista service, paper cups, sleeves & napkins."),
});

export type EventQuotationOutput = z.infer<typeof EventQuotationSchema>;

import { normalizePhoneNumber } from "./communication/consent";

// 4b. Customer Van Catering Request Input Schema
export const VanRequestInputSchema = z
  .object({
    contact: z
      .string()
      .trim()
      .min(3, "Contact must be at least 3 characters")
      .max(150, "Contact must not exceed 150 characters")
      .refine((val) => {
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
        if (isEmail) return true;
        // Phone-shaped contacts must strictly normalize to E.164
        return Boolean(normalizePhoneNumber(val));
      }, "Contact must be a valid email address or a valid phone number that can be normalized to E.164"),
    phoneNumber: z
      .string()
      .trim()
      .max(30, "Phone number must not exceed 30 characters")
      .optional()
      .nullable()
      .refine((val) => {
        if (!val || val.trim().length === 0) return true;
        return Boolean(normalizePhoneNumber(val));
      }, "Phone number must be a valid phone number that can be normalized to E.164"),
    voiceConsent: z
      .boolean()
      .default(false),
    whatsappConsent: z
      .boolean()
      .default(false),
    organization: z
      .string()
      .trim()
      .min(1, "Organization / College / Host name is required")
      .max(150, "Organization name must not exceed 150 characters"),
    location: z
      .string()
      .trim()
      .min(1, "Location / City is required")
      .max(200, "Location must not exceed 200 characters"),
    eventDate: z
      .string()
      .trim()
      .max(100, "Date string must not exceed 100 characters")
      .default("Flexible"),
    crowdSize: z
      .union([z.string().trim().max(100), z.number().int().positive()])
      .default("Not Specified"),
    notes: z
      .string()
      .trim()
      .max(2000, "Notes must not exceed 2000 characters")
      .default(""),
    idempotencyKey: z
      .string()
      .trim()
      .max(100)
      .optional(),
  })
  .refine(
    (data) => {
      // If either voice or WhatsApp consent is requested, a valid phone number is required
      if (data.voiceConsent || data.whatsappConsent) {
        const rawPhone = data.phoneNumber || data.contact;
        const normalized = normalizePhoneNumber(rawPhone);
        return Boolean(normalized);
      }
      return true;
    },
    {
      message:
        "A valid phone number (in E.164 format or 10-digit Indian mobile) is required when opting in to voice calls or WhatsApp notifications.",
      path: ["phoneNumber"],
    }
  );

export type VanRequestInput = z.infer<typeof VanRequestInputSchema>;

// 5. Hyper-Local Hype Broadcaster Agent Schema
export const SocialBroadcastPostSchema = z.object({
  platform: z.enum(["WhatsApp Status", "Instagram Story", "Twitter / X", "SMS Alert"]),
  headline: z.string().min(3),
  body: z.string().min(10),
  hashtags: z.array(z.string()),
  shareableUrl: z.string(),
});

export const SocialBroadcastArraySchema = z.array(SocialBroadcastPostSchema);
export type SocialBroadcastPostOutput = z.infer<typeof SocialBroadcastPostSchema>;

// 6. Guest Sentiment Guardian Agent Schema
export const ReviewRecoveryNoticeSchema = z.object({
  customerName: z.string().min(1),
  rating: z.number().int().min(1).max(3),
  sentiment: z.enum(["negative", "mixed"]),
  detectedIssues: z.array(z.string()).min(1),
  managerApologyText: z.string().min(20),
  voucherCode: z.string().regex(/^BREWCARE\d{4}$/, "Must be a valid BREWCARE voucher code"),
  discountAmount: z.number().positive(),
});

export type ReviewRecoveryNoticeOutput = z.infer<typeof ReviewRecoveryNoticeSchema>;

/**
 * Universal safe parser and guardrail validator for LLM outputs.
 */
export function safeValidateAgentOutput<T>(
  schema: z.ZodType<T>,
  rawInput: unknown
): { success: true; data: T } | { success: false; error: string; issues: z.ZodIssue[] } {
  const result = schema.safeParse(rawInput);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const issueDescriptions = result.error.issues
    .map((iss) => `${iss.path.join(".") || "root"}: ${iss.message}`)
    .join("; ");

  return {
    success: false,
    error: `Agent Output Guardrail Violation: ${issueDescriptions}`,
    issues: result.error.issues,
  };
}
