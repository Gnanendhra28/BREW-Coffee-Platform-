// Recovery State Machine & Transition Validator for Agent 6: ❤️ Guest Sentiment Guardian
// Enforces strict, deterministic progression through the customer recovery lifecycle.

import {
  RecoveryStatus,
  RecoveryRecord,
} from "./types";

const VALID_RECOVERY_TRANSITIONS: Record<RecoveryStatus, RecoveryStatus[]> = {
  RECEIVED: ["ANALYZING", "CANCELLED", "NO_ACTION"],
  ANALYZING: ["CLASSIFIED", "ESCALATED", "FAILED"],
  CLASSIFIED: ["ELIGIBILITY_CHECKED", "ESCALATED", "NO_ACTION"],
  ELIGIBILITY_CHECKED: ["RECOVERY_PENDING", "APPROVED", "NO_ACTION", "ESCALATED"],
  RECOVERY_PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ISSUED", "CANCELLED"],
  ISSUED: ["DELIVERED", "RESOLVED", "CANCELLED"],
  DELIVERED: ["RESOLVED"],
  RESOLVED: [],
  NO_ACTION: [],
  ESCALATED: ["RESOLVED", "REJECTED", "CANCELLED"],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: ["ANALYZING", "CANCELLED"],
};

export function isValidRecoveryTransition(from: RecoveryStatus, to: RecoveryStatus): boolean {
  return VALID_RECOVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

// In-Memory store of active and resolved recovery records
const RECOVERY_RECORDS = new Map<string, RecoveryRecord>();
const FEEDBACK_RECOVERY_INDEX = new Map<string, string>(); // feedbackId -> recoveryId

export function resetRecoveryRecordsStore(): void {
  RECOVERY_RECORDS.clear();
  FEEDBACK_RECOVERY_INDEX.clear();
}

export function saveRecoveryRecord(record: RecoveryRecord): void {
  RECOVERY_RECORDS.set(record.recoveryId, record);
  FEEDBACK_RECOVERY_INDEX.set(record.feedbackId, record.recoveryId);
}

export function getRecoveryRecord(recoveryId: string): RecoveryRecord | undefined {
  return RECOVERY_RECORDS.get(recoveryId);
}

export function getRecoveryRecordByFeedbackId(feedbackId: string): RecoveryRecord | undefined {
  const id = FEEDBACK_RECOVERY_INDEX.get(feedbackId);
  if (!id) return undefined;
  return RECOVERY_RECORDS.get(id);
}

export function listRecoveryRecords(storeId?: string): RecoveryRecord[] {
  const all = Array.from(RECOVERY_RECORDS.values());
  if (storeId) {
    return all.filter((r) => r.storeId === storeId);
  }
  return all;
}

/**
 * Updates a recovery record status with transition validation.
 * Safely handles idempotent / repeated approvals.
 */
export function transitionRecoveryStatus(
  recoveryId: string,
  newStatus: RecoveryStatus,
  options: {
    approvedBy?: string;
    resolvedAt?: number;
  } = {}
): RecoveryRecord {
  const record = RECOVERY_RECORDS.get(recoveryId);
  if (!record) {
    throw new Error(`Recovery record '${recoveryId}' not found.`);
  }

  // Idempotent no-op if already in desired state
  if (record.status === newStatus) {
    return record;
  }

  if (!isValidRecoveryTransition(record.status, newStatus)) {
    throw new Error(
      `Invalid recovery status transition from '${record.status}' to '${newStatus}'.`
    );
  }

  record.status = newStatus;
  if (options.approvedBy) record.approvedBy = options.approvedBy;
  if (options.resolvedAt) record.resolvedAt = options.resolvedAt;

  if (newStatus === "RESOLVED" && !record.resolvedAt) {
    record.resolvedAt = Date.now();
  }

  RECOVERY_RECORDS.set(recoveryId, record);
  return record;
}
