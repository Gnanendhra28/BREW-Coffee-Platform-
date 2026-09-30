// Production Quotation Generation Engine for Agent 4: 🎪 Event Booking Concierge
// Creates immutable, versioned 3-tier catering quotations with full operational manifest.

import {
  EventRequirements,
  EventQuotationRecord,
  QuotationTier,
  RiskTier,
} from "./types";
import { calculateConsumption, buildIngredientManifest } from "./consumption";
import { calculateStaffing } from "./staffing";
import { calculateEquipment } from "./equipment";
import { calculateLogistics } from "./logistics";
import { calculateTierCostBreakdown, calculateTierEconomics } from "./calculations";

export const QUOTE_VALIDITY_DAYS = 7;

/**
 * Generates an immutable, versioned 3-tier catering quotation.
 */
export function generateEventQuotationRecord(params: {
  requirements: EventRequirements;
  customerId?: string;
  quoteId?: string;
  previousVersion?: number;
  currentStock?: Record<string, number>;
}): EventQuotationRecord {
  const { requirements, currentStock } = params;
  const customerId = params.customerId || `cust-${Date.now()}`;
  const quoteId = params.quoteId || `quote-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const quoteVersion = (params.previousVersion || 0) + 1;
  const versionId = `QUOTE-${quoteId}-V${quoteVersion}`;

  const guestCount = requirements.guestCount;
  const durationMinutes = requirements.durationMinutes || 240;

  // 1. Logistics
  const logistics = calculateLogistics(requirements.location);

  // 2. Standard Tier Calculations (Used for primary manifest)
  const standardConsumption = calculateConsumption({
    guestCount,
    durationMinutes,
    tierId: "STANDARD",
    eventType: requirements.eventType,
  });

  const standardStaffing = calculateStaffing({
    guestCount,
    durationMinutes,
    tierId: "STANDARD",
  });

  const standardEquipment = calculateEquipment({
    guestCount,
    tierId: "STANDARD",
  });

  const standardManifestData = buildIngredientManifest(standardConsumption, currentStock);

  // 3. Build All 3 Tiers
  const tierIds: Array<"BASIC" | "STANDARD" | "PREMIUM"> = ["BASIC", "STANDARD", "PREMIUM"];
  const tiers: QuotationTier[] = [];

  for (const tid of tierIds) {
    const tierConsumption = calculateConsumption({
      guestCount,
      durationMinutes,
      tierId: tid,
      eventType: requirements.eventType,
    });

    const tierStaffing = calculateStaffing({
      guestCount,
      durationMinutes,
      tierId: tid,
    });

    const tierEquipment = calculateEquipment({
      guestCount,
      tierId: tid,
    });

    const tierCostBreakdown = calculateTierCostBreakdown({
      consumption: tierConsumption,
      staffing: tierStaffing,
      equipment: tierEquipment,
      logistics,
      currentStock,
    });

    const econ = calculateTierEconomics({
      tierId: tid,
      guestCount,
      totalCost: tierCostBreakdown.totalCost,
      travelDistanceFee: logistics.totalLogisticsCost,
    });

    tiers.push(econ.tier);
  }

  // 4. Procurement & Feasibility Assessment
  const procurementRequired = standardManifestData.procurementRequired;

  // 5. Risk Tier & Approval Classification
  let riskTier: RiskTier = "LOW";
  let requiresApproval = false;

  if (guestCount > 500 || !logistics.isServiceable) {
    riskTier = "HIGH";
    requiresApproval = true;
  } else if (guestCount > 250 || procurementRequired) {
    riskTier = "MEDIUM";
    requiresApproval = true;
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + 1000 * 60 * 60 * 24 * QUOTE_VALIDITY_DAYS;
  const idempotencyKey = `${customerId}:${quoteId}:V${quoteVersion}:EVENT_QUOTE`;

  return {
    quoteId,
    quoteVersion,
    versionId,
    customerId,
    organization: requirements.organization,
    location: requirements.location,
    eventDate: requirements.eventDate,
    startTime: requirements.startTime,
    endTime: requirements.endTime,
    durationMinutes,
    guestCount,
    eventType: requirements.eventType,
    dietaryRequirements: requirements.dietaryRequirements,
    requirements,
    consumption: standardConsumption,
    staffing: standardStaffing,
    equipment: standardEquipment,
    logistics,
    ingredientManifest: standardManifestData.manifest,
    tiers,
    selectedTier: tiers.find((t) => t.isRecommended) || tiers[1],
    status: "READY",
    riskTier,
    requiresApproval,
    procurementRequired,
    issuedAt,
    expiresAt,
    idempotencyKey,
  };
}
