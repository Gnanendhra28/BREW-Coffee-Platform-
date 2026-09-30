// Autonomous Curbside Drive-Thru Expediter Agent Core Orchestrator
// Pure Deterministic Execution: < 2ms latency SLA, 0 mandatory LLM dependencies.
// Synchronizes: Customer Order + Preparation Progress + Vehicle ETA + Arrival Signal + Handoff Handoff.

import { CurbsideExpediteAssessment } from "./types";
import { parseVehicleDetails } from "./calculations";
import {
  tool_get_order,
  tool_get_vehicle_eta,
  tool_get_preparation_estimate,
  tool_calculate_urgency,
  tool_calculate_priority,
  tool_prioritize_order,
  tool_notify_barista,
  tool_get_kds_queue,
} from "./tools";
import { mapOrderStatusToLifecycle } from "./stateMachine";
import { recordCurbsideAuditLog } from "./auditLogger";

export interface ExpediterAgentRunResult {
  runId: string;
  orderId: string;
  assessment: CurbsideExpediteAssessment;
  actionTaken: string;
  baristaNotified: boolean;
  latencyMs: number;
}

/**
 * Runs an autonomous expediting intelligence cycle for a specific order.
 */
export function runCurbsideExpediterCycle(
  orderId: string,
  storeId: string = "van-01",
  triggerEvent: string = "ETA_OR_STATE_UPDATE"
): ExpediterAgentRunResult | null {
  const startTime = performance.now();
  const runId = `expediter-run-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  const order = tool_get_order(orderId);
  if (!order) {
    return null;
  }

  // Curbside only: walk-up orders follow standard FIFO KDS queue
  if (order.pickupType !== "curbside") {
    return null;
  }

  // 1. Parse vehicle metadata
  const parsedVehicle = parseVehicleDetails(order.vehicleInfo);

  // 2. Compute deterministic preparation durations
  const prep = tool_get_preparation_estimate(order);

  // 3. Obtain vehicle ETA
  const eta = tool_get_vehicle_eta(orderId);

  // 4. Calculate Urgency & Recommended Action
  const urgency = tool_calculate_urgency(
    eta.etaSeconds,
    prep.remainingPrepSeconds,
    prep.isReady
  );

  // 5. Calculate Deterministic 0-100 Priority Score
  const priorityScore = tool_calculate_priority(
    urgency.urgencyLevel,
    urgency.arrivalBufferSeconds,
    prep.elapsedPrepSeconds,
    true
  );

  // 6. Map lifecycle state
  const lifecycleState = mapOrderStatusToLifecycle(order.status, order.curbsideArrivalStatus);

  // Target ready time formatted
  const targetReadyTime = new Date(prep.targetReadyTimestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const toolsCalled: string[] = ["get_order", "get_vehicle_eta", "get_preparation_estimate"];
  let actionTaken = "NORMAL_QUEUE";
  let baristaNotified = false;

  // 7. Execute Autonomous Expediting & Notification Policy
  if (
    (urgency.urgencyLevel === "URGENT" || urgency.urgencyLevel === "CRITICAL") &&
    order.status !== "served" &&
    order.status !== "cancelled"
  ) {
    // Prioritize in KDS
    const prioritizeRes = tool_prioritize_order({
      storeId,
      orderId,
      action: urgency.recommendedAction,
      urgency: urgency.urgencyLevel,
      reason: urgency.reason,
    });
    toolsCalled.push("prioritize_order");
    actionTaken = prioritizeRes.actionApplied;

    // Notify Barista (with automatic cooldown/debouncing)
    const notifRes = tool_notify_barista({
      orderId,
      orderNumber: order.orderNumber,
      urgency: urgency.urgencyLevel,
      message: urgency.reason,
    });
    toolsCalled.push("notify_barista");
    baristaNotified = notifRes.delivered;
  }

  const assessment: CurbsideExpediteAssessment = {
    orderId,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    vehicleInfo: order.vehicleInfo,
    parsedVehicle,
    lifecycleState,
    vehicleEtaSeconds: eta.etaSeconds,
    remainingPrepSeconds: prep.remainingPrepSeconds,
    arrivalBufferSeconds: urgency.arrivalBufferSeconds,
    urgencyLevel: urgency.urgencyLevel,
    recommendedAction: urgency.recommendedAction,
    priorityScore,
    reason: urgency.reason,
    requiresNotification: urgency.urgencyLevel === "URGENT" || urgency.urgencyLevel === "CRITICAL",
    targetReadyTime,
  };

  const latencyMs = Number((performance.now() - startTime).toFixed(2));

  // 8. Record Structured Audit Log
  recordCurbsideAuditLog({
    runId,
    storeId,
    orderId,
    triggerEvent,
    timestamp: Date.now(),
    vehicleEtaSeconds: eta.etaSeconds,
    remainingPrepSeconds: prep.remainingPrepSeconds,
    urgency: urgency.urgencyLevel,
    priority: priorityScore,
    decision: urgency.recommendedAction,
    toolsCalled,
    executedAction: actionTaken,
    latencyMs,
  });

  return {
    runId,
    orderId,
    assessment,
    actionTaken,
    baristaNotified,
    latencyMs,
  };
}

/**
 * Evaluates all active curbside orders and returns them sorted by priority score (descending).
 */
export function runAllActiveCurbsideAssessments(
  storeId: string = "van-01"
): CurbsideExpediteAssessment[] {
  const queue = tool_get_kds_queue(storeId);
  const curbsideOrders = queue.filter((o) => o.pickupType === "curbside");

  const results: CurbsideExpediteAssessment[] = [];

  for (const order of curbsideOrders) {
    const run = runCurbsideExpediterCycle(order.id, storeId, "BATCH_KDS_EVALUATION");
    if (run) {
      results.push(run.assessment);
    }
  }

  // Sort descending by priority score
  return results.sort((a, b) => b.priorityScore - a.priorityScore);
}
