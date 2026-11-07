/**
 * BREW Coffee Platform — Phase 6.4 WhatsApp Provider Selector
 * Factory function for selecting between MockWhatsAppProvider and MetaWhatsAppCloudProvider.
 */

import { WhatsAppProvider } from "../types";
import { MockWhatsAppProvider } from "./whatsappProvider";
import { MetaWhatsAppCloudProvider, MetaWhatsAppCloudConfig } from "./metaWhatsAppProvider";

export type WhatsAppProviderMode = "mock" | "cloud_api" | "auto";

export function getWhatsAppProvider(
  mode: WhatsAppProviderMode = "auto",
  config?: MetaWhatsAppCloudConfig
): WhatsAppProvider {
  const envMode = process.env.WHATSAPP_PROVIDER_MODE?.toLowerCase();

  if (mode === "mock" || envMode === "mock") {
    return new MockWhatsAppProvider();
  }

  if (mode === "cloud_api" || envMode === "cloud_api") {
    return new MetaWhatsAppCloudProvider(config);
  }

  // Auto mode: Check if Meta credentials exist in environment
  const hasCredentials = Boolean(
    (process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID) &&
    (process.env.META_WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN)
  );

  if (hasCredentials && envMode !== "mock") {
    return new MetaWhatsAppCloudProvider(config);
  }

  return new MockWhatsAppProvider();
}
