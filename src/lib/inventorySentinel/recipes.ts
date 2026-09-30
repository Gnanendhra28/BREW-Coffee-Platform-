// Deterministic Recipe Specifications and Ingredient Deduction Engine
import { InventoryStock } from "./types";

export interface ItemIngredientRequirement {
  coffeeBeansKg: number;
  wholeMilkLiters: number;
  oatMilkLiters: number;
  vanillaGelatoTubs: number;
  paperCups: number;
  bakeryPastries: number;
  syrupsLiters: number;
}

// Master standard recipes per unit item
export const RECIPE_REGISTRY: Record<string, Partial<ItemIngredientRequirement>> = {
  // --- ESPRESSO & COFFEE ---
  cappuccino: { coffeeBeansKg: 0.018, wholeMilkLiters: 0.18, paperCups: 1 },
  latte: { coffeeBeansKg: 0.018, wholeMilkLiters: 0.22, paperCups: 1 },
  "flat white": { coffeeBeansKg: 0.02, wholeMilkLiters: 0.16, paperCups: 1 },
  espresso: { coffeeBeansKg: 0.018, paperCups: 1 },
  "double espresso": { coffeeBeansKg: 0.022, paperCups: 1 },
  americano: { coffeeBeansKg: 0.018, paperCups: 1 },
  "cold brew": { coffeeBeansKg: 0.028, paperCups: 1 },
  mocha: { coffeeBeansKg: 0.018, wholeMilkLiters: 0.2, syrupsLiters: 0.025, paperCups: 1 },
  affogato: { coffeeBeansKg: 0.018, vanillaGelatoTubs: 0.1, paperCups: 1 },
  "caramel macchiato": { coffeeBeansKg: 0.018, wholeMilkLiters: 0.2, syrupsLiters: 0.025, paperCups: 1 },
  "classic filter coffee": { coffeeBeansKg: 0.016, wholeMilkLiters: 0.15, paperCups: 1 },

  // --- TEA ---
  "earl grey": { paperCups: 1 },
  "masala chai": { wholeMilkLiters: 0.15, paperCups: 1 },
  "green tea": { paperCups: 1 },
  "assam gold": { wholeMilkLiters: 0.12, paperCups: 1 },

  // --- SHAKES ---
  "belgian dark chocolate shake": { wholeMilkLiters: 0.24, syrupsLiters: 0.035, paperCups: 1 },
  "salted caramel shake": { wholeMilkLiters: 0.24, syrupsLiters: 0.035, paperCups: 1 },
  "strawberry cream shake": { wholeMilkLiters: 0.24, syrupsLiters: 0.03, paperCups: 1 },

  // --- BAKERY & DESSERTS ---
  "cinnamon roll": { bakeryPastries: 1 },
  "classic brownie": { bakeryPastries: 1 },
  "choco lava cake": { bakeryPastries: 1 },
  "blueberry crumble muffin": { bakeryPastries: 1 },
  "banana walnut bread": { bakeryPastries: 1 },
  "almond biscotti": { bakeryPastries: 1 },
  croissant: { bakeryPastries: 1 },
};

/**
 * Resolves recipe requirements for an item name with robust fuzzy substring match.
 */
export function getRecipeForItem(name: string): Partial<ItemIngredientRequirement> {
  const lower = name.toLowerCase().trim();

  // Direct lookup
  if (RECIPE_REGISTRY[lower]) {
    return RECIPE_REGISTRY[lower];
  }

  // Substring match
  for (const [key, recipe] of Object.entries(RECIPE_REGISTRY)) {
    if (lower.includes(key)) {
      return recipe;
    }
  }

  // General fallbacks based on category tokens
  if (lower.includes("coffee") || lower.includes("brew") || lower.includes("espresso")) {
    return { coffeeBeansKg: 0.018, paperCups: 1 };
  }
  if (lower.includes("shake")) {
    return { wholeMilkLiters: 0.22, syrupsLiters: 0.02, paperCups: 1 };
  }
  if (lower.includes("roll") || lower.includes("pastry") || lower.includes("cake") || lower.includes("cookie") || lower.includes("bread") || lower.includes("brownie") || lower.includes("muffin")) {
    return { bakeryPastries: 1 };
  }

  // Universal fallback: At least 1 paper cup is consumed for any beverage
  return { paperCups: 1 };
}

/**
 * Calculates deterministic total ingredient deductions for a batch of order items.
 */
export function calculateOrderIngredients(
  items: { name: string; quantity: number }[]
): ItemIngredientRequirement {
  const totals: ItemIngredientRequirement = {
    coffeeBeansKg: 0,
    wholeMilkLiters: 0,
    oatMilkLiters: 0,
    vanillaGelatoTubs: 0,
    paperCups: 0,
    bakeryPastries: 0,
    syrupsLiters: 0,
  };

  for (const item of items) {
    const qty = Math.max(1, item.quantity || 1);
    const recipe = getRecipeForItem(item.name);

    if (recipe.coffeeBeansKg) totals.coffeeBeansKg += recipe.coffeeBeansKg * qty;
    if (recipe.wholeMilkLiters) totals.wholeMilkLiters += recipe.wholeMilkLiters * qty;
    if (recipe.oatMilkLiters) totals.oatMilkLiters += recipe.oatMilkLiters * qty;
    if (recipe.vanillaGelatoTubs) totals.vanillaGelatoTubs += recipe.vanillaGelatoTubs * qty;
    if (recipe.paperCups) totals.paperCups += recipe.paperCups * qty;
    if (recipe.bakeryPastries) totals.bakeryPastries += recipe.bakeryPastries * qty;
    if (recipe.syrupsLiters) totals.syrupsLiters += recipe.syrupsLiters * qty;
  }

  // Format to standard decimal precision
  totals.coffeeBeansKg = Number(totals.coffeeBeansKg.toFixed(3));
  totals.wholeMilkLiters = Number(totals.wholeMilkLiters.toFixed(2));
  totals.oatMilkLiters = Number(totals.oatMilkLiters.toFixed(2));
  totals.vanillaGelatoTubs = Number(totals.vanillaGelatoTubs.toFixed(2));
  totals.paperCups = Math.ceil(totals.paperCups);
  totals.bakeryPastries = Math.ceil(totals.bakeryPastries);
  totals.syrupsLiters = Number(totals.syrupsLiters.toFixed(3));

  return totals;
}

/**
 * Applies recipe deductions to current inventory stock, clamping at 0.
 */
export function applyRecipeDeduction(
  current: InventoryStock,
  items: { name: string; quantity: number }[]
): InventoryStock {
  const deductions = calculateOrderIngredients(items);

  return {
    ...current,
    coffeeBeansKg: Math.max(0, Number((current.coffeeBeansKg - deductions.coffeeBeansKg).toFixed(3))),
    wholeMilkLiters: Math.max(0, Number((current.wholeMilkLiters - deductions.wholeMilkLiters).toFixed(2))),
    oatMilkLiters: Math.max(0, Number((current.oatMilkLiters - deductions.oatMilkLiters).toFixed(2))),
    vanillaGelatoTubs: Math.max(0, Number((current.vanillaGelatoTubs - deductions.vanillaGelatoTubs).toFixed(2))),
    paperCups: Math.max(0, current.paperCups - deductions.paperCups),
    bakeryPastries: Math.max(0, current.bakeryPastries - deductions.bakeryPastries),
    syrupsLiters: Math.max(0, Number((current.syrupsLiters - deductions.syrupsLiters).toFixed(3))),
  };
}
