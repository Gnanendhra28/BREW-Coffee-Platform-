// Reactive Event Bus & Pipeline Router for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Listens to weather shifts, inventory surpluses, yield optimizer deals, and approval requests.

import {
  WeatherSnapshot,
  StoreMarketingContext,
  HypeCampaignRecord,
} from "./types";
import { runHypeBroadcasterCycle } from "./hypeAgent";

export type HypeBroadcasterEventType =
  | "WEATHER_CHANGED"
  | "RAIN_FORECAST_DETECTED"
  | "HEATWAVE_DETECTED"
  | "YIELD_OPTIMIZER_PROMOTION_CREATED"
  | "AFTERNOON_SLUMP_TRIGGERED"
  | "CAMPAIGN_APPROVAL_REQUESTED"
  | "CUSTOMER_OPT_OUT_REQUESTED";

export interface HypeBroadcasterEvent {
  eventId: string;
  eventType: HypeBroadcasterEventType;
  storeId: string;
  timestamp: number;
  payload: any;
}

type HypeEventHandler = (event: HypeBroadcasterEvent) => Promise<void> | void;

const EVENT_LISTENERS = new Map<HypeBroadcasterEventType, Set<HypeEventHandler>>();

export function onHypeBroadcasterEvent(
  eventType: HypeBroadcasterEventType,
  handler: HypeEventHandler
): () => void {
  let set = EVENT_LISTENERS.get(eventType);
  if (!set) {
    set = new Set();
    EVENT_LISTENERS.set(eventType, set);
  }
  set.add(handler);

  return () => {
    set?.delete(handler);
  };
}

export function clearHypeEventListeners(): void {
  EVENT_LISTENERS.clear();
}

/**
 * Emits an event to all registered listeners.
 */
export async function emitHypeBroadcasterEvent(event: HypeBroadcasterEvent): Promise<void> {
  const set = EVENT_LISTENERS.get(event.eventType);
  if (!set || set.size === 0) return;

  const promises: Promise<void>[] = [];
  for (const handler of set) {
    try {
      const res = handler(event);
      if (res instanceof Promise) {
        promises.push(res);
      }
    } catch (err) {
      console.error(`Error in event handler for ${event.eventType}:`, err);
    }
  }

  await Promise.allSettled(promises);
}

// Auto-register reactive background handlers
onHypeBroadcasterEvent("WEATHER_CHANGED", async (event) => {
  await runHypeBroadcasterCycle({
    storeId: event.storeId,
    triggerSource: "EVENT:WEATHER_CHANGED",
    weatherSnapshot: event.payload?.weather,
  });
});

onHypeBroadcasterEvent("YIELD_OPTIMIZER_PROMOTION_CREATED", async (event) => {
  await runHypeBroadcasterCycle({
    storeId: event.storeId,
    triggerSource: "EVENT:YIELD_OPTIMIZER_PROMOTION_CREATED",
  });
});
