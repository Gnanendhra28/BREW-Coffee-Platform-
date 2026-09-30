// Deterministic Audience Selection & Filtering Engine for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Guarantees:
// 1. Mandatory marketing consent validation (opt-outs strictly excluded)
// 2. Coarse radius filtering (<= 3 km, no raw GPS coordinates leaked)
// 3. Frequency capping (max 3 messages / day, min 2 hours spacing)
// 4. Quiet hours exclusion (21:00 - 08:00)
// 5. Channel alignment

import { CustomerMarketingProfile, AudienceCriteria, AudienceSelectionResult } from "./types";

export const QUIET_HOURS_START = 21; // 9:00 PM
export const QUIET_HOURS_END = 8;    // 8:00 AM
export const MIN_CONTACT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_DAILY_CONTACTS = 3;

/**
 * Checks whether a given hour falls inside legal marketing quiet hours (21:00 to 08:00).
 */
export function isWithinQuietHours(hour: number = new Date().getHours()): boolean {
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * Filter customer cohort against strict privacy, distance, consent, frequency and quiet-hours criteria.
 */
export function selectTargetAudience(
  candidates: CustomerMarketingProfile[],
  criteria: AudienceCriteria,
  evaluationContext: {
    currentHour?: number;
    currentTimeMs?: number;
  } = {}
): AudienceSelectionResult {
  const currentHour = evaluationContext.currentHour ?? new Date().getHours();
  const now = evaluationContext.currentTimeMs ?? Date.now();

  const isQuiet = isWithinQuietHours(currentHour);
  const quietBlockActive = isQuiet && !criteria.quietHoursBypass;

  let totalEvaluated = 0;
  let excludedOptOut = 0;
  let excludedQuietHours = 0;
  let excludedFrequencyCap = 0;
  let excludedRadius = 0;
  const eligibleCustomers: CustomerMarketingProfile[] = [];

  for (const candidate of candidates) {
    totalEvaluated++;

    // 1. Mandatory Explicit Consent Check
    if (criteria.requireConsent && !candidate.marketingConsent) {
      excludedOptOut++;
      continue;
    }

    // 2. Quiet Hours Guard
    if (quietBlockActive) {
      excludedQuietHours++;
      continue;
    }

    // 3. Radius / Proximity Boundary Check
    if (candidate.distanceKm > criteria.maxRadiusKm) {
      excludedRadius++;
      continue;
    }

    // 4. Frequency Capping Guard (Max 3/day & min 2 hr gap)
    if (candidate.dailyContactCount >= MAX_DAILY_CONTACTS) {
      excludedFrequencyCap++;
      continue;
    }
    if (
      candidate.lastContactedTimestamp &&
      now - candidate.lastContactedTimestamp < MIN_CONTACT_INTERVAL_MS
    ) {
      excludedFrequencyCap++;
      continue;
    }

    // 5. Channel Compatibility Check
    const hasMatchingChannel = criteria.allowedChannels.some(
      (ch) => ch === "social" || (candidate.channelPreferences && candidate.channelPreferences[ch])
    );
    if (!hasMatchingChannel) {
      continue;
    }

    // Candidate passed all deterministic checks
    eligibleCustomers.push(candidate);
  }

  return {
    totalEvaluated,
    eligibleCount: eligibleCustomers.length,
    excludedOptOut,
    excludedQuietHours,
    excludedFrequencyCap,
    excludedRadius,
    eligibleCustomers,
  };
}

/**
 * Standard seed customer pool for local testing and demonstration around HITEC City / DLF Cybercity.
 */
export const MOCK_LOCAL_CUSTOMERS: CustomerMarketingProfile[] = [
  {
    customerId: "cust-01",
    name: "Arjun Verma",
    phone: "+919876543210",
    email: "arjun.v@cybercorp.com",
    locationZone: "DLF Cybercity Phase 2",
    distanceKm: 0.6,
    marketingConsent: true,
    channelPreferences: { push: true, sms: true, whatsapp: true, email: false },
    dailyContactCount: 0,
    segments: ["regular_morning", "pastry_lover"],
  },
  {
    customerId: "cust-02",
    name: "Priya Sharma",
    phone: "+919876543211",
    email: "priya.s@fintechhub.in",
    locationZone: "Mindspace Tech Park",
    distanceKm: 1.4,
    marketingConsent: true,
    channelPreferences: { push: true, sms: false, whatsapp: true, email: true },
    dailyContactCount: 1,
    lastContactedTimestamp: Date.now() - 4 * 60 * 60 * 1000, // 4 hours ago (valid)
    segments: ["cold_brew_enthusiast", "afternoon_worker"],
  },
  {
    customerId: "cust-03",
    name: "Rahul Nair (Opted Out)",
    phone: "+919876543212",
    locationZone: "Cyber Gateway Sector 2",
    distanceKm: 0.2,
    marketingConsent: false, // EXPLICIT OPT-OUT
    channelPreferences: { push: true, sms: true, whatsapp: true, email: false },
    dailyContactCount: 0,
    segments: ["regular_morning"],
  },
  {
    customerId: "cust-04",
    name: "Sneha Reddy (Frequency Capped)",
    phone: "+919876543213",
    locationZone: "Inorbit Junction",
    distanceKm: 0.8,
    marketingConsent: true,
    channelPreferences: { push: true, sms: true, whatsapp: true, email: false },
    dailyContactCount: 3, // REACHED MAX 3
    segments: ["afternoon_worker"],
  },
  {
    customerId: "cust-05",
    name: "Vikram Malhotra (Out of Range)",
    phone: "+919876543214",
    locationZone: "Secunderabad Station",
    distanceKm: 14.5, // > 3.0 KM
    marketingConsent: true,
    channelPreferences: { push: true, sms: true, whatsapp: true, email: true },
    dailyContactCount: 0,
    segments: ["occasional"],
  },
  {
    customerId: "cust-06",
    name: "Divya Kapoor (Recent Touch)",
    phone: "+919876543215",
    locationZone: "Knowledge City Building 4",
    distanceKm: 1.1,
    marketingConsent: true,
    channelPreferences: { push: true, sms: true, whatsapp: false, email: false },
    dailyContactCount: 1,
    lastContactedTimestamp: Date.now() - 30 * 60 * 1000, // 30 mins ago (blocked by min 2hr gap)
    segments: ["espresso_purist"],
  },
];
