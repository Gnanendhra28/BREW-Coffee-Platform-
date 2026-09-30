// Autonomous Bundle Candidate Generator and Discount Optimization Engine
// Pure Deterministic Logic: Zero LLM hallucinations for pricing, margin, or discounts.

import {
  PastryInventoryItem,
  WasteRiskAssessment,
  BundleCandidate,
  PromotionRiskTier,
} from "./types";
import {
  calculateBundleEconomics,
  calculatePromotionDuration,
  YIELD_CONFIG,
} from "./calculations";

export interface BeverageCatalogItem {
  id: string;
  name: string;
  price: number;
  cost: number;
}

// Master pairing beverages with high margin profiles
export const HIGH_MARGIN_BEVERAGES: BeverageCatalogItem[] = [
  { id: "c-3", name: "Cappuccino", price: 220, cost: 35 },
  { id: "c-6", name: "Flat White", price: 200, cost: 35 },
  { id: "c-4", name: "Cold Brew", price: 240, cost: 28 },
  { id: "c-2", name: "Americano", price: 180, cost: 22 },
  { id: "c-7", name: "Latte", price: 220, cost: 38 },
];

/**
 * Generates and optimizes flash bundle candidates for surplus pastries.
 */
export function generateOptimizedBundleCandidates(params: {
  surplusPastry: PastryInventoryItem;
  riskAssessment: WasteRiskAssessment;
  remainingOperatingHours: number;
  weatherCondition?: string;
}): BundleCandidate[] {
  const { surplusPastry, riskAssessment, remainingOperatingHours } = params;

  // Hard safety: Never create bundles for expired products or SAFE risk (no surplus)
  if (
    surplusPastry.isExpired ||
    surplusPastry.remainingShelfLifeHours <= 0 ||
    riskAssessment.wasteRiskLevel === "SAFE"
  ) {
    return [];
  }

  const candidates: BundleCandidate[] = [];

  for (const bev of HIGH_MARGIN_BEVERAGES) {
    const normalPrice = bev.price + surplusPastry.sellingPrice;
    const totalCost = bev.cost + surplusPastry.unitCost;

    // Reject bundles where product cost equals or exceeds normal selling price
    if (totalCost >= normalPrice) {
      continue;
    }

    // Determine target discount percentage based on surplus volume and urgency
    let targetDiscount = 20; // default 20%
    if (riskAssessment.wasteRiskLevel === "CRITICAL") {
      targetDiscount = 30; // aggressive clearance
    } else if (riskAssessment.wasteRiskLevel === "HIGH") {
      targetDiscount = 25;
    } else if (riskAssessment.wasteRiskLevel === "LOW") {
      targetDiscount = 15;
    }

    // Calculate preliminary deal price
    let dealPrice = Math.round(normalPrice * (1 - targetDiscount / 100));

    // Economic safety validation & clamping
    let economics = calculateBundleEconomics({ normalPrice, dealPrice, totalCost });
    if (!economics.isEconomicallyViable) {
      // Try clamping to minimum acceptable margin (30%)
      const minViablePrice = Math.ceil(totalCost / (1 - YIELD_CONFIG.minGrossMarginPercent / 100));
      if (minViablePrice < normalPrice) {
        dealPrice = minViablePrice;
        economics = calculateBundleEconomics({ normalPrice, dealPrice, totalCost });
      }
    }

    if (!economics.isEconomicallyViable) {
      continue; // Skip if economics cannot be satisfied
    }

    // Projected waste reduction modeling
    // Discount increases uptake velocity by ~1.8x
    const projectedSalesWithBundle = Math.min(
      riskAssessment.expectedSurplus,
      Math.round(riskAssessment.expectedNaturalSales * 1.8 + 4)
    );
    const projectedWasteSavedUnits = Math.min(riskAssessment.expectedSurplus, projectedSalesWithBundle);
    const wasteRemainingAfterPromotion = Math.max(0, riskAssessment.expectedSurplus - projectedWasteSavedUnits);
    const projectedWasteReductionPercent =
      riskAssessment.expectedSurplus > 0
        ? Number((((riskAssessment.expectedSurplus - wasteRemainingAfterPromotion) / riskAssessment.expectedSurplus) * 100).toFixed(1))
        : 100;

    // Determine promotion risk tier and human approval requirement
    let riskTier: PromotionRiskTier = "LOW";
    let requiresApproval = false;

    if (economics.discountPercent > 28 || riskAssessment.expectedSurplus > 15) {
      riskTier = "HIGH";
      requiresApproval = true;
    } else if (economics.discountPercent > 20 || riskAssessment.expectedSurplus > 8) {
      riskTier = "MEDIUM";
      requiresApproval = true;
    }

    // Duration sizing
    const duration = calculatePromotionDuration({
      remainingOperatingHours,
      remainingShelfLifeHours: surplusPastry.remainingShelfLifeHours,
      requestedDurationMinutes: 120,
    });

    const bundleId = `bundle-${bev.id}-${surplusPastry.id}`;
    const title = `☕ ${bev.name} + ${surplusPastry.name} Flash Pair`;
    const tagline = `Artisanal pairing · Limited ${economics.discountPercent}% OFF until ${new Date(duration.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    candidates.push({
      bundleId,
      title,
      tagline,
      beverageId: bev.id,
      beverageName: bev.name,
      beveragePrice: bev.price,
      beverageCost: bev.cost,
      pastryId: surplusPastry.id,
      pastryName: surplusPastry.name,
      pastryPrice: surplusPastry.sellingPrice,
      pastryCost: surplusPastry.unitCost,
      normalPrice,
      totalCost,
      recommendedPrice: dealPrice,
      discountPercent: economics.discountPercent,
      grossMarginAmount: economics.grossMarginAmount,
      grossMarginPercent: economics.grossMarginPercent,
      projectedWasteReductionPercent,
      projectedWasteSavedUnits,
      riskTier,
      requiresApproval,
      durationMinutes: duration.durationMinutes,
      expiresAt: duration.expiresAt,
    });
  }

  // Sort descending by highest gross margin recovered
  return candidates.sort((a, b) => b.grossMarginAmount - a.grossMarginAmount);
}
