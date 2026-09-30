// Production Policy Engine & Governance Guardrails for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Guarantees:
// 1. Quiet Hours Enforcement (21:00 - 08:00)
// 2. Customer Frequency Capping (max 3/day, min 2 hrs)
// 3. Store Hourly Rate Limiting (max 5 campaigns/hr)
// 4. Commercial Fact & Discount Verification (No hallucinated pricing or fake scarcity)
// 5. Strict Campaign State Machine Transitions
// 6. Pre-Send Revalidation Guard

import {
  CampaignStatus,
  HypeCampaignRecord,
  MarketingOpportunity,
  StoreMarketingContext,
  CampaignMessageCopy,
} from "./types";
import { isWithinQuietHours } from "./audience";

export const MAX_STORE_CAMPAIGNS_PER_HOUR = 5;

// In-Memory store campaign dispatch rate limiter: storeId -> timestamp[]
const STORE_DISPATCH_TIMESTAMPS = new Map<string, number[]>();

export function recordStoreCampaignDispatch(storeId: string, timestamp: number = Date.now()): void {
  const list = STORE_DISPATCH_TIMESTAMPS.get(storeId) || [];
  const oneHourAgo = timestamp - 60 * 60 * 1000;
  const recent = list.filter((t) => t > oneHourAgo);
  recent.push(timestamp);
  STORE_DISPATCH_TIMESTAMPS.set(storeId, recent);
}

export function isStoreRateLimited(storeId: string, timestamp: number = Date.now()): boolean {
  const list = STORE_DISPATCH_TIMESTAMPS.get(storeId) || [];
  const oneHourAgo = timestamp - 60 * 60 * 1000;
  const recent = list.filter((t) => t > oneHourAgo);
  return recent.length >= MAX_STORE_CAMPAIGNS_PER_HOUR;
}

export function resetStoreRateLimits(): void {
  STORE_DISPATCH_TIMESTAMPS.clear();
}

/**
 * Valid state machine transitions for Hype Campaigns.
 */
const VALID_STATUS_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ["GENERATED", "CANCELLED"],
  GENERATED: ["PENDING_APPROVAL", "APPROVED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["SCHEDULED", "SENDING", "CANCELLED"],
  SCHEDULED: ["SENDING", "CANCELLED"],
  SENDING: ["SENT", "FAILED", "CANCELLED"],
  SENT: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: ["SENDING", "CANCELLED"], // Allows retry or final cancellation
};

export function isValidCampaignTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Generates an authoritative idempotency key for marketing campaigns.
 * Bucket is by store, trigger type, and hourly time window (plus promo ID if present).
 */
export function generateCampaignIdempotencyKey(
  storeId: string,
  opportunity: MarketingOpportunity,
  timestampMs: number = Date.now()
): string {
  const dateObj = new Date(timestampMs);
  const hourBucket = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}-${dateObj.getDate()}-H${dateObj.getHours()}`;
  const promoSuffix = opportunity.promotionReference?.id ? `:${opportunity.promotionReference.id}` : "";
  return `${storeId}:${opportunity.type}:${hourBucket}${promoSuffix}`;
}

export interface FactValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Commercial Fact & Discount Validator.
 * Deterministically checks that generated copy does not hallucinate prices or discount amounts.
 */
export function validateCampaignCopyFacts(
  copy: CampaignMessageCopy,
  opportunity: MarketingOpportunity
): FactValidationResult {
  const errors: string[] = [];
  const textToScan = `${copy.headline} ${copy.body} ${copy.ctaText}`.toLowerCase();

  // 1. Price verification
  if (opportunity.promotionReference) {
    const expectedDealPrice = opportunity.promotionReference.dealPrice;
    const expectedNormalPrice = opportunity.promotionReference.normalPrice;
    const expectedDiscount = opportunity.promotionReference.discountPercent;

    // Extract all rupees mentioned in text e.g. ₹300, rs 300, rs. 300, 300 rs
    const priceMatches = textToScan.match(/(?:₹|rs\.?|inr)\s?(\d+)/g);
    if (priceMatches) {
      for (const m of priceMatches) {
        const num = parseInt(m.replace(/[^\d]/g, ""), 10);
        if (num !== expectedDealPrice && num !== expectedNormalPrice) {
          errors.push(
            `Copy contains unauthorized price ₹${num}. Source promotion price is ₹${expectedDealPrice} (was ₹${expectedNormalPrice}).`
          );
        }
      }
    }

    // Extract discount percentage e.g. 25%, 50%
    const percentMatches = textToScan.match(/(\d+)%/g);
    if (percentMatches) {
      for (const p of percentMatches) {
        const num = parseInt(p.replace(/[^\d]/g, ""), 10);
        if (num !== expectedDiscount) {
          errors.push(
            `Copy contains unverified discount ${num}%. Source promotion discount is ${expectedDiscount}%.`
          );
        }
      }
    }
  }

  // 2. Prohibit fraudulent / misleading hype claims
  const forbiddenPhrases = [
    "100% free",
    "totally free coffee",
    "guaranteed cash",
    "limited to first 1 customers",
    "cure",
    "cure fatigue completely",
  ];
  for (const phrase of forbiddenPhrases) {
    if (textToScan.includes(phrase)) {
      errors.push(`Copy contains misleading or prohibited claim: '${phrase}'`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export interface PreSendValidationResult {
  canSend: boolean;
  errors: string[];
}

/**
 * Comprehensive Pre-Send Revalidation Guard.
 * Executed right before dispatching messages.
 */
export function validateCampaignPreSend(
  campaign: HypeCampaignRecord,
  context: StoreMarketingContext,
  nowMs: number = Date.now()
): PreSendValidationResult {
  const errors: string[] = [];

  // 1. Check Store Operational Status
  if (!context.isStoreOpen) {
    errors.push(`Store '${context.storeId}' is currently marked closed.`);
  }

  // 2. Check Quiet Hours
  const currentHour = context.currentLocalHour ?? new Date(nowMs).getHours();
  if (isWithinQuietHours(currentHour) && !campaign.audienceCriteria.quietHoursBypass) {
    errors.push(`Current time (${currentHour}:00) is within protected marketing quiet hours (21:00 - 08:00).`);
  }

  // 3. Store Rate Limit
  if (isStoreRateLimited(context.storeId, nowMs)) {
    errors.push(`Store '${context.storeId}' has reached its hourly campaign limit (${MAX_STORE_CAMPAIGNS_PER_HOUR}/hr).`);
  }

  // 4. Source Promotion Expiration & Availability
  if (campaign.opportunity.promotionReference) {
    const promoRef = campaign.opportunity.promotionReference;
    if (promoRef.expiresAt <= nowMs) {
      errors.push(`Referenced promotion '${promoRef.id}' has expired.`);
    }
    const matchingStorePromo = context.activePromotions.find(
      (p) => p.id === promoRef.id && p.isActive
    );
    if (!matchingStorePromo) {
      errors.push(`Referenced promotion '${promoRef.id}' is no longer active in store context.`);
    }
  }

  // 5. Eligible Audience Verification
  if (!campaign.audience || campaign.audience.eligibleCount === 0) {
    errors.push("No eligible customers found for this campaign dispatch.");
  }

  // 6. Copy Fact Integrity Verification
  for (const [channel, copy] of Object.entries(campaign.messages)) {
    if (copy) {
      const factCheck = validateCampaignCopyFacts(copy, campaign.opportunity);
      if (!factCheck.isValid) {
        errors.push(`Channel ${channel} failed fact validation: ${factCheck.errors.join("; ")}`);
      }
    }
  }

  return {
    canSend: errors.length === 0,
    errors,
  };
}
