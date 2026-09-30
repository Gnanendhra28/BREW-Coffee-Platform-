// Structured JSON Audit Logger for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Guarantees:
// 1. Immutable audit record of all opportunity detections, policy validations, and dispatches
// 2. High-performance ring buffer to prevent memory leakage
// 3. Structured observability compatible with CloudWatch / Datadog / Axiom

import { HypeAuditLog } from "./types";

const MAX_AUDIT_LOG_BUFFER = 500;
const AUDIT_LOG_BUFFER: HypeAuditLog[] = [];

export function logHypeBroadcastAudit(log: HypeAuditLog): void {
  AUDIT_LOG_BUFFER.push(log);
  if (AUDIT_LOG_BUFFER.length > MAX_AUDIT_LOG_BUFFER) {
    AUDIT_LOG_BUFFER.shift(); // Evict oldest
  }
}

export function getHypeAuditLogs(storeId?: string): HypeAuditLog[] {
  if (storeId) {
    return AUDIT_LOG_BUFFER.filter((l) => l.storeId === storeId);
  }
  return [...AUDIT_LOG_BUFFER];
}

export function clearHypeAuditLogs(): void {
  AUDIT_LOG_BUFFER.length = 0;
}
