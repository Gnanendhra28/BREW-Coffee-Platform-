// Store Context Assembler for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Aggregates store location, operating hours, local time, weather snapshot, and live promotion telemetry.

import { StoreMarketingContext, WeatherSnapshot } from "./types";
import { defaultWeatherProvider } from "./weather";

let STORE_CONTEXT_OVERRIDE: Partial<StoreMarketingContext> | null = null;

export function setStoreContextOverride(patch: Partial<StoreMarketingContext> | null): void {
  STORE_CONTEXT_OVERRIDE = patch;
}

/**
 * Builds the authoritative store marketing context for evaluation.
 */
export async function buildStoreMarketingContext(params: {
  storeId?: string;
  tenantId?: string;
  location?: string;
  currentHour?: number;
  weatherSnapshot?: WeatherSnapshot;
} = {}): Promise<StoreMarketingContext> {
  const storeId = params.storeId || "van-01";
  const tenantId = params.tenantId || "brew-hq";
  const location = params.location || "Cyber Gateway Sector 2";
  const currentHour = params.currentHour ?? new Date().getHours();

  // Operating hours check (7 AM to 11 PM)
  const isStoreOpen = currentHour >= 7 && currentHour < 23;

  // Weather resolution
  let weather = params.weatherSnapshot;
  if (!weather) {
    weather = await defaultWeatherProvider.getCurrentWeather(location);
  }

  const baseContext: StoreMarketingContext = {
    storeId,
    tenantId,
    storeName: "BREW Mobile Van #01",
    location,
    city: "Hyderabad",
    landmark: "Opposite Inorbit Mall Main Entrance",
    timezone: "Asia/Kolkata",
    operatingHours: "7:00 AM — 11:00 PM",
    currentLocalHour: currentHour,
    isStoreOpen,
    weather,
    activePromotions: [
      {
        id: "deal-afternoon-combo",
        title: "Late Afternoon Artisan Pair",
        productName: "Cappuccino + Cinnamon Roll",
        normalPrice: 400,
        dealPrice: 300,
        discountPercent: 25,
        expiresAt: Date.now() + 1000 * 60 * 60 * 2,
        isActive: true,
      },
    ],
    inventorySignals: [
      {
        productId: "d-4",
        productName: "Cinnamon Roll",
        availableStock: 14,
        isSurplus: true,
      },
      {
        productId: "c-1",
        productName: "Cappuccino",
        availableStock: 50,
        isSurplus: false,
      },
    ],
  };

  if (STORE_CONTEXT_OVERRIDE) {
    return {
      ...baseContext,
      ...STORE_CONTEXT_OVERRIDE,
      weather: STORE_CONTEXT_OVERRIDE.weather || baseContext.weather,
      activePromotions: STORE_CONTEXT_OVERRIDE.activePromotions || baseContext.activePromotions,
      inventorySignals: STORE_CONTEXT_OVERRIDE.inventorySignals || baseContext.inventorySignals,
    };
  }

  return baseContext;
}
