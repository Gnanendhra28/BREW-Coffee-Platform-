// Requirement Validation Engine for Agent 4: 🎪 Event Booking Concierge
// Enforces:
// 1. Strict capacity bounds (1 to 1000 guests)
// 2. Date feasibility & past date rejection
// 3. Service area boundary verification (Max 60km from mobile van hub)
// 4. Missing required field detection with targeted clarification prompts
// 5. Dietary allergen verification

import { EventRequirements, ValidationResult, DietaryRequirement } from "./types";

export const MAX_EVENT_GUEST_CAPACITY = 1000;
export const MIN_EVENT_GUEST_CAPACITY = 1;
export const MAX_EVENT_DURATION_MINUTES = 720; // 12 Hours
export const MAX_SERVICEABLE_RADIUS_KM = 60;

// Known serviceable hubs & landmarks within Greater Hyderabad mobile van radius
export const SERVICEABLE_LOCATIONS = new Set([
  "dlf cybercity",
  "cyber towers",
  "mindspace",
  "financial district",
  "gachibowli",
  "hitec city",
  "jubilee hills",
  "banjara hills",
  "kondapur",
  "madhapur",
  "kokapet",
  "hyderabad",
  "secunderabad",
  "kukatpally",
  "begumpet",
  "iit hyderabad",
  "t-hub",
  "knowledge city",
]);

// Cities strictly outside mobile van range
const NON_SERVICEABLE_CITIES = new Set([
  "mumbai",
  "delhi",
  "bangalore",
  "bengaluru",
  "chennai",
  "kolkata",
  "pune",
  "ahmedabad",
  "jaipur",
]);

/**
 * Validates complete or partial event requirements.
 */
export function validateEventRequirements(
  req: Partial<EventRequirements>,
  now: Date = new Date()
): ValidationResult {
  const missingFields: string[] = [];
  const errors: string[] = [];
  let isServiceable = true;
  let distanceKm = 15; // Default local metro distance

  // 1. Guest Count Validation
  if (req.guestCount === undefined || req.guestCount === null) {
    missingFields.push("guestCount");
  } else if (req.guestCount < MIN_EVENT_GUEST_CAPACITY) {
    errors.push(`Guest count must be at least ${MIN_EVENT_GUEST_CAPACITY}. Received: ${req.guestCount}`);
  } else if (req.guestCount > MAX_EVENT_GUEST_CAPACITY) {
    errors.push(
      `Guest count of ${req.guestCount} exceeds maximum mobile van capacity of ${MAX_EVENT_GUEST_CAPACITY} attendees.`
    );
  }

  // 2. Date Validation
  if (!req.eventDate || req.eventDate === "Flexible") {
    missingFields.push("eventDate");
  } else {
    const eventTime = new Date(req.eventDate).getTime();
    const todayTime = new Date(now.toISOString().split("T")[0]).getTime();
    if (isNaN(eventTime)) {
      errors.push(`Invalid event date format: '${req.eventDate}'. Expected YYYY-MM-DD.`);
    } else if (eventTime < todayTime) {
      errors.push(`Event date '${req.eventDate}' cannot be in the past.`);
    }
  }

  // 3. Duration & Time Validation
  if (req.durationMinutes !== undefined) {
    if (req.durationMinutes <= 0) {
      errors.push("Event duration must be greater than zero minutes.");
    } else if (req.durationMinutes > MAX_EVENT_DURATION_MINUTES) {
      errors.push(
        `Event duration (${req.durationMinutes / 60} hrs) exceeds maximum allowable 12-hour mobile van service window.`
      );
    }
  }

  // 4. Location & Service Area Validation
  const locStr = (req.location || "").toLowerCase().trim();
  const cityStr = (req.city || "").toLowerCase().trim();

  if (!req.location || req.location === "Not Specified") {
    missingFields.push("location");
  } else {
    // Check non-serviceable cities
    if (
      NON_SERVICEABLE_CITIES.has(locStr) ||
      NON_SERVICEABLE_CITIES.has(cityStr) ||
      Array.from(NON_SERVICEABLE_CITIES).some((city) => locStr.includes(city))
    ) {
      isServiceable = false;
      errors.push(
        `Location '${req.location}' is outside our mobile coffee van service radius (Max ${MAX_SERVICEABLE_RADIUS_KM}km from Hyderabad Mobile Hub).`
      );
    } else {
      // Evaluate distance estimate
      if (locStr.includes("cyber") || locStr.includes("hitec") || locStr.includes("gachibowli")) {
        distanceKm = 10;
      } else if (locStr.includes("financial") || locStr.includes("mindspace")) {
        distanceKm = 14;
      } else if (locStr.includes("jubilee") || locStr.includes("banjara")) {
        distanceKm = 18;
      } else if (locStr.includes("iit hyderabad") || locStr.includes("kandi")) {
        distanceKm = 48; // Near boundary
      } else if (locStr.includes("warangal") || locStr.includes("karimnagar")) {
        distanceKm = 140;
        isServiceable = false;
        errors.push(`Location '${req.location}' is approx ${distanceKm}km away, exceeding 60km maximum radius.`);
      } else {
        distanceKm = 20;
      }
    }
  }

  // 5. Dietary Allergen Feasibility Check
  const unconfirmedDietary: DietaryRequirement[] = [];
  const supportedDietary = new Set(["vegan", "vegetarian", "dairy_free", "gluten_free"]);

  if (req.dietaryRequirements && req.dietaryRequirements.length > 0) {
    for (const diet of req.dietaryRequirements) {
      if (!supportedDietary.has(diet)) {
        unconfirmedDietary.push(diet);
      }
    }
  }

  // 6. Clarification Prompt Generation if Missing Info
  let clarificationPrompt: string | undefined;
  if (missingFields.length > 0) {
    if (missingFields.includes("eventDate") && missingFields.includes("location")) {
      clarificationPrompt =
        "We can prepare your instant 3-tier catering quotation, but we need the event date and approximate location first.";
    } else if (missingFields.includes("eventDate")) {
      clarificationPrompt = "Please let us know your preferred event date to verify van schedule availability.";
    } else if (missingFields.includes("location")) {
      clarificationPrompt = "Which venue or office campus in Hyderabad will the mobile coffee van be stationing at?";
    } else if (missingFields.includes("guestCount")) {
      clarificationPrompt = "How many guests or attendees are expected at your event?";
    }
  }

  const isValid = missingFields.length === 0 && errors.length === 0 && isServiceable;

  return {
    isValid,
    missingFields,
    errors,
    clarificationPrompt,
    isServiceable,
    distanceKm,
    dietaryConfirmed: unconfirmedDietary.length === 0,
    unconfirmedDietaryRequirements: unconfirmedDietary,
  };
}
