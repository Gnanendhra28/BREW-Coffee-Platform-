/**
 * BREW Coffee Platform — Phase 6.2 Requirement Extraction Providers
 * Rule-based MockExtractionProvider for offline deterministic execution and tests,
 * and GeminiExtractionProvider for server-side production inference with automatic fallback.
 */

import {
  BookingRequirements,
  ExtractionProvider,
  SupportedLanguage,
  LanguageDetectionResult,
} from "../types";
import { detectLanguage } from "../language";

const HYDERABAD_HUBS = [
  "Hitec City",
  "Gachibowli",
  "Jubilee Hills",
  "Banjara Hills",
  "Madhapur",
  "Cybercity",
  "Financial District",
  "Kondapur",
  "Begumpet",
  "Secunderabad",
  "Kukatpally",
  "Manikonda",
];

const BEVERAGE_KEYWORDS = [
  "cold brew",
  "espresso",
  "latte",
  "cappuccino",
  "oat milk",
  "americano",
  "mocha",
  "pour over",
  "manual brew",
  "filter coffee",
  "tea",
];

/**
 * Deterministic, rule-based extraction provider for unit/integration testing and zero-network workflows.
 */
export class MockExtractionProvider implements ExtractionProvider {
  async detectLanguage(
    text: string,
    currentLanguage?: SupportedLanguage
  ): Promise<LanguageDetectionResult> {
    return detectLanguage(text, currentLanguage);
  }

  async extractRequirements(
    text: string,
    current: BookingRequirements,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _language: SupportedLanguage
  ): Promise<Partial<BookingRequirements>> {
    const raw = text.trim();
    const lower = raw.toLowerCase();
    const result: Partial<BookingRequirements> = {};

    // 1. Guest Count Extraction
    const guestMatch = lower.match(
      /(\d+)\s*(?:guests?|people|pax|attendees|log|logon|लोग|mandiki|mandi|మంది|atithulu)?/i
    );
    if (guestMatch) {
      const parsed = parseInt(guestMatch[1], 10);
      if (parsed >= 10 && parsed <= 1000) {
        result.guestCount = parsed;
      }
    }

    // 2. Event Date Extraction (YYYY-MM-DD or standard forms)
    const dateIsoMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateIsoMatch) {
      result.eventDate = dateIsoMatch[1];
    } else {
      const verboseDateMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/i);
      if (verboseDateMatch) {
        const day = verboseDateMatch[1].padStart(2, "0");
        const monthNames: Record<string, string> = {
          jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
          apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
          aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10",
          nov: "11", november: "11", dec: "12", december: "12",
        };
        const month = monthNames[verboseDateMatch[2].toLowerCase()] || "12";
        const year = verboseDateMatch[3] || "2026";
        result.eventDate = `${year}-${month}-${day}`;
      }
    }

    // 3. Start Time Extraction
    const time24Match = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (time24Match) {
      result.startTime = `${time24Match[1].padStart(2, "0")}:${time24Match[2]}`;
    } else {
      const timeAmPmMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|gantalu|గంటలకు|बजे)/i);
      if (timeAmPmMatch) {
        let hour = parseInt(timeAmPmMatch[1], 10);
        const minute = timeAmPmMatch[2] || "00";
        const meridian = (timeAmPmMatch[3] || "").toLowerCase();
        if (meridian === "pm" && hour < 12) hour += 12;
        if (meridian === "am" && hour === 12) hour = 0;
        result.startTime = `${hour.toString().padStart(2, "0")}:${minute}`;
      }
    }

    // 4. Duration Hours Extraction
    const durationMatch = lower.match(
      /(\d+)\s*(?:hours?|hrs?|ghante|ghanta|gantalu|ganta|గంటలు|घंटे)/i
    );
    if (durationMatch) {
      const hours = parseInt(durationMatch[1], 10);
      if (hours >= 1 && hours <= 12) {
        result.durationHours = hours;
      }
    }

    // 5. Venue Address Extraction
    for (const hub of HYDERABAD_HUBS) {
      if (lower.includes(hub.toLowerCase())) {
        result.venueAddress = hub;
        break;
      }
    }
    if (!result.venueAddress) {
      const locationMarkerMatch = lower.match(
        /(?:at|in|near|location:|venue:|daggara|mein|lo)\s+([A-Za-z0-9\s,.-]+?)(?=(?:\.|\?|,|and|with|$))/i
      );
      if (locationMarkerMatch && locationMarkerMatch[1].trim().length >= 3) {
        result.venueAddress = locationMarkerMatch[1].trim();
      }
    }

    // 6. Event Type Extraction
    if (lower.includes("wedding") || lower.includes("shaadi") || lower.includes("pelli")) {
      result.eventType = "wedding";
    } else if (lower.includes("birthday") || lower.includes("janmadin") || lower.includes("puttinaroju")) {
      result.eventType = "birthday";
    } else if (lower.includes("corporate") || lower.includes("office") || lower.includes("company")) {
      result.eventType = "corporate";
    } else if (lower.includes("party") || lower.includes("gathering")) {
      result.eventType = "private_party";
    }

    // 7. Beverage Preferences
    const foundPrefs: string[] = [];
    for (const kw of BEVERAGE_KEYWORDS) {
      if (lower.includes(kw)) {
        foundPrefs.push(kw);
      }
    }
    if (foundPrefs.length > 0) {
      const merged = Array.from(new Set([...current.beveragePreferences, ...foundPrefs]));
      result.beveragePreferences = merged;
    }

    // 8. Tier Selection
    if (
      lower.includes("classic brew") ||
      lower.includes("basic") ||
      lower.includes("package 1") ||
      lower.includes("first package")
    ) {
      result.selectedTier = "BASIC";
    } else if (
      lower.includes("artisanal signature") ||
      lower.includes("standard") ||
      lower.includes("package 2") ||
      lower.includes("second package")
    ) {
      result.selectedTier = "STANDARD";
    } else if (
      lower.includes("vip unlimited") ||
      lower.includes("vip") ||
      lower.includes("premium") ||
      lower.includes("package 3") ||
      lower.includes("third package")
    ) {
      result.selectedTier = "PREMIUM";
    }

    // 9. Human Handoff Intent
    if (
      lower.includes("human") ||
      lower.includes("talk to human") ||
      lower.includes("speak to someone") ||
      lower.includes("representative") ||
      lower.includes("manager") ||
      lower.includes("manager se baat") ||
      lower.includes("human tho matladali") ||
      lower.includes("operator") ||
      lower.includes("agent")
    ) {
      result.handoffRequested = true;
    }

    // 10. Confirmation / Approval Intent
    if (
      lower.includes("confirm") ||
      lower.includes("yes") ||
      lower.includes("proceed") ||
      lower.includes("go ahead") ||
      lower.includes("i confirm") ||
      lower.includes("haan") ||
      lower.includes("theek hai") ||
      lower.includes("kardo") ||
      lower.includes("avunu") ||
      lower.includes("sare") ||
      lower.includes("cheseddam")
    ) {
      result.customerConfirmed = true;
    }

    result.confidenceScore = 0.95;
    return result;
  }
}

/**
 * Production Gemini AI extraction provider that uses Gemini 1.5 Flash when available,
 * and automatically falls back to MockExtractionProvider if credentials are unset or network fails.
 */
export class GeminiExtractionProvider implements ExtractionProvider {
  private fallback: MockExtractionProvider;

  constructor() {
    this.fallback = new MockExtractionProvider();
  }

  async detectLanguage(
    text: string,
    currentLanguage?: SupportedLanguage
  ): Promise<LanguageDetectionResult> {
    return detectLanguage(text, currentLanguage);
  }

  async extractRequirements(
    text: string,
    current: BookingRequirements,
    language: SupportedLanguage
  ): Promise<Partial<BookingRequirements>> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) {
      return this.fallback.extractRequirements(text, current, language);
    }

    const systemPrompt = `You are the structured extraction engine for BREW Coffee Voice Booking Concierge.
Given the customer message and currently known requirements, extract newly stated booking fields into a JSON object.
Use EXACTLY this schema (return null for unknown fields):
{
  "guestCount": number | null,
  "eventDate": "YYYY-MM-DD" | null,
  "startTime": "HH:mm" | null,
  "durationHours": number | null,
  "venueAddress": string | null,
  "eventType": string | null,
  "beveragePreferences": string[],
  "selectedTier": "BASIC" | "STANDARD" | "PREMIUM" | null,
  "handoffRequested": boolean,
  "customerConfirmed": boolean
}
Return pure JSON with no markdown formatting.`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: systemPrompt },
                  {
                    text: `Current State:\n${JSON.stringify(current)}\n\nUser Utterance (${language}):\n"${text}"`,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      if (!response.ok) {
        return this.fallback.extractRequirements(text, current, language);
      }

      const json = await response.json();
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        return this.fallback.extractRequirements(text, current, language);
      }

      const parsed = JSON.parse(rawText);
      return {
        ...parsed,
        confidenceScore: 0.98,
      };
    } catch {
      return this.fallback.extractRequirements(text, current, language);
    }
  }
}
