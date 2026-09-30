// Production Type Contracts & Data Models for Agent 4: 🎪 Event Booking Concierge

export type EventType =
  | "corporate"
  | "wedding"
  | "birthday"
  | "conference"
  | "workshop"
  | "private_party"
  | "college_event"
  | "launch_event"
  | "meeting"
  | "other";

export type ServiceLevel = "BASIC" | "STANDARD" | "PREMIUM" | "VIP";

export type DietaryRequirement =
  | "vegan"
  | "vegetarian"
  | "gluten_free"
  | "dairy_free"
  | "nut_free"
  | "halal"
  | "other";

export type QuoteStatus =
  | "DRAFT"
  | "CALCULATING"
  | "READY"
  | "SENT"
  | "VIEWED"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";

export type BookingStatus =
  | "CONFIRMED"
  | "PAYMENT_PENDING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH";

export interface EventRequirements {
  organization: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  eventType: EventType;
  guestCount: number;
  eventDate: string;           // YYYY-MM-DD
  startTime: string;           // HH:MM (24h)
  endTime: string;             // HH:MM (24h)
  durationMinutes: number;
  location: string;
  city: string;
  budget?: number;
  serviceLevel: ServiceLevel;
  dietaryRequirements: DietaryRequirement[];
  beveragePreferences?: string[];
  foodPreferences?: string[];
  specialRequests?: string;
}

export interface ValidationResult {
  isValid: boolean;
  missingFields: string[];
  errors: string[];
  clarificationPrompt?: string;
  isServiceable: boolean;
  distanceKm?: number;
  dietaryConfirmed: boolean;
  unconfirmedDietaryRequirements: DietaryRequirement[];
}

export interface ConsumptionForecast {
  guestCount: number;
  durationHours: number;
  coffeeServings: number;
  teaServings: number;
  pastriesCount: number;
  coffeeBeansKg: number;
  milkLiters: number;
  oatMilkLiters: number;
  cupsCount: number;
  syrupsLiters: number;
  sugarKg: number;
  waterLiters: number;
}

export interface StaffingRequirement {
  baristasAssigned: number;
  serviceStaffAssigned: number;
  totalStaffCount: number;
  setupHours: number;
  serviceHours: number;
  cleanupHours: number;
  totalLaborHours: number;
  hourlyRatePerStaff: number;
  totalLaborCost: number;
}

export interface EquipmentRequirement {
  espressoMachinesCount: number;
  espressoGrindersCount: number;
  brewerUrnsCount: number;
  thermalDispensersCount: number;
  servingTablesCount: number;
  powerRequirementKw: number;
  powerDescription: string;
  equipmentRentalCost: number;
}

export interface LogisticsCalculation {
  baseLocation: string;
  destinationLocation: string;
  distanceKm: number;
  estimatedTravelTimeMinutes: number;
  isServiceable: boolean;
  baseTravelFee: number;
  distanceSurcharge: number;
  setupTeardownFee: number;
  totalLogisticsCost: number;
}

export interface IngredientManifestItem {
  ingredient: string;
  quantity: number;
  unit: string;
  unitCost: number;
  totalCost: number;
  inStockQuantity: number;
  shortfallQuantity: number;
  procurementRequired: boolean;
}

export interface CostBreakdown {
  ingredientCost: number;
  pastryCost: number;
  laborCost: number;
  equipmentCost: number;
  logisticsCost: number;
  operationalOverhead: number;
  totalCost: number;
}

export interface QuotationTier {
  tierId: "BASIC" | "STANDARD" | "PREMIUM";
  name: string;
  tagline: string;
  pricePerGuest: number;
  totalAmount: number;
  totalCost: number;
  grossProfit: number;
  grossMarginPercent: number;
  isRecommended: boolean;
  perks: string[];
  includedProducts: string[];
  staffAssigned: number;
  equipmentSummary: string;
}

export interface EventQuotationRecord {
  quoteId: string;
  quoteVersion: number;
  versionId: string;           // e.g. QUOTE-1001-V1
  customerId: string;
  organization: string;
  location: string;
  eventDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  guestCount: number;
  eventType: EventType;
  dietaryRequirements: DietaryRequirement[];
  requirements: EventRequirements;
  consumption: ConsumptionForecast;
  staffing: StaffingRequirement;
  equipment: EquipmentRequirement;
  logistics: LogisticsCalculation;
  ingredientManifest: IngredientManifestItem[];
  tiers: QuotationTier[];
  selectedTier?: QuotationTier;
  status: QuoteStatus;
  riskTier: RiskTier;
  requiresApproval: boolean;
  procurementRequired: boolean;
  issuedAt: number;
  expiresAt: number;
  approvedBy?: string;
  idempotencyKey: string;
}

export interface BookingRecord {
  bookingId: string;
  quoteId: string;
  quoteVersion: number;
  versionId: string;
  customerId: string;
  organization: string;
  eventDate: string;           // YYYY-MM-DD
  startTime: string;
  endTime: string;
  timeSlot: string;            // e.g. "2026-10-15:10:00-14:00"
  selectedTier: QuotationTier;
  guestCount: number;
  location: string;
  status: BookingStatus;
  assignedBaristas: string[];
  allocatedEquipment: string[];
  totalAmount: number;
  paymentStatus: "PENDING" | "PAID" | "PARTIAL";
  createdAt: number;
  confirmedAt?: number;
  idempotencyKey: string;
}

export interface EventConciergeAuditLog {
  runId: string;
  agentName: "EventBookingConcierge";
  customerId: string;
  quoteId?: string;
  quoteVersion?: number;
  bookingId?: string;
  timestamp: number;
  trigger: string;
  guestCount: number;
  eventType: string;
  totalAmount?: number;
  grossMarginPercent?: number;
  riskTier: RiskTier;
  approvalStatus: string;
  decision: string;
  toolsCalled: string[];
  executionResult: "SUCCESS" | "REJECTED" | "NEEDS_CLARIFICATION";
  latencyMs: number;
  error?: string;
}

export interface EventConciergeMetrics {
  inquiriesReceived: number;
  quotesGenerated: number;
  quotesAccepted: number;
  quotesRejected: number;
  quotesExpired: number;
  bookingsConfirmed: number;
  bookingsCancelled: number;
  totalQuotedRevenue: number;
  totalConfirmedRevenue: number;
  avgGuestCount: number;
  avgQuoteValue: number;
  avgGrossMarginPercent: number;
  conversionRatePercent: number;
  procurementRequiredQuotesCount: number;
}
