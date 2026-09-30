// Main Autonomous Agent Orchestrator for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Integrates context assembly, opportunity detection, audience filtering, copy generation, governance, and dispatch.

import {
  MarketingOpportunity,
  HypeCampaignRecord,
  WeatherSnapshot,
  AudienceCriteria,
} from "./types";
import { buildStoreMarketingContext } from "./context";
import { detectMarketingOpportunities } from "./opportunities";
import { selectTargetAudience, MOCK_LOCAL_CUSTOMERS } from "./audience";
import { generateHypeCampaignCopy } from "./copyGenerator";
import {
  createHypeCampaign,
  updateCampaignStatus,
  recordCampaignPerformance,
} from "./campaigns";
import {
  validateCampaignPreSend,
  recordStoreCampaignDispatch,
} from "./policy";
import { dispatchCampaignMessages } from "./delivery";
import { logHypeBroadcastAudit } from "./auditLogger";

export interface HypeBroadcasterCycleOptions {
  storeId?: string;
  triggerSource?: string;
  currentHour?: number;
  weatherSnapshot?: WeatherSnapshot;
  autoApprove?: boolean;
  approvedBy?: string;
}

export interface HypeBroadcasterCycleResult {
  success: boolean;
  storeId: string;
  triggerSource: string;
  opportunityDetected?: MarketingOpportunity;
  campaign?: HypeCampaignRecord;
  actionTaken: "NO_OPPORTUNITY" | "STORE_CLOSED" | "CAMPAIGN_DRAFTED" | "CAMPAIGN_DISPATCHED" | "DISPATCH_BLOCKED";
  blockedReasons?: string[];
  latencyMs: number;
}

/**
 * Runs a complete autonomous marketing broadcaster cycle.
 */
export async function runHypeBroadcasterCycle(
  options: HypeBroadcasterCycleOptions = {}
): Promise<HypeBroadcasterCycleResult> {
  const start = Date.now();
  const storeId = options.storeId || "van-01";
  const triggerSource = options.triggerSource || "SCHEDULED_POLL";

  // 1. Build Store Context
  const context = await buildStoreMarketingContext({
    storeId,
    currentHour: options.currentHour,
    weatherSnapshot: options.weatherSnapshot,
  });

  // Guard: Store must be operational
  if (!context.isStoreOpen) {
    const latencyMs = Date.now() - start;
    logHypeBroadcastAudit({
      runId: `run-${Date.now()}`,
      agentName: "HyperLocalHypeBroadcaster",
      tenantId: context.tenantId,
      storeId,
      trigger: triggerSource,
      decision: "NO_ACTION: Store is closed for the day.",
      policyChecksPassed: true,
      toolsCalled: ["buildStoreMarketingContext"],
      executionResult: "SUCCESS",
      latencyMs,
    });

    return {
      success: true,
      storeId,
      triggerSource,
      actionTaken: "STORE_CLOSED",
      latencyMs,
    };
  }

  // 2. Opportunity Detection
  const opportunities = detectMarketingOpportunities(context);
  if (opportunities.length === 0) {
    const latencyMs = Date.now() - start;
    logHypeBroadcastAudit({
      runId: `run-${Date.now()}`,
      agentName: "HyperLocalHypeBroadcaster",
      tenantId: context.tenantId,
      storeId,
      trigger: triggerSource,
      decision: "NO_ACTION: No active marketing opportunity detected under current conditions.",
      policyChecksPassed: true,
      toolsCalled: ["detectMarketingOpportunities"],
      executionResult: "SUCCESS",
      latencyMs,
    });

    return {
      success: true,
      storeId,
      triggerSource,
      actionTaken: "NO_OPPORTUNITY",
      latencyMs,
    };
  }

  const topOpportunity = opportunities[0];

  // 3. Target Audience Selection & Consent Enforcement
  const audienceCriteria: AudienceCriteria = {
    storeId,
    maxRadiusKm: 3.0,
    allowedChannels: ["push", "sms", "whatsapp", "social"],
    requireConsent: true,
  };

  const audience = selectTargetAudience(MOCK_LOCAL_CUSTOMERS, audienceCriteria, {
    currentHour: options.currentHour ?? context.currentLocalHour,
    currentTimeMs: start,
  });

  // 4. Copy Generation & Strict Commercial Fact Verification
  const messages = generateHypeCampaignCopy(topOpportunity, context, {
    preferredTone: topOpportunity.urgencyLevel === "HIGH" ? "urgent" : "friendly",
  });

  // 5. Idempotent Campaign Record Creation
  const { campaign, isExisting } = createHypeCampaign({
    storeId,
    tenantId: context.tenantId,
    opportunity: topOpportunity,
    audienceCriteria: {
      ...audienceCriteria,
      allowedChannels: ["push", "sms", "whatsapp", "social"],
    },
    audience,
    messages,
  });

  // 6. Handle Dispatch if Auto-Approve Requested
  if (options.autoApprove) {
    const preSendCheck = validateCampaignPreSend(campaign, context, start);
    if (!preSendCheck.canSend) {
      const latencyMs = Date.now() - start;
      logHypeBroadcastAudit({
        runId: `run-${Date.now()}`,
        agentName: "HyperLocalHypeBroadcaster",
        tenantId: context.tenantId,
        storeId,
        campaignId: campaign.campaignId,
        trigger: triggerSource,
        opportunityType: topOpportunity.type,
        decision: `DISPATCH_BLOCKED: ${preSendCheck.errors.join("; ")}`,
        policyChecksPassed: false,
        toolsCalled: ["validateCampaignPreSend"],
        executionResult: "BLOCKED",
        latencyMs,
        error: preSendCheck.errors.join("; "),
      });

      return {
        success: false,
        storeId,
        triggerSource,
        opportunityDetected: topOpportunity,
        campaign,
        actionTaken: "DISPATCH_BLOCKED",
        blockedReasons: preSendCheck.errors,
        latencyMs,
      };
    }

    // State transitions
    updateCampaignStatus(campaign.campaignId, "APPROVED", {
      approvedBy: options.approvedBy || "AUTONOMOUS_POLICY_AGENT",
      preSendValidationPassed: true,
    });
    updateCampaignStatus(campaign.campaignId, "SENDING");

    // Multi-channel delivery
    const dispatchSummary = await dispatchCampaignMessages(
      campaign,
      audience.eligibleCustomers,
      ["whatsapp", "push", "sms"]
    );

    // Record rate limit timestamp
    recordStoreCampaignDispatch(storeId, Date.now());

    // Mark SENT
    updateCampaignStatus(campaign.campaignId, "SENT");

    const latencyMs = Date.now() - start;
    logHypeBroadcastAudit({
      runId: `run-${Date.now()}`,
      agentName: "HyperLocalHypeBroadcaster",
      tenantId: context.tenantId,
      storeId,
      campaignId: campaign.campaignId,
      trigger: triggerSource,
      opportunityType: topOpportunity.type,
      audienceEligibleCount: audience.eligibleCount,
      decision: `Dispatched to ${dispatchSummary.deliveredCount} customers across push/whatsapp/sms.`,
      policyChecksPassed: true,
      toolsCalled: ["selectTargetAudience", "dispatchCampaignMessages"],
      executionResult: "SUCCESS",
      latencyMs,
    });

    return {
      success: true,
      storeId,
      triggerSource,
      opportunityDetected: topOpportunity,
      campaign,
      actionTaken: "CAMPAIGN_DISPATCHED",
      latencyMs,
    };
  }

  // Non-auto-approved: Campaign generated and ready for 1-click barista review
  const latencyMs = Date.now() - start;
  logHypeBroadcastAudit({
    runId: `run-${Date.now()}`,
    agentName: "HyperLocalHypeBroadcaster",
    tenantId: context.tenantId,
    storeId,
    campaignId: campaign.campaignId,
    trigger: triggerSource,
    opportunityType: topOpportunity.type,
    audienceEligibleCount: audience.eligibleCount,
    decision: isExisting
      ? "Idempotent campaign already active in time bucket."
      : "Draft campaign generated and awaiting barista dispatch approval.",
    policyChecksPassed: true,
    toolsCalled: ["selectTargetAudience", "generateHypeCampaignCopy"],
    executionResult: "SUCCESS",
    latencyMs,
  });

  return {
    success: true,
    storeId,
    triggerSource,
    opportunityDetected: topOpportunity,
    campaign,
    actionTaken: "CAMPAIGN_DRAFTED",
    latencyMs,
  };
}

/**
 * Simulates a customer clicking a link and converting, attributing revenue to campaign.
 */
export function recordHypeConversion(
  campaignId: string,
  amount: number
): void {
  recordCampaignPerformance(campaignId, {
    clickCount: 1,
    conversionCount: 1,
    revenueGenerated: amount,
  });
}
