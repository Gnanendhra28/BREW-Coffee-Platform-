/**
 * BREW Coffee Platform — Phase 6.1 Do-Not-Contact (DND) Engine & Opt-Out Rules
 * Pure functions for DND suppression evaluation and deterministic multilingual phrase matching.
 */

import { CommunicationChannel, DndRecord, DndScope, DndSource } from "./types";
import { DndRecordSchema } from "./schemas";
import { assertValidPhoneNumber } from "./consent";

/**
 * Creates a validated DndRecord.
 */
export function createDndRecord(params: {
  phoneNumber: string;
  scope: DndScope;
  reason: string;
  sourceChannel?: DndSource;
  createdAt?: string;
}): DndRecord {
  const normalizedPhone = assertValidPhoneNumber(params.phoneNumber);
  const nowUtc = params.createdAt || new Date().toISOString();
  const id = `dnd_${normalizedPhone.replace(/\+/g, "")}`;

  const record: DndRecord = {
    id,
    phoneNumber: normalizedPhone,
    scope: params.scope,
    reason: params.reason.trim(),
    createdAt: nowUtc,
    sourceChannel: params.sourceChannel,
  };

  return DndRecordSchema.parse(record);
}

/**
 * Pure evaluation function checking whether a communication channel is blocked by an active DND entry.
 * 
 * Rules:
 * - scope 'all' blocks ALL channels (voice and whatsapp).
 * - scope 'voice' blocks ONLY voice calls.
 * - scope 'whatsapp' blocks ONLY whatsapp messages.
 */
export function isChannelBlockedByDnd(
  dndRecord: DndRecord | null | undefined,
  channel: CommunicationChannel
): boolean {
  if (!dndRecord) return false;

  if (dndRecord.scope === "all") {
    return true;
  }

  if (dndRecord.scope === channel) {
    return true;
  }

  return false;
}

/**
 * Exact deterministic opt-out keywords and anchored regex patterns in English, Hindi, and Telugu.
 * Does not depend on external LLM inference, ensuring zero latency and zero hallucination risk.
 */
const EXACT_OPTOUT_COMMANDS = new Set([
  // English
  "stop",
  "unsubscribe",
  "quit",
  "cancel",
  "end",
  "opt out",
  "optout",
  "do not call",
  "dont call",
  "don't call",
  "dont call me",
  "don't call me",
  "stop calling",
  "no calls",
  "stop all",
  // Hindi (Devanagari)
  "रोको",
  "बंद करो",
  "कॉल मत करो",
  "संदेश मत भेजो",
  "अनसब्सक्राइब",
  "फोन मत करना",
  "कॉल बंद करो",
  // Telugu (Script)
  "ఆపండి",
  "వద్దు",
  "కాల్ చేయవద్దు",
  "ఫోన్ చేయకండి",
  "మెసేజ్ చేయవద్దు",
  "రద్దు చేయండి",
  "కాల్స్ వద్దు",
  // Hinglish (Romanized Hindi)
  "band karo",
  "call mat karo",
  "roko",
  "phone mat karo",
  "mat karo",
  "message mat bhejo",
  // Tenglish (Romanized Telugu)
  "aapandi",
  "vaddu",
  "call cheyavaddhu",
  "phone cheyakandi",
  "message cheyavaddhu",
]);

const ANCHORED_COMMAND_PATTERNS: RegExp[] = [
  /^(please\s+)?(stop|unsubscribe|quit|cancel|end)(\s+all)?$/i,
  /^(please\s+)?(do\s+not|dont|don't)\s+call(\s+me)?$/i,
  /^(please\s+)?(stop\s+calling)(\s+me)?$/i,
  /^(mujhe\s+)?(call|phone)\s+mat\s+karo$/i,
  /^(naku\s+)?(call|phone)\s+cheyakandi$/i,
];

/**
 * Detects whether a customer message represents an explicit opt-out command.
 * 
 * Accurately recognizes:
 * - English ("STOP", "UNSUBSCRIBE", "DON'T CALL ME")
 * - Hindi ("कॉल मत करो", "बंद करो", "call mat karo")
 * - Telugu ("ఆపండి", "వద్దు", "call cheyavaddhu")
 * 
 * Safely ignores non-opt-out conversational sentences such as:
 * - "I will stop by at 4pm"
 * - "Can you call me tomorrow?"
 * - "Coffee stop near me"
 */
export function isOptOutPhrase(rawText: string): boolean {
  if (!rawText || typeof rawText !== "string") return false;

  const cleaned = rawText
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "") // Normalize contractions, e.g. "don't" -> "dont"
    .replace(/[.!?,;:\-_"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (EXACT_OPTOUT_COMMANDS.has(cleaned)) {
    return true;
  }

  return ANCHORED_COMMAND_PATTERNS.some((pattern) => pattern.test(cleaned));
}
