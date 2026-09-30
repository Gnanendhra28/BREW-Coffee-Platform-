// Production Type Contracts & Data Models for Agent 3: ⚡ Yield Optimizer

export type WasteRiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PromotionStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "PAUSED"
  | "EXPIRED"
  | "CANCELLED"
  | "COMPLETED";

export type PromotionRiskTier = "LOW" | "MEDIUM" | "HIGH";

export type ForecastMethod =
  | "historical_rush"
  | "rolling_velocity"
  | "current_day_velocity"
  | "configured_baseline";

export interface PastryInventoryItem {
  id: string;
  name: string;
  category: "pastry" | "dessert";
  currentStock: number;
  reservedStock: number;
  availableStock: number;
  unit: string;
  unitCost: number;       // Wholesale preparation cost (e.g. ₹60)
  sellingPrice: number;   // Normal menu price (e.g. ₹180)
  shelfLifeHours: number; // Max shelf life
  remainingShelfLifeHours: number;
  isExpired: boolean;
  expiresAt: number;
}

export interface PastrySalesVelocity {
  productId: string;
  rateLast1h: number;
  rateLast3h: number;
  rateLast6h: number;
  rateLast24h: number;
  rateLast7d: number;
  trend: "normal" | "increasing" | "decreasing" | "spike" | "drop";
  baselinePerHour: number;
}

export interface PastryDemandForecast {
  productId: string;
  forecastRatePerHour: number;
  horizonHours: number;
  expectedNaturalSales: number;
  confidence: number;
  methodUsed: ForecastMethod;
}

export interface WasteRiskAssessment {
  productId: string;
  productName: string;
  currentStock: number;
  expectedNaturalSales: number;
  expectedSurplus: number;
  wasteRiskLevel: WasteRiskLevel;
  remainingOperatingHours: number;
  projectedWasteCost: number;
  reason: string;
}

export interface BundleCandidate {
  bundleId: string;
  title: string;
  tagline: string;
  beverageId: string;
  beverageName: string;
  beveragePrice: number;
  beverageCost: number;
  pastryId: string;
  pastryName: string;
  pastryPrice: number;
  pastryCost: number;
  normalPrice: number;
  totalCost: number;
  recommendedPrice: number;
  discountPercent: number;
  grossMarginAmount: number;
  grossMarginPercent: number;
  projectedWasteReductionPercent: number;
  projectedWasteSavedUnits: number;
  riskTier: PromotionRiskTier;
  requiresApproval: boolean;
  durationMinutes: number;
  expiresAt: number;
}

export interface YieldFlashDealRecord {
  id: string;
  idempotencyKey: string;
  storeId: string;
  status: PromotionStatus;
  candidate: BundleCandidate;
  triggerReason: "weather" | "bakery_spoilage_prevention" | "manual";
  createdAt: number;
  publishedAt?: number;
  expiresAt: number;
  approvedBy?: string;
  autoApproved: boolean;
  // Post-campaign performance tracking
  unitsSold: number;
  wasteAvoidedUnits: number;
  revenueGenerated: number;
  discountCostTotal: number;
  marginEarnedTotal: number;
}

export interface YieldOptimizerMetrics {
  pastryUnitsEvaluated: number;
  surplusUnitsDetected: number;
  promotionsCreated: number;
  promotionsPublished: number;
  unitsSoldThroughPromotion: number;
  wasteAvoidedUnits: number;
  wasteRemainingUnits: number;
  wasteReductionRate: number; // 0 - 100%
  totalRevenueRecovered: number;
  totalDiscountCost: number;
  totalGrossMarginEarned: number;
  avgDiscountPercent: number;
}

export interface YieldOptimizerAuditLog {
  runId: string;
  agentName: "YieldOptimizer";
  storeId: string;
  timestamp: number;
  triggerEvent: string;
  activeSurplusUnits: number;
  wasteRisk: WasteRiskLevel;
  candidateBundlesCount: number;
  selectedBundleId?: string;
  discountPercent?: number;
  grossMarginPercent?: number;
  approvalStatus: string;
  decision: string;
  toolsCalled: string[];
  executionResult: "SUCCESS" | "REJECTED" | "NO_ACTION";
  latencyMs: number;
  error?: string;
}

export interface YieldOptimizerEvent {
  type:
    | "INVENTORY_UPDATED"
    | "ORDER_COMPLETED"
    | "PASTRY_SURPLUS_DETECTED"
    | "WASTE_RISK_HIGH"
    | "FLASH_DEAL_CREATED"
    | "FLASH_DEAL_PUBLISHED"
    | "FLASH_DEAL_EXPIRED"
    | "STORE_CLOSING_SOON";
  storeId: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}
