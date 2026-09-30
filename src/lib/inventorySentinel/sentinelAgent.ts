// Autonomous Inventory Sentinel Agent Core Orchestrator
import {
  StockoutPrediction,
  ConsumptionRateAnalytics,
  InventoryHealthReport,
  RestockRequest,
  InventoryStock,
} from "./types";
import {
  getTrackedIngredients,
  analyzeConsumptionRates,
  forecastDemand,
  evaluateIngredientStockout,
  calculateInventoryHealthScore,
} from "./calculations";
import {
  tool_create_restock_request,
  tool_notify_manager,
  getServerStockCache,
} from "./tools";
import { recordAuditLog } from "./auditLogger";

export interface SentinelRunResult {
  runId: string;
  timestamp: number;
  storeId: string;
  healthReport: InventoryHealthReport;
  autoCreatedRestocks: RestockRequest[];
  alertsGenerated: {
    severity: "critical" | "warning";
    ingredient: string;
    message: string;
  }[];
  agentSummary: string;
  latencyMs: number;
}

/**
 * Runs a complete autonomous Inventory Sentinel intelligence cycle.
 * Tiered architecture:
 * 1. Fast deterministic computations (< 2ms)
 * 2. Risk & anomaly evaluation
 * 3. Autonomous action policy (idempotent restock creation & notifications)
 * 4. Structured reasoning & audit logging
 */
export function runInventorySentinelCycle(
  storeId: string = "van-01",
  triggerEvent: string = "SCHEDULED_POLL",
  currentStockOverride?: InventoryStock,
  pendingInbound: Partial<Record<keyof InventoryStock, number>> = {}
): SentinelRunResult {
  const startTime = performance.now();
  const runId = `sentinel-run-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  const stock = currentStockOverride || getServerStockCache();
  const trackedIngredients = getTrackedIngredients(stock, pendingInbound);

  const analyticsList: ConsumptionRateAnalytics[] = [];
  const predictions: StockoutPrediction[] = [];
  const autoCreatedRestocks: RestockRequest[] = [];
  const alertsGenerated: SentinelRunResult["alertsGenerated"] = [];
  const toolsCalled: string[] = ["get_inventory", "forecast_demand", "calculate_stockout"];

  // 1. Evaluate every tracked ingredient deterministically
  for (const ingredient of trackedIngredients) {
    const analytics = analyzeConsumptionRates(ingredient);
    analyticsList.push(analytics);

    const forecast = forecastDemand(ingredient, analytics, ingredient.leadTimeHours);
    const prediction = evaluateIngredientStockout(ingredient, analytics, forecast);
    predictions.push(prediction);

    // 2. Autonomous Action Policy: Trigger action when risk is HIGH or CRITICAL
    if (prediction.riskLevel === "CRITICAL" || prediction.riskLevel === "HIGH") {
      // Create idempotent restock request
      const restockResult = tool_create_restock_request({
        storeId,
        ingredientId: ingredient.id,
        quantityUnits: prediction.recommendedOrderQuantity,
        reason: prediction.recommendationText,
      });

      toolsCalled.push("create_restock_request");

      if (restockResult.success && restockResult.request) {
        autoCreatedRestocks.push(restockResult.request);
      }

      // Dispatch alert
      const severity = prediction.riskLevel === "CRITICAL" ? "critical" : "warning";
      tool_notify_manager({
        storeId,
        severity,
        title: `${prediction.ingredientName} ${prediction.riskLevel} Stockout Risk`,
        message: prediction.recommendationText,
        ingredientId: ingredient.id,
      });

      toolsCalled.push("notify_manager");

      alertsGenerated.push({
        severity,
        ingredient: prediction.ingredientName,
        message: prediction.recommendationText,
      });
    }
  }

  // 3. Detect consumption anomalies
  const anomaliesDetected = analyticsList
    .filter((a) => a.isAnomaly)
    .map((a) => {
      const ing = trackedIngredients.find((i) => i.id === a.ingredientId);
      return {
        ingredientId: a.ingredientId,
        ingredientName: ing ? ing.name : a.ingredientId,
        description: a.anomalyReason || "Unusual deviation from normal baseline burn rate.",
        suggestedAction: "Audit physical count in rear storage vault and inspect recipe calibrations.",
      };
    });

  // 4. Calculate Deterministic Composite Health Score
  const healthScore = calculateInventoryHealthScore(predictions, analyticsList);

  const healthReport: InventoryHealthReport = {
    timestamp: Date.now(),
    storeId,
    healthScore,
    criticalAlertsCount: predictions.filter((p) => p.riskLevel === "CRITICAL").length,
    warningAlertsCount: predictions.filter((p) => p.riskLevel === "HIGH" || p.riskLevel === "MEDIUM").length,
    ingredients: predictions,
    anomaliesDetected,
  };

  // 5. Compose structured human-readable summary
  let agentSummary = `Inventory Health is ${healthScore.status} (${healthScore.score}/100). `;
  if (healthReport.criticalAlertsCount > 0) {
    const criticals = predictions.filter((p) => p.riskLevel === "CRITICAL").map((p) => p.ingredientName);
    agentSummary += `CRITICAL: Immediate replenishment required for ${criticals.join(", ")}. `;
  } else if (healthReport.warningAlertsCount > 0) {
    const highs = predictions.filter((p) => p.riskLevel === "HIGH").map((p) => p.ingredientName);
    agentSummary += `High stockout risk for ${highs.join(", ")}. Reorders created within safe lead time. `;
  } else {
    agentSummary += `All ingredients have healthy coverage for upcoming service velocity.`;
  }

  const latencyMs = Number((performance.now() - startTime).toFixed(2));

  // 6. Record Audit Log
  recordAuditLog({
    runId,
    storeId,
    triggerEvent,
    timestamp: Date.now(),
    inputContext: {
      activeIngredientsCount: trackedIngredients.length,
      criticalCount: healthReport.criticalAlertsCount,
    },
    decision: healthReport.criticalAlertsCount > 0 ? "ACTION_REQUIRED" : "MONITOR_CONTINUE",
    toolsCalled,
    recommendedAction: autoCreatedRestocks.length > 0 ? "RESTOCK_DISPATCHED" : "NO_ACTION",
    executedAction: autoCreatedRestocks.length > 0 ? `Created ${autoCreatedRestocks.length} PO(s)` : "None",
    approvalStatus: autoCreatedRestocks.some((r) => r.requiresApproval) ? "PENDING_APPROVAL" : "AUTO_CLEARED",
    executionResult: "SUCCESS",
    latencyMs,
  });

  return {
    runId,
    timestamp: Date.now(),
    storeId,
    healthReport,
    autoCreatedRestocks,
    alertsGenerated,
    agentSummary,
    latencyMs,
  };
}
