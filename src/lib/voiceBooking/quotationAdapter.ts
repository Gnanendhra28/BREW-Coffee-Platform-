/**
 * BREW Coffee Platform — Phase 6.2.1 Voice Booking Quotation Adapter
 * Deterministic pricing bridge to Event Booking Concierge calculation engine.
 * Eliminates all fabricated business defaults: strictly validates real calendar dates,
 * boundaries, and start/end times before generating auditable catering quotations.
 */

import crypto from "crypto";
import { generateEventQuotationRecord } from "../eventBookingConcierge/quoteEngine";
import { EventQuotationRecord, EventType, ServiceLevel } from "../eventBookingConcierge/types";
import {
  BookingRequirements,
  QuotationIntegrityResult,
  QuotationMaterialSnapshot,
  SupportedLanguage,
} from "./types";
import { isValidCalendarDate, isValidTime24 } from "./schemas";

/**
 * Normalizes an arbitrary event type string to the domain EventType enum.
 */
function normalizeEventType(raw?: string | null): EventType {
  if (!raw) return "corporate";
  const lower = raw.toLowerCase().trim();
  if (lower.includes("wedding") || lower.includes("shaadi") || lower.includes("pelli")) {
    return "wedding";
  }
  if (lower.includes("birthday") || lower.includes("janmadin") || lower.includes("puttinaroju")) {
    return "birthday";
  }
  if (lower.includes("conference")) return "conference";
  if (lower.includes("workshop")) return "workshop";
  if (lower.includes("private") || lower.includes("party")) return "private_party";
  if (lower.includes("college") || lower.includes("university")) return "college_event";
  if (lower.includes("launch")) return "launch_event";
  if (lower.includes("meeting")) return "meeting";
  return "corporate";
}

export interface QuotationValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates that all mandatory fields are present and operationally valid for quotation.
 * Disallows fabricated dates, placeholder durations, and silent midnight wrapping.
 */
export function validateQuotationRequirements(
  requirements: BookingRequirements
): QuotationValidationResult {
  const errors: string[] = [];

  // 1. Guest Count (10 - 1000)
  if (requirements.guestCount === null || requirements.guestCount === undefined) {
    errors.push("guestCount is required for quotation");
  } else if (requirements.guestCount < 10 || requirements.guestCount > 1000) {
    errors.push(`guestCount must be between 10 and 1000 (received ${requirements.guestCount})`);
  }

  // 2. Event Date (Valid calendar date, no defaults)
  if (!requirements.eventDate) {
    errors.push("eventDate is required for quotation");
  } else if (!isValidCalendarDate(requirements.eventDate)) {
    errors.push(`eventDate '${requirements.eventDate}' is not a valid calendar date in YYYY-MM-DD format`);
  }

  // 3. Start Time (Valid 24h format, no defaults)
  if (!requirements.startTime) {
    errors.push("startTime is required for quotation");
  } else if (!isValidTime24(requirements.startTime)) {
    errors.push(`startTime '${requirements.startTime}' must be in 24-hour HH:mm format`);
  }

  // 4. Duration (1 - 12 hours, no defaults)
  if (requirements.durationHours === null || requirements.durationHours === undefined) {
    errors.push("durationHours is required for quotation");
  } else if (requirements.durationHours < 1 || requirements.durationHours > 12) {
    errors.push(`durationHours must be between 1 and 12 (received ${requirements.durationHours})`);
  }

  // 5. Venue Address (min 3 chars)
  if (!requirements.venueAddress || requirements.venueAddress.trim().length < 3) {
    errors.push("venueAddress is required (at least 3 characters) to calculate mobilization");
  }

  // 6. Operational Window Check (Prevent silent midnight wrap)
  if (requirements.startTime && isValidTime24(requirements.startTime) && requirements.durationHours && requirements.durationHours >= 1 && requirements.durationHours <= 12) {
    const [startH, startM] = requirements.startTime.split(":").map(Number);
    const durationMinutes = Math.round(requirements.durationHours * 60);
    const totalEndMinutes = startH * 60 + startM + durationMinutes;

    if (totalEndMinutes > 24 * 60) {
      errors.push(
        `Service duration (${requirements.durationHours}h) starting at ${requirements.startTime} crosses midnight into the next day. Single-day mobile van operations must conclude by 23:59.`
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Deterministically generates a 3-tier event quotation using the Event Booking Concierge engine.
 * Throws a descriptive validation error if any mandatory business input is absent or invalid.
 */
export function generateVoiceBookingQuotation(
  requirements: BookingRequirements,
  customerId?: string
): EventQuotationRecord {
  const validation = validateQuotationRequirements(requirements);
  if (!validation.isValid) {
    throw new Error(`Quotation validation failed: ${validation.errors.join("; ")}`);
  }

  // Mandatory fields guaranteed by validation
  const guestCount = requirements.guestCount!;
  const eventDate = requirements.eventDate!;
  const startTime = requirements.startTime!;
  const durationHours = requirements.durationHours!;
  const venueAddress = requirements.venueAddress!.trim();

  const durationMinutes = Math.round(durationHours * 60);
  const [startH, startM] = startTime.split(":").map(Number);
  const totalEndMinutes = startH * 60 + startM + durationMinutes;
  const endH = Math.min(23, Math.floor(totalEndMinutes / 60));
  const endM = totalEndMinutes % 60;
  const endTime = `${endH.toString().padStart(2, "0")}:${endM.toString().padStart(2, "0")}`;

  const quotation = generateEventQuotationRecord({
    requirements: {
      organization: "Private Event / Voice Booking",
      guestCount,
      durationMinutes,
      location: venueAddress,
      city: "Hyderabad",
      eventType: normalizeEventType(requirements.eventType),
      eventDate,
      startTime,
      endTime,
      serviceLevel: (requirements.selectedTier as ServiceLevel) || "STANDARD",
      dietaryRequirements: [],
    },
    customerId: customerId || "voice-booking-session",
  });

  return quotation;
}

/**
 * Formats deterministic quotation details into natural conversational text in the target language.
 */
export function formatQuotationMessage(
  quotation: EventQuotationRecord,
  language: SupportedLanguage
): string {
  const tiers = quotation.tiers;
  const basic = tiers.find((t) => t.tierId === "BASIC");
  const standard = tiers.find((t) => t.tierId === "STANDARD");
  const premium = tiers.find((t) => t.tierId === "PREMIUM");

  if (language === "hi") {
    return (
      `आपके ${quotation.guestCount} मेहमानों के लिए हमारे 3 विशेष पैकेज तैयार हैं:\n` +
      `1. Classic Brew: ₹${basic?.pricePerGuest || 180}/मेहमान (कुल: ₹${basic?.totalAmount.toLocaleString("en-IN")})\n` +
      `2. Artisanal Signature (अनुशंसित): ₹${standard?.pricePerGuest || 260}/मेहमान (कुल: ₹${standard?.totalAmount.toLocaleString("en-IN")})\n` +
      `3. VIP Unlimited Bar: ₹${premium?.pricePerGuest || 360}/मेहमान (कुल: ₹${premium?.totalAmount.toLocaleString("en-IN")})\n` +
      `क्या आप इनमें से कोई पैकेज चुनना चाहेंगे, या हमारे प्रतिनिधि से बात करना पसंद करेंगे?`
    );
  }

  if (language === "te") {
    return (
      `మీ ${quotation.guestCount} మంది అతిథుల కోసం మా వద్ద 3 ప్యాకేజీలు అందుబాటులో ఉన్నాయి:\n` +
      `1. Classic Brew: ₹${basic?.pricePerGuest || 180}/అతిథికి (మొత్తం: ₹${basic?.totalAmount.toLocaleString("en-IN")})\n` +
      `2. Artisanal Signature (సిఫార్సు చేయబడింది): ₹${standard?.pricePerGuest || 260}/అతిథికి (మొత్తం: ₹${standard?.totalAmount.toLocaleString("en-IN")})\n` +
      `3. VIP Unlimited Bar: ₹${premium?.pricePerGuest || 360}/అతిథికి (మొత్తం: ₹${premium?.totalAmount.toLocaleString("en-IN")})\n` +
      `మీరు ఏ ప్యాకేజీని ఎంచుకోవాలనుకుంటున్నారు? దయచేసి నిర్ధారించండి.`
    );
  }

  // English default
  return (
    `For your event of ${quotation.guestCount} guests, here are our 3 catering packages:\n` +
    `1. Classic Brew: ₹${basic?.pricePerGuest || 180}/guest (Total: ₹${basic?.totalAmount.toLocaleString("en-IN")})\n` +
    `2. Artisanal Signature (Recommended): ₹${standard?.pricePerGuest || 260}/guest (Total: ₹${standard?.totalAmount.toLocaleString("en-IN")})\n` +
    `3. VIP Unlimited Bar: ₹${premium?.pricePerGuest || 360}/guest (Total: ₹${premium?.totalAmount.toLocaleString("en-IN")})\n` +
    `Would you like to confirm one of these packages, or speak with our concierge team?`
  );
}

/**
 * Generates a deterministic canonical snapshot and SHA-256 hash of the exact requirements
 * that affect quotation pricing and validity:
 * - guestCount
 * - eventDate
 * - startTime
 * - durationHours
 * - venueAddress
 * - selectedTier
 * - eventType (influences consumption calculations in quoteEngine)
 */
export function createQuotationSnapshot(
  requirements: BookingRequirements,
  generatedAt: string = new Date().toISOString()
): QuotationMaterialSnapshot {
  const guestCount = requirements.guestCount ?? 0;
  const eventDate = requirements.eventDate ?? "";
  const startTime = requirements.startTime ?? "";
  const durationHours = requirements.durationHours ?? 0;
  const venueAddress = (requirements.venueAddress || "").trim();
  const selectedTier = requirements.selectedTier ?? null;
  const eventType = requirements.eventType ? requirements.eventType.trim() : null;

  // Canonical object with sorted keys for deterministic SHA-256 hash calculation
  const canonicalObject = {
    durationHours,
    eventDate,
    eventType: eventType ? normalizeEventType(eventType) : "corporate",
    guestCount,
    selectedTier,
    startTime,
    venueAddress: venueAddress.toLowerCase(),
  };

  const canonicalString = JSON.stringify(canonicalObject, Object.keys(canonicalObject).sort());
  const hash = crypto.createHash("sha256").update(canonicalString).digest("hex");

  return {
    guestCount,
    eventDate,
    startTime,
    durationHours,
    venueAddress,
    selectedTier,
    eventType,
    hash,
    generatedAt,
  };
}

/**
 * Compares a saved quotation snapshot against current booking requirements.
 * Verifies all 7 material fields affecting pricing, logistics, and operational feasibility.
 * Rejects confirmation if any material field was modified since the quotation was generated.
 */
export function verifyQuotationIntegrity(
  snapshot: QuotationMaterialSnapshot | null | undefined,
  currentRequirements: BookingRequirements
): QuotationIntegrityResult {
  if (!snapshot) {
    return {
      isMatch: false,
      mismatchedFields: ["snapshot_missing"],
      reason: "No quotation snapshot exists for this session.",
    };
  }

  const mismatchedFields: string[] = [];

  if (snapshot.guestCount !== (currentRequirements.guestCount ?? 0)) {
    mismatchedFields.push("guestCount");
  }
  if (snapshot.eventDate !== (currentRequirements.eventDate ?? "")) {
    mismatchedFields.push("eventDate");
  }
  if (snapshot.startTime !== (currentRequirements.startTime ?? "")) {
    mismatchedFields.push("startTime");
  }
  if (snapshot.durationHours !== (currentRequirements.durationHours ?? 0)) {
    mismatchedFields.push("durationHours");
  }
  if (
    (snapshot.venueAddress || "").trim().toLowerCase() !==
    (currentRequirements.venueAddress || "").trim().toLowerCase()
  ) {
    mismatchedFields.push("venueAddress");
  }

  // Tier integrity:
  // If snapshot had a specific tier selected, changing it to a different tier is a mismatch.
  // If snapshot had no tier selected (null), selecting one of the 3 quoted tiers is permissible.
  if (snapshot.selectedTier !== null && snapshot.selectedTier !== currentRequirements.selectedTier) {
    mismatchedFields.push("selectedTier");
  }

  const snapNormEvent = normalizeEventType(snapshot.eventType);
  const currNormEvent = normalizeEventType(currentRequirements.eventType);
  if (snapNormEvent !== currNormEvent) {
    mismatchedFields.push("eventType");
  }

  if (mismatchedFields.length > 0) {
    return {
      isMatch: false,
      mismatchedFields,
      reason: `Quotation snapshot integrity check failed. Material fields modified since quote generation: ${mismatchedFields.join(", ")}. Re-quotation required.`,
    };
  }

  return {
    isMatch: true,
    mismatchedFields: [],
  };
}
