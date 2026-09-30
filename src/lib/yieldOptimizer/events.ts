// Production Event Dispatcher and Reactive Lifecycle Router for Agent 3: ⚡ Yield Optimizer

import { YieldOptimizerEvent, YieldFlashDealRecord } from "./types";
import { runYieldOptimizerCycle, YieldOptimizerCycleResult } from "./optimizerAgent";
import {
  tool_publish_flash_deal,
  tool_get_all_deals,
  updatePastryStockInStore,
} from "./tools";

type YieldEventListener = (event: YieldOptimizerEvent) => void;
const EVENT_LISTENERS: Set<YieldEventListener> = new Set();

/**
 * Subscribes a listener to Yield Optimizer events. Returns an unsubscribe function.
 */
export function subscribeToYieldEvents(listener: YieldEventListener): () => void {
  EVENT_LISTENERS.add(listener);
  return () => {
    EVENT_LISTENERS.delete(listener);
  };
}

/**
 * Emits an event to all registered listeners.
 */
export function emitYieldEvent(event: YieldOptimizerEvent): void {
  for (const listener of EVENT_LISTENERS) {
    try {
      listener(event);
    } catch (err) {
      console.error("[YieldOptimizer] Error in event listener:", err);
    }
  }
}

/**
 * Main reactive handler for incoming system events.
 */
export function handleYieldOptimizerEvent(
  event: YieldOptimizerEvent
): {
  handled: boolean;
  actionTaken: string;
  result?: YieldOptimizerCycleResult | { deal?: YieldFlashDealRecord; error?: string };
} {
  emitYieldEvent(event);

  switch (event.type) {
    case "INVENTORY_UPDATED": {
      // Re-evaluate pastry inventory if pastry updates are detected
      const payload = event.payload;
      if (payload && typeof payload.productId === "string" && typeof payload.currentStock === "number") {
        updatePastryStockInStore(payload.productId, {
          currentStock: payload.currentStock,
        });
      }
      const cycleResult = runYieldOptimizerCycle({
        storeId: event.storeId,
        triggerEvent: "INVENTORY_UPDATED",
      });
      return {
        handled: true,
        actionTaken: "RE_EVALUATED_INVENTORY",
        result: cycleResult,
      };
    }

    case "ORDER_COMPLETED": {
      // Order completed: re-evaluate if it was a pastry or just check velocity
      const cycleResult = runYieldOptimizerCycle({
        storeId: event.storeId,
        triggerEvent: "ORDER_COMPLETED",
      });
      return {
        handled: true,
        actionTaken: "ORDER_RE_EVALUATION",
        result: cycleResult,
      };
    }

    case "PASTRY_SURPLUS_DETECTED":
    case "WASTE_RISK_HIGH": {
      const cycleResult = runYieldOptimizerCycle({
        storeId: event.storeId,
        triggerEvent: event.type,
      });
      return {
        handled: true,
        actionTaken: "SURPLUS_MITIGATION_CYCLE",
        result: cycleResult,
      };
    }

    case "FLASH_DEAL_PUBLISHED": {
      const dealId = event.payload?.dealId as string;
      if (!dealId) {
        return { handled: false, actionTaken: "MISSING_DEAL_ID" };
      }
      const pubResult = tool_publish_flash_deal(dealId);
      return {
        handled: true,
        actionTaken: pubResult.success ? "DEAL_PUBLISHED" : "PUBLISH_FAILED",
        result: pubResult,
      };
    }

    case "FLASH_DEAL_EXPIRED": {
      const dealId = event.payload?.dealId as string;
      if (dealId) {
        const deals = tool_get_all_deals();
        const deal = deals.find((d) => d.id === dealId);
        if (deal && deal.status === "ACTIVE") {
          deal.status = "EXPIRED";
        }
      }
      return {
        handled: true,
        actionTaken: "DEAL_MARKED_EXPIRED",
      };
    }

    case "STORE_CLOSING_SOON": {
      const cycleResult = runYieldOptimizerCycle({
        storeId: event.storeId,
        triggerEvent: "STORE_CLOSING_SOON",
      });
      return {
        handled: true,
        actionTaken: "CLOSING_SWEEP_CYCLE",
        result: cycleResult,
      };
    }

    default:
      return {
        handled: false,
        actionTaken: "IGNORED_UNKNOWN_EVENT",
      };
  }
}
