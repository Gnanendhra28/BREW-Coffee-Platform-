// Analytics & Performance Aggregation for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Computes business ROI, audience delivery rates, click-through-rates, and conversion attribution.

import { HypeBroadcasterMetrics } from "./types";
import { listHypeCampaigns } from "./campaigns";

export function getHypeBroadcasterMetrics(storeId?: string): HypeBroadcasterMetrics {
  const campaigns = listHypeCampaigns(storeId);

  let campaignsGenerated = campaigns.length;
  let campaignsApproved = 0;
  let campaignsSent = 0;
  let campaignsBlocked = 0;
  let campaignsCancelled = 0;
  let totalAudienceReached = 0;
  let totalDeliverySuccess = 0;
  let totalDeliveryFailures = 0;
  let totalOpens = 0;
  let totalClicks = 0;
  let totalConversions = 0;
  let totalRevenueAttributed = 0;

  for (const c of campaigns) {
    if (c.status === "APPROVED" || c.status === "SENT") {
      campaignsApproved++;
    }
    if (c.status === "SENT") {
      campaignsSent++;
    }
    if (c.status === "REJECTED" || c.status === "FAILED") {
      campaignsBlocked++;
    }
    if (c.status === "CANCELLED") {
      campaignsCancelled++;
    }

    totalAudienceReached += c.metrics.targetedCount;
    totalDeliverySuccess += c.metrics.deliveredCount;
    totalDeliveryFailures += c.metrics.failedCount;
    totalOpens += c.metrics.openCount;
    totalClicks += c.metrics.clickCount;
    totalConversions += c.metrics.conversionCount;
    totalRevenueAttributed += c.metrics.revenueGenerated;
  }

  const avgClickRatePercent =
    totalDeliverySuccess > 0
      ? Math.round((totalClicks / totalDeliverySuccess) * 1000) / 10
      : 0;

  const avgConversionRatePercent =
    totalDeliverySuccess > 0
      ? Math.round((totalConversions / totalDeliverySuccess) * 1000) / 10
      : 0;

  return {
    campaignsGenerated,
    campaignsApproved,
    campaignsSent,
    campaignsBlocked,
    campaignsCancelled,
    totalAudienceReached,
    totalDeliverySuccess,
    totalDeliveryFailures,
    totalConversions,
    totalRevenueAttributed,
    avgClickRatePercent,
    avgConversionRatePercent,
  };
}
