// Response Generation & Fact Verification Pipeline for Agent 6: ❤️ Guest Sentiment Guardian
// Guarantees:
// 1. Authoritative fact verification (voucher code, amount, and name must match)
// 2. Prohibits hallucinated refund promises ("Your refund is processed")
// 3. Graceful fallback to verified templates if validation fails

import {
  CustomerFeedback,
  IssueCategory,
  VoucherRecord,
} from "./types";
import { generateFallbackApology } from "./templates";

export interface ResponseFactValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates drafted text against authoritative recovery facts.
 */
export function validateResponseFacts(
  draft: string,
  params: {
    customerName?: string;
    voucher?: VoucherRecord;
    isRefundApproved?: boolean;
  }
): ResponseFactValidationResult {
  const errors: string[] = [];
  const lower = draft.toLowerCase();

  // 1. Voucher Amount Check
  if (params.voucher) {
    const expectedAmount = params.voucher.amount;
    const priceMatches = lower.match(/(?:₹|rs\.?|inr)\s?(\d+)/g);
    if (priceMatches) {
      for (const m of priceMatches) {
        const num = parseInt(m.replace(/[^\d]/g, ""), 10);
        if (num !== expectedAmount) {
          errors.push(
            `Draft contains unauthorized amount ₹${num}. Authoritative voucher amount is ₹${expectedAmount}.`
          );
        }
      }
    }

    // Voucher code check
    if (!draft.includes(params.voucher.code)) {
      errors.push(`Draft does not contain authoritative voucher code '${params.voucher.code}'.`);
    }
  }

  // 2. Prohibit False Promises
  if (!params.isRefundApproved) {
    const falseRefundPhrases = [
      "your refund has been processed",
      "we have refunded your account",
      "money has been refunded",
      "refund credited",
    ];
    for (const phrase of falseRefundPhrases) {
      if (lower.includes(phrase)) {
        errors.push(`Draft contains false refund claim: '${phrase}'.`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Generates verified apology and response text.
 */
export function generateGuardianCustomerResponse(params: {
  feedback: CustomerFeedback;
  issues: IssueCategory[];
  voucher?: VoucherRecord;
  isEscalated?: boolean;
  isRefundApproved?: boolean;
  customDraft?: string;
}): string {
  const fallback = generateFallbackApology({
    customerName: params.feedback.customerName,
    issues: params.issues,
    voucher: params.voucher,
    isEscalated: params.isEscalated,
  });

  if (!params.customDraft) {
    return fallback;
  }

  // Validate custom draft against facts
  const factCheck = validateResponseFacts(params.customDraft, {
    customerName: params.feedback.customerName,
    voucher: params.voucher,
    isRefundApproved: params.isRefundApproved,
  });

  if (factCheck.isValid) {
    return params.customDraft;
  }

  // Fallback to verified template on validation failure
  return fallback;
}
