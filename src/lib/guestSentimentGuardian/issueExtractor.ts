// Structured Issue Extraction Engine for Agent 6: ❤️ Guest Sentiment Guardian
// Deterministically maps customer comments into structured IssueCategories.

import { IssueCategory } from "./types";

interface IssueRule {
  category: IssueCategory;
  keywords: string[];
}

const ISSUE_RULES: IssueRule[] = [
  {
    category: "WAIT_TIME",
    keywords: ["wait", "waiting", "slow", "late", "delay", "delayed", "forever", "queue", "line", "mins", "minutes"],
  },
  {
    category: "ORDER_DELAY",
    keywords: ["delay", "delayed", "late", "took forever", "overdue"],
  },
  {
    category: "MISSING_ITEM",
    keywords: ["missing", "forgot", "forgotten", "left out", "where is", "didn't receive", "did not get"],
  },
  {
    category: "WRONG_ITEM",
    keywords: ["wrong", "incorrect", "ordered", "instead", "mix up", "different"],
  },
  {
    category: "TEMPERATURE",
    keywords: ["cold", "lukewarm", "not hot", "tepid", "freezing", "burnt my mouth", "too hot"],
  },
  {
    category: "DRINK_QUALITY",
    keywords: ["coffee", "espresso", "cappuccino", "latte", "flat white", "americano", "sweet", "sugar", "syrup", "bitter", "sour", "watery", "foam", "taste"],
  },
  {
    category: "FOOD_QUALITY",
    keywords: ["pastry", "croissant", "brownie", "roll", "cinnamon", "stale", "hard", "dry", "soggy", "baked"],
  },
  {
    category: "STAFF_SERVICE",
    keywords: ["staff", "barista", "crew", "rude", "attitude", "ignored", "unfriendly", "behavior"],
  },
  {
    category: "PAYMENT",
    keywords: ["charged", "double charged", "payment", "upi", "card", "cash", "billing", "receipt"],
  },
  {
    category: "CURBSIDE",
    keywords: ["car", "curb", "curbside", "drive-thru", "parking", "bay", "vehicle", "window"],
  },
  {
    category: "CLEANLINESS",
    keywords: ["dirty", "mess", "messy", "clean", "hygiene", "trash", "dust"],
  },
  {
    category: "AVAILABILITY",
    keywords: ["sold out", "out of stock", "unavailable", "empty", "didn't have"],
  },
  {
    category: "PRICING",
    keywords: ["price", "cost", "expensive", "overpriced", "ripoff", "worth"],
  },
];

/**
 * Extracts all matching structured issue categories from customer feedback comment.
 */
export function extractIssuesFromComment(comment: string = "", rating?: number): IssueCategory[] {
  const lower = comment.toLowerCase();
  const matched = new Set<IssueCategory>();

  for (const rule of ISSUE_RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) {
      matched.add(rule.category);
    }
  }

  // If low rating but no specific issue keyword matched, flag as OTHER
  if (matched.size === 0 && rating !== undefined && rating <= 3) {
    matched.add("OTHER");
  }

  return Array.from(matched);
}
