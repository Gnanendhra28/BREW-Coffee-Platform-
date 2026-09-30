// Structured Audit Logger for Yield Optimizer Agent
import { YieldOptimizerAuditLog } from "./types";

const AUDIT_BUFFER: YieldOptimizerAuditLog[] = [];
const MAX_LOG_SIZE = 100;

/**
 * Records a structured audit log entry for a yield optimizer execution.
 */
export function recordYieldAuditLog(
  entry: Omit<YieldOptimizerAuditLog, "agentName">
): YieldOptimizerAuditLog {
  const fullLog: YieldOptimizerAuditLog = {
    ...entry,
    agentName: "YieldOptimizer",
  };

  AUDIT_BUFFER.unshift(fullLog);
  if (AUDIT_BUFFER.length > MAX_LOG_SIZE) {
    AUDIT_BUFFER.pop();
  }

  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        level: fullLog.error ? "error" : "info",
        service: "YieldOptimizer",
        runId: fullLog.runId,
        storeId: fullLog.storeId,
        timestamp: fullLog.timestamp,
        triggerEvent: fullLog.triggerEvent,
        activeSurplusUnits: fullLog.activeSurplusUnits,
        wasteRisk: fullLog.wasteRisk,
        selectedBundleId: fullLog.selectedBundleId,
        discountPercent: fullLog.discountPercent,
        grossMarginPercent: fullLog.grossMarginPercent,
        approvalStatus: fullLog.approvalStatus,
        decision: fullLog.decision,
        toolsCalled: fullLog.toolsCalled,
        latencyMs: fullLog.latencyMs,
        error: fullLog.error,
      })
    );
  }

  return fullLog;
}

/**
 * Retrieves recent audit logs.
 */
export function getRecentYieldAuditLogs(limit: number = 25): YieldOptimizerAuditLog[] {
  return AUDIT_BUFFER.slice(0, limit);
}

/**
 * Clears audit buffer (useful for test isolation).
 */
export function clearYieldAuditLogs(): void {
  AUDIT_BUFFER.length = 0;
}
