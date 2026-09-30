// Production Yield Optimizer Agent Core: ⚡ Yield Optimizer
// Autonomous, deterministic margin-safe pastry waste mitigation agent.

import {
  WasteRiskAssessment,
  BundleCandidate,
  YieldFlashDealRecord,
  YieldOptimizerAuditLog,
} from "./types";
import {
  tool_get_pastry_inventory,
  tool_get_pastry_item,
  tool_get_operating_hours,
  tool_calculate_waste_risk,
  tool_generate_bundle_candidates,
  tool_create_flash_deal,
  tool_get_yield_metrics,
} from "./tools";
import { recordYieldAuditLog } from "./auditLogger";

export interface YieldOptimizerCycleResult {
  runId: string;
  storeId: string;
  timestamp: number;
  triggerEvent: string;
  evaluatedPastriesCount: number;
  totalSurplusUnits: number;
  highestRiskLevel: string;
  assessments: WasteRiskAssessment[];
  dealsGenerated: YieldFlashDealRecord[];
  auditLog: YieldOptimizerAuditLog;
  latencyMs: number;
}

/**
 * Runs a complete deterministic evaluation cycle of pastry inventory for a store.
 * Identifies surplus items at waste risk and automatically generates margin-safe
 * promotional flash deal bundles.
 */
export function runYieldOptimizerCycle(options: {
  storeId?: string;
  triggerEvent?: string;
  weatherCondition?: string;
  currentHour?: number;
} = {}): YieldOptimizerCycleResult {
  const startTime = performance.now();
  const storeId = options.storeId || "van-01";
  const triggerEvent = options.triggerEvent || "SCHEDULED_PERIODIC_CHECK";
  const runId = `yield-run-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const toolsCalled: string[] = [];

  try {
    // 1. Fetch store inventory & hours
    toolsCalled.push("tool_get_pastry_inventory");
    const pastries = tool_get_pastry_inventory(storeId);

    toolsCalled.push("tool_get_operating_hours");
    const hoursInfo = tool_get_operating_hours(storeId);

    const assessments: WasteRiskAssessment[] = [];
    const dealsGenerated: YieldFlashDealRecord[] = [];
    let totalSurplus = 0;
    let highestRisk: string = "SAFE";

    const riskRank: Record<string, number> = {
      SAFE: 0,
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      CRITICAL: 4,
    };

    // 2. Evaluate each pastry
    toolsCalled.push("tool_calculate_waste_risk");
    for (const pastry of pastries) {
      const risk = tool_calculate_waste_risk({
        product: pastry,
        remainingOperatingHours: hoursInfo.remainingOperatingHours,
        currentHour: options.currentHour,
      });

      assessments.push(risk);
      totalSurplus += risk.expectedSurplus;

      if ((riskRank[risk.wasteRiskLevel] ?? 0) > (riskRank[highestRisk] ?? 0)) {
        highestRisk = risk.wasteRiskLevel;
      }

      // If actionable risk (surplus > 0, not expired)
      if (
        risk.wasteRiskLevel !== "SAFE" &&
        risk.expectedSurplus > 0 &&
        !pastry.isExpired &&
        pastry.remainingShelfLifeHours > 0
      ) {
        // Generate bundle candidates
        toolsCalled.push("tool_generate_bundle_candidates");
        const candidates = tool_generate_bundle_candidates({
          surplusPastry: pastry,
          riskAssessment: risk,
          remainingOperatingHours: hoursInfo.remainingOperatingHours,
          weatherCondition: options.weatherCondition,
        });

        if (candidates.length > 0) {
          // Select optimal candidate (first one is top-ranked)
          const bestCandidate = candidates[0];

          toolsCalled.push("tool_create_flash_deal");
          const dealResult = tool_create_flash_deal({
            storeId,
            candidate: bestCandidate,
            triggerReason: options.weatherCondition ? "weather" : "bakery_spoilage_prevention",
          });

          if (dealResult.success && dealResult.deal) {
            dealsGenerated.push(dealResult.deal);
          }
        }
      }
    }

    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    const firstDeal = dealsGenerated[0];

    const audit = recordYieldAuditLog({
      runId,
      storeId,
      timestamp: Date.now(),
      triggerEvent,
      activeSurplusUnits: totalSurplus,
      wasteRisk: highestRisk as any,
      candidateBundlesCount: dealsGenerated.length,
      selectedBundleId: firstDeal?.candidate.bundleId,
      discountPercent: firstDeal?.candidate.discountPercent,
      grossMarginPercent: firstDeal?.candidate.grossMarginPercent,
      approvalStatus: firstDeal?.status || "NONE",
      decision:
        dealsGenerated.length > 0
          ? `Generated ${dealsGenerated.length} margin-safe flash deal(s) targeting ${totalSurplus} surplus unit(s).`
          : totalSurplus > 0
          ? `Evaluated ${totalSurplus} surplus unit(s); no viable margin deals or items expired.`
          : "Inventory balanced: All pastry stocks projected to clear naturally before closing.",
      toolsCalled: Array.from(new Set(toolsCalled)),
      executionResult: dealsGenerated.length > 0 ? "SUCCESS" : "NO_ACTION",
      latencyMs,
    });

    return {
      runId,
      storeId,
      timestamp: Date.now(),
      triggerEvent,
      evaluatedPastriesCount: pastries.length,
      totalSurplusUnits: totalSurplus,
      highestRiskLevel: highestRisk,
      assessments,
      dealsGenerated,
      auditLog: audit,
      latencyMs,
    };
  } catch (err: any) {
    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    const errorAudit = recordYieldAuditLog({
      runId,
      storeId,
      timestamp: Date.now(),
      triggerEvent,
      activeSurplusUnits: 0,
      wasteRisk: "SAFE",
      candidateBundlesCount: 0,
      approvalStatus: "FAILED",
      decision: "Yield optimization cycle failed due to unexpected internal error.",
      toolsCalled: Array.from(new Set(toolsCalled)),
      executionResult: "REJECTED",
      latencyMs,
      error: err?.message || String(err),
    });

    return {
      runId,
      storeId,
      timestamp: Date.now(),
      triggerEvent,
      evaluatedPastriesCount: 0,
      totalSurplusUnits: 0,
      highestRiskLevel: "SAFE",
      assessments: [],
      dealsGenerated: [],
      auditLog: errorAudit,
      latencyMs,
    };
  }
}

/**
 * Quick single-item pastry evaluation for real-time order completion hook or UI inspection.
 */
export function evaluatePastryItem(
  productId: string,
  weatherCondition?: string,
  currentHour?: number
): {
  assessment: WasteRiskAssessment | null;
  bundleCandidates: BundleCandidate[];
} {
  const item = tool_get_pastry_item(productId);
  if (!item) return { assessment: null, bundleCandidates: [] };

  const hoursInfo = tool_get_operating_hours();
  const assessment = tool_calculate_waste_risk({
    product: item,
    remainingOperatingHours: hoursInfo.remainingOperatingHours,
    currentHour,
  });

  const bundleCandidates =
    assessment.wasteRiskLevel !== "SAFE" && !item.isExpired && item.remainingShelfLifeHours > 0
      ? tool_generate_bundle_candidates({
          surplusPastry: item,
          riskAssessment: assessment,
          remainingOperatingHours: hoursInfo.remainingOperatingHours,
          weatherCondition,
        })
      : [];

  return { assessment, bundleCandidates };
}

/**
 * Returns complete operational status for the Barista UI dashboard.
 */
export function getYieldOptimizerStatus(storeId: string = "van-01") {
  const pastries = tool_get_pastry_inventory(storeId);
  const hoursInfo = tool_get_operating_hours(storeId);
  const metrics = tool_get_yield_metrics();

  const assessments = pastries.map((p) =>
    tool_calculate_waste_risk({
      product: p,
      remainingOperatingHours: hoursInfo.remainingOperatingHours,
    })
  );

  return {
    storeHours: hoursInfo.hoursStr,
    closingHour: hoursInfo.closingHour,
    remainingOperatingHours: hoursInfo.remainingOperatingHours,
    assessments,
    metrics,
  };
}
