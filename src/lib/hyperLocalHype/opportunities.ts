// Deterministic Opportunity Detection Engine for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Evaluates real-time store context (weather, time-of-day, promotions, inventory) and generates prioritized opportunities.

import { StoreMarketingContext, MarketingOpportunity, MarketingOpportunityType } from "./types";

/**
 * Detects all valid marketing opportunities based on deterministic store context signals.
 * Opportunities are strictly scored between 0 and 100 and ordered by priority.
 */
export function detectMarketingOpportunities(
  context: StoreMarketingContext
): MarketingOpportunity[] {
  const opportunities: MarketingOpportunity[] = [];
  const now = Date.now();
  const { weather, currentLocalHour, activePromotions, isStoreOpen, localEvent } = context;

  // If store is closed, do not generate active marketing broadcast opportunities
  if (!isStoreOpen) {
    return [];
  }

  // 1. Yield Optimizer Flash Deal Amplification (Highest commercial priority)
  const activePromo = activePromotions.find((p) => p.isActive && p.expiresAt > now);
  if (activePromo) {
    opportunities.push({
      id: `opp-yield-${activePromo.id}`,
      type: "YIELD_FLASH_DEAL",
      priorityScore: 96,
      triggerReason: `Active flash deal '${activePromo.title}' detected with ${activePromo.discountPercent}% off (Expires in ${Math.round((activePromo.expiresAt - now) / 60000)} mins)`,
      recommendedProducts: [activePromo.productName],
      promotionReference: {
        id: activePromo.id,
        dealPrice: activePromo.dealPrice,
        normalPrice: activePromo.normalPrice,
        discountPercent: activePromo.discountPercent,
        expiresAt: activePromo.expiresAt,
      },
      headlineTheme: `Flash Deal: ${activePromo.productName} for just ₹${activePromo.dealPrice}`,
      urgencyLevel: "HIGH",
      detectedAt: now,
    });
  }

  // 2. Rain / Weather Disruption Opportunity
  if (
    weather.rainProbability >= 0.5 ||
    weather.condition === "RAIN" ||
    weather.condition === "STORM" ||
    weather.condition === "DRIZZLE"
  ) {
    const isHeavy = weather.rainProbability >= 0.7 || weather.condition === "STORM";
    opportunities.push({
      id: `opp-rain-${weather.observedAt}`,
      type: "RAIN_OPPORTUNITY",
      priorityScore: isHeavy ? 92 : 86,
      triggerReason: `High rain probability (${Math.round(weather.rainProbability * 100)}%) and condition ${weather.condition}`,
      recommendedProducts: ["Hot Hazelnut Latte", "Spiced Chai Latte", "Warm Croissant"],
      headlineTheme: "Rainy Day Comfort: Warm Coffee Delivered or Curbside Ready",
      urgencyLevel: isHeavy ? "HIGH" : "MEDIUM",
      detectedAt: now,
    });
  }

  // 3. Hot Weather / Heatwave Cold Drink Opportunity
  if (
    weather.temperatureC >= 28 ||
    weather.feelsLikeC >= 30 ||
    weather.condition === "HOT"
  ) {
    const isExtreme = weather.temperatureC >= 34 || weather.feelsLikeC >= 36;
    opportunities.push({
      id: `opp-heat-${weather.observedAt}`,
      type: "COLD_DRINK_OPPORTUNITY",
      priorityScore: isExtreme ? 90 : 82,
      triggerReason: `Warm/hot weather detected (${weather.temperatureC}°C, feels like ${weather.feelsLikeC}°C)`,
      recommendedProducts: ["Iced Spanish Latte", "Cold Brew Tonic", "Vietnamese Iced Coffee"],
      headlineTheme: "Beat the Afternoon Heat with Refreshing Artisanal Cold Brews",
      urgencyLevel: isExtreme ? "HIGH" : "MEDIUM",
      detectedAt: now,
    });
  }

  // 4. Chilly / Cold Weather Comfort Opportunity
  if (weather.temperatureC <= 19 || weather.condition === "CHILLY") {
    opportunities.push({
      id: `opp-cold-${weather.observedAt}`,
      type: "HOT_DRINK_OPPORTUNITY",
      priorityScore: 84,
      triggerReason: `Crisp chilly weather detected (${weather.temperatureC}°C)`,
      recommendedProducts: ["Signature Cappuccino", "Vanilla Flat White", "Mocha Supreme"],
      headlineTheme: "Warm Up with Steaming Single-Origin Artisan Brews",
      urgencyLevel: "MEDIUM",
      detectedAt: now,
    });
  }

  // 5. Afternoon Slump Opportunity (14:00 - 16:30)
  if (currentLocalHour >= 14 && currentLocalHour <= 16) {
    opportunities.push({
      id: `opp-slump-${currentLocalHour}`,
      type: "AFTERNOON_SLUMP",
      priorityScore: 78,
      triggerReason: `Afternoon lull/slump window detected (${currentLocalHour}:00)`,
      recommendedProducts: ["Double Shot Cortado", "Nitro Cold Brew", "Belgian Chocolate Brownie"],
      headlineTheme: "Beat the 3 PM Work Slump with a Fresh Artisan Double Shot",
      urgencyLevel: "MEDIUM",
      detectedAt: now,
    });
  }

  // 6. Morning Rush Opportunity (07:30 - 10:30)
  if (currentLocalHour >= 7 && currentLocalHour <= 10) {
    opportunities.push({
      id: `opp-morning-${currentLocalHour}`,
      type: "MORNING_RUSH",
      priorityScore: 80,
      triggerReason: `Morning commute peak window detected (${currentLocalHour}:00)`,
      recommendedProducts: ["Morning Flat White", "Butter Croissant", "Americano"],
      headlineTheme: "Fast Commute Coffee: Curbside Pickup Ready in 3 Minutes",
      urgencyLevel: "MEDIUM",
      detectedAt: now,
    });
  }

  // 7. Local Tech Park / Cultural Event Opportunity
  if (localEvent && localEvent.distanceKm <= 2.5) {
    opportunities.push({
      id: `opp-event-${localEvent.name.toLowerCase().replace(/\s+/g, "-")}`,
      type: "LOCAL_EVENT",
      priorityScore: 85,
      triggerReason: `Nearby crowd event '${localEvent.name}' within ${localEvent.distanceKm} km`,
      recommendedProducts: ["Cold Brew On-The-Go", "Quick Espresso", "Cinnamon Cruffin"],
      headlineTheme: `Attending ${localEvent.name}? BREW Mobile Bar is 200m away!`,
      urgencyLevel: "HIGH",
      detectedAt: now,
    });
  }

  // Sort descending by priorityScore
  return opportunities.sort((a, b) => b.priorityScore - a.priorityScore);
}
