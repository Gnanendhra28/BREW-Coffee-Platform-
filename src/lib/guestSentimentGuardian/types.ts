// Production Data Contracts & Type Schemas for Agent 6: ❤️ Guest Sentiment Guardian

export type SentimentType = "POSITIVE" | "NEUTRAL" | "MIXED" | "NEGATIVE";

export type IssueCategory =
  | "WAIT_TIME"
  | "ORDER_DELAY"
  | "FOOD_QUALITY"
  | "DRINK_QUALITY"
  | "MISSING_ITEM"
  | "WRONG_ITEM"
  | "TEMPERATURE"
  | "STAFF_SERVICE"
  | "PAYMENT"
  | "ORDER_ACCURACY"
  | "DELIVERY"
  | "CURBSIDE"
  | "CLEANLINESS"
  | "AVAILABILITY"
  | "PRICING"
  | "OTHER";

export type SeverityLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RecoveryActionType =
  | "VOUCHER"
  | "COUPON"
  | "STORE_CREDIT"
  | "REFUND_REVIEW"
  | "REPLACEMENT"
  | "APOLOGY"
  | "HUMAN_CALLBACK"
  | "MANAGER_REVIEW"
  | "NO_ACTION";

export type RecoveryStatus =
  | "RECEIVED"
  | "ANALYZING"
  | "CLASSIFIED"
  | "ELIGIBILITY_CHECKED"
  | "RECOVERY_PENDING"
  | "APPROVED"
  | "ISSUED"
  | "DELIVERED"
  | "RESOLVED"
  | "NO_ACTION"
  | "ESCALATED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export type RootCauseConfidence = "CONFIRMED" | "LIKELY" | "POSSIBLE" | "UNKNOWN";

export interface RootCauseCorrelation {
  issue: IssueCategory;
  suspectedCause: string;
  confidence: RootCauseConfidence;
  operationalTelemetry?: Record<string, unknown>;
}

export interface CustomerFeedback {
  feedbackId: string;
  tenantId: string;
  storeId: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  orderId?: string;
  rating: number; // 1 to 5
  comment: string;
  source: "IN_APP_REVIEW" | "WEBSITE_REVIEW" | "ORDER_FEEDBACK" | "MANUAL_OR_IMPORTED";
  createdAt: number;
  marketingConsent?: boolean;
}

export interface OrderItemSummary {
  id: string;
  name: string;
  quantity: number;
  price: number;
}

export interface OrderContext {
  orderId: string;
  orderNumber?: string;
  customerId?: string;
  storeId?: string;
  totalAmount: number;
  items: OrderItemSummary[];
  status: string;
  pickupType: "walkup" | "curbside";
  createdAt: number;
  readyAt?: number;
  servedAt?: number;
  actualWaitMinutes?: number;
  targetWaitMinutes?: number;
}

export interface CustomerProfileContext {
  customerId: string;
  name: string;
  phone?: string;
  email?: string;
  totalOrders: number;
  recentRecoveriesCount30Days: number;
  lastRecoveryTimestamp?: number;
  marketingConsent: boolean;
}

export interface RecoveryPolicyConfig {
  ratingThresholds: {
    positiveMin: number;     // 4 or 5 -> Positive
    recoveryMax: number;     // <= 3 -> Eligible for recovery
    highPriorityMax: number; // <= 1 -> High Priority
  };
  voucherTiers: {
    tier1Star: number;       // e.g. ₹100
    tier2Star: number;       // e.g. ₹75
    tier3Star: number;       // e.g. ₹50
  };
  maxVoucherValue: number;   // e.g. ₹200 (hard cap)
  maxStoreCredit: number;    // e.g. ₹500
  maxRecoveriesPerCustomer30Days: number; // e.g. 2
  autoApproveMaxAmount: number; // e.g. ₹75 (above requires manager approval)
  voucherValidityDays: number;  // e.g. 14 days
}

export interface VoucherRecord {
  voucherId: string;
  code: string;
  customerId?: string;
  storeId: string;
  amount: number;
  issuedAt: number;
  expiresAt: number;
  isRedeemed: boolean;
  idempotencyKey: string;
}

export interface RecoveryRecord {
  recoveryId: string;
  feedbackId: string;
  tenantId: string;
  storeId: string;
  customerId?: string;
  orderId?: string;
  rating: number;
  status: RecoveryStatus;
  sentiment: SentimentType;
  issues: IssueCategory[];
  severity: SeverityLevel;
  isCriticalSafety: boolean;
  safetyReason?: string;
  rootCauseCorrelations: RootCauseCorrelation[];
  eligibility: {
    isEligible: boolean;
    reason?: string;
  };
  recommendedAction: RecoveryActionType;
  compensationValue?: number;
  requiresApproval: boolean;
  approvedBy?: string;
  voucher?: VoucherRecord;
  responseDraft?: string;
  customerNotificationSent: boolean;
  idempotencyKey: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface GuardianAuditLog {
  runId: string;
  agentName: "GuestSentimentGuardian";
  tenantId: string;
  storeId: string;
  feedbackId: string;
  customerId?: string;
  orderId?: string;
  rating: number;
  sentiment: SentimentType;
  issues: IssueCategory[];
  severity: SeverityLevel;
  decision: string;
  recoveryType: RecoveryActionType;
  recoveryValue: number;
  approvalStatus: string;
  voucherCode?: string;
  executionResult: "SUCCESS" | "BLOCKED" | "ESCALATED" | "FAILED";
  latencyMs: number;
  error?: string;
  timestamp: number;
}

export interface GuardianAnalyticsMetrics {
  totalReviews: number;
  avgRating: number;
  ratingsDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
  sentimentDistribution: Record<SentimentType, number>;
  topIssues: Array<{ issue: IssueCategory; count: number }>;
  criticalEscalationsCount: number;
  autoRecoveriesCount: number;
  manualRecoveriesCount: number;
  vouchersIssuedCount: number;
  totalCompensationAmount: number;
  abuseBlockedCount: number;
}
