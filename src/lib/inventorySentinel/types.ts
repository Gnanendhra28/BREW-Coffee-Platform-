// Production Types and Data Models for Agent 1: 🛡️ Inventory Sentinel

export type RiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type TrendDirection = "normal" | "increasing" | "decreasing" | "spike" | "drop";

export type ActionRiskTier = "LOW" | "MEDIUM" | "HIGH";

export type RestockStatus = "pending" | "approved" | "rejected" | "dispatched" | "received";

export interface InventoryStock {
  coffeeBeansKg: number;
  wholeMilkLiters: number;
  oatMilkLiters: number;
  vanillaGelatoTubs: number;
  paperCups: number;
  bakeryPastries: number;
  syrupsLiters: number;
  lastRestockedAt: number;
}

export const DEFAULT_INVENTORY_STOCK: InventoryStock = {
  coffeeBeansKg: 6.2,
  wholeMilkLiters: 12.5,
  oatMilkLiters: 4.0,
  vanillaGelatoTubs: 3.5,
  paperCups: 68,
  bakeryPastries: 14,
  syrupsLiters: 2.8,
  lastRestockedAt: Date.now(),
};

export interface TrackedIngredient {
  id: string;
  name: string;
  category: "coffee" | "dairy" | "bakery" | "packaging" | "syrups" | "ice" | "dessert";
  currentStock: number;
  unit: string; // "kg", "L", "units", "tubs"
  minimumOrderQuantity: number;
  packSize: number;
  packageUnit: string; // "2.5kg bag", "10L crate", "100-pack sleeve", "12-pc tray", "4-tub pack"
  supplierId: string;
  costPerPack: number;
  maxVanCapacity: number;
  leadTimeHours: number;
  safetyStockBuffer: number;
  averageBurnRatePerHour: number;
  incomingQuantity: number;
}

export interface IngredientConsumptionRecord {
  id: string;
  timestamp: number;
  orderId: string;
  ingredientId: string;
  quantityConsumed: number;
  unit: string;
  reason: "customer_order" | "spillage" | "calibration" | "audit";
}

export interface ConsumptionRateAnalytics {
  ingredientId: string;
  rateLast1h: number;
  rateLast6h: number;
  rateLast24h: number;
  rateLast7d: number;
  normalizedRatePerHour: number;
  trend: TrendDirection;
  isAnomaly: boolean;
  anomalyReason?: string;
  baselineRate: number;
}

export interface DemandForecast {
  ingredientId: string;
  predictedRatePerHour: number;
  predictedDemandNext24h: number;
  predictedDemandLeadTime: number;
  confidence: number;
  methodUsed: "historical_rush" | "rolling_window" | "current_velocity" | "configured_baseline";
}

export interface StockoutPrediction {
  ingredientId: string;
  ingredientName: string;
  currentStock: number;
  unit: string;
  predictedConsumptionRate: number; // units per hour
  stockoutHours: number | null;
  predictedStockoutTimestamp: number | null;
  riskLevel: RiskLevel;
  safetyStock: number;
  reorderPoint: number;
  recommendedOrderQuantity: number;
  incomingQuantity: number;
  leadTimeHours: number;
  recommendationText: string;
}

export interface SupplierProfile {
  id: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  leadTimeHours: number;
  minOrderQuantity: number;
  packSize: number;
  packageUnit: string;
  costPerPack: number;
  reliabilityScore: number; // 0.0 - 1.0 (e.g. 0.98)
  available: boolean;
}

export interface RestockRequest {
  id: string;
  idempotencyKey: string;
  storeId: string;
  ingredientId: string;
  ingredientName: string;
  quantityPacks: number;
  quantityUnits: number;
  unit: string;
  supplierId: string;
  supplierName: string;
  estimatedCost: number;
  status: RestockStatus;
  riskTier: ActionRiskTier;
  requiresApproval: boolean;
  approvalStatus?: "auto_approved" | "pending_barista" | "approved" | "rejected";
  createdAt: number;
  updatedAt: number;
  reason: string;
}

export interface InventoryHealthScore {
  score: number; // 0 - 100
  status: "EXCELLENT" | "HEALTHY" | "ATTENTION" | "CRITICAL";
  stockCoverageRatio: number;
  stockoutRiskIndex: number;
  demandVolatilityRatio: number;
  supplierReliabilityIndex: number;
  inboundCoverageIndex: number;
}

export interface InventoryHealthReport {
  timestamp: number;
  storeId: string;
  healthScore: InventoryHealthScore;
  criticalAlertsCount: number;
  warningAlertsCount: number;
  ingredients: StockoutPrediction[];
  anomaliesDetected: {
    ingredientId: string;
    ingredientName: string;
    description: string;
    suggestedAction: string;
  }[];
}

export interface SentinelAgentAuditLog {
  runId: string;
  agentName: "InventorySentinel";
  storeId: string;
  triggerEvent: string;
  timestamp: number;
  inputContext: Record<string, unknown>;
  decision: string;
  toolsCalled: string[];
  recommendedAction: string;
  executedAction: string;
  approvalStatus: string;
  executionResult: "SUCCESS" | "FAILED" | "FALLBACK";
  latencyMs: number;
  error?: string;
}

export interface InventorySentinelEvent {
  type:
    | "ORDER_COMPLETED"
    | "INVENTORY_UPDATED"
    | "INVENTORY_LOW"
    | "PURCHASE_ORDER_CREATED"
    | "PURCHASE_ORDER_RECEIVED"
    | "SUPPLIER_DELAYED";
  storeId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}
