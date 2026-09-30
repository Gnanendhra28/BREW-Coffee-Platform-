// Controlled Tool Execution Layer for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Zero raw database access. Exposes safe, validated domain tools for the agent orchestrator.

import { buildStoreMarketingContext } from "./context";
import { defaultWeatherProvider } from "./weather";
import { detectMarketingOpportunities } from "./opportunities";
import { selectTargetAudience, MOCK_LOCAL_CUSTOMERS } from "./audience";
import { generateHypeCampaignCopy } from "./copyGenerator";
import {
  createHypeCampaign,
  getHypeCampaign,
  updateCampaignStatus,
} from "./campaigns";
import {
  validateCampaignPreSend,
} from "./policy";
import { dispatchCampaignMessages } from "./delivery";
import { getHypeBroadcasterMetrics } from "./analytics";
import { logHypeBroadcastAudit } from "./auditLogger";
import {
  StoreMarketingContext,
  MarketingOpportunity,
  AudienceCriteria,
} from "./types";

/**
 * 1. Tool to assemble store marketing context.
 */
export async function tool_get_store_marketing_context(params: {
  storeId?: string;
  location?: string;
  currentHour?: number;
}) {
  const context = await buildStoreMarketingContext(params);
  return {
    success: true,
    context,
  };
}

/**
 * 2. Tool to fetch authoritative weather telemetry.
 */
export async function tool_get_weather_telemetry(params: { location: string }) {
  const weather = await defaultWeatherProvider.getCurrentWeather(params.location);
  return {
    success: true,
    weather,
  };
}

/**
 * 3. Tool to detect opportunities.
 */
export async function tool_detect_opportunities(params: {
  storeId?: string;
  context?: StoreMarketingContext;
}) {
  const context = params.context || (await buildStoreMarketingContext({ storeId: params.storeId }));
  const opportunities = detectMarketingOpportunities(context);
  return {
    success: true,
    count: opportunities.length,
    opportunities,
  };
}

/**
 * 4. Tool to evaluate target audience.
 */
export function tool_evaluate_audience(params: {
  storeId: string;
  maxRadiusKm?: number;
  allowedChannels?: Array<"push" | "sms" | "whatsapp" | "social">;
  currentHour?: number;
}) {
  const criteria: AudienceCriteria = {
    storeId: params.storeId,
    maxRadiusKm: params.maxRadiusKm ?? 3.0,
    allowedChannels: params.allowedChannels ?? ["push", "sms", "whatsapp", "social"],
    requireConsent: true,
  };

  const result = selectTargetAudience(MOCK_LOCAL_CUSTOMERS, criteria, {
    currentHour: params.currentHour,
  });

  return {
    success: true,
    criteria,
    audience: result,
  };
}

/**
 * 5. Tool to generate campaign draft and verified copy.
 */
export async function tool_generate_campaign(params: {
  storeId: string;
  opportunity: MarketingOpportunity;
  preferredTone?: "friendly" | "urgent" | "playful" | "premium";
  maxRadiusKm?: number;
  currentHour?: number;
}) {
  const context = await buildStoreMarketingContext({
    storeId: params.storeId,
    currentHour: params.currentHour,
  });

  const criteria: AudienceCriteria = {
    storeId: params.storeId,
    maxRadiusKm: params.maxRadiusKm ?? 3.0,
    allowedChannels: ["push", "sms", "whatsapp", "social"],
    requireConsent: true,
  };

  const audience = selectTargetAudience(MOCK_LOCAL_CUSTOMERS, criteria, {
    currentHour: params.currentHour,
  });

  const messages = generateHypeCampaignCopy(params.opportunity, context, {
    preferredTone: params.preferredTone,
  });

  const { campaign, isExisting } = createHypeCampaign({
    storeId: params.storeId,
    tenantId: context.tenantId,
    opportunity: params.opportunity,
    audienceCriteria: criteria,
    audience,
    messages,
  });

  return {
    success: true,
    isExisting,
    campaign,
  };
}

/**
 * 6. Tool to approve and dispatch campaign with full policy checks.
 */
export async function tool_approve_and_dispatch_campaign(params: {
  campaignId: string;
  approvedBy: string;
  storeContext?: StoreMarketingContext;
  currentHour?: number;
}) {
  const start = Date.now();
  const campaign = getHypeCampaign(params.campaignId);
  if (!campaign) {
    return {
      success: false,
      error: `Campaign '${params.campaignId}' not found.`,
    };
  }

  const context =
    params.storeContext ||
    (await buildStoreMarketingContext({
      storeId: campaign.storeId,
      currentHour: params.currentHour,
    }));

  // Policy validation
  const preSend = validateCampaignPreSend(campaign, context, start);
  if (!preSend.canSend) {
    logHypeBroadcastAudit({
      runId: `run-${Date.now()}`,
      agentName: "HyperLocalHypeBroadcaster",
      tenantId: campaign.tenantId,
      storeId: campaign.storeId,
      campaignId: campaign.campaignId,
      trigger: "CAMPAIGN_APPROVAL_REQUEST",
      opportunityType: campaign.opportunity.type,
      audienceEligibleCount: campaign.audience.eligibleCount,
      decision: `BLOCKED: ${preSend.errors.join("; ")}`,
      policyChecksPassed: false,
      toolsCalled: ["validateCampaignPreSend"],
      executionResult: "BLOCKED",
      latencyMs: Date.now() - start,
      error: preSend.errors.join("; "),
    });

    return {
      success: false,
      blocked: true,
      errors: preSend.errors,
    };
  }

  // State machine transition to APPROVED -> SENDING
  updateCampaignStatus(campaign.campaignId, "APPROVED", {
    approvedBy: params.approvedBy,
    preSendValidationPassed: true,
  });
  updateCampaignStatus(campaign.campaignId, "SENDING");

  // Dispatch messages
  const dispatchResult = await dispatchCampaignMessages(
    campaign,
    campaign.audience.eligibleCustomers,
    ["whatsapp", "push", "sms"]
  );

  // Transition to SENT
  updateCampaignStatus(campaign.campaignId, "SENT");

  logHypeBroadcastAudit({
    runId: `run-${Date.now()}`,
    agentName: "HyperLocalHypeBroadcaster",
    tenantId: campaign.tenantId,
    storeId: campaign.storeId,
    campaignId: campaign.campaignId,
    trigger: "CAMPAIGN_DISPATCHED",
    opportunityType: campaign.opportunity.type,
    audienceEligibleCount: campaign.audience.eligibleCount,
    decision: `Dispatched to ${dispatchResult.deliveredCount} customers.`,
    policyChecksPassed: true,
    toolsCalled: ["validateCampaignPreSend", "dispatchCampaignMessages"],
    executionResult: "SUCCESS",
    latencyMs: Date.now() - start,
  });

  return {
    success: true,
    campaignId: campaign.campaignId,
    deliveredCount: dispatchResult.deliveredCount,
    metrics: campaign.metrics,
    dispatchResult,
  };
}

/**
 * 7. Tool to fetch marketing performance analytics.
 */
export function tool_get_marketing_analytics(params: { storeId?: string } = {}) {
  const metrics = getHypeBroadcasterMetrics(params.storeId);
  return {
    success: true,
    metrics,
  };
}
