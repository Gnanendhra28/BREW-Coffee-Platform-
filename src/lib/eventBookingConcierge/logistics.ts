// Logistics & Transportation Calculation Engine for Agent 4: 🎪 Event Booking Concierge
// Resolves travel distance, drive times, mobilizations, and delivery surcharges.

import { LogisticsCalculation } from "./types";
import { MAX_SERVICEABLE_RADIUS_KM } from "./validation";

export const BASE_TRAVEL_FEE = 1500; // Flat travel fee included in standard quotation
export const PER_KM_SURCHARGE = 50;  // ₹50/km beyond 25km radius
export const BASE_RADIUS_KM = 25;

/**
 * Calculates transportation and mobilization logistics for a catering destination.
 */
export function calculateLogistics(destination: string, distanceKmInput?: number): LogisticsCalculation {
  const destLower = (destination || "").toLowerCase().trim();

  let distanceKm = distanceKmInput || 15;
  if (!distanceKmInput) {
    if (destLower.includes("cybercity") || destLower.includes("hitec") || destLower.includes("gachibowli")) {
      distanceKm = 10;
    } else if (destLower.includes("financial district") || destLower.includes("mindspace")) {
      distanceKm = 14;
    } else if (destLower.includes("jubilee hills") || destLower.includes("banjara hills")) {
      distanceKm = 18;
    } else if (destLower.includes("iit hyderabad") || destLower.includes("kandi")) {
      distanceKm = 48;
    } else if (destLower.includes("warangal") || destLower.includes("karimnagar")) {
      distanceKm = 140;
    }
  }

  const isServiceable = distanceKm <= MAX_SERVICEABLE_RADIUS_KM;
  const estimatedTravelTimeMinutes = Math.round(distanceKm * 2.2 + 15);

  let distanceSurcharge = 0;
  if (distanceKm > BASE_RADIUS_KM && isServiceable) {
    distanceSurcharge = (distanceKm - BASE_RADIUS_KM) * PER_KM_SURCHARGE;
  }

  const setupTeardownFee = 0; // included in base travel fee
  const totalLogisticsCost = BASE_TRAVEL_FEE + distanceSurcharge;

  return {
    baseLocation: "BREW Mobile Van Central Hub, Hitec City, Hyderabad",
    destinationLocation: destination || "City Hub",
    distanceKm,
    estimatedTravelTimeMinutes,
    isServiceable,
    baseTravelFee: BASE_TRAVEL_FEE,
    distanceSurcharge,
    setupTeardownFee,
    totalLogisticsCost,
  };
}
