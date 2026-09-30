// Deterministic Demand Forecasting & Rolling Sales Velocity Engine
// Enforces:
// 1. Rolling window sales velocity (1h, 3h, 6h, 24h, 7d)
// 2. 4-level deterministic forecast hierarchy (Historical Rush -> Rolling -> Velocity -> Baseline)
// 3. Graceful fallback without hard failures

import {
  PastryInventoryItem,
  PastrySalesVelocity,
  PastryDemandForecast,
  ForecastMethod,
} from "./types";

const DEFAULT_PASTRY_BASELINE_RATE = 2.0; // 2 pastries per hour default

/**
 * Calculates rolling sales velocity across standard time windows.
 */
export function calculateSalesVelocity(
  productId: string,
  salesHistory: { timestamp: number; quantity: number }[] = [],
  currentTime: number = Date.now()
): PastrySalesVelocity {
  const oneHourAgo = currentTime - 1000 * 60 * 60;
  const threeHoursAgo = currentTime - 1000 * 60 * 60 * 3;
  const sixHoursAgo = currentTime - 1000 * 60 * 60 * 6;
  const twentyFourHoursAgo = currentTime - 1000 * 60 * 60 * 24;
  const sevenDaysAgo = currentTime - 1000 * 60 * 60 * 24 * 7;

  let sum1h = 0;
  let sum3h = 0;
  let sum6h = 0;
  let sum24h = 0;
  let sum7d = 0;

  for (const s of salesHistory) {
    if (s.timestamp >= oneHourAgo) sum1h += s.quantity;
    if (s.timestamp >= threeHoursAgo) sum3h += s.quantity;
    if (s.timestamp >= sixHoursAgo) sum6h += s.quantity;
    if (s.timestamp >= twentyFourHoursAgo) sum24h += s.quantity;
    if (s.timestamp >= sevenDaysAgo) sum7d += s.quantity;
  }

  const rate1h = sum1h > 0 ? Number(sum1h.toFixed(2)) : DEFAULT_PASTRY_BASELINE_RATE;
  const rate3h = sum3h > 0 ? Number((sum3h / 3).toFixed(2)) : DEFAULT_PASTRY_BASELINE_RATE;
  const rate6h = sum6h > 0 ? Number((sum6h / 6).toFixed(2)) : DEFAULT_PASTRY_BASELINE_RATE;
  const rate24h = sum24h > 0 ? Number((sum24h / 14).toFixed(2)) : DEFAULT_PASTRY_BASELINE_RATE;
  const rate7d = sum7d > 0 ? Number((sum7d / (14 * 7)).toFixed(2)) : DEFAULT_PASTRY_BASELINE_RATE;

  let trend: PastrySalesVelocity["trend"] = "normal";
  const ratio = rate1h / Math.max(0.1, DEFAULT_PASTRY_BASELINE_RATE);
  if (ratio >= 2.0) trend = "spike";
  else if (ratio >= 1.3) trend = "increasing";
  else if (ratio <= 0.4 && sum24h > 0) trend = "drop";
  else if (ratio <= 0.75) trend = "decreasing";

  return {
    productId,
    rateLast1h: rate1h,
    rateLast3h: rate3h,
    rateLast6h: rate6h,
    rateLast24h: rate24h,
    rateLast7d: rate7d,
    trend,
    baselinePerHour: DEFAULT_PASTRY_BASELINE_RATE,
  };
}

/**
 * Deterministic Forecast Hierarchy for Pastry Demand.
 */
export function forecastPastryDemand(
  product: PastryInventoryItem,
  velocity: PastrySalesVelocity,
  horizonHours: number,
  currentHour: number = new Date().getHours()
): PastryDemandForecast {
  let methodUsed: ForecastMethod = "configured_baseline";
  let baseRate = velocity.baselinePerHour;
  let confidence = 0.8;

  // Level 1: Historical Rush window multiplier
  let timeMultiplier = 1.0;
  if (currentHour >= 15 && currentHour <= 18) {
    // Afternoon tea & coffee combo rush
    timeMultiplier = 1.25;
    methodUsed = "historical_rush";
    confidence = 0.92;
  } else if (currentHour >= 8 && currentHour <= 11) {
    // Morning breakfast rush
    timeMultiplier = 1.35;
    methodUsed = "historical_rush";
    confidence = 0.94;
  } else if (currentHour >= 20 || currentHour < 7) {
    // Late night dip
    timeMultiplier = 0.45;
    methodUsed = "historical_rush";
    confidence = 0.88;
  } else if (velocity.rateLast6h > 0) {
    // Level 2: Rolling 6-hour moving average
    baseRate = velocity.rateLast6h;
    methodUsed = "rolling_velocity";
    confidence = 0.86;
  } else if (velocity.rateLast1h > 0) {
    // Level 3: Current velocity
    baseRate = velocity.rateLast1h;
    methodUsed = "current_day_velocity";
    confidence = 0.82;
  }

  const forecastRatePerHour = Number((baseRate * timeMultiplier).toFixed(2));
  const expectedNaturalSales = Math.round(forecastRatePerHour * horizonHours);

  return {
    productId: product.id,
    forecastRatePerHour,
    horizonHours,
    expectedNaturalSales,
    confidence,
    methodUsed,
  };
}
