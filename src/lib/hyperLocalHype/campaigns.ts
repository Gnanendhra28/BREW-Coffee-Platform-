// Campaign Lifecycle Management & Idempotency Store for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Guarantees:
// 1. In-memory thread-safe / asynchronous campaign registry
// 2. Idempotency enforcement to prevent duplicate broadcasts within time bucket
// 3. State machine transition enforcement
// 4. Performance metrics updating

import {
  HypeCampaignRecord,
  CampaignStatus,
  MarketingOpportunity,
  AudienceCriteria,
  AudienceSelectionResult,
  CampaignMessageCopy,
  CampaignPerformanceMetrics,
} from "./types";
import {
  isValidCampaignTransition,
  generateCampaignIdempotencyKey,
} from "./policy";

const HYPE_CAMPAIGNS = new Map<string, HypeCampaignRecord>();
const IDEMPOTENCY_INDEX = new Map<string, string>(); // idempotencyKey -> campaignId

export function resetCampaignStore(): void {
  HYPE_CAMPAIGNS.clear();
  IDEMPOTENCY_INDEX.clear();
}

export interface CreateCampaignParams {
  storeId: string;
  tenantId: string;
  opportunity: MarketingOpportunity;
  audienceCriteria: AudienceCriteria;
  audience: AudienceSelectionResult;
  messages: Partial<Record<"push" | "sms" | "whatsapp" | "social", CampaignMessageCopy>>;
  expiresInMs?: number;
}

/**
 * Creates or retrieves an existing idempotent hype campaign.
 */
export function createHypeCampaign(params: CreateCampaignParams): {
  campaign: HypeCampaignRecord;
  isExisting: boolean;
} {
  const now = Date.now();
  const idempotencyKey = generateCampaignIdempotencyKey(
    params.storeId,
    params.opportunity,
    now
  );

  // Check existing active idempotent campaign
  const existingId = IDEMPOTENCY_INDEX.get(idempotencyKey);
  if (existingId) {
    const existing = HYPE_CAMPAIGNS.get(existingId);
    if (existing && existing.status !== "CANCELLED" && existing.status !== "REJECTED") {
      return { campaign: existing, isExisting: true };
    }
  }

  const campaignId = `camp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const expiresAt = now + (params.expiresInMs ?? 2 * 60 * 60 * 1000); // 2 hours default

  const initialMetrics: CampaignPerformanceMetrics = {
    targetedCount: params.audience.eligibleCount,
    deliveredCount: 0,
    failedCount: 0,
    openCount: 0,
    clickCount: 0,
    conversionCount: 0,
    revenueGenerated: 0,
  };

  const record: HypeCampaignRecord = {
    campaignId,
    idempotencyKey,
    storeId: params.storeId,
    tenantId: params.tenantId,
    status: "GENERATED",
    opportunity: params.opportunity,
    audienceCriteria: params.audienceCriteria,
    audience: params.audience,
    messages: params.messages,
    preSendValidationPassed: false,
    metrics: initialMetrics,
    createdAt: now,
    expiresAt,
  };

  HYPE_CAMPAIGNS.set(campaignId, record);
  IDEMPOTENCY_INDEX.set(idempotencyKey, campaignId);

  return { campaign: record, isExisting: false };
}

export function getHypeCampaign(campaignId: string): HypeCampaignRecord | undefined {
  return HYPE_CAMPAIGNS.get(campaignId);
}

export function listHypeCampaigns(storeId?: string): HypeCampaignRecord[] {
  const all = Array.from(HYPE_CAMPAIGNS.values());
  if (storeId) {
    return all.filter((c) => c.storeId === storeId);
  }
  return all;
}

export function findCampaignByIdempotencyKey(key: string): HypeCampaignRecord | undefined {
  const id = IDEMPOTENCY_INDEX.get(key);
  if (!id) return undefined;
  return HYPE_CAMPAIGNS.get(id);
}

/**
 * Updates campaign status ensuring state machine compliance.
 */
export function updateCampaignStatus(
  campaignId: string,
  newStatus: CampaignStatus,
  options: {
    approvedBy?: string;
    preSendValidationPassed?: boolean;
    preSendValidationErrors?: string[];
  } = {}
): HypeCampaignRecord {
  const campaign = HYPE_CAMPAIGNS.get(campaignId);
  if (!campaign) {
    throw new Error(`Campaign with ID '${campaignId}' not found.`);
  }

  if (!isValidCampaignTransition(campaign.status, newStatus)) {
    throw new Error(
      `Invalid campaign status transition from '${campaign.status}' to '${newStatus}'.`
    );
  }

  campaign.status = newStatus;
  if (options.approvedBy) campaign.approvedBy = options.approvedBy;
  if (options.preSendValidationPassed !== undefined) {
    campaign.preSendValidationPassed = options.preSendValidationPassed;
  }
  if (options.preSendValidationErrors) {
    campaign.preSendValidationErrors = options.preSendValidationErrors;
  }

  if (newStatus === "SENT") {
    campaign.sentAt = Date.now();
  }

  HYPE_CAMPAIGNS.set(campaignId, campaign);
  return campaign;
}

/**
 * Updates live performance metrics (opens, clicks, conversions, revenue) for attribution.
 */
export function recordCampaignPerformance(
  campaignId: string,
  delta: Partial<CampaignPerformanceMetrics>
): HypeCampaignRecord {
  const campaign = HYPE_CAMPAIGNS.get(campaignId);
  if (!campaign) {
    throw new Error(`Campaign '${campaignId}' not found.`);
  }

  if (delta.deliveredCount) campaign.metrics.deliveredCount += delta.deliveredCount;
  if (delta.failedCount) campaign.metrics.failedCount += delta.failedCount;
  if (delta.openCount) campaign.metrics.openCount += delta.openCount;
  if (delta.clickCount) campaign.metrics.clickCount += delta.clickCount;
  if (delta.conversionCount) campaign.metrics.conversionCount += delta.conversionCount;
  if (delta.revenueGenerated) campaign.metrics.revenueGenerated += delta.revenueGenerated;

  return campaign;
}
