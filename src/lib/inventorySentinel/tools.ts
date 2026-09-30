// Controlled Agent Tool Execution Layer for Inventory Sentinel
// Enforces:
// 1. Strict parameter validation (positive quantities, valid store IDs, allowed suppliers)
// 2. Safe read abstractions without raw database writes
// 3. Idempotent purchase order and restock request dispatching

import {
  TrackedIngredient,
  RestockRequest,
  StockoutPrediction,
  DemandForecast,
} from "./types";
import {
  getTrackedIngredients,
  analyzeConsumptionRates,
  forecastDemand,
  calculateSafetyStock,
  calculateReorderPoint,
  calculateReorderQuantity,
  evaluateIngredientStockout,
} from "./calculations";
import { getSupplier, findBestSupplierForIngredient } from "./suppliers";
import { getRecipeForItem, calculateOrderIngredients } from "./recipes";
import {
  generateIdempotencyKey,
  isActionDuplicate,
  registerAction,
  validateActionSafety,
} from "./policy";
import { InventoryStock, DEFAULT_INVENTORY_STOCK } from "./types";

// In-memory pending purchase orders / restock requests registry
const ACTIVE_RESTOCK_REQUESTS: RestockRequest[] = [];

// Working state cache for standalone testing / serverless runs
let CURRENT_SERVER_STOCK: InventoryStock = { ...DEFAULT_INVENTORY_STOCK };

export function updateServerStockCache(patch: Partial<InventoryStock>): void {
  CURRENT_SERVER_STOCK = { ...CURRENT_SERVER_STOCK, ...patch };
}

export function getServerStockCache(): InventoryStock {
  return CURRENT_SERVER_STOCK;
}

// -------------------------------------------------------------
// CONTROLLED TOOL IMPLEMENTATIONS
// -------------------------------------------------------------

export function tool_get_inventory(_storeId: string = "van-01"): TrackedIngredient[] {
  void _storeId;
  return getTrackedIngredients(CURRENT_SERVER_STOCK);
}

export function tool_get_inventory_item(
  _storeId: string = "van-01",
  ingredientId: string
): TrackedIngredient | null {
  void _storeId;
  const all = getTrackedIngredients(CURRENT_SERVER_STOCK);
  return all.find((item) => item.id === ingredientId) || null;
}

export function tool_get_pending_purchase_orders(storeId: string = "van-01"): RestockRequest[] {
  return ACTIVE_RESTOCK_REQUESTS.filter(
    (req) => req.storeId === storeId && (req.status === "pending" || req.status === "approved" || req.status === "dispatched")
  );
}

export function tool_get_recipe(itemName: string) {
  return getRecipeForItem(itemName);
}

export function tool_calculate_consumption(items: { name: string; quantity: number }[]) {
  return calculateOrderIngredients(items);
}

export function tool_forecast_demand(
  storeId: string = "van-01",
  ingredientId: string
): DemandForecast | null {
  const item = tool_get_inventory_item(storeId, ingredientId);
  if (!item) return null;

  const analytics = analyzeConsumptionRates(item);
  return forecastDemand(item, analytics, item.leadTimeHours);
}

export function tool_calculate_stockout(
  storeId: string = "van-01",
  ingredientId: string
): StockoutPrediction | null {
  const item = tool_get_inventory_item(storeId, ingredientId);
  if (!item) return null;

  const analytics = analyzeConsumptionRates(item);
  const forecast = forecastDemand(item, analytics, item.leadTimeHours);
  return evaluateIngredientStockout(item, analytics, forecast);
}

export function tool_calculate_reorder_point(
  storeId: string = "van-01",
  ingredientId: string
): { reorderPoint: number; safetyStock: number } | null {
  const item = tool_get_inventory_item(storeId, ingredientId);
  if (!item) return null;

  const analytics = analyzeConsumptionRates(item);
  const forecast = forecastDemand(item, analytics, item.leadTimeHours);
  const safetyStock = calculateSafetyStock(item, forecast.predictedRatePerHour, item.leadTimeHours);
  const reorderPoint = calculateReorderPoint(forecast.predictedRatePerHour, item.leadTimeHours, safetyStock);

  return { reorderPoint, safetyStock };
}

export function tool_calculate_reorder_quantity(
  storeId: string = "van-01",
  ingredientId: string
): { recommendedQuantity: number; recommendedPacks: number; estimatedCost: number } | null {
  const item = tool_get_inventory_item(storeId, ingredientId);
  if (!item) return null;

  const analytics = analyzeConsumptionRates(item);
  const forecast = forecastDemand(item, analytics, item.leadTimeHours);
  const safetyStock = calculateSafetyStock(item, forecast.predictedRatePerHour, item.leadTimeHours);

  return calculateReorderQuantity(
    item,
    forecast.predictedDemandLeadTime,
    safetyStock,
    item.incomingQuantity
  );
}

export function tool_get_supplier(supplierId: string) {
  return getSupplier(supplierId);
}

/**
 * Creates a structured restock request with strict safety checks and idempotency.
 */
export function tool_create_restock_request(params: {
  storeId: string;
  ingredientId: string;
  quantityUnits: number;
  reason?: string;
}): { success: boolean; request?: RestockRequest; error?: string; isDuplicate?: boolean } {
  const item = tool_get_inventory_item(params.storeId, params.ingredientId);
  if (!item) {
    return { success: false, error: `Invalid ingredientId: ${params.ingredientId}` };
  }

  const supplier = getSupplier(item.supplierId) || findBestSupplierForIngredient(item.category);
  const quantityPacks = Math.max(item.minimumOrderQuantity, Math.ceil(params.quantityUnits / item.packSize));
  const estimatedCost = quantityPacks * item.costPerPack;

  // 1. Safety validation
  const safety = validateActionSafety({
    storeId: params.storeId,
    ingredientId: params.ingredientId,
    quantityUnits: params.quantityUnits,
    quantityPacks,
    estimatedCost,
    maxVanCapacity: item.maxVanCapacity,
    currentStock: item.currentStock,
  });

  if (!safety.valid) {
    return { success: false, error: safety.reason };
  }

  // 2. Idempotency Check
  const idempotencyKey = generateIdempotencyKey(params.storeId, params.ingredientId, "RESTOCK_REQUEST");
  const dupCheck = isActionDuplicate(idempotencyKey);
  if (dupCheck.isDuplicate && dupCheck.existingRequest) {
    return {
      success: true,
      request: dupCheck.existingRequest,
      isDuplicate: true,
      error: "Idempotent: An active restock request for this ingredient already exists in this period.",
    };
  }

  // 3. Create Request
  const requestId = `po-req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const restockRequest: RestockRequest = {
    id: requestId,
    idempotencyKey,
    storeId: params.storeId,
    ingredientId: params.ingredientId,
    ingredientName: item.name,
    quantityPacks,
    quantityUnits: quantityPacks * item.packSize,
    unit: item.unit,
    supplierId: supplier.id,
    supplierName: supplier.name,
    estimatedCost,
    status: "pending",
    riskTier: safety.riskTier,
    requiresApproval: safety.requiresApproval,
    approvalStatus: safety.requiresApproval ? "pending_barista" : "auto_approved",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reason: params.reason || `Automated Sentinel restock: approaching depletion threshold.`,
  };

  registerAction(idempotencyKey, restockRequest);
  ACTIVE_RESTOCK_REQUESTS.unshift(restockRequest);

  return { success: true, request: restockRequest };
}

/**
 * Dispatches an automated managerial notification for critical/high risk conditions.
 */
export function tool_notify_manager(params: {
  storeId: string;
  severity: "critical" | "warning";
  title: string;
  message: string;
  ingredientId?: string;
}): { delivered: boolean; notificationId: string } {
  const notificationId = `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  if (process.env.NODE_ENV !== "test") {
    console.log(
      `[SENTINEL NOTIFICATION] [${params.severity.toUpperCase()}] Store: ${params.storeId} — ${params.title}: ${params.message}`
    );
  }

  return { delivered: true, notificationId };
}
