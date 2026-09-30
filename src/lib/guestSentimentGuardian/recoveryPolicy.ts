// Deterministic Recovery Policy Engine for Agent 6: ❤️ Guest Sentiment Guardian
// Guarantees:
// 1. Configurable centralized rating & compensation thresholds
// 2. Zero arbitrary monetary decisions by LLM
// 3. Strict fraud and abuse capping (max 2 recoveries / 30 days)
// 4. Automatic block on safety-critical cases (requires human review)
// 5. Hard compensation caps (max voucher ₹200; > ₹75 requires manager approval)

import {
  RecoveryPolicyConfig,
  CustomerFeedback,
  CustomerProfileContext,
  OrderContext,
  RecoveryActionType,
  SeverityLevel,
} from "./types";

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicyConfig = {
  ratingThresholds: {
    positiveMin: 4,
    recoveryMax: 3,
    highPriorityMax: 1,
  },
  voucherTiers: {
    tier1Star: 100, // ₹100 voucher for 1-star review
    tier2Star: 75,  // ₹75 voucher for 2-star review
    tier3Star: 50,  // ₹50 voucher for 3-star review
  },
  maxVoucherValue: 200,
  maxStoreCredit: 500,
  maxRecoveriesPerCustomer30Days: 2,
  autoApproveMaxAmount: 75, // Up to ₹75 can be auto-approved; ₹100+ requires manager review
  voucherValidityDays: 14,
};

export interface PolicyEvaluationResult {
  isEligible: boolean;
  reason?: string;
  recommendedAction: RecoveryActionType;
  compensationValue: number;
  requiresApproval: boolean;
}

/**
 * Evaluates recovery eligibility and compensation amount strictly deterministically.
 */
export function evaluateRecoveryPolicy(params: {
  feedback: CustomerFeedback;
  severity: SeverityLevel;
  isCriticalSafety: boolean;
  customerProfile?: CustomerProfileContext | null;
  order?: OrderContext | null;
  policy?: RecoveryPolicyConfig;
}): PolicyEvaluationResult {
  const policy = params.policy || DEFAULT_RECOVERY_POLICY;
  const rating = params.feedback.rating;

  // 1. Positive / High rating (4 or 5 stars) -> No recovery action needed
  if (rating > policy.ratingThresholds.recoveryMax) {
    return {
      isEligible: false,
      reason: `Rating ${rating} is positive (above recovery threshold ${policy.ratingThresholds.recoveryMax}).`,
      recommendedAction: "NO_ACTION",
      compensationValue: 0,
      requiresApproval: false,
    };
  }

  // 2. Safety-Critical Case (Allergy, Food Poisoning, Contamination, Legal)
  // Must NEVER issue an automatic voucher!
  if (params.isCriticalSafety || params.severity === "CRITICAL") {
    return {
      isEligible: false,
      reason: "Safety-critical issue detected. Automated compensation blocked. Immediate human escalation required.",
      recommendedAction: "MANAGER_REVIEW",
      compensationValue: 0,
      requiresApproval: true,
    };
  }

  // 3. Abuse / Fraud Frequency Check (Customer has received >= maxRecoveries in last 30 days)
  if (params.customerProfile) {
    const recentCount = params.customerProfile.recentRecoveriesCount30Days;
    if (recentCount >= policy.maxRecoveriesPerCustomer30Days) {
      return {
        isEligible: false,
        reason: `Customer has reached maximum allowed recoveries (${recentCount}/${policy.maxRecoveriesPerCustomer30Days}) in 30 days.`,
        recommendedAction: "MANAGER_REVIEW",
        compensationValue: 0,
        requiresApproval: true,
      };
    }
  }

  // 4. Deterministic Voucher Sizing based on Star Rating
  let compensation = 0;
  if (rating === 1) {
    compensation = policy.voucherTiers.tier1Star;
  } else if (rating === 2) {
    compensation = policy.voucherTiers.tier2Star;
  } else if (rating === 3) {
    compensation = policy.voucherTiers.tier3Star;
  }

  // Clamp to maximum allowed voucher value
  compensation = Math.min(compensation, policy.maxVoucherValue);

  // 5. Manager Approval Threshold Check
  const requiresApproval = compensation > policy.autoApproveMaxAmount;

  return {
    isEligible: true,
    recommendedAction: "VOUCHER",
    compensationValue: compensation,
    requiresApproval,
  };
}
