import { MENU_ITEMS, MenuItem } from "../data/menuData";

export interface ChatMessage {
  id: string;
  sender: "user" | "barista";
  text: string;
  timestamp: number;
  recommendations?: {
    item: MenuItem;
    reason: string;
  }[];
  quickReplies?: string[];
}

interface TasteProfileQuery {
  categories: ("coffee" | "tea" | "shakes" | "desserts")[];
  temperature?: "cold" | "hot";
  sweetnessPreference?: "very_sweet" | "mild_sweet" | "unsweetened" | "any";
  flavorKeywords: string[];
  intent: "general" | "strong" | "refreshing" | "comforting" | "pairing" | "dessert" | "healthy";
  mentionedItems: string[];
}

// Semantic synonyms and mapping for taste analysis
const FLAVOR_MAP: Record<string, string[]> = {
  chocolate: ["chocolate", "choco", "cocoa", "fudge", "brownie", "mocha", "valrhona", "ganache"],
  sweet: ["sweet", "sugary", "caramel", "honey", "syrup", "glazed", "dessert", "sweet tooth", "molten"],
  bitter_strong: ["strong", "bold", "bitter", "dark", "intense", "espresso", "black", "double shot", "punch"],
  fruity: ["fruit", "fruity", "peach", "berry", "strawberry", "mango", "banana", "passionfruit", "citrus", "lemon"],
  nutty: ["nutty", "hazelnut", "walnut", "almond", "peanut", "peanut butter", "toasted"],
  spicy_warm: ["spicy", "cinnamon", "ginger", "cardamom", "clove", "anise", "saffron", "pepper", "warming"],
  creamy_milky: ["creamy", "milky", "milk", "velvety", "latte", "froth", "foam", "custard", "gelato", "ice cream", "shake"],
  refreshing: ["refreshing", "crisp", "clean", "mint", "cooling", "thirst", "light", "summer"],
  healthy_calm: ["healthy", "organic", "green tea", "detox", "calm", "soothing", "caffeine-free", "herbal", "throat", "digestive"],
};

export function parseTasteQuery(userText: string): TasteProfileQuery {
  const lower = userText.toLowerCase();

  // 1. Temperature detection
  let temperature: "cold" | "hot" | undefined = undefined;
  if (
    lower.includes("cold") ||
    lower.includes("iced") ||
    lower.includes("chill") ||
    lower.includes("shake") ||
    lower.includes("ice") ||
    lower.includes("cool")
  ) {
    temperature = "cold";
  } else if (
    lower.includes("hot") ||
    lower.includes("warm") ||
    lower.includes("steaming") ||
    lower.includes("winter") ||
    lower.includes("throat")
  ) {
    temperature = "hot";
  }

  // 2. Sweetness preference
  let sweetnessPreference: "very_sweet" | "mild_sweet" | "unsweetened" | "any" = "any";
  if (lower.includes("no sugar") || lower.includes("unsweetened") || lower.includes("black") || lower.includes("without sugar") || lower.includes("zero sugar")) {
    sweetnessPreference = "unsweetened";
  } else if (lower.includes("less sweet") || lower.includes("mild sweet") || lower.includes("not too sweet") || lower.includes("low sweet")) {
    sweetnessPreference = "mild_sweet";
  } else if (lower.includes("very sweet") || lower.includes("sweet tooth") || lower.includes("lots of sugar") || lower.includes("sweetest")) {
    sweetnessPreference = "very_sweet";
  }

  // 3. Category detection
  const categories: ("coffee" | "tea" | "shakes" | "desserts")[] = [];
  if (lower.includes("coffee") || lower.includes("espresso") || lower.includes("latte") || lower.includes("cappuccino") || lower.includes("brew") || lower.includes("caffeine")) {
    categories.push("coffee");
  }
  if (lower.includes("tea") || lower.includes("chai") || lower.includes("herbal") || lower.includes("green tea") || lower.includes("earl grey")) {
    categories.push("tea");
  }
  if (lower.includes("shake") || lower.includes("smoothie") || lower.includes("milkshake") || lower.includes("thick")) {
    categories.push("shakes");
  }
  if (
    lower.includes("dessert") ||
    lower.includes("food") ||
    lower.includes("eat") ||
    lower.includes("cake") ||
    lower.includes("pastry") ||
    lower.includes("cookie") ||
    lower.includes("snack") ||
    lower.includes("bakery") ||
    lower.includes("bread") ||
    lower.includes("brownie") ||
    lower.includes("donut") ||
    lower.includes("lava")
  ) {
    categories.push("desserts");
  }

  // 4. Flavor keywords extraction
  const flavorKeywords: string[] = [];
  for (const [flavorKey, words] of Object.entries(FLAVOR_MAP)) {
    if (words.some((w) => lower.includes(w))) {
      flavorKeywords.push(flavorKey);
    }
  }

  // 5. Intent detection
  let intent: TasteProfileQuery["intent"] = "general";
  if (lower.includes("strong") || lower.includes("punch") || lower.includes("bold") || lower.includes("wake up") || lower.includes("kick")) {
    intent = "strong";
  } else if (lower.includes("refresh") || lower.includes("hydrat") || lower.includes("thirst")) {
    intent = "refreshing";
  } else if (lower.includes("comfort") || lower.includes("relax") || lower.includes("sooth") || lower.includes("cozy") || lower.includes("cold weather")) {
    intent = "comforting";
  } else if (lower.includes("pair") || lower.includes("with my") || lower.includes("along with") || lower.includes("combination")) {
    intent = "pairing";
  } else if (lower.includes("healthy") || lower.includes("calorie") || lower.includes("diet") || lower.includes("light")) {
    intent = "healthy";
  }

  // 6. Mentioned previous items
  const mentionedItems: string[] = [];
  for (const item of MENU_ITEMS) {
    if (lower.includes(item.name.toLowerCase())) {
      mentionedItems.push(item.id);
    }
  }

  return {
    categories,
    temperature,
    sweetnessPreference,
    flavorKeywords,
    intent,
    mentionedItems,
  };
}

export function scoreMenuItem(item: MenuItem, query: TasteProfileQuery, userPrompt: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const itemText = `${item.name} ${item.description} ${(item.notes || []).join(" ")} ${item.category} ${item.categoryLabel}`.toLowerCase();
  const lowerPrompt = userPrompt.toLowerCase();

  // Category matching
  if (query.categories.length > 0) {
    if (query.categories.includes(item.category)) {
      score += 35;
    } else {
      score -= 20;
    }
  }

  // Temperature matching
  const isColdItem =
    item.name.toLowerCase().includes("iced") ||
    item.name.toLowerCase().includes("cold brew") ||
    item.category === "shakes" ||
    item.name.toLowerCase().includes("affogato");

  if (query.temperature === "cold") {
    if (isColdItem) {
      score += 25;
      reasons.push("chilled & refreshing");
    } else if (item.category === "coffee" || item.category === "tea") {
      score -= 30; // Not cold
    }
  } else if (query.temperature === "hot") {
    if (!isColdItem && (item.category === "coffee" || item.category === "tea")) {
      score += 25;
      reasons.push("hot & steaming");
    } else if (isColdItem) {
      score -= 30;
    }
  }

  // Sweetness preference
  const isSweetItem =
    item.category === "desserts" ||
    item.category === "shakes" ||
    item.name.toLowerCase().includes("mocha") ||
    item.name.toLowerCase().includes("affogato");

  if (query.sweetnessPreference === "unsweetened") {
    if (item.name === "Americano" || item.name === "Espresso" || item.name === "Classic Black Tea" || item.name === "Organic Green Tea" || item.name === "Iced Americano") {
      score += 40;
      reasons.push("zero added sugar");
    } else if (isSweetItem) {
      score -= 50;
    }
  } else if (query.sweetnessPreference === "very_sweet") {
    if (isSweetItem) {
      score += 30;
      reasons.push("rich, sweet indulgence");
    }
  } else if (query.sweetnessPreference === "mild_sweet") {
    if (item.name === "Flat White" || item.name === "Cappuccino" || item.name === "Artisanal Iced Tea" || item.name === "Banana Bread Slice") {
      score += 30;
      reasons.push("naturally balanced sweetness");
    }
  }

  // Flavor keyword overlaps
  for (const f of query.flavorKeywords) {
    const synonyms = FLAVOR_MAP[f] || [];
    let matched = false;
    for (const syn of synonyms) {
      if (itemText.includes(syn)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      score += 20;
      reasons.push(`${f} notes`);
    }
  }

  // Direct word match from prompt
  const words = lowerPrompt.split(/\s+/).filter((w) => w.length > 3);
  for (const w of words) {
    if (itemText.includes(w)) {
      score += 8;
    }
  }

  // Intent bonus
  if (query.intent === "strong") {
    if (item.name === "Espresso" || item.name === "Flat White" || item.name === "Americano" || item.name === "Cold Brew") {
      score += 30;
      reasons.push("delivers a bold caffeine kick");
    }
  } else if (query.intent === "comforting") {
    if (item.name === "Ginger Tea" || item.name === "Cinnamon Spiced Tea" || item.name === "Royal Signature Tea" || item.name === "Cappuccino") {
      score += 30;
      reasons.push("soothing and deeply comforting");
    }
  } else if (query.intent === "healthy") {
    if (item.name === "Organic Green Tea" || item.name === "Fresh Mint Tea" || item.name === "Americano") {
      score += 35;
      reasons.push("clean, 0 kcal organic profile");
    }
  } else if (query.intent === "refreshing") {
    if (item.name === "Artisanal Iced Tea" || item.name === "Cold Brew" || item.name === "Iced Americano" || item.name === "Mango Milkshake") {
      score += 30;
      reasons.push("ultra-crisp and thirst-quenching");
    }
  }

  // Special ratings / signature bonus
  if (item.badge === "Signature" || item.badge === "Popular") {
    score += 5;
  }
  if (item.rating >= 4.9) {
    score += 3;
  }

  return { score, reasons };
}

export function generateBaristaResponse(
  userPrompt: string,
  history: { sender: "user" | "barista"; text: string }[] = []
): {
  replyText: string;
  recommendations: { item: MenuItem; reason: string }[];
  quickReplies: string[];
} {
  // Combine recent user context for conversational continuity
  const recentUserContext = history
    .filter((h) => h.sender === "user")
    .map((h) => h.text)
    .join(" ");
  const combinedPrompt = recentUserContext ? `${recentUserContext} ${userPrompt}` : userPrompt;
  const query = parseTasteQuery(combinedPrompt);

  // Score all items
  const scored = MENU_ITEMS.map((item) => {
    const { score, reasons } = scoreMenuItem(item, query, userPrompt);
    return { item, score, reasons };
  });

  // Sort descending
  scored.sort((a, b) => b.score - a.score);

  const topItems = scored.slice(0, 2).filter((s) => s.score > 10);

  // If nothing strongly matched, fallback to crowd favorites
  const recommendedItems = topItems.length > 0 ? topItems : [
    {
      item: MENU_ITEMS.find((m) => m.name === "Affogato") || MENU_ITEMS[0],
      score: 50,
      reasons: ["our supreme signature blend", "creamy vanilla and bold espresso"],
    },
    {
      item: MENU_ITEMS.find((m) => m.name === "Cold Brew") || MENU_ITEMS[1],
      score: 45,
      reasons: ["slow-steeped 18 hours for natural sweetness"],
    },
  ];

  const primary = recommendedItems[0];
  const secondary = recommendedItems[1];

  // Craft artisanal barista dialogue
  let replyText = "";
  const item1Name = primary.item.name;

  if (query.sweetnessPreference === "unsweetened") {
    replyText = `For pure, unadulterated coffee flavor with zero added sugar, I highly recommend our **${item1Name}**. It brings out pure origin notes with crisp clarity!`;
  } else if (query.flavorKeywords.includes("chocolate")) {
    replyText = `If you're craving rich chocolate, you'll fall in love with our **${item1Name}**! Handcrafted with artisanal cocoa and velvety textures for a decadent treat.`;
  } else if (query.temperature === "cold") {
    replyText = `Looking for something cold and revitalizing? The **${item1Name}** is our baristas' top pick—wonderfully chilled with vibrant flavor!`;
  } else if (query.intent === "comforting" || query.intent === "healthy") {
    replyText = `For a soothing, restorative experience, I've selected the **${item1Name}**. Hand-steeped to warm you up from the inside out.`;
  } else if (query.categories.includes("desserts")) {
    replyText = `To satisfy your sweet tooth, you can't beat our freshly baked **${item1Name}**. It has the perfect molten texture!`;
  } else {
    replyText = `Based on what you enjoy, our barista craft pick for you is the **${item1Name}**! It balances incredible depth with smooth artisanal notes.`;
  }

  if (secondary && secondary.item.id !== primary.item.id) {
    replyText += ` If you want an alternative or a sweet companion, also check out the **${secondary.item.name}**.`;
  }

  // Format recommendations
  const recommendations = recommendedItems.map((s) => ({
    item: s.item,
    reason: s.reasons.length > 0
      ? `Matches your taste: ${s.reasons.slice(0, 2).join(" & ")}`
      : `Handcrafted favorite from our ${s.item.categoryLabel} collection`,
  }));

  // Smart quick-replies based on current recommendations
  const quickReplies: string[] = [];
  if (primary.item.category === "coffee") {
    quickReplies.push("Suggest a dessert to pair with this");
    quickReplies.push("Something iced instead");
  } else if (primary.item.category === "desserts") {
    quickReplies.push("What coffee goes best with this?");
    quickReplies.push("Show me a fruit milkshake");
  } else {
    quickReplies.push("Show me a hot coffee");
    quickReplies.push("Something less sweet");
  }
  quickReplies.push("Explore Full Menu");

  return {
    replyText,
    recommendations,
    quickReplies,
  };
}
