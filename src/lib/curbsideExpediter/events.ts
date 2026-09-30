// Event-Driven Integration System for Curbside Drive-Thru Expediter Agent
import { CurbsideExpediterEvent } from "./types";
import { runCurbsideExpediterCycle } from "./expediterAgent";
import {
  tool_mark_vehicle_arrived,
  tool_mark_handoff_started,
  tool_mark_handoff_completed,
  updateOrderInCache,
  registerOrderInCache,
} from "./tools";
import { VanOrder } from "@/context/VanContext";

type CurbsideEventListener = (event: CurbsideExpediterEvent) => void;
const EVENT_LISTENERS: Set<CurbsideEventListener> = new Set();

export function subscribeToCurbsideEvents(listener: CurbsideEventListener): () => void {
  EVENT_LISTENERS.add(listener);
  return () => EVENT_LISTENERS.delete(listener);
}

/**
 * Handles incoming events and routes to the Curbside Expediter agent pipeline.
 */
export function handleCurbsideExpediterEvent(event: CurbsideExpediterEvent) {
  // Notify external subscribers
  for (const listener of EVENT_LISTENERS) {
    try {
      listener(event);
    } catch (err) {
      console.error("[CurbsideExpediter Event Listener Error]", err);
    }
  }

  switch (event.type) {
    case "ORDER_CREATED": {
      if (event.payload?.order) {
        registerOrderInCache(event.payload.order as VanOrder);
      }
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "ORDER_CREATED");
    }

    case "ORDER_CONFIRMED":
    case "ORDER_PREPARATION_STARTED": {
      updateOrderInCache(event.orderId, { status: "brewing" });
      return runCurbsideExpediterCycle(event.orderId, event.storeId, event.type);
    }

    case "VEHICLE_APPROACHING": {
      updateOrderInCache(event.orderId, { curbsideArrivalStatus: "approaching" });
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "VEHICLE_APPROACHING");
    }

    case "VEHICLE_ARRIVED": {
      tool_mark_vehicle_arrived(event.orderId, event.timestamp);
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "VEHICLE_ARRIVED");
    }

    case "ORDER_READY": {
      updateOrderInCache(event.orderId, { status: "ready" });
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "ORDER_READY");
    }

    case "HANDOFF_STARTED": {
      tool_mark_handoff_started(event.orderId, event.timestamp);
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "HANDOFF_STARTED");
    }

    case "HANDOFF_COMPLETED": {
      const res = tool_mark_handoff_completed(event.orderId, event.timestamp);
      runCurbsideExpediterCycle(event.orderId, event.storeId, "HANDOFF_COMPLETED");
      return res;
    }

    case "ORDER_CANCELLED": {
      updateOrderInCache(event.orderId, { status: "cancelled" });
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "ORDER_CANCELLED");
    }

    default:
      return runCurbsideExpediterCycle(event.orderId, event.storeId, "GENERIC_EVENT");
  }
}
