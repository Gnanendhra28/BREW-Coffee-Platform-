// Deterministic Mathematical & Economic Engine for Agent 3: ⚡ Yield Optimizer
// Covers:
// 1. Operating Hours Remaining Parser & Sizing
// 2. Expected Surplus & Zero-Clamped Waste Analysis
// 3. Deterministic Waste Risk Classification (SAFE, LOW, MEDIUM, HIGH, CRITICAL)
// 4. Financial Economics (Gross Margin Amount, Percentage, Discount Bounds)
// 5. Campaign Duration Capping (closing time, shelf-life expiry)

import { WasteRiskAssessment } from "./types";

export const YIELD_CONFIG = {
  minDiscountPercent: 10,
  maxDiscountPercent: 35,
  minGrossMarginPercent: 30, // Minimum acceptable gross margin
  minGrossMarginAmountRupees: 50, // Minimum ₹50 cash margin per bundle
  maxCampaignDurationMinutes: 180, // 3 hours max per flash deal
  defaultClosingHour: 23, // 11:00 PM default van closing
};

/**
 * Parses closing hour (0-24) from human-readable store hours string.
 * e.g. "7:00 AM — 11:00 PM" -> 23.0; "7:30 AM — 9:00 PM" -> 21.0
 */
export function parseClosingHour(hoursStr?: string): number {
  if (!hoursStr) return YIELD_CONFIG.defaultClosingHour;

  const parts = hoursStr.split("—").map((p) => p.trim());
  if (parts.length < 2) return YIELD_CONFIG.defaultClosingHour;

  const closeStr = parts[1].toLowerCase();
  const match = closeStr.match(/(\d+)(?::(\d+))?\s*(am|pm)?/);
  if (!match) return YIELD_CONFIG.defaultClosingHour;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3];

  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;

  return hour + minute / 60;
}

/**
 * Calculates remaining operating hours until closing.
 */
export function calculateRemainingOperatingHours(
  closingHour: number = YIELD_CONFIG.defaultClosingHour,
  currentTime: Date = new Date()
): number {
  const currentHour = currentTime.getHours() + currentTime.getMinutes() / 60;
  return Math.max(0, Number((closingHour - currentHour).toFixed(2)));
}

/**
 * Calculates expected surplus pastries at closing.
 * expectedSurplus = max(0, availableStock - expectedNaturalSales)
 */
export function calculateExpectedSurplus(
  availableStock: number,
  expectedNaturalSales: number
): number {
  return Math.max(0, Math.round(availableStock - expectedNaturalSales));
}

/**
 * Classifies Waste Risk Level deterministically.
 */
export function classifyWasteRisk(params: {
  productId: string;
  productName: string;
  currentStock: number;
  expectedNaturalSales: number;
  expectedSurplus: number;
  remainingOperatingHours: number;
  unitCost: number;
  isExpired?: boolean;
  remainingShelfLifeHours?: number;
}): WasteRiskAssessment {
  const {
    productId,
    productName,
    currentStock,
    expectedNaturalSales,
    expectedSurplus,
    remainingOperatingHours,
    unitCost,
    isExpired,
    remainingShelfLifeHours,
  } = params;

  // Hard safety rule: Expired products
  if (isExpired || (remainingShelfLifeHours !== undefined && remainingShelfLifeHours <= 0)) {
    return {
      productId,
      productName,
      currentStock,
      expectedNaturalSales: 0,
      expectedSurplus: currentStock,
      wasteRiskLevel: "CRITICAL",
      remainingOperatingHours,
      projectedWasteCost: currentStock * unitCost,
      reason: "Product has reached or exceeded shelf-life expiry. Unsafe for promotion or sale.",
    };
  }

  const projectedWasteCost = expectedSurplus * unitCost;

  // Case 1: Healthy Inventory (Surplus is 0 or negligible)
  if (expectedSurplus <= 0 || expectedSurplus / Math.max(1, currentStock) <= 0.15) {
    return {
      productId,
      productName,
      currentStock,
      expectedNaturalSales,
      expectedSurplus: 0,
      wasteRiskLevel: "SAFE",
      remainingOperatingHours,
      projectedWasteCost: 0,
      reason: "Healthy inventory velocity. Natural demand is projected to clear available stock before closing.",
    };
  }

  // Case 2: Severe Surplus / Urgent Closing window
  if (expectedSurplus >= 20 || (expectedSurplus >= 10 && remainingOperatingHours <= 2.0)) {
    return {
      productId,
      productName,
      currentStock,
      expectedNaturalSales,
      expectedSurplus,
      wasteRiskLevel: "CRITICAL",
      remainingOperatingHours,
      projectedWasteCost,
      reason: `CRITICAL: Severe surplus of ${expectedSurplus} units with only ${remainingOperatingHours}h remaining. Aggressive margin-safe bundle recommended immediately.`,
    };
  }

  // Case 3: High Surplus Risk
  if (expectedSurplus >= 8 || remainingOperatingHours <= 3.0) {
    return {
      productId,
      productName,
      currentStock,
      expectedNaturalSales,
      expectedSurplus,
      wasteRiskLevel: "HIGH",
      remainingOperatingHours,
      projectedWasteCost,
      reason: `HIGH RISK: Projected surplus of ${expectedSurplus} unsold pastries by close (₹${projectedWasteCost} inventory at risk). Flash bundle pairing recommended.`,
    };
  }

  // Case 4: Medium Surplus Risk
  if (expectedSurplus >= 4) {
    return {
      productId,
      productName,
      currentStock,
      expectedNaturalSales,
      expectedSurplus,
      wasteRiskLevel: "MEDIUM",
      remainingOperatingHours,
      projectedWasteCost,
      reason: `MEDIUM: Moderate surplus of ${expectedSurplus} units. Monitor afternoon velocity.`,
    };
  }

  // Case 5: Low Surplus Risk
  return {
    productId,
    productName,
    currentStock,
    expectedNaturalSales,
    expectedSurplus,
    wasteRiskLevel: "LOW",
    remainingOperatingHours,
    projectedWasteCost,
    reason: `LOW: Minor surplus of ${expectedSurplus} units with ample remaining operating window (${remainingOperatingHours}h).`,
  };
}

/**
 * Calculates Bundle Gross Margin and Validates Economic Viability.
 */
export function calculateBundleEconomics(params: {
  normalPrice: number;
  dealPrice: number;
  totalCost: number;
}): {
  grossMarginAmount: number;
  grossMarginPercent: number;
  discountPercent: number;
  isEconomicallyViable: boolean;
  rejectionReason?: string;
} {
  const { normalPrice, dealPrice, totalCost } = params;

  // 1. Guard against non-positive prices
  if (normalPrice <= 0 || dealPrice <= 0) {
    return {
      grossMarginAmount: 0,
      grossMarginPercent: 0,
      discountPercent: 0,
      isEconomicallyViable: false,
      rejectionReason: "Prices must be strictly positive.",
    };
  }

  // 2. Guard against negative or insufficient gross margin
  const grossMarginAmount = Math.round(dealPrice - totalCost);
  const grossMarginPercent = Number(((grossMarginAmount / dealPrice) * 100).toFixed(1));
  const discountPercent = Number((((normalPrice - dealPrice) / normalPrice) * 100).toFixed(1));

  if (dealPrice <= totalCost) {
    return {
      grossMarginAmount,
      grossMarginPercent,
      discountPercent,
      isEconomicallyViable: false,
      rejectionReason: `Proposed deal price (₹${dealPrice}) is below combined product cost (₹${totalCost}). Zero or negative margin rejected.`,
    };
  }

  if (grossMarginPercent < YIELD_CONFIG.minGrossMarginPercent) {
    return {
      grossMarginAmount,
      grossMarginPercent,
      discountPercent,
      isEconomicallyViable: false,
      rejectionReason: `Gross margin (${grossMarginPercent}%) is below minimum required threshold (${YIELD_CONFIG.minGrossMarginPercent}%).`,
    };
  }

  if (discountPercent > YIELD_CONFIG.maxDiscountPercent) {
    return {
      grossMarginAmount,
      grossMarginPercent,
      discountPercent,
      isEconomicallyViable: false,
      rejectionReason: `Discount (${discountPercent}%) exceeds maximum allowable cap (${YIELD_CONFIG.maxDiscountPercent}%).`,
    };
  }

  return {
    grossMarginAmount,
    grossMarginPercent,
    discountPercent,
    isEconomicallyViable: true,
  };
}

/**
 * Sizes promotion duration capped deterministically by closing time and shelf-life expiry.
 */
export function calculatePromotionDuration(params: {
  remainingOperatingHours: number;
  remainingShelfLifeHours?: number;
  requestedDurationMinutes?: number;
}): { durationMinutes: number; expiresAt: number } {
  const requested = params.requestedDurationMinutes || 120;
  const operatingMinutesRemaining = Math.max(0, Math.round(params.remainingOperatingHours * 60));
  const shelfLifeMinutesRemaining =
    params.remainingShelfLifeHours !== undefined
      ? Math.max(0, Math.round(params.remainingShelfLifeHours * 60))
      : 9999;

  // Capped at closing time, shelf life, and max campaign cap
  const cappedMinutes = Math.min(
    requested,
    operatingMinutesRemaining,
    shelfLifeMinutesRemaining,
    YIELD_CONFIG.maxCampaignDurationMinutes
  );

  const durationMinutes = Math.max(1, cappedMinutes);
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;

  return { durationMinutes, expiresAt };
}
