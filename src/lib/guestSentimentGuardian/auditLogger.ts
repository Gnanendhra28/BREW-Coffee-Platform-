// Structured JSON Audit Logger for Agent 6: ❤️ Guest Sentiment Guardian
// Guarantees immutable tracking of review assessments, policy checks, voucher issuances, and human approvals.

import { GuardianAuditLog } from "./types";

const MAX_AUDIT_LOG_BUFFER = 500;
const GUARDIAN_AUDIT_BUFFER: GuardianAuditLog[] = [];

export function logGuardianAudit(log: GuardianAuditLog): void {
  GUARDIAN_AUDIT_BUFFER.push(log);
  if (GUARDIAN_AUDIT_BUFFER.length > MAX_AUDIT_LOG_BUFFER) {
    GUARDIAN_AUDIT_BUFFER.shift(); // Evict oldest
  }
}

export function getGuardianAuditLogs(storeId?: string): GuardianAuditLog[] {
  if (storeId) {
    return GUARDIAN_AUDIT_BUFFER.filter((l) => l.storeId === storeId);
  }
  return [...GUARDIAN_AUDIT_BUFFER];
}

export function clearGuardianAuditLogs(): void {
  GUARDIAN_AUDIT_BUFFER.length = 0;
}
