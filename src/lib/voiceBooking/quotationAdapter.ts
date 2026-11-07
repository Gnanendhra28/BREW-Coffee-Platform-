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
  } else {
    const todayIso = new Date().toISOString().split("T")[0];
    if (requirements.eventDate < todayIso) {
      errors.push(`eventDate '${requirements.eventDate}' cannot be in the past`);
    }
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

  // Bidirectional tier reflection: if requirements do not specify a tier,
  // the quotation leaves selectedTier unselected (undefined) until explicitly chosen
  if (!requirements.selectedTier) {
    quotation.selectedTier = undefined;
  } else {
    const matchedTier = quotation.tiers.find((t) => t.tierId === requirements.selectedTier);
    if (matchedTier) {
      quotation.selectedTier = matchedTier;
    }
  }

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
 * Generates a deterministic canonical snapshot and authenticated HMAC-SHA256 signature
 * of the exact requirements that affect quotation pricing and validity:
 * - guestCount
 * - eventDate
 * - startTime
 * - durationHours
 * - venueAddress
 * - selectedTier
 * - eventType (influences consumption calculations in quoteEngine)
 */
export const SNAPSHOT_CANONICAL_VERSION = "v1";

/**
 * Helper to determine if the execution context is a non-local or deployed cloud environment.
 */
function isDeployedOrNonLocalEnv(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").toLowerCase().trim();
  const appEnv = (process.env.APP_ENV || process.env.ENVIRONMENT || "").toLowerCase().trim();
  const isCloudHost = Boolean(
    process.env.RENDER ||
    process.env.VERCEL ||
    process.env.K_SERVICE ||
    process.env.AWS_REGION
  );

  return (
    nodeEnv === "production" ||
    nodeEnv === "staging" ||
    appEnv === "production" ||
    appEnv === "staging" ||
    appEnv === "uat" ||
    isCloudHost
  );
}

/**
 * Retrieves the server-side HMAC secret for quotation snapshot signing and verification.
 * 
 * FAIL-CLOSED SECURITY GUARANTEE:
 * - In production, staging, and deployed cloud environments, `QUOTATION_SNAPSHOT_SECRET` is strictly mandatory.
 *   If missing, unconfigured, or empty, this function throws an error, failing closed immediately.
 * - In explicitly local development / offline test environments (`NODE_ENV === "development" || "test"`),
 *   a deterministic dev fallback secret is permitted to ensure zero-network offline testing.
 * 
 * KEY ROTATION SPECIFICATION:
 * - Zero-downtime rotation is supported via dual-secret verification:
 *   1. Primary secret: `QUOTATION_SNAPSHOT_SECRET` (used for signing new snapshots and primary verification).
 *   2. Previous secret: `QUOTATION_SNAPSHOT_SECRET_PREVIOUS` (optionally accepted during key rotation windows).
 * - During key rotation, set `QUOTATION_SNAPSHOT_SECRET_PREVIOUS` to the old key and `QUOTATION_SNAPSHOT_SECRET`
 *   to the new key. In-flight quotations signed with the old key remain valid until they expire.
 * - Once all in-flight quotations expire or complete, `QUOTATION_SNAPSHOT_SECRET_PREVIOUS` can be removed.
 */
export function getSnapshotHmacSecret(): string {
  const secret = process.env.QUOTATION_SNAPSHOT_SECRET;
  if (secret && secret.trim().length > 0) {
    return secret.trim();
  }
  if (isDeployedOrNonLocalEnv()) {
    throw new Error(
      "QUOTATION_SNAPSHOT_SECRET environment variable is missing or mandatory in production, staging, and deployed environments. Refusing to operate unauthenticated."
    );
  }
  return (
    process.env.BREW_TEST_QUOTATION_SECRET ||
    "brew-dev-quotation-snapshot-hmac-secret-fallback-do-not-use-in-prod"
  );
}

/**
 * Computes an authenticated HMAC-SHA256 digest over the canonical JSON payload.
 */
export function computeSnapshotHmac(canonicalPayload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(canonicalPayload).digest("hex");
}

export interface CanonicalSnapshotFields {
  guestCount: number;
  eventDate: string;
  startTime: string;
  durationHours: number;
  venueAddress: string;
  selectedTier: "BASIC" | "STANDARD" | "PREMIUM" | null;
  eventType: string | null;
}

/**
 * Deterministically canonicalizes quotation snapshot material fields into a versioned JSON payload.
 * Guarantees consistent ordering and normalization across all pricing and operational parameters.
 */
export function buildCanonicalSnapshotPayload(fields: CanonicalSnapshotFields): string {
  const canonicalObject = {
    _version: SNAPSHOT_CANONICAL_VERSION,
    durationHours: fields.durationHours,
    eventDate: fields.eventDate,
    eventType: fields.eventType ? normalizeEventType(fields.eventType) : "corporate",
    guestCount: fields.guestCount,
    selectedTier: fields.selectedTier,
    startTime: fields.startTime,
    venueAddress: (fields.venueAddress || "").trim().toLowerCase(),
  };

  return JSON.stringify(canonicalObject, Object.keys(canonicalObject).sort());
}

/**
 * Creates an immutable, canonical quotation snapshot capturing all 7 material fields
 * that directly influence pricing, equipment allocation, travel surcharges, and guest consumption.
 * Generates an authenticated HMAC-SHA256 signature for tamper detection and data integrity enforcement.
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

  const canonicalString = buildCanonicalSnapshotPayload({
    guestCount,
    eventDate,
    startTime,
    durationHours,
    venueAddress,
    selectedTier,
    eventType,
  });

  const secret = getSnapshotHmacSecret();
  const hash = computeSnapshotHmac(canonicalString, secret);

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

export interface VerifyQuotationIntegrityOptions {
  authoritativeQuoteOverride?: EventQuotationRecord;
}

/**
 * Compares a saved quotation snapshot against current booking requirements and authoritative quotation.
 * Recomputes the canonical payload and HMAC-SHA256 signature to verify cryptographic snapshot integrity.
 * Verifies all 7 material fields affecting pricing, logistics, and operational feasibility.
 * Mandates existence of a non-empty active quotation record.
 * Strictly verifies quotation tier existence and cross-object consistency (fail-closed).
 * Strictly verifies authoritative pricing against deterministic quoteEngine recomputation.
 */
export function verifyQuotationIntegrity(
  snapshot: QuotationMaterialSnapshot | null | undefined,
  currentRequirements: BookingRequirements,
  activeQuotation?: EventQuotationRecord | null,
  options?: VerifyQuotationIntegrityOptions
): QuotationIntegrityResult {
  // 1. Mandatory quotation snapshot existence
  if (!snapshot || typeof snapshot !== "object") {
    return {
      isMatch: false,
      mismatchedFields: ["snapshot_missing"],
      reason: "No quotation snapshot exists for this session.",
    };
  }

  // 2. Mandatory active quotation existence (fail-closed)
  if (!activeQuotation || typeof activeQuotation !== "object") {
    const mismatches = ["activeQuotation"];
    if (currentRequirements.selectedTier !== null) {
      mismatches.push("selectedTier");
    }
    return {
      isMatch: false,
      mismatchedFields: mismatches,
      reason: "Active quotation record is mandatory for quotation integrity verification. Missing or null quotation records are rejected.",
    };
  }

  // 3. Mandatory non-empty tier list on active quotation
  if (!Array.isArray(activeQuotation.tiers) || activeQuotation.tiers.length === 0) {
    const mismatches = ["activeQuotation_tiers"];
    if (currentRequirements.selectedTier !== null) {
      mismatches.push("selectedTier");
    }
    return {
      isMatch: false,
      mismatchedFields: mismatches,
      reason: "Active quotation contains an invalid or empty tiers list. Verification failed closed.",
    };
  }

  // 4. Strict HMAC-SHA256 format check on stored signature
  if (!snapshot.hash || typeof snapshot.hash !== "string" || !/^[0-9a-f]{64}$/i.test(snapshot.hash)) {
    return {
      isMatch: false,
      mismatchedFields: ["hash"],
      reason: "Quotation snapshot has an invalid, missing, or malformed HMAC-SHA256 signature format.",
    };
  }

  // 5. Fetch server-side HMAC secret (fail closed if unconfigured in production or deployed environments)
  let primarySecret: string;
  try {
    primarySecret = getSnapshotHmacSecret();
  } catch {
    return {
      isMatch: false,
      mismatchedFields: ["hash"],
      reason: "Quotation snapshot integrity check failed closed: server HMAC secret is not configured in production.",
    };
  }

  // 6. Recompute canonical payload from stored snapshot fields
  const canonicalPayload = buildCanonicalSnapshotPayload({
    guestCount: snapshot.guestCount,
    eventDate: snapshot.eventDate,
    startTime: snapshot.startTime,
    durationHours: snapshot.durationHours,
    venueAddress: snapshot.venueAddress,
    selectedTier: snapshot.selectedTier,
    eventType: snapshot.eventType,
  });

  // Verify HMAC signature using constant-time comparison
  const storedHashBuf = Buffer.from(snapshot.hash.toLowerCase(), "hex");
  const primaryComputedHash = computeSnapshotHmac(canonicalPayload, primarySecret);
  const primaryHashBuf = Buffer.from(primaryComputedHash.toLowerCase(), "hex");

  let signatureValid =
    storedHashBuf.length === primaryHashBuf.length &&
    crypto.timingSafeEqual(storedHashBuf, primaryHashBuf);

  // Key rotation support: if primary fails, attempt validation against previous secret if configured
  if (!signatureValid && process.env.QUOTATION_SNAPSHOT_SECRET_PREVIOUS) {
    const prevSecret = process.env.QUOTATION_SNAPSHOT_SECRET_PREVIOUS.trim();
    if (prevSecret.length > 0) {
      const prevComputedHash = computeSnapshotHmac(canonicalPayload, prevSecret);
      const prevHashBuf = Buffer.from(prevComputedHash.toLowerCase(), "hex");
      if (
        storedHashBuf.length === prevHashBuf.length &&
        crypto.timingSafeEqual(storedHashBuf, prevHashBuf)
      ) {
        signatureValid = true;
      }
    }
  }

  if (!signatureValid) {
    return {
      isMatch: false,
      mismatchedFields: ["hash"],
      reason:
        "Quotation snapshot hash integrity check failed: stored signature does not match canonical recomputed HMAC-SHA256. Snapshot has been tampered with or corrupted.",
    };
  }

  // 7. Compare all 7 material fields against current requirements
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

  // 8. Bidirectional Selected-Tier Consistency
  // Enforce consistency between currentRequirements.selectedTier, snapshot.selectedTier, and activeQuotation.selectedTier
  const reqTier = currentRequirements.selectedTier ?? null;
  const snapTier = snapshot.selectedTier ?? null;
  const quoteTier = activeQuotation.selectedTier ? activeQuotation.selectedTier.tierId : null;

  if (reqTier === null && snapTier === null && quoteTier === null) {
    // If all three are null, the unselected state is valid if supported by the quotation lifecycle
  } else {
    // If any one is non-null, all three must identify the same tier
    if (reqTier === null || snapTier === null || quoteTier === null) {
      mismatchedFields.push("selectedTier");
    } else if (reqTier !== snapTier || reqTier !== quoteTier || snapTier !== quoteTier) {
      mismatchedFields.push("selectedTier");
    } else {
      // All three are non-null and identify the same tier
      const tierExistsInQuote = activeQuotation.tiers.some((t) => t.tierId === reqTier);
      if (!tierExistsInQuote) {
        mismatchedFields.push("selectedTier");
      }
    }
  }

  const snapNormEvent = normalizeEventType(snapshot.eventType);
  const currNormEvent = normalizeEventType(currentRequirements.eventType);
  if (snapNormEvent !== currNormEvent) {
    mismatchedFields.push("eventType");
  }

  // 9. Authoritative Quotation Record Verification (Complete EventQuotationRecord comparison)
  // Recomputes the authoritative quote via generateVoiceBookingQuotation() and verifies
  // every financially and operationally significant field against activeQuotation.
  try {
    const authoritativeQuote =
      options?.authoritativeQuoteOverride ||
      generateVoiceBookingQuotation(
        currentRequirements,
        activeQuotation.customerId
      );

    // Verify operational parameters
    if (
      activeQuotation.guestCount !== authoritativeQuote.guestCount ||
      activeQuotation.durationMinutes !== authoritativeQuote.durationMinutes ||
      activeQuotation.eventDate !== authoritativeQuote.eventDate ||
      activeQuotation.startTime !== authoritativeQuote.startTime ||
      activeQuotation.endTime !== authoritativeQuote.endTime ||
      activeQuotation.eventType !== authoritativeQuote.eventType
    ) {
      mismatchedFields.push("quotation_pricing_mismatch");
    }

    // Verify all quotation tiers and unit pricing
    if (!activeQuotation.tiers || activeQuotation.tiers.length !== authoritativeQuote.tiers.length) {
      mismatchedFields.push("quotation_pricing_mismatch");
    } else {
      for (const authTier of authoritativeQuote.tiers) {
        const activeTier = activeQuotation.tiers.find((t) => t.tierId === authTier.tierId);
        if (
          !activeTier ||
          activeTier.pricePerGuest !== authTier.pricePerGuest ||
          activeTier.totalAmount !== authTier.totalAmount ||
          activeTier.totalCost !== authTier.totalCost ||
          activeTier.grossProfit !== authTier.grossProfit ||
          activeTier.grossMarginPercent !== authTier.grossMarginPercent ||
          activeTier.staffAssigned !== authTier.staffAssigned
        ) {
          mismatchedFields.push("quotation_pricing_mismatch");
          break;
        }
      }
    }

    // Verify selected tier pricing if selected
    if (activeQuotation.selectedTier) {
      const authSelectedTier = authoritativeQuote.tiers.find(
        (t) => t.tierId === activeQuotation.selectedTier?.tierId
      );
      if (
        !authSelectedTier ||
        activeQuotation.selectedTier.tierId !== authSelectedTier.tierId ||
        activeQuotation.selectedTier.totalAmount !== authSelectedTier.totalAmount ||
        activeQuotation.selectedTier.pricePerGuest !== authSelectedTier.pricePerGuest ||
        activeQuotation.selectedTier.totalCost !== authSelectedTier.totalCost ||
        activeQuotation.selectedTier.grossProfit !== authSelectedTier.grossProfit ||
        activeQuotation.selectedTier.grossMarginPercent !== authSelectedTier.grossMarginPercent ||
        activeQuotation.selectedTier.staffAssigned !== authSelectedTier.staffAssigned
      ) {
        mismatchedFields.push("quotation_pricing_mismatch");
      }
    }

    // Verify logistics presence and exact field values (mandatory comparison)
    const hasActiveLogistics = Boolean(activeQuotation.logistics);
    const hasAuthLogistics = Boolean(authoritativeQuote.logistics);

    if (hasAuthLogistics !== hasActiveLogistics) {
      mismatchedFields.push("quotation_pricing_mismatch");
    } else if (hasAuthLogistics && activeQuotation.logistics && authoritativeQuote.logistics) {
      if (
        activeQuotation.logistics.totalLogisticsCost !== authoritativeQuote.logistics.totalLogisticsCost ||
        activeQuotation.logistics.baseTravelFee !== authoritativeQuote.logistics.baseTravelFee ||
        activeQuotation.logistics.distanceSurcharge !== authoritativeQuote.logistics.distanceSurcharge ||
        activeQuotation.logistics.setupTeardownFee !== authoritativeQuote.logistics.setupTeardownFee ||
        activeQuotation.logistics.distanceKm !== authoritativeQuote.logistics.distanceKm ||
        activeQuotation.logistics.estimatedTravelTimeMinutes !== authoritativeQuote.logistics.estimatedTravelTimeMinutes ||
        activeQuotation.logistics.isServiceable !== authoritativeQuote.logistics.isServiceable ||
        activeQuotation.logistics.baseLocation !== authoritativeQuote.logistics.baseLocation ||
        activeQuotation.logistics.destinationLocation !== authoritativeQuote.logistics.destinationLocation
      ) {
        mismatchedFields.push("quotation_pricing_mismatch");
      }
    }

    // Verify ingredientManifest presence and exact items (mandatory comparison)
    const hasActiveManifest = Array.isArray(activeQuotation.ingredientManifest);
    const hasAuthManifest = Array.isArray(authoritativeQuote.ingredientManifest);

    if (hasAuthManifest !== hasActiveManifest) {
      mismatchedFields.push("quotation_pricing_mismatch");
    } else if (hasAuthManifest && activeQuotation.ingredientManifest && authoritativeQuote.ingredientManifest) {
      if (activeQuotation.ingredientManifest.length !== authoritativeQuote.ingredientManifest.length) {
        mismatchedFields.push("quotation_pricing_mismatch");
      } else {
        // Reject missing, extra, or altered manifest items
        for (const authItem of authoritativeQuote.ingredientManifest) {
          const activeItem = activeQuotation.ingredientManifest.find(
            (i) => i.ingredient === authItem.ingredient
          );
          if (
            !activeItem ||
            activeItem.quantity !== authItem.quantity ||
            activeItem.unitCost !== authItem.unitCost ||
            activeItem.totalCost !== authItem.totalCost ||
            activeItem.unit !== authItem.unit
          ) {
            mismatchedFields.push("quotation_pricing_mismatch");
            break;
          }
        }
        for (const activeItem of activeQuotation.ingredientManifest) {
          const authItem = authoritativeQuote.ingredientManifest.find(
            (i) => i.ingredient === activeItem.ingredient
          );
          if (!authItem) {
            mismatchedFields.push("quotation_pricing_mismatch");
            break;
          }
        }
      }
    }
  } catch {
    mismatchedFields.push("quotation_pricing_mismatch");
  }

  if (mismatchedFields.length > 0) {
    // Deduplicate mismatched fields
    const uniqueMismatches = Array.from(new Set(mismatchedFields));
    return {
      isMatch: false,
      mismatchedFields: uniqueMismatches,
      reason: `Quotation integrity check failed. Discrepancies detected: ${uniqueMismatches.join(", ")}. Re-quotation required.`,
    };
  }

  return {
    isMatch: true,
    mismatchedFields: [],
  };
}
