// Production Concierge Agent Core: 🎪 Event Booking Concierge
// Autonomous, deterministic catering quotation and booking concierge.

import {
  EventRequirements,
  ValidationResult,
  EventQuotationRecord,
  EventConciergeAuditLog,
} from "./types";
import {
  tool_parse_event_request,
  tool_validate_event_requirements,
  tool_create_quote,
} from "./tools";
import { recordConciergeAuditLog } from "./auditLogger";

export interface ConciergeInquiryResult {
  runId: string;
  customerId: string;
  timestamp: number;
  input: string | Partial<EventRequirements>;
  validation: ValidationResult;
  quote?: EventQuotationRecord;
  customerSummaryMessage: string;
  needsClarification: boolean;
  auditLog: EventConciergeAuditLog;
  latencyMs: number;
}

/**
 * Transforms a customer's catering inquiry into an accurate, transparent 3-tier quotation.
 * If requirements are incomplete, responds with a targeted clarification prompt without inventing data.
 */
export function processEventInquiry(
  input: string | Partial<EventRequirements>,
  options: {
    customerId?: string;
    currentStock?: Record<string, number>;
  } = {}
): ConciergeInquiryResult {
  const startTime = performance.now();
  const runId = `concierge-run-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const customerId = options.customerId || `cust-${Date.now()}`;
  const toolsCalled: string[] = [];

  try {
    // 1. Parsing
    let requirements: Partial<EventRequirements>;
    if (typeof input === "string") {
      toolsCalled.push("tool_parse_event_request");
      requirements = tool_parse_event_request(input);
    } else {
      requirements = { ...input };
    }

    // 2. Validation
    toolsCalled.push("tool_validate_event_requirements");
    const validation = tool_validate_event_requirements(requirements);

    // If requirements are incomplete or invalid
    if (!validation.isValid) {
      const latencyMs = Number((performance.now() - startTime).toFixed(2));
      const audit = recordConciergeAuditLog({
        runId,
        customerId,
        timestamp: Date.now(),
        trigger: "CUSTOMER_INQUIRY",
        guestCount: requirements.guestCount || 0,
        eventType: requirements.eventType || "corporate",
        riskTier: "LOW",
        approvalStatus: "PENDING_CLARIFICATION",
        decision: validation.errors.join("; ") || validation.clarificationPrompt || "Inquiry needs clarification",
        toolsCalled,
        executionResult: "NEEDS_CLARIFICATION",
        latencyMs,
      });

      return {
        runId,
        customerId,
        timestamp: Date.now(),
        input,
        validation,
        needsClarification: true,
        customerSummaryMessage:
          validation.clarificationPrompt ||
          validation.errors.join("; ") ||
          "Please provide your event date and venue location to generate a formal quote.",
        auditLog: audit,
        latencyMs,
      };
    }

    // 3. Complete Requirements -> Generate Quote
    const completeReq = requirements as EventRequirements;
    toolsCalled.push("tool_create_quote");
    const quoteResult = tool_create_quote({
      requirements: completeReq,
      customerId,
      currentStock: options.currentStock,
    });

    if (!quoteResult.success || !quoteResult.quote) {
      const latencyMs = Number((performance.now() - startTime).toFixed(2));
      const audit = recordConciergeAuditLog({
        runId,
        customerId,
        timestamp: Date.now(),
        trigger: "CUSTOMER_INQUIRY",
        guestCount: completeReq.guestCount,
        eventType: completeReq.eventType,
        riskTier: "HIGH",
        approvalStatus: "REJECTED",
        decision: quoteResult.error || "Failed to generate viable quotation",
        toolsCalled,
        executionResult: "REJECTED",
        latencyMs,
        error: quoteResult.error,
      });

      return {
        runId,
        customerId,
        timestamp: Date.now(),
        input,
        validation,
        needsClarification: false,
        customerSummaryMessage: `Unable to generate quotation: ${quoteResult.error}`,
        auditLog: audit,
        latencyMs,
      };
    }

    const quote = quoteResult.quote;
    const recommendedTier = quote.tiers.find((t) => t.isRecommended) || quote.tiers[1];

    // 4. Formulate Transparent Customer Summary Message
    const customerSummaryMessage = `☕ BREW Mobile Van Catering Quotation (${quote.versionId})
-----------------------------------------------------------------
Host / Campus: ${quote.organization}
Location: ${quote.location} (Estimated travel: ${quote.logistics.distanceKm} km)
Date: ${quote.eventDate} | Service: ${quote.durationMinutes / 60} Hours (${quote.startTime} to ${quote.endTime})
Expected Crowd: ${quote.guestCount} Attendees
-----------------------------------------------------------------
3-TIER PACKAGES:
1. 🥉 Classic Brew: ₹${quote.tiers[0].pricePerGuest}/guest -> Total: ₹${quote.tiers[0].totalAmount.toLocaleString(
      "en-IN"
    )}
2. 🥈 Artisanal Signature (Recommended): ₹${quote.tiers[1].pricePerGuest}/guest -> Total: ₹${quote.tiers[1].totalAmount.toLocaleString(
      "en-IN"
    )}
3. 🥇 VIP Unlimited Bar: ₹${quote.tiers[2].pricePerGuest}/guest -> Total: ₹${quote.tiers[2].totalAmount.toLocaleString(
      "en-IN"
    )}
-----------------------------------------------------------------
Operational Allocation for Recommended Tier:
• Crew: ${quote.staffing.baristasAssigned} Certified Baristas
• Specialty Beans: ${quote.consumption.coffeeBeansKg} kg | Fresh Milk: ${quote.consumption.milkLiters} L
• Artisanal Cups: ${quote.consumption.cupsCount} cups | Warm Pastries: ${quote.consumption.pastriesCount} pieces
• Power Requirement: ${quote.equipment.powerDescription}
• Logistics: Base mobilization fee of ₹${quote.logistics.totalLogisticsCost} included
${quote.procurementRequired ? "\n⚠️ Note: Large batch ingredient procurement run required before event date." : ""}
Quote valid until: ${new Date(quote.expiresAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}.`;

    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    const audit = recordConciergeAuditLog({
      runId,
      customerId,
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      timestamp: Date.now(),
      trigger: "CUSTOMER_INQUIRY",
      guestCount: completeReq.guestCount,
      eventType: completeReq.eventType,
      totalAmount: recommendedTier.totalAmount,
      grossMarginPercent: recommendedTier.grossMarginPercent,
      riskTier: quote.riskTier,
      approvalStatus: quote.requiresApproval ? "MANAGER_APPROVAL_PENDING" : "AUTO_APPROVED",
      decision: `Generated 3-tier quotation (${quote.versionId}) for ${completeReq.guestCount} guests. Recommended: ${recommendedTier.name} (₹${recommendedTier.totalAmount}, ${recommendedTier.grossMarginPercent}% margin).`,
      toolsCalled,
      executionResult: "SUCCESS",
      latencyMs,
    });

    return {
      runId,
      customerId,
      timestamp: Date.now(),
      input,
      validation,
      quote,
      customerSummaryMessage,
      needsClarification: false,
      auditLog: audit,
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Number((performance.now() - startTime).toFixed(2));
    const audit = recordConciergeAuditLog({
      runId,
      customerId,
      timestamp: Date.now(),
      trigger: "CUSTOMER_INQUIRY",
      guestCount: 0,
      eventType: "corporate",
      riskTier: "HIGH",
      approvalStatus: "ERROR",
      decision: "Internal exception encountered in concierge agent cycle",
      toolsCalled,
      executionResult: "REJECTED",
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      runId,
      customerId,
      timestamp: Date.now(),
      input,
      validation: {
        isValid: false,
        missingFields: [],
        errors: [err instanceof Error ? err.message : "Internal error"],
        isServiceable: false,
        dietaryConfirmed: false,
        unconfirmedDietaryRequirements: [],
      },
      needsClarification: false,
      customerSummaryMessage: "An error occurred while evaluating catering quotation.",
      auditLog: audit,
      latencyMs,
    };
  }
}
