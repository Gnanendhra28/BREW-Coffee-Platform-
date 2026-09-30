// Deterministic Cost & Margin Engine for Agent 4: 🎪 Event Booking Concierge
// Enforces:
// 1. Strict cost accounting (ingredients, labor, equipment, logistics, overhead)
// 2. Deterministic gross margin calculation
// 3. Mandatory minimum 30% gross margin protection

import { CostBreakdown, QuotationTier, ConsumptionForecast, StaffingRequirement, EquipmentRequirement, LogisticsCalculation } from "./types";
import { buildIngredientManifest } from "./consumption";
import { CATERING_PACKAGES } from "./packages";

export const MINIMUM_EVENT_GROSS_MARGIN_PERCENT = 30.0; // Enforce strict 30% floor

/**
 * Calculates total internal operational cost for a specific catering tier.
 */
export function calculateTierCostBreakdown(params: {
  consumption: ConsumptionForecast;
  staffing: StaffingRequirement;
  equipment: EquipmentRequirement;
  logistics: LogisticsCalculation;
  currentStock?: Record<string, number>;
}): CostBreakdown {
  const { consumption, staffing, equipment, logistics, currentStock } = params;

  const ingredientData = buildIngredientManifest(consumption, currentStock);
  const ingredientCost = ingredientData.totalIngredientCost;
  const laborCost = staffing.totalLaborCost;
  const equipmentCost = equipment.equipmentRentalCost;
  const logisticsCost = logistics.totalLogisticsCost;

  // Operational overhead: ice, compostable napkins, trash bags, power consumables (~5%)
  const operationalOverhead = Math.round((ingredientCost + laborCost) * 0.05);
  const totalCost = ingredientCost + laborCost + equipmentCost + logisticsCost + operationalOverhead;

  return {
    ingredientCost,
    pastryCost: 0, // Included in ingredientCost manifest
    laborCost,
    equipmentCost,
    logisticsCost,
    operationalOverhead,
    totalCost,
  };
}

/**
 * Calculates price, gross profit, and gross margin percentage for a package tier.
 * Validates minimum 30% gross margin guardrail.
 */
export function calculateTierEconomics(params: {
  tierId: "BASIC" | "STANDARD" | "PREMIUM";
  guestCount: number;
  totalCost: number;
  customPricePerGuest?: number;
  travelDistanceFee?: number;
}): {
  tier: QuotationTier;
  isEconomicallyViable: boolean;
  rejectionReason?: string;
  recommendedMinimumPricePerGuest?: number;
} {
  const { tierId, guestCount, totalCost, customPricePerGuest, travelDistanceFee = 1500 } = params;
  const pkg = CATERING_PACKAGES[tierId];

  const pricePerGuest = customPricePerGuest || pkg.basePricePerGuest;
  const totalAmount = guestCount * pricePerGuest + travelDistanceFee;
  const grossProfit = totalAmount - totalCost;
  const grossMarginPercent = totalAmount > 0 ? Number(((grossProfit / totalAmount) * 100).toFixed(1)) : 0;

  const isEconomicallyViable = grossMarginPercent >= MINIMUM_EVENT_GROSS_MARGIN_PERCENT;

  // Calculate required price per guest if below margin
  let recommendedMinimumPricePerGuest: number | undefined;
  let rejectionReason: string | undefined;

  if (!isEconomicallyViable) {
    // totalAmount * 0.70 = totalCost => totalAmount = totalCost / 0.70
    const targetRevenue = totalCost / (1 - MINIMUM_EVENT_GROSS_MARGIN_PERCENT / 100);
    recommendedMinimumPricePerGuest = Math.ceil((targetRevenue - travelDistanceFee) / guestCount);
    rejectionReason = `Gross margin ${grossMarginPercent}% is below minimum required 30% (Cost: ₹${totalCost}, Total: ₹${totalAmount}). Required minimum price: ₹${recommendedMinimumPricePerGuest}/guest.`;
  }

  const tier: QuotationTier = {
    tierId,
    name: pkg.name,
    tagline: pkg.tagline,
    pricePerGuest,
    totalAmount,
    totalCost,
    grossProfit,
    grossMarginPercent,
    isRecommended: pkg.isRecommended,
    perks: pkg.perks,
    includedProducts: pkg.includedProducts,
    staffAssigned: tierId === "PREMIUM" ? (guestCount > 250 ? 4 : guestCount > 100 ? 3 : 2) : (guestCount > 250 ? 3 : guestCount > 100 ? 2 : 1),
    equipmentSummary: pkg.equipmentSummary,
  };

  return {
    tier,
    isEconomicallyViable,
    rejectionReason,
    recommendedMinimumPricePerGuest,
  };
}
