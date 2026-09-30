// Operational Analytics & Sentiment Metrics for Agent 6: ❤️ Guest Sentiment Guardian
// Computes store sentiment distribution, issue frequency, escalation rates, and recovery expenditure.

import {
  GuardianAnalyticsMetrics,
  SentimentType,
  IssueCategory,
} from "./types";
import { listRecoveryRecords } from "./stateMachine";

export function getGuardianAnalytics(storeId?: string): GuardianAnalyticsMetrics {
  const records = listRecoveryRecords(storeId);

  const totalReviews = records.length;
  let ratingSum = 0;
  const ratingsDistribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sentimentDistribution: Record<SentimentType, number> = {
    POSITIVE: 0,
    NEUTRAL: 0,
    MIXED: 0,
    NEGATIVE: 0,
  };
  const issueCounts = new Map<IssueCategory, number>();
  let criticalEscalationsCount = 0;
  let autoRecoveriesCount = 0;
  let manualRecoveriesCount = 0;
  let vouchersIssuedCount = 0;
  let totalCompensationAmount = 0;
  let abuseBlockedCount = 0;

  for (const r of records) {
    const star = Math.min(5, Math.max(1, r.rating)) as 1 | 2 | 3 | 4 | 5;
    ratingsDistribution[star] = (ratingsDistribution[star] || 0) + 1;
    ratingSum += star;

    sentimentDistribution[r.sentiment] = (sentimentDistribution[r.sentiment] || 0) + 1;

    for (const issue of r.issues) {
      issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
    }

    if (r.isCriticalSafety || r.status === "ESCALATED") {
      criticalEscalationsCount++;
    }
    if (r.voucher) {
      vouchersIssuedCount++;
      totalCompensationAmount += r.voucher.amount;
      if (r.approvedBy === "AUTONOMOUS_GUARDIAN_POLICY") {
        autoRecoveriesCount++;
      } else {
        manualRecoveriesCount++;
      }
    }
    if (r.eligibility && !r.eligibility.isEligible && r.eligibility.reason?.includes("maximum allowed recoveries")) {
      abuseBlockedCount++;
    }
  }

  const avgRating = totalReviews > 0 ? Math.round((ratingSum / totalReviews) * 10) / 10 : 5.0;

  const topIssues = Array.from(issueCounts.entries())
    .map(([issue, count]) => ({ issue, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalReviews,
    avgRating,
    ratingsDistribution,
    sentimentDistribution,
    topIssues,
    criticalEscalationsCount,
    autoRecoveriesCount,
    manualRecoveriesCount,
    vouchersIssuedCount,
    totalCompensationAmount,
    abuseBlockedCount,
  };
}
