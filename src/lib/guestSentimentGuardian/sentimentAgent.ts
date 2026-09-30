// Main Autonomous Agent Orchestrator for Agent 6: ❤️ Guest Sentiment Guardian
// Integrates sentiment classification, issue extraction, safety checks, order correlation,
// policy guardrails, voucher generation, human-in-the-loop approval, and audit logging.

import {
  CustomerFeedback,
  RecoveryRecord,
} from "./types";
import { classifySentiment } from "./classifier";
import { extractIssuesFromComment } from "./issueExtractor";
import { evaluateFeedbackSeverity } from "./severity";
import { getOrderContext, getCustomerProfile } from "./context";
import { correlateOperationalRootCauses } from "./correlation";
import { evaluateRecoveryPolicy, DEFAULT_RECOVERY_POLICY } from "./recoveryPolicy";
import { issueCustomerRecoveryVoucher } from "./voucher";
import {
  saveRecoveryRecord,
  getRecoveryRecordByFeedbackId,
} from "./stateMachine";
import { triggerGuardianAlert } from "./alerts";
import { generateGuardianCustomerResponse } from "./responseGenerator";
import { logGuardianAudit } from "./auditLogger";

export interface ProcessFeedbackResult {
  success: boolean;
  isExisting: boolean;
  recovery: RecoveryRecord;
  latencyMs: number;
}

/**
 * Evaluates and orchestrates recovery for incoming customer feedback.
 */
export async function processCustomerFeedback(
  feedback: CustomerFeedback,
  options: {
    autoApproveEligible?: boolean;
    policyConfig?: typeof DEFAULT_RECOVERY_POLICY;
  } = {}
): Promise<ProcessFeedbackResult> {
  const start = Date.now();
  const autoApprove = options.autoApproveEligible ?? true;

  // 1. Deterministic Idempotency Check
  const existingRecord = getRecoveryRecordByFeedbackId(feedback.feedbackId);
  if (existingRecord) {
    return {
      success: true,
      isExisting: true,
      recovery: existingRecord,
      latencyMs: Date.now() - start,
    };
  }

  const recoveryId = `rec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const idempotencyKey = `${feedback.tenantId}:${feedback.storeId}:${feedback.feedbackId}:RECOVERY`;

  // 2. Classify Sentiment & Issues
  const sentiment = classifySentiment(feedback.rating, feedback.comment);
  const issues = extractIssuesFromComment(feedback.comment, feedback.rating);

  // 3. Severity & Safety-Critical Risk Evaluation
  const severityResult = evaluateFeedbackSeverity(feedback.rating, feedback.comment, issues);

  // 4. Retrieve Context (Customer & Order)
  const customerProfile = getCustomerProfile(feedback.customerId);
  const order = getOrderContext(feedback.orderId);

  // 5. Correlate Operational Root Causes
  const rootCauses = correlateOperationalRootCauses(feedback, issues, order);

  // 6. Policy & Eligibility Evaluation
  const policyResult = evaluateRecoveryPolicy({
    feedback,
    severity: severityResult.severity,
    isCriticalSafety: severityResult.isCriticalSafety,
    customerProfile,
    order,
    policy: options.policyConfig,
  });

  // Base Recovery Record
  const recovery: RecoveryRecord = {
    recoveryId,
    feedbackId: feedback.feedbackId,
    tenantId: feedback.tenantId,
    storeId: feedback.storeId,
    customerId: feedback.customerId,
    orderId: feedback.orderId,
    rating: feedback.rating,
    status: "RECEIVED",
    sentiment,
    issues,
    severity: severityResult.severity,
    isCriticalSafety: severityResult.isCriticalSafety,
    safetyReason: severityResult.criticalReason,
    rootCauseCorrelations: rootCauses,
    eligibility: {
      isEligible: policyResult.isEligible,
      reason: policyResult.reason,
    },
    recommendedAction: policyResult.recommendedAction,
    compensationValue: policyResult.compensationValue,
    requiresApproval: policyResult.requiresApproval,
    customerNotificationSent: false,
    idempotencyKey,
    createdAt: start,
  };

  // CASE 1: Safety-Critical Issue Detected (Allergies, Poisoning, Contamination, Legal)
  if (severityResult.isCriticalSafety) {
    recovery.status = "ESCALATED";

    // Trigger operational manager alert
    triggerGuardianAlert({
      storeId: feedback.storeId,
      alertType: "CRITICAL_SAFETY_INCIDENT",
      severity: "CRITICAL",
      headline: `🚨 Critical Safety Alert: #${feedback.feedbackId}`,
      description: severityResult.criticalReason || "Potential health/safety issue flagged in customer feedback.",
    });

    // Generate safe acknowledgment (no admissions, promises human follow up)
    recovery.responseDraft = generateGuardianCustomerResponse({
      feedback,
      issues,
      isEscalated: true,
    });

    saveRecoveryRecord(recovery);

    logGuardianAudit({
      runId: `run-${Date.now()}`,
      agentName: "GuestSentimentGuardian",
      tenantId: feedback.tenantId,
      storeId: feedback.storeId,
      feedbackId: feedback.feedbackId,
      customerId: feedback.customerId,
      orderId: feedback.orderId,
      rating: feedback.rating,
      sentiment,
      issues,
      severity: "CRITICAL",
      decision: "BLOCKED_AUTO_COMPENSATION: Critical safety issue escalated to human management.",
      recoveryType: "MANAGER_REVIEW",
      recoveryValue: 0,
      approvalStatus: "ESCALATED",
      executionResult: "ESCALATED",
      latencyMs: Date.now() - start,
      timestamp: Date.now(),
    });

    return {
      success: true,
      isExisting: false,
      recovery,
      latencyMs: Date.now() - start,
    };
  }

  // CASE 2: Not Eligible (Rating is 4-5 stars, or exceeded abuse limit)
  if (!policyResult.isEligible) {
    recovery.status = "NO_ACTION";
    recovery.responseDraft = generateGuardianCustomerResponse({
      feedback,
      issues,
    });

    saveRecoveryRecord(recovery);

    logGuardianAudit({
      runId: `run-${Date.now()}`,
      agentName: "GuestSentimentGuardian",
      tenantId: feedback.tenantId,
      storeId: feedback.storeId,
      feedbackId: feedback.feedbackId,
      customerId: feedback.customerId,
      orderId: feedback.orderId,
      rating: feedback.rating,
      sentiment,
      issues,
      severity: severityResult.severity,
      decision: `NO_ACTION: ${policyResult.reason}`,
      recoveryType: "NO_ACTION",
      recoveryValue: 0,
      approvalStatus: "NOT_REQUIRED",
      executionResult: "SUCCESS",
      latencyMs: Date.now() - start,
      timestamp: Date.now(),
    });

    return {
      success: true,
      isExisting: false,
      recovery,
      latencyMs: Date.now() - start,
    };
  }

  // CASE 3: Requires Manager Approval (e.g. 1-Star Review or > ₹75 compensation)
  if (policyResult.requiresApproval || !autoApprove) {
    recovery.status = "RECOVERY_PENDING";
    recovery.responseDraft = generateGuardianCustomerResponse({
      feedback,
      issues,
    });

    saveRecoveryRecord(recovery);

    logGuardianAudit({
      runId: `run-${Date.now()}`,
      agentName: "GuestSentimentGuardian",
      tenantId: feedback.tenantId,
      storeId: feedback.storeId,
      feedbackId: feedback.feedbackId,
      customerId: feedback.customerId,
      orderId: feedback.orderId,
      rating: feedback.rating,
      sentiment,
      issues,
      severity: severityResult.severity,
      decision: "PENDING_APPROVAL: Compensation exceeds autonomous threshold; awaiting manager approval.",
      recoveryType: "VOUCHER",
      recoveryValue: policyResult.compensationValue,
      approvalStatus: "PENDING",
      executionResult: "SUCCESS",
      latencyMs: Date.now() - start,
      timestamp: Date.now(),
    });

    return {
      success: true,
      isExisting: false,
      recovery,
      latencyMs: Date.now() - start,
    };
  }

  // CASE 4: Low-Risk, Policy-Compliant Auto-Recovery (2-3 Star, <= ₹75)
  // Deterministically issue voucher
  const { voucher } = issueCustomerRecoveryVoucher({
    storeId: feedback.storeId,
    feedbackId: feedback.feedbackId,
    customerId: feedback.customerId,
    amount: policyResult.compensationValue,
  });

  recovery.status = "RESOLVED";
  recovery.approvedBy = "AUTONOMOUS_GUARDIAN_POLICY";
  recovery.voucher = voucher;
  recovery.resolvedAt = Date.now();

  // Generate verified response incorporating authoritative voucher facts
  recovery.responseDraft = generateGuardianCustomerResponse({
    feedback,
    issues,
    voucher,
  });

  // Verify marketing consent before dispatching notification
  const hasConsent = feedback.marketingConsent ?? customerProfile?.marketingConsent ?? true;
  recovery.customerNotificationSent = hasConsent;

  saveRecoveryRecord(recovery);

  logGuardianAudit({
    runId: `run-${Date.now()}`,
    agentName: "GuestSentimentGuardian",
    tenantId: feedback.tenantId,
    storeId: feedback.storeId,
    feedbackId: feedback.feedbackId,
    customerId: feedback.customerId,
    orderId: feedback.orderId,
    rating: feedback.rating,
    sentiment,
    issues,
    severity: severityResult.severity,
    decision: `AUTO_RESOLVED: Issued voucher ${voucher.code} (₹${voucher.amount}) for ${issues.join(", ")}. NotificationSent=${hasConsent}`,
    recoveryType: "VOUCHER",
    recoveryValue: voucher.amount,
    approvalStatus: "AUTO_APPROVED",
    voucherCode: voucher.code,
    executionResult: "SUCCESS",
    latencyMs: Date.now() - start,
    timestamp: Date.now(),
  });

  return {
    success: true,
    isExisting: false,
    recovery,
    latencyMs: Date.now() - start,
  };
}
