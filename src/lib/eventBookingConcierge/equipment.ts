// Deterministic Equipment Calculation Engine for Agent 4: 🎪 Event Booking Concierge
// Computes commercial brewing gear, power requirements, and allocated hardware wear.

import { EquipmentRequirement } from "./types";

/**
 * Calculates equipment requirements and power specifications deterministically.
 */
export function calculateEquipment(params: {
  guestCount: number;
  tierId: "BASIC" | "STANDARD" | "PREMIUM";
}): EquipmentRequirement {
  const { guestCount, tierId } = params;

  const espressoMachinesCount = guestCount > 250 ? 2 : 1;
  const espressoGrindersCount = espressoMachinesCount + (tierId === "PREMIUM" ? 1 : 0);
  const brewerUrnsCount = guestCount > 150 ? 2 : 1;
  const thermalDispensersCount = tierId === "PREMIUM" ? 4 : tierId === "STANDARD" ? 3 : 2;
  const servingTablesCount = guestCount > 120 ? 2 : 1;

  let powerRequirementKw = 2.8;
  let powerDescription = "16A Single Phase 230V AC (or Van Internal Silent Inverter)";

  if (espressoMachinesCount >= 2 || tierId === "PREMIUM") {
    powerRequirementKw = 4.2;
    powerDescription = "32A Single Phase or Dual 16A Circuits (or Dual Van Lithium Inverters)";
  }

  // Equipment wear / amortized maintenance cost
  const equipmentRentalCost = tierId === "PREMIUM" ? 1800 : tierId === "STANDARD" ? 1200 : 800;

  return {
    espressoMachinesCount,
    espressoGrindersCount,
    brewerUrnsCount,
    thermalDispensersCount,
    servingTablesCount,
    powerRequirementKw,
    powerDescription,
    equipmentRentalCost,
  };
}
