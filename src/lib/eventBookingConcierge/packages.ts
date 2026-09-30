// Configurable Package Definitions for Agent 4: 🎪 Event Booking Concierge
// Defines standard 3-tier catering architecture with strict operational SLAs.

export interface PackageDefinition {
  tierId: "BASIC" | "STANDARD" | "PREMIUM";
  name: string;
  tagline: string;
  basePricePerGuest: number;
  minimumGuests: number;
  maximumGuests: number;
  isRecommended: boolean;
  perks: string[];
  includedProducts: string[];
  staffingRatio: number; // e.g. 1 barista per N guests
  equipmentSummary: string;
}

export const CATERING_PACKAGES: Record<"BASIC" | "STANDARD" | "PREMIUM", PackageDefinition> = {
  BASIC: {
    tierId: "BASIC",
    name: "Classic Brew",
    tagline: "Essential handcrafted coffee & tea service for business meetings and quick popups",
    basePricePerGuest: 180,
    minimumGuests: 10,
    maximumGuests: 500,
    isRecommended: false,
    perks: [
      "Single-Origin Espresso, Americano, Classic Filter Coffee",
      "Imperial Black & Herbal Green Teas",
      "1 Dedicated Certified Barista",
      "Compostable paper cups, sleeves & stirrers",
    ],
    includedProducts: [
      "Espresso",
      "Americano",
      "Classic Filter Coffee",
      "Imperial Black Tea",
      "Herbal Green Tea",
    ],
    staffingRatio: 120, // 1 staff per 120 guests
    equipmentSummary: "1x Commercial 2-Group Espresso Station + 2x Thermal Dispensers",
  },
  STANDARD: {
    tierId: "STANDARD",
    name: "Artisanal Signature",
    tagline: "Our most popular package: Full espresso bar, farm dairy + vegan oat milk, and freshly baked pastries",
    basePricePerGuest: 260,
    minimumGuests: 20,
    maximumGuests: 800,
    isRecommended: true,
    perks: [
      "Full Coffee Menu: Flat Whites, Cappuccinos, Cold Brew, Mochas",
      "Whole Milk & Vegan Oat Milk bar",
      "Fresh Cinnamon Roll & Brownie Bites pairing",
      "2 Dedicated Baristas for rapid 45s service speed",
      "Digital Order Board display with custom host branding",
    ],
    includedProducts: [
      "Single-Origin Espresso",
      "Cappuccino",
      "Latte",
      "Flat White",
      "Cold Brew",
      "Cafe Mocha",
      "Farm Fresh Whole Milk",
      "Plant-Based Oat Milk",
      "Cinnamon Roll Bites",
      "Walnut Brownie Bites",
    ],
    staffingRatio: 75, // 2 staff for ~150 guests
    equipmentSummary: "2x Commercial Espresso Stations + Milk Microfoam Steamer + Display Case",
  },
  PREMIUM: {
    tierId: "PREMIUM",
    name: "VIP Unlimited Bar",
    tagline: "The ultimate curbside experience: Unlimited specialty brews, chilled shakes, artisan bakery & express handover",
    basePricePerGuest: 360,
    minimumGuests: 30,
    maximumGuests: 1000,
    isRecommended: false,
    perks: [
      "Unlimited Specialty Coffees, Belgian Shakes & Mango Coolers",
      "Full Artisan Bakery spread (Tiramisu cups, Choco Lava, Cookies)",
      "Dedicated 3-Barista Crew + Curbside Express Handover",
      "Personalized cup branding stickers with your company logo",
      "Live Barista Latte Art Demonstrations",
    ],
    includedProducts: [
      "All Specialty Coffees (Single-Origin, Pour Over, Affogato)",
      "Belgian Chocolate Shake",
      "Alphonso Mango Cooler",
      "Full Bakery Spread (Tiramisu, Lava Cake, Almond Croissants, Cookies)",
      "Whole, Oat, and Almond Milks",
      "Sugar-Free Flavored Syrups (Vanilla, Hazelnut, Caramel)",
    ],
    staffingRatio: 50, // 3 staff for ~150 guests
    equipmentSummary: "Complete Van Dual-Machine Silent Inverter Setup + Blender Bar + Pastry Warmer",
  },
};
