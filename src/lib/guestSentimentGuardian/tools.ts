// Controlled Tool Execution Layer for Agent 6: ❤️ Guest Sentiment Guardian
// Exposes safe, validated domain tools without exposing direct arbitrary DB mutations.

import {
  CustomerFeedback,
  IssueCategory,
  SeverityLevel,
} from "./types";
import { classifySentiment } from "./classifier";
import { extractIssuesFromComment } from "./issueExtractor";
import { evaluateFeedbackSeverity } from "./severity";
import { getOrderContext, getCustomerProfile } from "./context";
import { correlateOperationalRootCauses } from "./correlation";
import { evaluateRecoveryPolicy } from "./recoveryPolicy";
import { issueCustomerRecoveryVoucher } from "./voucher";
import {
  getRecoveryRecord,
  transitionRecoveryStatus,
} from "./stateMachine";
import { getGuardianAnalytics } from "./analytics";
import { logGuardianAudit } from "./auditLogger";

/**
 * Tool 1: Classify sentiment and extract structured issues.
 */
export function tool_classify_and_extract_issues(params: {
  rating: number;
  comment: string;
}) {
  const sentiment = classifySentiment(params.rating, params.comment);
  const issues = extractIssuesFromComment(params.comment, params.rating);
  const severityResult = evaluateFeedbackSeverity(params.rating, params.comment, issues);

  return {
    success: true,
    rating: params.rating,
    sentiment,
    issues,
    severity: severityResult.severity,
    isCriticalSafety: severityResult.isCriticalSafety,
    criticalReason: severityResult.criticalReason,
  };
}

/**
 * Tool 2: Correlate operational root cause with order telemetry.
 */
export function tool_correlate_operational_events(params: {
  feedback: CustomerFeedback;
  issues: IssueCategory[];
  orderId?: string;
}) {
  const order = getOrderContext(params.orderId || params.feedback.orderId);
  const correlations = correlateOperationalRootCauses(params.feedback, params.issues, order);

  return {
    success: true,
    hasOrderContext: order !== null,
    orderId: order?.orderId,
    correlations,
  };
}

/**
 * Tool 3: Evaluate recovery policy eligibility.
 */
export function tool_check_recovery_eligibility(params: {
  feedback: CustomerFeedback;
  severityResult: { severity: SeverityLevel; isCriticalSafety: boolean };
}) {
  const customerProfile = getCustomerProfile(params.feedback.customerId);
  const order = getOrderContext(params.feedback.orderId);

  const policyResult = evaluateRecoveryPolicy({
    feedback: params.feedback,
    severity: params.severityResult.severity,
    isCriticalSafety: params.severityResult.isCriticalSafety,
    customerProfile,
    order,
  });

  return {
    success: true,
    policyResult,
  };
}

/**
 * Tool 4: Issue recovery voucher (idempotent & deterministic).
 */
export function tool_issue_recovery_voucher(params: {
  storeId: string;
  feedbackId: string;
  customerId?: string;
  amount: number;
}) {
  const { voucher, isExisting } = issueCustomerRecoveryVoucher({
    storeId: params.storeId,
    feedbackId: params.feedbackId,
    customerId: params.customerId,
    amount: params.amount,
  });

  return {
    success: true,
    isExisting,
    voucher,
  };
}

/**
 * Tool 5: Approve recovery (Human Barista / Manager).
 */
export function tool_approve_recovery(params: {
  recoveryId: string;
  approvedBy: string;
}) {
  const record = getRecoveryRecord(params.recoveryId);
  if (!record) {
    return { success: false, error: `Recovery '${params.recoveryId}' not found.` };
  }

  // If already approved, return idempotent success
  if (record.status === "APPROVED" || record.status === "ISSUED" || record.status === "RESOLVED") {
    return { success: true, isAlreadyApproved: true, record };
  }

  // Issue voucher if recommended and not yet issued
  if (record.recommendedAction === "VOUCHER" && !record.voucher && record.compensationValue) {
    const { voucher } = issueCustomerRecoveryVoucher({
      storeId: record.storeId,
      feedbackId: record.feedbackId,
      customerId: record.customerId,
      amount: record.compensationValue,
    });
    record.voucher = voucher;
  }

  transitionRecoveryStatus(params.recoveryId, "APPROVED", {
    approvedBy: params.approvedBy,
  });

  transitionRecoveryStatus(params.recoveryId, "ISSUED");

  logGuardianAudit({
    runId: `run-${Date.now()}`,
    agentName: "GuestSentimentGuardian",
    tenantId: record.tenantId,
    storeId: record.storeId,
    feedbackId: record.feedbackId,
    customerId: record.customerId,
    orderId: record.orderId,
    rating: record.rating,
    sentiment: record.sentiment,
    issues: record.issues,
    severity: record.severity,
    decision: `Manually approved by ${params.approvedBy}`,
    recoveryType: record.recommendedAction,
    recoveryValue: record.compensationValue || 0,
    approvalStatus: "APPROVED",
    voucherCode: record.voucher?.code,
    executionResult: "SUCCESS",
    latencyMs: 1,
    timestamp: Date.now(),
  });

  return {
    success: true,
    record,
  };
}

/**
 * Tool 6: Escalate critical case.
 */
export function tool_escalate_recovery(params: {
  recoveryId: string;
  reason: string;
}) {
  const record = getRecoveryRecord(params.recoveryId);
  if (!record) {
    return { success: false, error: `Recovery '${params.recoveryId}' not found.` };
  }

  transitionRecoveryStatus(params.recoveryId, "ESCALATED");

  logGuardianAudit({
    runId: `run-${Date.now()}`,
    agentName: "GuestSentimentGuardian",
    tenantId: record.tenantId,
    storeId: record.storeId,
    feedbackId: record.feedbackId,
    customerId: record.customerId,
    orderId: record.orderId,
    rating: record.rating,
    sentiment: record.sentiment,
    issues: record.issues,
    severity: record.severity,
    decision: `ESCALATED: ${params.reason}`,
    recoveryType: record.recommendedAction,
    recoveryValue: 0,
    approvalStatus: "ESCALATED",
    executionResult: "ESCALATED",
    latencyMs: 1,
    timestamp: Date.now(),
  });

  return {
    success: true,
    record,
  };
}

/**
 * Tool 7: Fetch analytics.
 */
export function tool_get_guardian_analytics(params: { storeId?: string } = {}) {
  const metrics = getGuardianAnalytics(params.storeId);
  return {
    success: true,
    metrics,
  };
}
