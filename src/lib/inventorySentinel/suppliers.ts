// Supplier Directory and Evaluation Engine for Inventory Sentinel
import { SupplierProfile } from "./types";

export const MASTER_SUPPLIERS: Record<string, SupplierProfile> = {
  "sup-roastery-direct": {
    id: "sup-roastery-direct",
    name: "Araku Origin Roastery Direct",
    contactEmail: "orders@arakuroastery.in",
    contactPhone: "+91 40 2340 8891",
    leadTimeHours: 3.0,
    minOrderQuantity: 1, // 1 pack
    packSize: 2.5, // 2.5 kg bag
    packageUnit: "2.5kg Valve Bag",
    costPerPack: 2200, // ₹2,200 per 2.5kg
    reliabilityScore: 0.98,
    available: true,
  },
  "sup-dairy-crest": {
    id: "sup-dairy-crest",
    name: "Heritage Farm Dairy Co.",
    contactEmail: "dispatch@heritagefarm.in",
    contactPhone: "+91 40 2341 9902",
    leadTimeHours: 1.5,
    minOrderQuantity: 1, // 1 crate
    packSize: 10.0, // 10 Liters crate
    packageUnit: "10L Cold Crate (10x 1L)",
    costPerPack: 680, // ₹680 per 10L
    reliabilityScore: 0.96,
    available: true,
  },
  "sup-eco-pack": {
    id: "sup-eco-pack",
    name: "GreenEarth Packaging Labs",
    contactEmail: "supply@greenearthpack.com",
    contactPhone: "+91 40 2345 1100",
    leadTimeHours: 2.0,
    minOrderQuantity: 1, // 1 sleeve
    packSize: 100, // 100 cups sleeve
    packageUnit: "100-Pack Embossed Sleeve",
    costPerPack: 450, // ₹450 per 100 cups
    reliabilityScore: 0.99,
    available: true,
  },
  "sup-artisan-bakes": {
    id: "sup-artisan-bakes",
    name: "Crumb & Co. Artisan Bakehouse",
    contactEmail: "morningrush@crumbbakes.in",
    contactPhone: "+91 40 2344 7733",
    leadTimeHours: 2.0,
    minOrderQuantity: 1, // 1 tray
    packSize: 12, // 12 pieces
    packageUnit: "12-Pc Fresh Oven Tray",
    costPerPack: 720, // ₹720 per tray (₹60/pc wholesale)
    reliabilityScore: 0.94,
    available: true,
  },
  "sup-sweet-craft": {
    id: "sup-sweet-craft",
    name: "Monin & SweetCraft Naturals",
    contactEmail: "support@sweetcraft.in",
    contactPhone: "+91 40 2349 5544",
    leadTimeHours: 4.0,
    minOrderQuantity: 1,
    packSize: 4.0, // 4 Liters
    packageUnit: "4x 1L Pure Cane Bottles",
    costPerPack: 1600,
    reliabilityScore: 0.97,
    available: true,
  },
  "sup-gelato-italia": {
    id: "sup-gelato-italia",
    name: "Gelato Bella Handcrafted Creamery",
    contactEmail: "dispatch@gelatobella.in",
    contactPhone: "+91 40 2342 3311",
    leadTimeHours: 2.5,
    minOrderQuantity: 1,
    packSize: 4.0, // 4 tubs
    packageUnit: "4-Tub Insulated Box",
    costPerPack: 1400,
    reliabilityScore: 0.95,
    available: true,
  },
};

export function getSupplier(supplierId: string): SupplierProfile | null {
  return MASTER_SUPPLIERS[supplierId] || null;
}

export function getAllSuppliers(): SupplierProfile[] {
  return Object.values(MASTER_SUPPLIERS);
}

export function findBestSupplierForIngredient(ingredientCategory: string): SupplierProfile {
  switch (ingredientCategory) {
    case "coffee":
      return MASTER_SUPPLIERS["sup-roastery-direct"];
    case "dairy":
      return MASTER_SUPPLIERS["sup-dairy-crest"];
    case "packaging":
      return MASTER_SUPPLIERS["sup-eco-pack"];
    case "bakery":
      return MASTER_SUPPLIERS["sup-artisan-bakes"];
    case "syrups":
      return MASTER_SUPPLIERS["sup-sweet-craft"];
    case "dessert":
      return MASTER_SUPPLIERS["sup-gelato-italia"];
    default:
      return MASTER_SUPPLIERS["sup-roastery-direct"];
  }
}
