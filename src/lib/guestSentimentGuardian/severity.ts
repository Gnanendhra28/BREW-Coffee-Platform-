// Severity Classification & Safety-Critical Guard Engine for Agent 6: ❤️ Guest Sentiment Guardian
// Guarantees:
// 1. Immediate detection of health, allergy, contamination, and legal/harassment allegations
// 2. Strict CRITICAL classification with automatic compensation block
// 3. Deterministic severity tiers (LOW, MEDIUM, HIGH, CRITICAL)

import { SeverityLevel, IssueCategory } from "./types";

const SAFETY_CRITICAL_KEYWORDS = [
  "allergy", "allergic", "reaction", "anaphylaxis",
  "food poisoning", "poisoned", "vomit", "vomited", "vomiting", "nausea", "sick", "diarrhea",
  "contamination", "contaminated", "foreign object", "glass", "plastic piece", "metal", "bug", "insect", "cockroach",
  "burn", "burned my tongue severely", "injury", "injured", "hospital", "doctor", "bleeding",
  "harassment", "harassed", "threat", "threatened", "assault", "discriminate", "discrimination",
  "unsafe", "illegal", "police",
];

export interface SeverityEvaluationResult {
  severity: SeverityLevel;
  isCriticalSafety: boolean;
  criticalReason?: string;
}

/**
 * Evaluates comment and rating for severity and safety risks.
 */
export function evaluateFeedbackSeverity(
  rating: number,
  comment: string = "",
  issues: IssueCategory[] = []
): SeverityEvaluationResult {
  const lower = comment.toLowerCase();

  // 1. Immediate Safety-Critical Detection
  for (const keyword of SAFETY_CRITICAL_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        severity: "CRITICAL",
        isCriticalSafety: true,
        criticalReason: `Safety-critical keyword detected: '${keyword}'. Escalation required.`,
      };
    }
  }

  // 2. High Severity: 1-star reviews or severe issues (missing item + bad service)
  if (rating <= 1) {
    return {
      severity: "HIGH",
      isCriticalSafety: false,
    };
  }

  // 3. Medium Severity: 2-3 stars with operational issues (wait time, temperature, missing item)
  if (rating <= 3) {
    const hasMajorOperationalIssue = issues.some((i) =>
      ["WAIT_TIME", "ORDER_DELAY", "MISSING_ITEM", "WRONG_ITEM", "TEMPERATURE"].includes(i)
    );
    return {
      severity: hasMajorOperationalIssue ? "MEDIUM" : "LOW",
      isCriticalSafety: false,
    };
  }

  // 4. Low Severity: 4-5 stars
  return {
    severity: "LOW",
    isCriticalSafety: false,
  };
}
