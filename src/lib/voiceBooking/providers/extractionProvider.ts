/**
 * BREW Coffee Platform — Phase 6.2.1 Requirement Extraction Providers
 * Hardened GeminiExtractionProvider with strict Zod schema validation, header-based auth,
 * bounded timeouts, and explicit failure classification; and deterministic MockExtractionProvider
 * with robust confirmation intent classification and field clearing.
 */

import {
  BookingRequirements,
  ConfirmationIntent,
  ExtractionProvider,
  LanguageDetectionResult,
  StructuredExtractionResult,
  SupportedLanguage,
} from "../types";
import { detectLanguage } from "../language";
import {
  GeminiExtractionOutputSchema,
  isValidCalendarDate,
  isValidTime24,
} from "../schemas";

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
 * Classifies confirmation intent with high specificity.
 * Rejects "yes" inside unrelated sentences from triggering positive confirmation.
 */
export function classifyConfirmationIntent(
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _language: SupportedLanguage
): ConfirmationIntent {
  const lower = text.toLowerCase().trim();

  // 1. Clear Rejection
  if (
    /^(no|decline|cancel|stop|nah|nope)\b/i.test(lower) ||
    lower.includes("price is too high") ||
    lower.includes("too expensive") ||
    lower.includes("don't want") ||
    lower.includes("dont want") ||
    lower.includes("nahi chahiye") ||
    lower.includes("radd kardo") ||
    lower.includes("mat karo") ||
    lower.includes("kaadhu") ||
    lower.includes("vaddu") ||
    lower.includes("oddu")
  ) {
    return "rejection";
  }

  // 2. Modification Requests
  if (
    lower.includes("change") ||
    lower.includes("modify") ||
    lower.includes("instead of") ||
    lower.includes("badal do") ||
    lower.includes("marpu") ||
    lower.includes("actually make it") ||
    lower.includes("actually 120") ||
    lower.includes("different date") ||
    lower.includes("different time")
  ) {
    return "modification_requested";
  }

  // 3. Clarification Questions (even if starting with "yes", "yeah", "ok")
  if (
    lower.includes("?") ||
    lower.includes("what about") ||
    lower.includes("what is included") ||
    lower.includes("can you tell me") ||
    lower.includes("is travel included") ||
    lower.includes("how much time") ||
    lower.includes("kya") ||
    lower.includes("kaise") ||
    lower.includes("ela") ||
    lower.includes("emi")
  ) {
    return "clarification_requested";
  }

  // 4. Positive Acceptance Patterns (Unambiguous booking acceptance)
  const isEnglishAcceptance =
    (/^(yes|yeah|sure|confirm|proceed|i confirm|i accept|please confirm)\b/i.test(lower) &&
      (lower.includes("confirm") ||
        lower.includes("proceed") ||
        lower.includes("book") ||
        lower.includes("let's do it") ||
        lower.includes("package") ||
        lower.includes("signature") ||
        lower.includes("classic") ||
        lower.includes("vip") ||
        lower === "yes" ||
        lower === "yes please" ||
        lower === "confirm booking" ||
        lower.includes("quotation"))) ||
    lower === "i confirm" ||
    lower === "confirm" ||
    lower === "yes";

  const isHindiAcceptance =
    lower.includes("haan theek hai confirm") ||
    lower.includes("haan confirm kardo") ||
    lower.includes("ha yehi package") ||
    lower.includes("sahi hai proceed") ||
    lower.includes("हाँ, यह पैकेज कन्फ़र्म") ||
    lower.includes("कन्फ़र्म कर दीजिए") ||
    lower.includes("बुक कर दो") ||
    lower.includes("ha confirm");

  const isTeluguAcceptance =
    lower.includes("avunu confirm") ||
    lower.includes("avunu ee package") ||
    lower.includes("sare proceed") ||
    lower.includes("అవును, ఈ ప్యాకేజీని కన్ఫర్మ్") ||
    lower.includes("కన్ఫర్మ్ చేయండి") ||
    lower.includes("బుకింగ్ కన్ఫర్మ్") ||
    lower.includes("అవును కన్ఫర్మ్");

  if (isEnglishAcceptance || isHindiAcceptance || isTeluguAcceptance) {
    return "positive_acceptance";
  }

  // 5. Unrelated sentence containing "yes" / conversational filler -> Ambiguous
  if (
    lower.includes("yes") ||
    lower.includes("haan") ||
    lower.includes("avunu") ||
    lower.includes("maybe") ||
    lower.includes("not sure") ||
    lower.includes("let me think") ||
    lower.includes("okay") ||
    lower.includes("hmm")
  ) {
    return "ambiguous";
  }

  return "ambiguous";
}

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
    language: SupportedLanguage
  ): Promise<StructuredExtractionResult> {
    const raw = text.trim();
    const lower = raw.toLowerCase();
    const data: Partial<BookingRequirements> = {};
    const clearedFields: string[] = [];

    // 0. Explicit Field Clearing Checks
    if (lower.includes("clear the date") || lower.includes("remove the date") || lower.includes("date hata do") || lower.includes("date theeyandi")) {
      clearedFields.push("eventDate");
      data.eventDate = null;
    }
    if (lower.includes("clear the time") || lower.includes("remove the time") || lower.includes("time hata do") || lower.includes("time theeyandi")) {
      clearedFields.push("startTime");
      data.startTime = null;
    }
    if (lower.includes("clear the guests") || lower.includes("remove guest count")) {
      clearedFields.push("guestCount");
      data.guestCount = null;
    }
    if (lower.includes("clear preferences") || lower.includes("remove beverage preferences")) {
      clearedFields.push("beveragePreferences");
      data.beveragePreferences = [];
    }

    // 1. Guest Count Extraction (10 - 1000)
    if (!clearedFields.includes("guestCount")) {
      const guestMatch = lower.match(
        /(\d+)\s*(?:guests?|people|pax|attendees|log|logon|लोग|mandiki|mandi|మంది|atithulu)?/i
      );
      if (guestMatch) {
        const parsed = parseInt(guestMatch[1], 10);
        if (parsed >= 10 && parsed <= 1000) {
          data.guestCount = parsed;
        }
      }
    }

    // 2. Event Date Extraction (Real calendar dates)
    if (!clearedFields.includes("eventDate")) {
      const dateIsoMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (dateIsoMatch && isValidCalendarDate(dateIsoMatch[1])) {
        data.eventDate = dateIsoMatch[1];
      } else {
        const verboseDateMatch = lower.match(
          /(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/i
        );
        if (verboseDateMatch) {
          const day = verboseDateMatch[1].padStart(2, "0");
          const monthNames: Record<string, string> = {
            jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
            apr: "04", april: "04", may: "05", jun: "06", jul: "07", july: "07",
            aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10",
            nov: "11", november: "11", dec: "12", december: "12",
          };
          const month = monthNames[verboseDateMatch[2].toLowerCase()] || "12";
          const year = verboseDateMatch[3] || "2026";
          const candidate = `${year}-${month}-${day}`;
          if (isValidCalendarDate(candidate)) {
            data.eventDate = candidate;
          }
        }
      }
    }

    // 3. Start Time Extraction (24h valid format)
    if (!clearedFields.includes("startTime")) {
      const time24Match = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
      if (time24Match) {
        const candidate = `${time24Match[1].padStart(2, "0")}:${time24Match[2]}`;
        if (isValidTime24(candidate)) {
          data.startTime = candidate;
        }
      } else {
        const timeAmPmMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|gantalu|గంటలకు|బజే)/i);
        if (timeAmPmMatch) {
          let hour = parseInt(timeAmPmMatch[1], 10);
          const minute = timeAmPmMatch[2] || "00";
          const meridian = (timeAmPmMatch[3] || "").toLowerCase();
          if (meridian === "pm" && hour < 12) hour += 12;
          if (meridian === "am" && hour === 12) hour = 0;
          const candidate = `${hour.toString().padStart(2, "0")}:${minute}`;
          if (isValidTime24(candidate)) {
            data.startTime = candidate;
          }
        }
      }
    }

    // 4. Duration Hours Extraction (1 - 12)
    const durationMatch = lower.match(
      /(\d+)\s*(?:hours?|hrs?|ghante|ghanta|gantalu|ganta|గంటలు|घंटे)/i
    );
    if (durationMatch) {
      const hours = parseInt(durationMatch[1], 10);
      if (hours >= 1 && hours <= 12) {
        data.durationHours = hours;
      }
    }

    // 5. Venue Address Extraction
    for (const hub of HYDERABAD_HUBS) {
      if (lower.includes(hub.toLowerCase())) {
        data.venueAddress = hub;
        break;
      }
    }
    if (!data.venueAddress) {
      const locationMarkerMatch = lower.match(
        /(?:at|in|near|location:|venue:|daggara|mein|lo)\s+([A-Za-z0-9\s,.-]+?)(?=(?:\.|\?|,|and|with|$))/i
      );
      if (locationMarkerMatch && locationMarkerMatch[1].trim().length >= 3) {
        data.venueAddress = locationMarkerMatch[1].trim();
      }
    }

    // 6. Event Type Extraction
    if (lower.includes("wedding") || lower.includes("shaadi") || lower.includes("pelli")) {
      data.eventType = "wedding";
    } else if (lower.includes("birthday") || lower.includes("janmadin") || lower.includes("puttinaroju")) {
      data.eventType = "birthday";
    } else if (lower.includes("corporate") || lower.includes("office") || lower.includes("company")) {
      data.eventType = "corporate";
    } else if (lower.includes("party") || lower.includes("gathering")) {
      data.eventType = "private_party";
    }

    // 7. Beverage Preferences (Contradiction safe)
    if (!clearedFields.includes("beveragePreferences")) {
      const foundPrefs: string[] = [];
      for (const kw of BEVERAGE_KEYWORDS) {
        if (lower.includes(kw)) {
          foundPrefs.push(kw);
        }
      }
      if (foundPrefs.length > 0) {
        // If customer says "only" or "just", replace rather than append
        if (lower.includes("only") || lower.includes("just") || lower.includes("sirf") || lower.includes("matrame")) {
          data.beveragePreferences = foundPrefs;
        } else {
          const merged = Array.from(new Set([...current.beveragePreferences, ...foundPrefs]));
          data.beveragePreferences = merged;
        }
      }
    }

    // 8. Tier Selection
    if (
      lower.includes("classic brew") ||
      lower.includes("basic") ||
      lower.includes("package 1") ||
      lower.includes("first package")
    ) {
      data.selectedTier = "BASIC";
    } else if (
      lower.includes("artisanal signature") ||
      lower.includes("standard") ||
      lower.includes("package 2") ||
      lower.includes("second package")
    ) {
      data.selectedTier = "STANDARD";
    } else if (
      lower.includes("vip unlimited") ||
      lower.includes("vip") ||
      lower.includes("premium") ||
      lower.includes("package 3") ||
      lower.includes("third package")
    ) {
      data.selectedTier = "PREMIUM";
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
      data.handoffRequested = true;
    }

    // 10. Confirmation Intent Classification
    const confirmationIntent = classifyConfirmationIntent(raw, language);
    data.customerConfirmed = confirmationIntent === "positive_acceptance";

    return {
      status: "success",
      source: "mock",
      data,
      confidenceScore: 0.95,
      confirmationIntent,
      clearedFields,
    };
  }
}

/**
 * Hardened Gemini AI extraction provider.
 * Enforces server-only execution, header-based API key transport (never in URL),
 * bounded HTTP timeout, and strict Zod runtime schema validation on model outputs.
 */
export class GeminiExtractionProvider implements ExtractionProvider {
  private fallback: MockExtractionProvider;
  private readonly timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.fallback = new MockExtractionProvider();
    this.timeoutMs = options?.timeoutMs || 8000;
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
  ): Promise<StructuredExtractionResult> {
    const isProduction = process.env.NODE_ENV === "production";
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.VOICE_AGENT_MODEL;

    // Fail-closed in production if credentials or model identifier are missing
    if (!apiKey || !model) {
      if (isProduction) {
        return {
          status: "service_unavailable",
          source: "gemini",
          data: null,
          confidenceScore: 0,
          error: "Gemini provider is not configured (missing GEMINI_API_KEY or VOICE_AGENT_MODEL).",
        };
      }
      // Non-production / test mode fallback to mock with clear attribution
      const mockResult = await this.fallback.extractRequirements(text, current, language);
      return {
        ...mockResult,
        source: "mock",
      };
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
  "customerConfirmed": boolean,
  "confirmationIntent": "positive_acceptance" | "rejection" | "clarification_requested" | "modification_requested" | "ambiguous" | null,
  "confidenceScore": number,
  "clearedFields": string[]
}
Return pure JSON with no markdown formatting. Do not include any extra fields.`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // SECURE TRANSPORT: Header-based authentication (NO API key in URL query parameter)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
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
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      if (response.status === 429) {
        return {
          status: "api_failure",
          source: "gemini",
          data: null,
          confidenceScore: 0,
          error: "Gemini API rate limit exceeded (HTTP 429).",
        };
      }

      if (!response.ok) {
        return {
          status: "api_failure",
          source: "gemini",
          data: null,
          confidenceScore: 0,
          error: `Gemini API returned HTTP ${response.status}`,
        };
      }

      const json = await response.json();
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        return {
          status: "invalid_response",
          source: "gemini",
          data: null,
          confidenceScore: 0,
          error: "Empty content returned by Gemini API.",
        };
      }

      // JSON Parse Check
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        return {
          status: "invalid_response",
          source: "gemini",
          data: null,
          confidenceScore: 0,
          error: "Model output failed JSON parsing.",
          rawResponse: rawText,
        };
      }

      // STRICT ZOD VALIDATION: Enforces bounds, real calendar dates, 24h times, and rejects extra fields
      const parseResult = GeminiExtractionOutputSchema.safeParse(parsedJson);
      if (!parseResult.success) {
        return {
          status: "invalid_response",
          source: "gemini",
          data: null,
          confidenceScore: 0,
          error: `Zod extraction schema validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          rawResponse: rawText,
        };
      }

      const validatedData = parseResult.data;
      const confidence = validatedData.confidenceScore ?? 1.0;

      if (confidence < 0.7) {
        return {
          status: "low_confidence",
          source: "gemini",
          data: validatedData,
          confidenceScore: confidence,
          confirmationIntent: validatedData.confirmationIntent || undefined,
          clearedFields: validatedData.clearedFields,
        };
      }

      return {
        status: "success",
        source: "gemini",
        data: validatedData,
        confidenceScore: confidence,
        confirmationIntent: validatedData.confirmationIntent || undefined,
        clearedFields: validatedData.clearedFields,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      const isAbort = (err as Error)?.name === "AbortError";
      return {
        status: "api_failure",
        source: "gemini",
        data: null,
        confidenceScore: 0,
        error: isAbort
          ? `Gemini request timed out after ${this.timeoutMs}ms.`
          : "Network failure communicating with Gemini API.",
      };
    }
  }
}
