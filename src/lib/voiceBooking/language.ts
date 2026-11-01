/**
 * BREW Coffee Platform — Phase 6.2 Multilingual Engine
 * Script analysis, token classification, and code-switching detection for English, Hindi, and Telugu.
 * Supports native scripts (Devanagari, Telugu) and romanized vernacular (Hinglish, Tenglish).
 */

import { SupportedLanguage, LanguageDetectionResult } from "./types";

const DEVANAGARI_REGEX = /[\u0900-\u097F]/;
const TELUGU_SCRIPT_REGEX = /[\u0C00-\u0C7F]/;

const HINDI_ROMANIZED_TOKENS = new Set([
  "namaste", "namaskar", "haan", "ha", "nahi", "nahin", "chahiye", "log", "logon",
  "kitna", "kitne", "kharcha", "kaise", "ghante", "ghanta", "baje", "karo", "kripya",
  "dhanyawad", "shukriya", "baat", "karni", "karna", "hai", "hain", "mujhe", "humko",
  "hum", "theek", "accha", "shadi", "shaadi", "janmadin", "peene", "chai", "coffee",
  "batao", "bataiye", "sahi", "kardo", "hoga", "hogi", "kaunsa", "package", "mehmaan",
  "aayenge", "subah", "shaam", "dopahar", "kitne", "rupaye", "paisa", "paise", "madad",
]);

const TELUGU_ROMANIZED_TOKENS = new Set([
  "namaskaram", "avunu", "kaadhu", "kavali", "vaddu", "mandiki", "mandi", "entha",
  "kharchu", "gantalu", "ganta", "daggara", "ela", "chesi", "cheyyandi", "dhanyavadhalu",
  "matladali", "matladandi", "maaku", "naku", "manchi", "pelliki", "pelli",
  "puttinaroju", "cheppandi", "telupandi", "sare", "theeyandi", "kaavalenu", "unte",
  "vastharu", "udayam", "saayanthram", "madhyahnam", "roju", "taruvatha", "sahayam",
]);

/**
 * Detects whether the input contains non-Latin scripts (Devanagari or Telugu).
 */
export function detectScript(text: string): "latin" | "devanagari" | "telugu" {
  if (DEVANAGARI_REGEX.test(text)) return "devanagari";
  if (TELUGU_SCRIPT_REGEX.test(text)) return "telugu";
  return "latin";
}

/**
 * Normalizes text for linguistic token analysis.
 */
function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

/**
 * Checks for explicit user directives to change conversation language.
 */
function checkExplicitLanguageDirective(normalizedText: string): SupportedLanguage | null {
  if (
    normalizedText.includes("switch to hindi") ||
    normalizedText.includes("hindi please") ||
    normalizedText.includes("hindi me baat") ||
    normalizedText.includes("hindi mein") ||
    normalizedText.includes("हिंदी में") ||
    normalizedText.includes("hindi lo matladu")
  ) {
    return "hi";
  }

  if (
    normalizedText.includes("switch to telugu") ||
    normalizedText.includes("telugu please") ||
    normalizedText.includes("telugu lo matladu") ||
    normalizedText.includes("telugu lo") ||
    normalizedText.includes("తెలుగులో") ||
    normalizedText.includes("telugu mein")
  ) {
    return "te";
  }

  if (
    normalizedText.includes("switch to english") ||
    normalizedText.includes("english please") ||
    normalizedText.includes("speak english") ||
    normalizedText.includes("english lo") ||
    normalizedText.includes("english mein")
  ) {
    return "en";
  }

  return null;
}

/**
 * Identifies the language of an input string with confidence scoring.
 * Correctly classifies Devanagari script, Telugu script, Hinglish, Tenglish, and English.
 */
export function detectLanguage(
  text: string,
  currentLanguage: SupportedLanguage = "en"
): LanguageDetectionResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { language: currentLanguage, confidence: 1.0, detectedScript: "latin" };
  }

  // 1. Check explicit language switch requests first
  const explicit = checkExplicitLanguageDirective(trimmed.toLowerCase());
  if (explicit) {
    return {
      language: explicit,
      confidence: 1.0,
      detectedScript: detectScript(trimmed),
    };
  }

  // 2. High-confidence native script detection
  const script = detectScript(trimmed);
  if (script === "devanagari") {
    return { language: "hi", confidence: 0.99, detectedScript: "devanagari" };
  }
  if (script === "telugu") {
    return { language: "te", confidence: 0.99, detectedScript: "telugu" };
  }

  // 3. Romanized / Latin script token analysis (Hinglish vs Tenglish vs English)
  const tokens = tokenizeWords(trimmed);
  if (tokens.length === 0) {
    return { language: currentLanguage, confidence: 0.8, detectedScript: "latin" };
  }

  let hindiScore = 0;
  let teluguScore = 0;

  for (const token of tokens) {
    if (HINDI_ROMANIZED_TOKENS.has(token)) {
      hindiScore += 1;
    }
    if (TELUGU_ROMANIZED_TOKENS.has(token)) {
      teluguScore += 1;
    }
  }

  const hindiRatio = hindiScore / tokens.length;
  const teluguRatio = teluguScore / tokens.length;

  if (hindiScore > teluguScore && (hindiScore >= 2 || hindiRatio >= 0.25)) {
    return {
      language: "hi",
      confidence: Math.min(0.95, 0.6 + hindiRatio * 0.4),
      detectedScript: "latin",
    };
  }

  if (teluguScore > hindiScore && (teluguScore >= 2 || teluguRatio >= 0.25)) {
    return {
      language: "te",
      confidence: Math.min(0.95, 0.6 + teluguRatio * 0.4),
      detectedScript: "latin",
    };
  }

  // 4. Default to English or retain current conversation language if tokens are neutral
  return {
    language: currentLanguage === "en" ? "en" : currentLanguage,
    confidence: 0.85,
    detectedScript: "latin",
  };
}
