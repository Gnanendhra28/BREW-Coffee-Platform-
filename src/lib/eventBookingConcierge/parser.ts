// Natural Language Request Parser for Agent 4: 🎪 Event Booking Concierge
// Converts free-text customer inquiries into structured, normalized EventRequirements.

import { EventRequirements, EventType, DietaryRequirement, ServiceLevel } from "./types";

/**
 * Extracts structured event requirements from natural language inquiries.
 */
export function parseNaturalLanguageEventRequest(
  input: string,
  defaults: Partial<EventRequirements> = {}
): Partial<EventRequirements> {
  const text = (input || "").trim();
  const lower = text.toLowerCase();

  // 1. Guest Count Extraction
  let guestCount: number | undefined = defaults.guestCount;
  if (!guestCount) {
    const crowdMatches = [
      /(?:for|about|around|approx|approximately)?\s*(\d{1,4})\s*(?:guests|people|attendees|employees|folks|pax|members|heads|persons)/i,
      /(?:crowd|gathering|size|headcount)\s*(?:of|is|around)?\s*(\d{1,4})/i,
      /(\d{1,4})\s*(?:guest|people|pax)\b/i,
    ];

    for (const regex of crowdMatches) {
      const match = text.match(regex);
      if (match && match[1]) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed > 0) {
          guestCount = parsed;
          break;
        }
      }
    }
  }

  // 2. Event Type Classification
  let eventType: EventType = defaults.eventType || "corporate";
  if (lower.includes("wedding") || lower.includes("reception") || lower.includes("sangeet") || lower.includes("marriage")) {
    eventType = "wedding";
  } else if (lower.includes("birthday") || lower.includes("bday") || lower.includes("anniversary")) {
    eventType = "birthday";
  } else if (lower.includes("conference") || lower.includes("summit") || lower.includes("symposium")) {
    eventType = "conference";
  } else if (lower.includes("workshop") || lower.includes("hackathon") || lower.includes("bootcamp")) {
    eventType = "workshop";
  } else if (lower.includes("college") || lower.includes("campus") || lower.includes("university") || lower.includes("fest")) {
    eventType = "college_event";
  } else if (lower.includes("launch") || lower.includes("opening") || lower.includes("inauguration")) {
    eventType = "launch_event";
  } else if (lower.includes("party") || lower.includes("get together") || lower.includes("celebration")) {
    eventType = "private_party";
  } else if (lower.includes("meeting") || lower.includes("boardroom") || lower.includes("townhall")) {
    eventType = "meeting";
  } else if (lower.includes("office") || lower.includes("corporate") || lower.includes("company") || lower.includes("team")) {
    eventType = "corporate";
  }

  // 3. Time & Duration Parsing
  let startTime = defaults.startTime || "10:00";
  let endTime = defaults.endTime || "14:00";
  let durationMinutes = defaults.durationMinutes || 240;

  // Pattern: "from 10 AM to 2 PM" or "10:00 to 14:00"
  const timeRangeMatch = text.match(
    /(?:from\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i
  );

  if (timeRangeMatch) {
    let startH = parseInt(timeRangeMatch[1], 10);
    const startM = timeRangeMatch[2] ? parseInt(timeRangeMatch[2], 10) : 0;
    const startMeridian = (timeRangeMatch[3] || "").toLowerCase();

    let endH = parseInt(timeRangeMatch[4], 10);
    const endM = timeRangeMatch[5] ? parseInt(timeRangeMatch[5], 10) : 0;
    const endMeridian = (timeRangeMatch[6] || "").toLowerCase();

    if (startMeridian === "pm" && startH < 12) startH += 12;
    if (startMeridian === "am" && startH === 12) startH = 0;
    if (endMeridian === "pm" && endH < 12) endH += 12;
    if (endMeridian === "am" && endH === 12) endH = 0;

    // Fallback meridian inference if only end meridian specified (e.g. 10 to 2 PM)
    if (!startMeridian && endMeridian === "pm" && startH <= 12 && startH >= 8) {
      // 10 AM to 2 PM
      if (startH < endH && endH < 12) {
        // e.g. 1 to 5 PM
        startH += 12;
      }
    }

    startTime = `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`;
    endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;

    const totalStartMins = startH * 60 + startM;
    const totalEndMins = endH * 60 + endM;
    const diff = totalEndMins - totalStartMins;
    if (diff > 0) {
      durationMinutes = diff;
    }
  } else {
    // Pattern: "4-hour" or "4 hours"
    const durMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:hour|hr|hours|hrs)/i);
    if (durMatch && durMatch[1]) {
      const hours = parseFloat(durMatch[1]);
      if (!isNaN(hours) && hours > 0) {
        durationMinutes = Math.round(hours * 60);
      }
    }
  }

  // 4. Date Extraction
  let eventDate = defaults.eventDate;
  if (!eventDate) {
    const isoDateMatch = text.match(/\b(202\d-\d{2}-\d{2})\b/);
    if (isoDateMatch) {
      eventDate = isoDateMatch[1];
    } else {
      // Relative date recognition (e.g. next Friday, tomorrow, next week)
      const now = new Date();
      if (lower.includes("tomorrow")) {
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        eventDate = tomorrow.toISOString().split("T")[0];
      } else if (lower.includes("next friday")) {
        const day = now.getDay();
        const daysUntilFriday = ((5 - day + 7) % 7) || 7;
        const nextFri = new Date(now.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000);
        eventDate = nextFri.toISOString().split("T")[0];
      } else if (lower.includes("next monday")) {
        const day = now.getDay();
        const daysUntilMon = ((1 - day + 7) % 7) || 7;
        const nextMon = new Date(now.getTime() + daysUntilMon * 24 * 60 * 60 * 1000);
        eventDate = nextMon.toISOString().split("T")[0];
      }
    }
  }

  // 5. Dietary Requirements Extraction
  const dietaryRequirements: DietaryRequirement[] = defaults.dietaryRequirements ? [...defaults.dietaryRequirements] : [];
  if (lower.includes("vegan") && !dietaryRequirements.includes("vegan")) {
    dietaryRequirements.push("vegan");
  }
  if (lower.includes("vegetarian") || lower.includes("veg") && !lower.includes("non-veg")) {
    if (!dietaryRequirements.includes("vegetarian")) dietaryRequirements.push("vegetarian");
  }
  if (lower.includes("gluten") || lower.includes("gluten-free") || lower.includes("gf")) {
    if (!dietaryRequirements.includes("gluten_free")) dietaryRequirements.push("gluten_free");
  }
  if (lower.includes("dairy-free") || lower.includes("lactose")) {
    if (!dietaryRequirements.includes("dairy_free")) dietaryRequirements.push("dairy_free");
  }
  if (lower.includes("nut-free") || lower.includes("nut allergy")) {
    if (!dietaryRequirements.includes("nut_free")) dietaryRequirements.push("nut_free");
  }
  if (lower.includes("halal") && !dietaryRequirements.includes("halal")) {
    dietaryRequirements.push("halal");
  }

  // 6. Service Level Preference
  let serviceLevel: ServiceLevel = defaults.serviceLevel || "STANDARD";
  if (lower.includes("vip") || lower.includes("unlimited")) {
    serviceLevel = "VIP";
  } else if (lower.includes("premium") || lower.includes("luxury")) {
    serviceLevel = "PREMIUM";
  } else if (lower.includes("basic") || lower.includes("budget") || lower.includes("simple")) {
    serviceLevel = "BASIC";
  }

  // 7. Location & Organization Extraction
  let location = defaults.location || "";
  let city = defaults.city || "Hyderabad";

  const knownHubs = [
    "DLF Cybercity",
    "Cyber Towers",
    "Mindspace",
    "Financial District",
    "Gachibowli",
    "Hitec City",
    "Jubilee Hills",
    "Banjara Hills",
    "Kondapur",
    "Madhapur",
    "Kokapet",
  ];

  for (const hub of knownHubs) {
    if (lower.includes(hub.toLowerCase())) {
      location = hub;
      break;
    }
  }

  if (!location) {
    if (lower.includes("hyderabad")) {
      location = "Hyderabad Hub";
      city = "Hyderabad";
    }
  }

  let organization = defaults.organization || "";
  const orgMatch = text.match(/(?:at|for)\s+([A-Z][A-Za-z0-9\s&]+(?:Inc|Corp|LLC|Technologies|Labs|Campus|College|University)?)/);
  if (orgMatch && orgMatch[1] && !knownHubs.some((h) => h.toLowerCase() === orgMatch[1].trim().toLowerCase())) {
    organization = orgMatch[1].trim();
  } else if (!organization) {
    organization = "Campus / Organization";
  }

  return {
    organization,
    eventType,
    guestCount,
    eventDate,
    startTime,
    endTime,
    durationMinutes,
    location,
    city,
    serviceLevel,
    dietaryRequirements,
    specialRequests: text,
  };
}
