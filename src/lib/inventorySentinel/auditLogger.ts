// Structured Audit Logger for Inventory Sentinel Agent
import { SentinelAgentAuditLog } from "./types";

const AUDIT_LOG_BUFFER: SentinelAgentAuditLog[] = [];
const MAX_LOG_BUFFER_SIZE = 100;

/**
 * Records a structured audit entry for an Inventory Sentinel agent run.
 */
export function recordAuditLog(entry: Omit<SentinelAgentAuditLog, "agentName">): SentinelAgentAuditLog {
  const fullLog: SentinelAgentAuditLog = {
    ...entry,
    agentName: "InventorySentinel",
  };

  AUDIT_LOG_BUFFER.unshift(fullLog);
  if (AUDIT_LOG_BUFFER.length > MAX_LOG_BUFFER_SIZE) {
    AUDIT_LOG_BUFFER.pop();
  }

  // Structured stdout log (Pino / Axiom compatible)
  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        level: fullLog.executionResult === "FAILED" ? "error" : "info",
        service: "InventorySentinel",
        runId: fullLog.runId,
        storeId: fullLog.storeId,
        triggerEvent: fullLog.triggerEvent,
        decision: fullLog.decision,
        recommendedAction: fullLog.recommendedAction,
        toolsCalled: fullLog.toolsCalled,
        latencyMs: fullLog.latencyMs,
        timestamp: fullLog.timestamp,
        error: fullLog.error,
      })
    );
  }

  return fullLog;
}

/**
 * Retrieves the recent audit log trail.
 */
export function getRecentAuditLogs(limit: number = 20): SentinelAgentAuditLog[] {
  return AUDIT_LOG_BUFFER.slice(0, limit);
}
