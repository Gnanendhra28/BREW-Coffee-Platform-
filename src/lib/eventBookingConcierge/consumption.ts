// Deterministic Consumption & Ingredient Forecast Engine for Agent 4: 🎪 Event Booking Concierge
// Calculates raw ingredient manifests, safety buffers, and consumable allocations.

import { ConsumptionForecast, EventType, IngredientManifestItem } from "./types";

export const INGREDIENT_UNIT_COSTS: Record<string, { unit: string; cost: number }> = {
  coffee_beans: { unit: "kg", cost: 800 },        // ₹800/kg Single-Origin
  whole_milk: { unit: "L", cost: 65 },            // ₹65/L Farm Fresh Dairy
  oat_milk: { unit: "L", cost: 140 },            // ₹140/L Premium Plant Milk
  paper_cups: { unit: "pcs", cost: 4.5 },         // ₹4.5/cup (Double-wall insulated)
  pastries: { unit: "pcs", cost: 55 },            // ₹55/piece wholesale bakery cost
  flavored_syrups: { unit: "L", cost: 350 },     // ₹350/L Monin/Davinci
  sugar_packets: { unit: "kg", cost: 50 },        // ₹50/kg Demerara sugar
};

/**
 * Calculates raw consumable and beverage servings based on guest count, duration, and tier.
 */
export function calculateConsumption(params: {
  guestCount: number;
  durationMinutes?: number;
  tierId: "BASIC" | "STANDARD" | "PREMIUM";
  eventType?: EventType;
}): ConsumptionForecast {
  const { guestCount, durationMinutes = 240, tierId } = params;
  const durationHours = Math.max(1, durationMinutes / 60);

  // Beverage multiplier: 1.2 for short (<= 2h), 1.3 for standard (3-4h), 1.5 for long (5h+)
  const beverageFactor = durationHours <= 2 ? 1.2 : durationHours <= 4 ? 1.3 : 1.5;

  const totalBeverageServings = Math.round(guestCount * beverageFactor);
  const coffeeServings = totalBeverageServings;
  const teaServings = Math.round(totalBeverageServings * 0.2);

  // Raw beans: 18g per shot on total beverage allocation
  const coffeeBeansKg = Number((guestCount * beverageFactor * 0.018).toFixed(1));

  // Milk calculation (160ml average per drink)
  const totalMilkNeeded = Number((guestCount * beverageFactor * 0.16).toFixed(1));
  const oatMilkLiters = tierId === "BASIC" ? 0 : Number((totalMilkNeeded * 0.25).toFixed(1));
  const wholeMilkLiters = Number((totalMilkNeeded - oatMilkLiters).toFixed(1));

  // Cups with 40% safety buffer for spills/refills
  const cupsCount = Math.round(Number((guestCount * 1.4).toFixed(4)));

  // Pastry ratio
  const pastryRatio = tierId === "BASIC" ? 0 : tierId === "STANDARD" ? 0.7 : 1.1;
  const pastriesCount = Math.round(Number((guestCount * pastryRatio).toFixed(4)));

  const syrupsLiters = tierId === "BASIC" ? 0 : Number((coffeeServings * 0.012).toFixed(1));
  const sugarKg = Number((totalBeverageServings * 0.008).toFixed(2));
  const waterLiters = Number((totalBeverageServings * 0.25).toFixed(1));

  return {
    guestCount,
    durationHours,
    coffeeServings,
    teaServings,
    pastriesCount,
    coffeeBeansKg,
    milkLiters: wholeMilkLiters,
    oatMilkLiters,
    cupsCount,
    syrupsLiters,
    sugarKg,
    waterLiters,
  };
}

/**
 * Builds the complete priced ingredient manifest and flags procurement requirements against live storage.
 */
export function buildIngredientManifest(
  consumption: ConsumptionForecast,
  currentStock: {
    coffeeBeansKg?: number;
    wholeMilkLiters?: number;
    oatMilkLiters?: number;
    paperCups?: number;
    bakeryPastries?: number;
  } = {}
): { manifest: IngredientManifestItem[]; procurementRequired: boolean; totalIngredientCost: number } {
  const stock = {
    coffeeBeansKg: currentStock.coffeeBeansKg ?? 8.5,
    wholeMilkLiters: currentStock.wholeMilkLiters ?? 18.0,
    oatMilkLiters: currentStock.oatMilkLiters ?? 6.0,
    paperCups: currentStock.paperCups ?? 150,
    bakeryPastries: currentStock.bakeryPastries ?? 24,
  };

  const items: IngredientManifestItem[] = [];
  let procurementRequired = false;

  // 1. Coffee Beans
  const beansShortfall = Math.max(0, Number((consumption.coffeeBeansKg - stock.coffeeBeansKg).toFixed(1)));
  if (beansShortfall > 0) procurementRequired = true;
  items.push({
    ingredient: "Single-Origin Coffee Beans",
    quantity: consumption.coffeeBeansKg,
    unit: "kg",
    unitCost: INGREDIENT_UNIT_COSTS.coffee_beans.cost,
    totalCost: Math.round(consumption.coffeeBeansKg * INGREDIENT_UNIT_COSTS.coffee_beans.cost),
    inStockQuantity: stock.coffeeBeansKg,
    shortfallQuantity: beansShortfall,
    procurementRequired: beansShortfall > 0,
  });

  // 2. Whole Milk
  const milkShortfall = Math.max(0, Number((consumption.milkLiters - stock.wholeMilkLiters).toFixed(1)));
  if (milkShortfall > 0) procurementRequired = true;
  items.push({
    ingredient: "Farm Fresh Whole Milk",
    quantity: consumption.milkLiters,
    unit: "L",
    unitCost: INGREDIENT_UNIT_COSTS.whole_milk.cost,
    totalCost: Math.round(consumption.milkLiters * INGREDIENT_UNIT_COSTS.whole_milk.cost),
    inStockQuantity: stock.wholeMilkLiters,
    shortfallQuantity: milkShortfall,
    procurementRequired: milkShortfall > 0,
  });

  // 3. Oat Milk
  if (consumption.oatMilkLiters > 0) {
    const oatShortfall = Math.max(0, Number((consumption.oatMilkLiters - stock.oatMilkLiters).toFixed(1)));
    if (oatShortfall > 0) procurementRequired = true;
    items.push({
      ingredient: "Plant-Based Oat Milk",
      quantity: consumption.oatMilkLiters,
      unit: "L",
      unitCost: INGREDIENT_UNIT_COSTS.oat_milk.cost,
      totalCost: Math.round(consumption.oatMilkLiters * INGREDIENT_UNIT_COSTS.oat_milk.cost),
      inStockQuantity: stock.oatMilkLiters,
      shortfallQuantity: oatShortfall,
      procurementRequired: oatShortfall > 0,
    });
  }

  // 4. Paper Cups
  const cupsShortfall = Math.max(0, consumption.cupsCount - stock.paperCups);
  if (cupsShortfall > 0) procurementRequired = true;
  items.push({
    ingredient: "Artisanal Paper Cups & Sleeves",
    quantity: consumption.cupsCount,
    unit: "pcs",
    unitCost: INGREDIENT_UNIT_COSTS.paper_cups.cost,
    totalCost: Math.round(consumption.cupsCount * INGREDIENT_UNIT_COSTS.paper_cups.cost),
    inStockQuantity: stock.paperCups,
    shortfallQuantity: cupsShortfall,
    procurementRequired: cupsShortfall > 0,
  });

  // 5. Bakery Pastries
  if (consumption.pastriesCount > 0) {
    const pastryShortfall = Math.max(0, consumption.pastriesCount - stock.bakeryPastries);
    if (pastryShortfall > 0) procurementRequired = true;
    items.push({
      ingredient: "Fresh Baked Artisan Pastries",
      quantity: consumption.pastriesCount,
      unit: "pcs",
      unitCost: INGREDIENT_UNIT_COSTS.pastries.cost,
      totalCost: Math.round(consumption.pastriesCount * INGREDIENT_UNIT_COSTS.pastries.cost),
      inStockQuantity: stock.bakeryPastries,
      shortfallQuantity: pastryShortfall,
      procurementRequired: pastryShortfall > 0,
    });
  }

  const totalIngredientCost = items.reduce((acc, it) => acc + it.totalCost, 0);

  return {
    manifest: items,
    procurementRequired,
    totalIngredientCost,
  };
}
