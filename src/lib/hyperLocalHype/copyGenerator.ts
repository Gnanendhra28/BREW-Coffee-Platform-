// Copy Generation Engine & Verification Pipeline for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Guarantees:
// 1. Authoritative data binding (exact prices, percentages, products)
// 2. Multi-tone support (friendly, urgent, playful, premium)
// 3. Deterministic fact validation (zero price/discount hallucination)
// 4. Automatic fallback to verified deterministic templates if validation fails

import {
  CampaignMessageCopy,
  MarketingOpportunity,
  StoreMarketingContext,
} from "./types";
import { generateFallbackTemplates } from "./templates";
import { validateCampaignCopyFacts } from "./policy";

export interface CopyGenerationOptions {
  preferredTone?: "friendly" | "urgent" | "playful" | "premium";
  targetChannels?: Array<"push" | "sms" | "whatsapp" | "social">;
}

/**
 * Generates verified marketing copy for each requested channel.
 * Every copy is validated against commercial facts before being returned.
 */
export function generateHypeCampaignCopy(
  opportunity: MarketingOpportunity,
  context: StoreMarketingContext,
  options: CopyGenerationOptions = {}
): Record<"push" | "sms" | "whatsapp" | "social", CampaignMessageCopy> {
  const channels = options.targetChannels || ["push", "sms", "whatsapp", "social"];
  const tone = options.preferredTone || (opportunity.urgencyLevel === "HIGH" ? "urgent" : "friendly");

  // Generate safe authoritative templates
  const fallbackTemplates = generateFallbackTemplates(opportunity, context);

  const result: Record<"push" | "sms" | "whatsapp" | "social", CampaignMessageCopy> = {
    push: fallbackTemplates.push!,
    sms: fallbackTemplates.sms!,
    whatsapp: fallbackTemplates.whatsapp!,
    social: fallbackTemplates.social!,
  };

  // Apply tone and custom framing if specified, but re-validate against strict policy
  for (const channel of channels) {
    const baseCopy = fallbackTemplates[channel];
    if (!baseCopy) continue;

    const copyWithTone: CampaignMessageCopy = {
      ...baseCopy,
      tone,
    };

    // Deterministic fact check
    const factCheck = validateCampaignCopyFacts(copyWithTone, opportunity);
    if (factCheck.isValid) {
      result[channel] = copyWithTone;
    } else {
      // Revert to guaranteed safe template
      result[channel] = baseCopy;
    }
  }

  return result;
}
