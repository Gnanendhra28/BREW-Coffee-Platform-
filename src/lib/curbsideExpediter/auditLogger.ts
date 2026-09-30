// Structured Audit Logger for Curbside Drive-Thru Expediter
import { CurbsideAuditLog } from "./types";

const AUDIT_BUFFER: CurbsideAuditLog[] = [];
const MAX_AUDIT_LOG_BUFFER = 100;

/**
 * Records a structured audit entry for an expediter agent execution.
 */
export function recordCurbsideAuditLog(
  entry: Omit<CurbsideAuditLog, "agentName">
): CurbsideAuditLog {
  const fullLog: CurbsideAuditLog = {
    ...entry,
    agentName: "CurbsideExpediter",
  };

  AUDIT_BUFFER.unshift(fullLog);
  if (AUDIT_BUFFER.length > MAX_AUDIT_LOG_BUFFER) {
    AUDIT_BUFFER.pop();
  }

  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        level: fullLog.error ? "error" : "info",
        service: "CurbsideExpediter",
        runId: fullLog.runId,
        storeId: fullLog.storeId,
        orderId: fullLog.orderId,
        triggerEvent: fullLog.triggerEvent,
        urgency: fullLog.urgency,
        priority: fullLog.priority,
        decision: fullLog.decision,
        executedAction: fullLog.executedAction,
        slaStatus: fullLog.slaStatus,
        latencyMs: fullLog.latencyMs,
        timestamp: fullLog.timestamp,
        error: fullLog.error,
      })
    );
  }

  return fullLog;
}

/**
 * Retrieves the recent audit log history.
 */
export function getRecentCurbsideAuditLogs(limit: number = 25): CurbsideAuditLog[] {
  return AUDIT_BUFFER.slice(0, limit);
}

/**
 * Clears the audit buffer (primarily for unit testing isolation).
 */
export function clearCurbsideAuditLogs(): void {
  AUDIT_BUFFER.length = 0;
}
