import {
  IssueCategory,
  VoucherRecord,
} from "./types";

export function generateFallbackApology(params: {
  customerName?: string;
  issues: IssueCategory[];
  voucher?: VoucherRecord;
  isEscalated?: boolean;
}): string {
  const name = params.customerName?.trim() || "Guest";
  const issueSummary = params.issues.length > 0 ? params.issues.join(" & ") : "service consistency";

  if (params.isEscalated) {
    return `Dear ${name},\n\nThank you for bringing this serious matter to our immediate attention. We take your feedback regarding ${issueSummary} with the utmost urgency.\n\nA senior operations manager has been assigned to personally review your case and follow up with you. Your health, safety, and trust are our top priorities.`;
  }

  if (params.voucher) {
    return `Dear ${name},\n\nThank you for sharing candid feedback regarding your recent visit. We take great pride in our craft, and we are truly sorry that your experience with our ${issueSummary} fell short of our standard.\n\nOur head barista has been notified to recalibrate this immediately. Please accept a ₹${params.voucher.amount} courtesy credit on us using code ${params.voucher.code} for your next brew. We would love the opportunity to pour you a cup done right!`;
  }

  return `Dear ${name},\n\nThank you for your valuable feedback. We are always striving to improve our craft and service, and our team has noted your notes regarding ${issueSummary} to ensure a smoother experience next time!`;
}
