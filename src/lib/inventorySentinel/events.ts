// Event-Driven Integration System for Inventory Sentinel Agent
import { InventorySentinelEvent } from "./types";
import { runInventorySentinelCycle } from "./sentinelAgent";
import { applyRecipeDeduction } from "./recipes";
import { updateServerStockCache, getServerStockCache } from "./tools";
import { InventoryStock } from "./types";

// Listeners registry for decoupled event handlers
type EventListener = (event: InventorySentinelEvent) => void;
const EVENT_LISTENERS: Set<EventListener> = new Set();

export function subscribeToInventoryEvents(listener: EventListener): () => void {
  EVENT_LISTENERS.add(listener);
  return () => EVENT_LISTENERS.delete(listener);
}

/**
 * Handles incoming operational events and triggers Inventory Sentinel evaluations.
 */
export function handleInventorySentinelEvent(event: InventorySentinelEvent) {
  // Notify external listeners
  for (const listener of EVENT_LISTENERS) {
    try {
      listener(event);
    } catch (err) {
      console.error("[InventorySentinel Event Listener Error]", err);
    }
  }

  switch (event.type) {
    case "ORDER_COMPLETED": {
      const items = (event.payload.items as { name: string; quantity: number }[]) || [];
      if (items.length > 0) {
        const current = getServerStockCache();
        const updated = applyRecipeDeduction(current, items);
        updateServerStockCache(updated);

        // Run sentinel cycle if significant consumption occurred
        return runInventorySentinelCycle(event.storeId, "ORDER_COMPLETED", updated);
      }
      break;
    }

    case "INVENTORY_UPDATED": {
      const stock = (event.payload.stock as Partial<InventoryStock>) || {};
      updateServerStockCache(stock);
      return runInventorySentinelCycle(event.storeId, "INVENTORY_UPDATED");
    }

    case "INVENTORY_LOW": {
      return runInventorySentinelCycle(event.storeId, "INVENTORY_LOW");
    }

    case "PURCHASE_ORDER_CREATED": {
      // Record incoming inbound quantity
      const ingredientId = event.payload.ingredientId as keyof InventoryStock;
      const quantity = (event.payload.quantity as number) || 0;
      return runInventorySentinelCycle(event.storeId, "PURCHASE_ORDER_CREATED", undefined, {
        [ingredientId]: quantity,
      });
    }

    case "PURCHASE_ORDER_RECEIVED": {
      // Inbound stock delivered to van storage vault
      const ingredientId = event.payload.ingredientId as keyof InventoryStock;
      const quantity = (event.payload.quantity as number) || 0;
      const current = getServerStockCache();
      const currentVal = typeof current[ingredientId] === "number" ? (current[ingredientId] as number) : 0;

      const nextStock = {
        ...current,
        [ingredientId]: Number((currentVal + quantity).toFixed(2)),
      };
      updateServerStockCache(nextStock);

      return runInventorySentinelCycle(event.storeId, "PURCHASE_ORDER_RECEIVED", nextStock);
    }

    case "SUPPLIER_DELAYED": {
      // Re-evaluate stockouts with extended safety window
      return runInventorySentinelCycle(event.storeId, "SUPPLIER_DELAYED");
    }

    default:
      return runInventorySentinelCycle(event.storeId, "GENERIC_EVENT");
  }
}
