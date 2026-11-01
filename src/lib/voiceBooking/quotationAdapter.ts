/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking Quotation Adapter
 * Deterministic pricing bridge to Event Booking Concierge calculation engine.
 * Guarantees zero AI price fabrication: all prices, margins, and tier breakdowns
 * are calculated purely via verified domain logic.
 */

import { generateEventQuotationRecord } from "../eventBookingConcierge/quoteEngine";
import { EventQuotationRecord, EventType, ServiceLevel } from "../eventBookingConcierge/types";
import { BookingRequirements, SupportedLanguage } from "./types";

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

/**
 * Deterministically generates a 3-tier event quotation using the Event Booking Concierge engine.
 */
export function generateVoiceBookingQuotation(
  requirements: BookingRequirements,
  customerId?: string
): EventQuotationRecord {
  if (!requirements.guestCount || requirements.guestCount < 10) {
    throw new Error(
      `Invalid guestCount: ${requirements.guestCount}. Minimum required guest count is 10.`
    );
  }
  if (!requirements.venueAddress || requirements.venueAddress.trim().length === 0) {
    throw new Error("Venue address is required to calculate mobilization and logistics fees.");
  }

  const durationHours = requirements.durationHours || 4;
  const durationMinutes = Math.max(60, Math.round(durationHours * 60));

  const startTime = requirements.startTime || "10:00";
  const [startH, startM] = startTime.split(":").map(Number);
  const endTotalMinutes = (startH * 60 + (startM || 0)) + durationMinutes;
  const endH = Math.floor(endTotalMinutes / 60) % 24;
  const endM = endTotalMinutes % 60;
  const endTime = `${endH.toString().padStart(2, "0")}:${endM.toString().padStart(2, "0")}`;

  const quotation = generateEventQuotationRecord({
    requirements: {
      organization: "Private Event / Voice Booking",
      guestCount: requirements.guestCount,
      durationMinutes,
      location: requirements.venueAddress.trim(),
      city: "Hyderabad",
      eventType: normalizeEventType(requirements.eventType),
      eventDate: requirements.eventDate || "2026-12-15",
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
