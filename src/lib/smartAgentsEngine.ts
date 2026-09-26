export interface InventoryStock {
  coffeeBeansKg: number; // e.g. 8.5 kg
  wholeMilkLiters: number; // e.g. 18.0 L
  oatMilkLiters: number; // e.g. 8.0 L
  vanillaGelatoTubs: number; // e.g. 6.0 tubs
  paperCups: number; // e.g. 150 cups
  bakeryPastries: number; // e.g. 24 pieces
  syrupsLiters: number; // e.g. 4.0 L
  lastRestockedAt: number;
}

export interface DepletionAlert {
  ingredient: string;
  currentStock: string;
  burnRatePerHour: string;
  predictedDepletionTime: string;
  severity: "critical" | "warning" | "healthy";
  recommendation: string;
}

export interface FlashDealConfig {
  id: string;
  isActive: boolean;
  title: string;
  tagline: string;
  discountPercent: number;
  triggerReason: "weather" | "bakery_spoilage_prevention" | "manual";
  beverageName: string;
  pastryName: string;
  originalPrice: number;
  dealPrice: number;
  expiresAt: number; // timestamp
}

export interface EventQuotation {
  organization: string;
  location: string;
  estimatedCrowd: number;
  baristasAssigned: number;
  vanOperationalHours: string;
  powerRequirement: string;
  ingredientAllocation: {
    coffeeBeansKg: number;
    milkLiters: number;
    cupsCount: number;
    pastriesCount: number;
  };
  tiers: {
    name: "Classic Brew" | "Artisanal Signature" | "VIP Unlimited Bar";
    pricePerGuest: number;
    totalAmount: number;
    perks: string[];
    isRecommended?: boolean;
  }[];
  travelDistanceFee: number;
  terms: string;
}

export interface SocialBroadcastPost {
  platform: "WhatsApp Status" | "Instagram Story" | "Twitter / X" | "SMS Alert";
  headline: string;
  body: string;
  hashtags: string[];
  shareableUrl: string;
}

export interface ReviewRecoveryNotice {
  customerName: string;
  rating: number;
  sentiment: "negative" | "mixed";
  detectedIssues: string[];
  managerApologyText: string;
  voucherCode: string;
  discountAmount: number;
}

// -------------------------------------------------------------
// 1. INVENTORY SENTINEL ENGINE
// -------------------------------------------------------------

export const DEFAULT_INVENTORY_STOCK: InventoryStock = {
  coffeeBeansKg: 6.2,
  wholeMilkLiters: 12.5,
  oatMilkLiters: 4.0,
  vanillaGelatoTubs: 3.5,
  paperCups: 68,
  bakeryPastries: 14,
  syrupsLiters: 2.8,
  lastRestockedAt: Date.now(),
};

// Estimate ingredient consumption per ordered item
export function deductOrderIngredients(
  current: InventoryStock,
  items: { name: string; quantity: number }[]
): InventoryStock {
  const updated = { ...current };

  for (const item of items) {
    const qty = item.quantity || 1;
    const name = item.name.toLowerCase();

    // Paper cups
    updated.paperCups = Math.max(0, updated.paperCups - qty);

    // Coffee beans (avg 18g per espresso drink)
    if (
      name.includes("cappuccino") ||
      name.includes("espresso") ||
      name.includes("latte") ||
      name.includes("flat white") ||
      name.includes("americano") ||
      name.includes("cold brew") ||
      name.includes("affogato") ||
      name.includes("mocha")
    ) {
      updated.coffeeBeansKg = Math.max(0, Number((updated.coffeeBeansKg - 0.018 * qty).toFixed(2)));
    }

    // Milk (approx 0.18L per milk coffee / shake)
    if (name.includes("cappuccino") || name.includes("latte") || name.includes("flat white") || name.includes("mocha")) {
      updated.wholeMilkLiters = Math.max(0, Number((updated.wholeMilkLiters - 0.18 * qty).toFixed(2)));
    } else if (name.includes("shake")) {
      updated.wholeMilkLiters = Math.max(0, Number((updated.wholeMilkLiters - 0.22 * qty).toFixed(2)));
    }

    // Vanilla gelato
    if (name.includes("affogato")) {
      updated.vanillaGelatoTubs = Math.max(0, Number((updated.vanillaGelatoTubs - 0.1 * qty).toFixed(2)));
    }

    // Bakery pastries
    if (
      name.includes("cinnamon roll") ||
      name.includes("brownie") ||
      name.includes("lava") ||
      name.includes("bread") ||
      name.includes("cookie") ||
      name.includes("donut") ||
      name.includes("pastry") ||
      name.includes("cake")
    ) {
      updated.bakeryPastries = Math.max(0, updated.bakeryPastries - qty);
    }
  }

  return updated;
}

// Predict stockouts and generate alerts
export function analyzeStockDepletion(stock: InventoryStock): DepletionAlert[] {
  const alerts: DepletionAlert[] = [];

  // Paper cups threshold
  if (stock.paperCups <= 25) {
    alerts.push({
      ingredient: "Artisanal Paper Cups",
      currentStock: `${stock.paperCups} cups remaining`,
      burnRatePerHour: "~18 cups/hr",
      predictedDepletionTime: "Depleted in ~1.2 hrs",
      severity: stock.paperCups <= 15 ? "critical" : "warning",
      recommendation: "Immediate restock required from mobile storage bay or prompt guests for reusable cup discount.",
    });
  }

  // Whole milk threshold
  if (stock.wholeMilkLiters <= 5.0) {
    alerts.push({
      ingredient: "Farm Fresh Whole Milk",
      currentStock: `${stock.wholeMilkLiters} L remaining`,
      burnRatePerHour: "~3.2 L/hr",
      predictedDepletionTime: "Depleted in ~1.5 hrs",
      severity: stock.wholeMilkLiters <= 3.0 ? "critical" : "warning",
      recommendation: "Procure 4 additional cartons or suggest Oat Milk / Americano alternatives.",
    });
  }

  // Coffee beans threshold
  if (stock.coffeeBeansKg <= 2.0) {
    alerts.push({
      ingredient: "Single-Origin Coffee Beans",
      currentStock: `${stock.coffeeBeansKg} kg remaining`,
      burnRatePerHour: "~0.75 kg/hr",
      predictedDepletionTime: "Depleted in ~2.5 hrs",
      severity: stock.coffeeBeansKg <= 1.0 ? "critical" : "warning",
      recommendation: "Open backup 2.5kg roasted batch bag from rear van vault.",
    });
  }

  // Bakery pastries threshold
  if (stock.bakeryPastries <= 5) {
    alerts.push({
      ingredient: "Fresh Baked Goods",
      currentStock: `${stock.bakeryPastries} pieces remaining`,
      burnRatePerHour: "~4 pcs/hr",
      predictedDepletionTime: "Depleted in ~1 hr",
      severity: "warning",
      recommendation: "Toggle 86 on low-stock items or trigger final flash bundle.",
    });
  }

  return alerts;
}

// -------------------------------------------------------------
// 2. FLASH DEAL & YIELD OPTIMIZER ENGINE
// -------------------------------------------------------------

export const DEFAULT_FLASH_DEAL: FlashDealConfig = {
  id: "deal-afternoon-combo",
  isActive: true,
  title: "☕ Late Afternoon Artisan Pair",
  tagline: "Slow-roasted Single-Origin Cappuccino + Warm Cinnamon Roll",
  discountPercent: 25,
  triggerReason: "bakery_spoilage_prevention",
  beverageName: "Cappuccino",
  pastryName: "Cinnamon Roll",
  originalPrice: 400,
  dealPrice: 300,
  expiresAt: Date.now() + 1000 * 60 * 60 * 2, // 2 hrs from now
};

// -------------------------------------------------------------
// 3. CORPORATE EVENT CONCIERGE ENGINE
// -------------------------------------------------------------

export function generateEventQuotation(params: {
  organization: string;
  location: string;
  crowdSizeStr?: string;
  eventDate?: string;
}): EventQuotation {
  let crowd = 120;
  if (params.crowdSizeStr) {
    const num = parseInt(params.crowdSizeStr.replace(/\D/g, ""), 10);
    if (!isNaN(num) && num > 0) crowd = num;
  }

  const baristasAssigned = crowd > 250 ? 3 : crowd > 100 ? 2 : 1;
  const beansKg = Number(((crowd * 1.3 * 0.018)).toFixed(1));
  const milkLiters = Number(((crowd * 1.3 * 0.16)).toFixed(1));
  const cupsCount = Math.ceil(crowd * 1.4);
  const pastriesCount = Math.ceil(crowd * 0.7);

  return {
    organization: params.organization || "Corporate / Campus Host",
    location: params.location || "City Hub",
    estimatedCrowd: crowd,
    baristasAssigned,
    vanOperationalHours: "4 Hours Dedicated On-Site Window Service",
    powerRequirement: "16A Single Phase (or Van Internal Silent Inverter)",
    ingredientAllocation: {
      coffeeBeansKg: beansKg,
      milkLiters,
      cupsCount,
      pastriesCount,
    },
    travelDistanceFee: 1500,
    terms: "Includes complete curbside bar setup, outdoor QR board, live barista service, paper cups, sleeves & napkins.",
    tiers: [
      {
        name: "Classic Brew",
        pricePerGuest: 180,
        totalAmount: crowd * 180 + 1500,
        perks: [
          "Single-Origin Espresso, Americano, Classic Filter Coffee",
          "Imperial Black & Herbal Green Teas",
          "1 Dedicated Certified Barista",
        ],
      },
      {
        name: "Artisanal Signature",
        pricePerGuest: 260,
        totalAmount: crowd * 260 + 1500,
        isRecommended: true,
        perks: [
          "Full Coffee Menu: Flat Whites, Cappuccinos, Cold Brew, Mochas",
          "Whole Milk & Vegan Oat Milk bar",
          "Fresh Cinnamon Roll & Brownie Bites pairing",
          "2 Dedicated Baristas for rapid 45s service speed",
          "Digital Order Board display with custom host branding",
        ],
      },
      {
        name: "VIP Unlimited Bar",
        pricePerGuest: 360,
        totalAmount: crowd * 360 + 1500,
        perks: [
          "Unlimited Specialty Coffees, Belgian Shakes & Mango Coolers",
          "Full Artisan Bakery spread (Tiramisu cups, Choco Lava, Cookies)",
          "Dedicated 3-Barista Crew + Curbside Express Handover",
          "Personalized cup branding stickers for your company",
        ],
      },
    ],
  };
}

// -------------------------------------------------------------
// 4. HYPER-LOCAL HYPE BROADCASTER ENGINE
// -------------------------------------------------------------

export function generateSocialBroadcast(station: {
  spotName: string;
  city: string;
  landmark: string;
  weatherCondition?: string;
  tempC?: number;
}): SocialBroadcastPost[] {
  const weatherNote = station.weatherCondition ? `It's a ${station.weatherCondition} (${station.tempC}°C)` : "The coffee aroma is in the air";

  return [
    {
      platform: "WhatsApp Status",
      headline: `🚐 BREW Van Live at ${station.spotName}!`,
      body: `Hey ${station.city}! ☕ ${weatherNote}. The BREW Van has parked at *${station.spotName}* (${station.landmark}).\n\n✨ Serving slow-roasted Single-Origin Espresso, Chilled Cold Brew & warm baked treats curbside.\n\n📲 Order ahead & pick up in 60 secs: https://brew-coffee.cafe/location`,
      hashtags: ["#BREWMobileCoffee", `#${station.city.replace(/\s+/g, "")}Coffee`, "#CurbsidePickup"],
      shareableUrl: `https://wa.me/?text=${encodeURIComponent(
        `☕ The BREW Van is LIVE at ${station.spotName}! Stop by for fresh artisanal coffee & warm pastries: https://brew-coffee.cafe/location`
      )}`,
    },
    {
      platform: "Instagram Story",
      headline: `Van Sighted: ${station.spotName}`,
      body: `📍 *${station.spotName}* — ${station.landmark}\n☕ Double-shot espresso pulled fresh, velvety microfoam & freshly baked cinnamon rolls.\n⏰ Open until 10:30 PM. See you at the window! 🚚💨`,
      hashtags: ["#SpecialtyCoffee", "#CoffeeVan", "#OutletOnWheels"],
      shareableUrl: "https://www.instagram.com/",
    },
    {
      platform: "SMS Alert",
      headline: "BREW Flash Station Update",
      body: `BREW Alert: Mobile Van is now stationing at ${station.spotName}. Skip the cafe queue—order on brew-coffee.cafe for rapid car pickup!`,
      hashtags: ["#BREWVan"],
      shareableUrl: "",
    },
  ];
}

// -------------------------------------------------------------
// 5. GUEST SENTIMENT GUARDIAN ENGINE
// -------------------------------------------------------------

export function analyzeReviewSentiment(review: {
  name: string;
  rating: number;
  comment: string;
}): ReviewRecoveryNotice | null {
  if (review.rating > 3) return null;

  const lower = review.comment.toLowerCase();
  const issues: string[] = [];

  if (lower.includes("wait") || lower.includes("slow") || lower.includes("late") || lower.includes("time") || lower.includes("queue")) {
    issues.push("Order wait time during peak rush");
  }
  if (lower.includes("sweet") || lower.includes("sugar")) {
    issues.push("Sweetness calibration");
  }
  if (lower.includes("cold") || lower.includes("temperature") || lower.includes("hot")) {
    issues.push("Beverage temperature consistency");
  }
  if (lower.includes("car") || lower.includes("curb") || lower.includes("parking")) {
    issues.push("Curbside handover coordination");
  }
  if (issues.length === 0) {
    issues.push("General service experience");
  }

  const voucherCode = `BREWCARE${Math.floor(1000 + Math.random() * 9000)}`;

  return {
    customerName: review.name || "Valued Guest",
    rating: review.rating,
    sentiment: review.rating <= 2 ? "negative" : "mixed",
    detectedIssues: issues,
    managerApologyText: `Dear ${review.name || "Guest"},\n\nThank you for sharing candid feedback regarding your visit. We take pride in our craft, and we are truly sorry that your experience with our ${issues.join(" & ")} fell short of our gold standard.\n\nOur head barista has been notified to recalibrate this immediately. Please accept a ₹50 courtesy credit on us using code ${voucherCode} for your next brew. We would love the chance to pour you a cup done right!`,
    voucherCode,
    discountAmount: 50,
  };
}
