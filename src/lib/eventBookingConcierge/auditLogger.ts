// Structured Audit Logger for Agent 4: 🎪 Event Booking Concierge
import { EventConciergeAuditLog } from "./types";

const AUDIT_BUFFER: EventConciergeAuditLog[] = [];
const MAX_LOG_SIZE = 100;

/**
 * Records a structured audit log entry for Event Booking Concierge executions.
 */
export function recordConciergeAuditLog(
  entry: Omit<EventConciergeAuditLog, "agentName">
): EventConciergeAuditLog {
  const fullLog: EventConciergeAuditLog = {
    ...entry,
    agentName: "EventBookingConcierge",
  };

  AUDIT_BUFFER.unshift(fullLog);
  if (AUDIT_BUFFER.length > MAX_LOG_SIZE) {
    AUDIT_BUFFER.pop();
  }

  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        level: fullLog.error ? "error" : "info",
        service: "EventBookingConcierge",
        runId: fullLog.runId,
        customerId: fullLog.customerId,
        quoteId: fullLog.quoteId,
        bookingId: fullLog.bookingId,
        timestamp: fullLog.timestamp,
        trigger: fullLog.trigger,
        guestCount: fullLog.guestCount,
        eventType: fullLog.eventType,
        totalAmount: fullLog.totalAmount,
        grossMarginPercent: fullLog.grossMarginPercent,
        riskTier: fullLog.riskTier,
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

export function getRecentConciergeAuditLogs(limit: number = 25): EventConciergeAuditLog[] {
  return AUDIT_BUFFER.slice(0, limit);
}

export function clearConciergeAuditLogs(): void {
  AUDIT_BUFFER.length = 0;
}
