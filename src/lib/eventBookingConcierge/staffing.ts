// Deterministic Staffing Calculation Engine for Agent 4: 🎪 Event Booking Concierge
// Calculates barista and crew requirements, labor hours, and staffing costs.

import { StaffingRequirement } from "./types";

export const HOURLY_LABOR_RATE_PER_STAFF = 500; // ₹500/hr certified specialty barista wage

/**
 * Calculates staffing requirements and labor cost deterministically.
 */
export function calculateStaffing(params: {
  guestCount: number;
  durationMinutes?: number;
  tierId: "BASIC" | "STANDARD" | "PREMIUM";
}): StaffingRequirement {
  const { guestCount, durationMinutes = 240, tierId } = params;
  const serviceHours = Math.max(1, durationMinutes / 60);

  // Barista sizing based on crowd thresholds and tier expectations
  let baristasAssigned = 1;
  if (tierId === "PREMIUM") {
    baristasAssigned = guestCount > 250 ? 4 : guestCount > 100 ? 3 : 2;
  } else if (tierId === "STANDARD") {
    baristasAssigned = guestCount > 250 ? 3 : guestCount > 100 ? 2 : 1;
  } else {
    // BASIC
    baristasAssigned = guestCount > 250 ? 3 : guestCount > 120 ? 2 : 1;
  }

  // Dedicated support/service staff (for busing, cup replenishment, guest coordination)
  let serviceStaffAssigned = 0;
  if (tierId === "PREMIUM" && guestCount > 80) {
    serviceStaffAssigned = 1;
  } else if (guestCount > 350) {
    serviceStaffAssigned = 1;
  }

  const totalStaffCount = baristasAssigned + serviceStaffAssigned;

  const setupHours = 1.0;
  const cleanupHours = 0.5;
  const shiftHoursPerStaff = setupHours + serviceHours + cleanupHours;
  const totalLaborHours = Number((shiftHoursPerStaff * totalStaffCount).toFixed(1));
  const totalLaborCost = Math.round(totalLaborHours * HOURLY_LABOR_RATE_PER_STAFF);

  return {
    baristasAssigned,
    serviceStaffAssigned,
    totalStaffCount,
    setupHours,
    serviceHours,
    cleanupHours,
    totalLaborHours,
    hourlyRatePerStaff: HOURLY_LABOR_RATE_PER_STAFF,
    totalLaborCost,
  };
}
