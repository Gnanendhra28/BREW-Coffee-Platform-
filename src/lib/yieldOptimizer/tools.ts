// Controlled Agent Tool Execution Layer for Agent 3: ⚡ Yield Optimizer
// Enforces:
// 1. Safe read abstractions without unvalidated raw database writes
// 2. Strict margin & price bounds verification
// 3. Pre-publish live inventory revalidation
// 4. Post-campaign conversion tracking & metrics aggregation

import {
  PastryInventoryItem,
  PastrySalesVelocity,
  PastryDemandForecast,
  WasteRiskAssessment,
  BundleCandidate,
  YieldFlashDealRecord,
  YieldOptimizerMetrics,
} from "./types";
import {
  parseClosingHour,
  calculateRemainingOperatingHours,
  calculateExpectedSurplus,
  classifyWasteRisk,
  calculateBundleEconomics,
} from "./calculations";
import { calculateSalesVelocity, forecastPastryDemand } from "./forecasting";
import { generateOptimizedBundleCandidates } from "./bundleOptimizer";
import {
  generateYieldIdempotencyKey,
  isDealDuplicate,
  registerYieldDeal,
  validateInventoryBeforePublish,
  isValidPromotionTransition,
} from "./policy";

// Master In-Memory Active Pastry Inventory Registry
const PASTRY_INVENTORY_STORE = new Map<string, PastryInventoryItem>([
  [
    "d-4",
    {
      id: "d-4",
      name: "Cinnamon Roll",
      category: "pastry",
      currentStock: 14,
      reservedStock: 0,
      availableStock: 14,
      unit: "pcs",
      unitCost: 60,
      sellingPrice: 180,
      shelfLifeHours: 12,
      remainingShelfLifeHours: 5,
      isExpired: false,
      expiresAt: Date.now() + 1000 * 60 * 60 * 5,
    },
  ],
  [
    "d-2",
    {
      id: "d-2",
      name: "Walnut Brownie",
      category: "pastry",
      currentStock: 8,
      reservedStock: 0,
      availableStock: 8,
      unit: "pcs",
      unitCost: 50,
      sellingPrice: 140,
      shelfLifeHours: 14,
      remainingShelfLifeHours: 6,
      isExpired: false,
      expiresAt: Date.now() + 1000 * 60 * 60 * 6,
    },
  ],
  [
    "d-7",
    {
      id: "d-7",
      name: "Almond Croissant",
      category: "pastry",
      currentStock: 10,
      reservedStock: 0,
      availableStock: 10,
      unit: "pcs",
      unitCost: 50,
      sellingPrice: 160,
      shelfLifeHours: 10,
      remainingShelfLifeHours: 4,
      isExpired: false,
      expiresAt: Date.now() + 1000 * 60 * 60 * 4,
    },
  ],
]);

// Master Flash Deal Storage: dealId -> record
const ACTIVE_DEALS = new Map<string, YieldFlashDealRecord>();

// Sales History Store for velocity computation: productId -> [{timestamp, quantity}]
const SALES_HISTORY_STORE = new Map<string, { timestamp: number; quantity: number }[]>();

// Store operating hours config
let CURRENT_STORE_HOURS = "7:00 AM — 11:00 PM";

export function setOperatingHoursConfig(hours: string): void {
  CURRENT_STORE_HOURS = hours;
}

export function updatePastryStockInStore(
  productId: string,
  stockPatch: Partial<PastryInventoryItem>
): void {
  const existing = PASTRY_INVENTORY_STORE.get(productId);
  if (existing) {
    const updated = {
      ...existing,
      ...stockPatch,
      availableStock:
        typeof stockPatch.currentStock === "number"
          ? stockPatch.currentStock - (stockPatch.reservedStock ?? existing.reservedStock)
          : existing.availableStock,
    };
    PASTRY_INVENTORY_STORE.set(productId, updated);
  }
}

export function clearYieldStore(): void {
  ACTIVE_DEALS.clear();
  SALES_HISTORY_STORE.clear();
}

// -------------------------------------------------------------
// CONTROLLED TOOL IMPLEMENTATIONS
// -------------------------------------------------------------

export function tool_get_pastry_inventory(storeId: string = "van-01"): PastryInventoryItem[] {
  void storeId;
  return Array.from(PASTRY_INVENTORY_STORE.values());
}

export function tool_get_pastry_item(productId: string): PastryInventoryItem | null {
  return PASTRY_INVENTORY_STORE.get(productId) || null;
}

export function tool_get_sales_history(
  storeId: string = "van-01",
  productId: string
): { timestamp: number; quantity: number }[] {
  void storeId;
  return SALES_HISTORY_STORE.get(productId) || [];
}

export function tool_get_operating_hours(storeId: string = "van-01"): {
  hoursStr: string;
  closingHour: number;
  remainingOperatingHours: number;
} {
  void storeId;
  const closingHour = parseClosingHour(CURRENT_STORE_HOURS);
  const remainingOperatingHours = calculateRemainingOperatingHours(closingHour);
  return {
    hoursStr: CURRENT_STORE_HOURS,
    closingHour,
    remainingOperatingHours,
  };
}

export function tool_calculate_velocity(
  productId: string,
  currentTime: number = Date.now()
): PastrySalesVelocity {
  const history = tool_get_sales_history("van-01", productId);
  return calculateSalesVelocity(productId, history, currentTime);
}

export function tool_forecast_pastry_demand(
  product: PastryInventoryItem,
  horizonHours: number,
  currentHour: number = new Date().getHours()
): PastryDemandForecast {
  const velocity = tool_calculate_velocity(product.id);
  return forecastPastryDemand(product, velocity, horizonHours, currentHour);
}

export function tool_calculate_surplus(
  availableStock: number,
  expectedNaturalSales: number
): number {
  return calculateExpectedSurplus(availableStock, expectedNaturalSales);
}

export function tool_calculate_waste_risk(params: {
  product: PastryInventoryItem;
  remainingOperatingHours: number;
  currentHour?: number;
}): WasteRiskAssessment {
  const forecast = tool_forecast_pastry_demand(params.product, params.remainingOperatingHours, params.currentHour);
  const surplus = calculateExpectedSurplus(params.product.availableStock, forecast.expectedNaturalSales);

  return classifyWasteRisk({
    productId: params.product.id,
    productName: params.product.name,
    currentStock: params.product.currentStock,
    expectedNaturalSales: forecast.expectedNaturalSales,
    expectedSurplus: surplus,
    remainingOperatingHours: params.remainingOperatingHours,
    unitCost: params.product.unitCost,
    isExpired: params.product.isExpired,
    remainingShelfLifeHours: params.product.remainingShelfLifeHours,
  });
}

export function tool_generate_bundle_candidates(params: {
  surplusPastry: PastryInventoryItem;
  riskAssessment: WasteRiskAssessment;
  remainingOperatingHours: number;
  weatherCondition?: string;
}): BundleCandidate[] {
  return generateOptimizedBundleCandidates(params);
}

export function tool_validate_bundle_margin(
  normalPrice: number,
  dealPrice: number,
  totalCost: number
) {
  return calculateBundleEconomics({ normalPrice, dealPrice, totalCost });
}

/**
 * Creates a structured draft flash deal with idempotency and safety bounds.
 */
export function tool_create_flash_deal(params: {
  storeId: string;
  candidate: BundleCandidate;
  triggerReason?: "weather" | "bakery_spoilage_prevention" | "manual";
}): { success: boolean; deal?: YieldFlashDealRecord; isDuplicate?: boolean; error?: string } {
  const { storeId, candidate, triggerReason = "bakery_spoilage_prevention" } = params;

  // 1. Economic safety check
  const econ = calculateBundleEconomics({
    normalPrice: candidate.normalPrice,
    dealPrice: candidate.recommendedPrice,
    totalCost: candidate.totalCost,
  });

  if (!econ.isEconomicallyViable) {
    return { success: false, error: econ.rejectionReason };
  }

  // 2. Idempotency Check
  const idempotencyKey = generateYieldIdempotencyKey(storeId, candidate.bundleId);
  const dupCheck = isDealDuplicate(idempotencyKey);
  if (dupCheck.isDuplicate && dupCheck.existingDeal) {
    return {
      success: true,
      deal: dupCheck.existingDeal,
      isDuplicate: true,
      error: "Idempotent: An active flash deal for this pairing already exists in this period.",
    };
  }

  // 3. Construct record
  const dealId = `deal-flash-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const autoApproved = !candidate.requiresApproval;
  const status = autoApproved ? "ACTIVE" : "PENDING_APPROVAL";

  const record: YieldFlashDealRecord = {
    id: dealId,
    idempotencyKey,
    storeId,
    status,
    candidate,
    triggerReason,
    createdAt: Date.now(),
    publishedAt: autoApproved ? Date.now() : undefined,
    expiresAt: candidate.expiresAt,
    autoApproved,
    unitsSold: 0,
    wasteAvoidedUnits: 0,
    revenueGenerated: 0,
    discountCostTotal: 0,
    marginEarnedTotal: 0,
  };

  registerYieldDeal(idempotencyKey, record);
  ACTIVE_DEALS.set(dealId, record);

  return { success: true, deal: record };
}

/**
 * Publishes an approved or drafted flash deal after re-validating live inventory.
 */
export function tool_publish_flash_deal(dealId: string): {
  success: boolean;
  deal?: YieldFlashDealRecord;
  error?: string;
} {
  const deal = ACTIVE_DEALS.get(dealId);
  if (!deal) {
    return { success: false, error: `Deal '${dealId}' not found.` };
  }

  // Revalidate state transition
  if (!isValidPromotionTransition(deal.status, "ACTIVE")) {
    return {
      success: false,
      error: `Illegal state transition: Cannot activate deal currently in '${deal.status}' state.`,
    };
  }

  // Revalidate live inventory before publication
  const livePastry = tool_get_pastry_item(deal.candidate.pastryId);
  const liveStock = livePastry ? livePastry.availableStock : 0;
  const inventoryCheck = validateInventoryBeforePublish(deal, liveStock);

  if (!inventoryCheck.valid) {
    deal.status = "CANCELLED";
    return { success: false, error: inventoryCheck.reason };
  }

  deal.status = "ACTIVE";
  deal.publishedAt = Date.now();

  return { success: true, deal };
}

/**
 * Records sales against an active promotion to measure actual waste reduction vs forecast.
 */
export function tool_record_promotion_sale(
  dealId: string,
  unitsPurchased: number = 1
): { success: boolean; deal?: YieldFlashDealRecord } {
  const deal = ACTIVE_DEALS.get(dealId);
  if (!deal || deal.status !== "ACTIVE") {
    return { success: false };
  }

  deal.unitsSold += unitsPurchased;
  deal.wasteAvoidedUnits += unitsPurchased;
  deal.revenueGenerated += deal.candidate.recommendedPrice * unitsPurchased;
  deal.discountCostTotal += (deal.candidate.normalPrice - deal.candidate.recommendedPrice) * unitsPurchased;
  deal.marginEarnedTotal += deal.candidate.grossMarginAmount * unitsPurchased;

  // Deduct from live pastry inventory
  const livePastry = tool_get_pastry_item(deal.candidate.pastryId);
  if (livePastry) {
    updatePastryStockInStore(deal.candidate.pastryId, {
      currentStock: Math.max(0, livePastry.currentStock - unitsPurchased),
    });
  }

  return { success: true, deal };
}

export function tool_get_all_deals(): YieldFlashDealRecord[] {
  return Array.from(ACTIVE_DEALS.values());
}

export function tool_get_yield_metrics(): YieldOptimizerMetrics {
  const deals = Array.from(ACTIVE_DEALS.values());
  const pastries = Array.from(PASTRY_INVENTORY_STORE.values());

  const pastryUnitsEvaluated = pastries.reduce((acc, p) => acc + p.currentStock, 0);
  const promotionsCreated = deals.length;
  const promotionsPublished = deals.filter((d) => d.status === "ACTIVE" || d.status === "COMPLETED").length;
  const unitsSoldThroughPromotion = deals.reduce((acc, d) => acc + d.unitsSold, 0);
  const wasteAvoidedUnits = deals.reduce((acc, d) => acc + d.wasteAvoidedUnits, 0);
  const totalRevenueRecovered = deals.reduce((acc, d) => acc + d.revenueGenerated, 0);
  const totalDiscountCost = deals.reduce((acc, d) => acc + d.discountCostTotal, 0);
  const totalGrossMarginEarned = deals.reduce((acc, d) => acc + d.marginEarnedTotal, 0);

  const avgDiscount =
    deals.length > 0
      ? Number((deals.reduce((acc, d) => acc + d.candidate.discountPercent, 0) / deals.length).toFixed(1))
      : 0;

  const totalSurplus = deals.reduce((acc, d) => acc + d.candidate.projectedWasteSavedUnits, 0);
  const wasteRemainingUnits = Math.max(0, totalSurplus - wasteAvoidedUnits);
  const wasteReductionRate = totalSurplus > 0 ? Number(((wasteAvoidedUnits / totalSurplus) * 100).toFixed(1)) : 100;

  return {
    pastryUnitsEvaluated,
    surplusUnitsDetected: totalSurplus,
    promotionsCreated,
    promotionsPublished,
    unitsSoldThroughPromotion,
    wasteAvoidedUnits,
    wasteRemainingUnits,
    wasteReductionRate,
    totalRevenueRecovered,
    totalDiscountCost,
    totalGrossMarginEarned,
    avgDiscountPercent: avgDiscount,
  };
}
