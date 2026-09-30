// Sentiment Classification Engine for Agent 6: ❤️ Guest Sentiment Guardian
// Deterministically classifies sentiment into POSITIVE, NEUTRAL, MIXED, NEGATIVE.
// Preserves the numeric rating (1-5) distinctly from text sentiment.

import { SentimentType } from "./types";

const POSITIVE_WORDS = [
  "great", "amazing", "love", "loved", "excellent", "best", "perfect", "good", "fast",
  "friendly", "tasty", "delicious", "fresh", "superb", "awesome", "fantastic", "smooth",
];

const NEGATIVE_WORDS = [
  "bad", "terrible", "horrible", "awful", "cold", "late", "slow", "delay", "delayed",
  "missing", "wrong", "forgot", "forget", "rude", "poor", "stale", "worst", "unacceptable",
  "dirty", "burnt", "bitter", "spilled", "waste", "disappointed", "disappointing",
];

export function classifySentiment(rating: number, comment: string = ""): SentimentType {
  const lower = comment.toLowerCase();

  const posCount = POSITIVE_WORDS.filter((w) => lower.includes(w)).length;
  const negCount = NEGATIVE_WORDS.filter((w) => lower.includes(w)).length;

  // 5 Stars
  if (rating >= 5) {
    return negCount > 0 ? "MIXED" : "POSITIVE";
  }

  // 4 Stars
  if (rating === 4) {
    if (negCount > 0 && posCount > 0) return "MIXED";
    if (negCount > posCount) return "MIXED";
    return "POSITIVE";
  }

  // 3 Stars (Recovery candidate)
  if (rating === 3) {
    if (posCount > 0 && negCount > 0) return "MIXED";
    if (posCount > 0 && negCount === 0) return "NEUTRAL";
    return "MIXED";
  }

  // 1 or 2 Stars (High / Critical priority)
  if (rating <= 2) {
    if (posCount > 0 && negCount > 0) return "MIXED";
    return "NEGATIVE";
  }

  return "NEUTRAL";
}
