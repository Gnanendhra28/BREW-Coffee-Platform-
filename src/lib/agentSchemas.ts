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
