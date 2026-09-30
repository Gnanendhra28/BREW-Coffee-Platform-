// Deterministic Mathematical & Operational Calculations Engine for Curbside Drive-Thru Expediter
// Covers:
// 1. Vehicle Metadata Parsing (Plate, Bay, Model/Color)
// 2. Parallel Station Preparation Time & Remaining Duration Estimator
// 3. Arrival Buffer & Urgency Classification (NORMAL, WATCH, URGENT, CRITICAL)
// 4. Deterministic 0-100 Priority Scoring
// 5. Sub-60s SLA & Statistical Distribution (Average, Median, P95, P99)

import {
  ParsedVehicleInfo,
  CurbsideUrgencyLevel,
  CurbsideAction,
  CurbsideExpediteAssessment,
  CurbsideSlaRecord,
  CurbsideOperationalMetrics,
  OrderPreparationEstimate,
} from "./types";
import { OrderStatus } from "@/context/VanContext";

// Standard preparation durations per unit item in seconds
export const ITEM_PREPARATION_DURATIONS: Record<string, number> = {
  // Espresso beverages
  latte: 90,
  cappuccino: 90,
  mocha: 90,
  "flat white": 80,
  "caramel macchiato": 90,
  espresso: 45,
  "double espresso": 45,
  cortado: 45,
  americano: 45,
  "classic filter coffee": 50,
  affogato: 40,

  // Cold coffee & teas
  "cold brew": 15,
  "vanilla bean cold brew": 20,
  "iced latte": 45,
  "earl grey": 60,
  "masala chai": 60,
  "green tea": 45,
  "assam gold": 50,

  // Shakes
  "belgian dark chocolate shake": 75,
  "salted caramel shake": 75,
  "strawberry cream shake": 75,

  // Bakery & Desserts (oven warming / plating)
  croissant: 20,
  "cinnamon roll": 20,
  "classic brownie": 20,
  "choco lava cake": 25,
  "blueberry crumble muffin": 20,
  "banana walnut bread": 20,
  "almond biscotti": 15,
};

/**
 * Parses vehicle metadata string into structured plate, curb bay, and description.
 */
export function parseVehicleDetails(vehicleInfo?: string): ParsedVehicleInfo {
  if (!vehicleInfo || vehicleInfo.trim().length === 0) {
    return {
      plate: "Unknown Plate",
      bay: "General Curb",
      description: "Customer Vehicle (Hazard lights on)",
      raw: "",
    };
  }

  const raw = vehicleInfo.trim();

  // Extract license plate in parentheses, e.g. "(TS 09 AB 1234)"
  const plateMatch = raw.match(/\(([^)]+)\)/);
  const plate = plateMatch ? plateMatch[1].trim() : "Unknown Plate";

  // Extract designated bay, e.g. "Bay #2", "Bay 3"
  const bayMatch = raw.match(/Bay\s*#?([0-9A-Za-z]+)/i);
  const bay = bayMatch ? `Bay #${bayMatch[1].trim()}` : "General Curb";

  // Clean vehicle description
  const description = raw
    .replace(/\([^)]*\)/g, "")
    .replace(/-.*bay.*$/i, "")
    .replace(/-.*$/, "")
    .trim() || "Customer Vehicle";

  return { plate, bay, description, raw };
}

/**
 * Resolves standard preparation time in seconds for a menu item.
 */
export function getStandardItemPrepSeconds(itemName: string): number {
  const lower = itemName.toLowerCase().trim();

  if (ITEM_PREPARATION_DURATIONS[lower]) {
    return ITEM_PREPARATION_DURATIONS[lower];
  }

  for (const [key, duration] of Object.entries(ITEM_PREPARATION_DURATIONS)) {
    if (lower.includes(key)) {
      return duration;
    }
  }

  if (lower.includes("coffee") || lower.includes("brew") || lower.includes("latte") || lower.includes("cappuccino")) {
    return 80;
  }
  if (lower.includes("tea") || lower.includes("chai")) {
    return 55;
  }
  if (lower.includes("shake")) {
    return 75;
  }
  if (lower.includes("roll") || lower.includes("pastry") || lower.includes("cake") || lower.includes("croissant") || lower.includes("cookie")) {
    return 20;
  }

  return 60; // default item duration
}

/**
 * Calculates deterministic preparation time for an order.
 * Accounts for 2-group parallel espresso extraction and simultaneous bakery oven warming.
 */
export function estimateOrderPreparation(
  orderId: string,
  items: { name: string; quantity: number }[],
  orderCreatedAt: number,
  orderStatus: OrderStatus,
  currentTime: number = Date.now()
): OrderPreparationEstimate {
  if (orderStatus === "ready" || orderStatus === "served") {
    return {
      orderId,
      totalPrepSeconds: 0,
      elapsedPrepSeconds: Math.max(0, Math.round((currentTime - orderCreatedAt) / 1000)),
      remainingPrepSeconds: 0,
      parallelStationsCount: 2,
      targetReadyTimestamp: orderCreatedAt,
      isReady: true,
    };
  }

  let beveragePrepSeconds = 0;
  let bakeryPrepSeconds = 0;

  for (const item of items) {
    const qty = Math.max(1, item.quantity || 1);
    const itemSec = getStandardItemPrepSeconds(item.name);
    const lower = item.name.toLowerCase();

    const isBakery =
      lower.includes("croissant") ||
      lower.includes("roll") ||
      lower.includes("cake") ||
      lower.includes("brownie") ||
      lower.includes("muffin") ||
      lower.includes("bread") ||
      lower.includes("biscotti");

    if (isBakery) {
      bakeryPrepSeconds += itemSec * qty;
    } else {
      beveragePrepSeconds += itemSec * qty;
    }
  }

  // Mobile van has a 2-group espresso machine: beverages can be parallelized 2 at a time
  const parallelBeverageSeconds = Math.ceil(beveragePrepSeconds / 2);
  // Bakery warming runs concurrently with coffee extraction; take max or additive offset
  const parallelBakerySeconds = Math.min(bakeryPrepSeconds, 30); // oven warming is batched
  const totalPrepSeconds = Math.max(30, parallelBeverageSeconds + parallelBakerySeconds);

  const elapsedPrepSeconds = Math.max(0, Math.round((currentTime - orderCreatedAt) / 1000));
  const remainingPrepSeconds = Math.max(0, totalPrepSeconds - elapsedPrepSeconds);
  const targetReadyTimestamp = currentTime + remainingPrepSeconds * 1000;

  return {
    orderId,
    totalPrepSeconds,
    elapsedPrepSeconds,
    remainingPrepSeconds,
    parallelStationsCount: 2,
    targetReadyTimestamp,
    isReady: remainingPrepSeconds === 0,
  };
}

/**
 * Evaluates Curbside Urgency and Action Recommendation.
 * Rules:
 * - Vehicle arrived (ETA = 0) & order not ready -> CRITICAL (Vehicle waiting at curb!)
 * - Vehicle ETA <= remainingPrep (buffer < 30s) -> URGENT (Expedite extraction)
 * - Buffer 30s - 120s -> WATCH (Approaching window)
 * - Buffer > 120s -> NORMAL (Adequate buffer)
 */
export function calculateCurbsideUrgency(
  vehicleEtaSeconds: number,
  remainingPrepSeconds: number,
  isOrderReady: boolean
): {
  urgencyLevel: CurbsideUrgencyLevel;
  recommendedAction: CurbsideAction;
  arrivalBufferSeconds: number;
  reason: string;
} {
  const arrivalBufferSeconds = vehicleEtaSeconds - remainingPrepSeconds;

  // Case 1: Order is already prepared and ready
  if (isOrderReady) {
    if (vehicleEtaSeconds <= 0) {
      return {
        urgencyLevel: "CRITICAL",
        recommendedAction: "PREPARE_HANDOFF",
        arrivalBufferSeconds,
        reason: "Vehicle has pulled into curb bay! Order is ready on counter. Hand over tray immediately.",
      };
    }
    if (vehicleEtaSeconds <= 120) {
      return {
        urgencyLevel: "WATCH",
        recommendedAction: "PREPARE_HANDOFF",
        arrivalBufferSeconds,
        reason: "Order is ready. Vehicle arriving in under 2 minutes. Position order tray for swift handover.",
      };
    }
    return {
      urgencyLevel: "NORMAL",
      recommendedAction: "NORMAL",
      arrivalBufferSeconds,
      reason: "Order is packed and ready. Ample vehicle travel buffer.",
    };
  }

  // Case 2: Order is still being prepared
  if (vehicleEtaSeconds <= 0) {
    return {
      urgencyLevel: "CRITICAL",
      recommendedAction: "EXPEDITE",
      arrivalBufferSeconds,
      reason: `CRITICAL: Vehicle has arrived at curb but order still requires ${remainingPrepSeconds}s prep. Prioritize immediate extraction on Group 1!`,
    };
  }

  if (arrivalBufferSeconds < 30) {
    return {
      urgencyLevel: "URGENT",
      recommendedAction: "EXPEDITE",
      arrivalBufferSeconds,
      reason: `URGENT: Vehicle arrives in ${vehicleEtaSeconds}s but preparation takes ${remainingPrepSeconds}s (buffer deficit ${arrivalBufferSeconds}s). Accelerate beverage extraction.`,
    };
  }

  if (arrivalBufferSeconds < 120) {
    return {
      urgencyLevel: "WATCH",
      recommendedAction: "NORMAL",
      arrivalBufferSeconds,
      reason: `WATCH: Vehicle ~${vehicleEtaSeconds}s away with ${remainingPrepSeconds}s prep remaining. Synchronize milk steaming for peak microfoam.`,
    };
  }

  return {
    urgencyLevel: "NORMAL",
    recommendedAction: "NORMAL",
    arrivalBufferSeconds,
    reason: `NORMAL: Healthy ${arrivalBufferSeconds}s preparation buffer. Vehicle is comfortably ahead of preparation schedule.`,
  };
}

/**
 * Calculates a Deterministic 0-100 Priority Score for KDS Queue Ordering.
 * Formula:
 * - Urgency base: CRITICAL = 50, URGENT = 35, WATCH = 15, NORMAL = 5
 * - Buffer deficit: up to 25 points for negative buffers
 * - Order wait age: up to 15 points
 * - Curbside delivery guarantee bonus: 10 points
 */
export function calculateQueuePriorityScore(
  urgencyLevel: CurbsideUrgencyLevel,
  arrivalBufferSeconds: number,
  orderAgeSeconds: number,
  isCurbside: boolean = true
): number {
  let score = 0;

  // 1. Urgency tier points
  switch (urgencyLevel) {
    case "CRITICAL":
      score += 50;
      break;
    case "URGENT":
      score += 35;
      break;
    case "WATCH":
      score += 15;
      break;
    case "NORMAL":
      score += 5;
      break;
  }

  // 2. Buffer deficit points (if vehicle arrives before prep finishes)
  if (arrivalBufferSeconds < 0) {
    const deficitPoints = Math.min(25, Math.round(Math.abs(arrivalBufferSeconds) * 0.25));
    score += deficitPoints;
  }

  // 3. Order age / queue wait time points (1 point per 30s in queue, up to 15)
  const agePoints = Math.min(15, Math.floor(orderAgeSeconds / 30));
  score += agePoints;

  // 4. Curbside vehicle parking bonus (street parking spots have strict limits)
  if (isCurbside) {
    score += 10;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Measures actual curbside handoff duration and classifies SLA compliance.
 * SLA Target: <= 60 seconds from curb arrival to window handover.
 */
export function measureHandoffSla(
  orderId: string,
  vehicleArrivedAt: number,
  handoffCompletedAt: number,
  handoffStartedAt?: number
): CurbsideSlaRecord {
  const handoffDurationSeconds = Math.max(0, Math.round((handoffCompletedAt - vehicleArrivedAt) / 1000));
  const slaMet = handoffDurationSeconds <= 60;
  const vehicleWaitSeconds = handoffDurationSeconds;

  return {
    orderId,
    vehicleArrivedAt,
    handoffStartedAt,
    handoffCompletedAt,
    handoffDurationSeconds,
    slaMet,
    vehicleWaitSeconds,
  };
}

/**
 * Computes aggregated operational & statistical metrics across SLA records.
 */
export function calculateOperationalMetrics(
  records: CurbsideSlaRecord[],
  activeAssessments: CurbsideExpediteAssessment[] = []
): CurbsideOperationalMetrics {
  const completed = records.length;
  const slaMetCount = records.filter((r) => r.slaMet).length;
  const slaMissedCount = completed - slaMetCount;
  const slaSuccessRate = completed > 0 ? Number(((slaMetCount / completed) * 100).toFixed(1)) : 100;

  const durations = records.map((r) => r.handoffDurationSeconds).sort((a, b) => a - b);
  const sumDuration = durations.reduce((acc, val) => acc + val, 0);
  const avgHandoff = completed > 0 ? Number((sumDuration / completed).toFixed(1)) : 0;

  const medianHandoff =
    completed > 0
      ? completed % 2 === 0
        ? Number(((durations[completed / 2 - 1] + durations[completed / 2]) / 2).toFixed(1))
        : durations[Math.floor(completed / 2)]
      : 0;

  const p95Idx = Math.floor(completed * 0.95);
  const p95Handoff = completed > 0 ? durations[Math.min(durations.length - 1, p95Idx)] : 0;

  const p99Idx = Math.floor(completed * 0.99);
  const p99Handoff = completed > 0 ? durations[Math.min(durations.length - 1, p99Idx)] : 0;

  const urgentCount = activeAssessments.filter((a) => a.urgencyLevel === "URGENT").length;
  const criticalCount = activeAssessments.filter((a) => a.urgencyLevel === "CRITICAL").length;
  const expeditedCount = activeAssessments.filter((a) => a.recommendedAction === "EXPEDITE").length;

  return {
    ordersMonitored: activeAssessments.length,
    ordersExpedited: expeditedCount,
    ordersCompleted: completed,
    slaMetCount,
    slaMissedCount,
    slaSuccessRate,
    avgHandoffDurationSeconds: avgHandoff,
    medianHandoffDurationSeconds: medianHandoff,
    p95HandoffDurationSeconds: p95Handoff,
    p99HandoffDurationSeconds: p99Handoff,
    avgVehicleWaitSeconds: avgHandoff,
    urgentOrdersCount: urgentCount,
    criticalOrdersCount: criticalCount,
  };
}
