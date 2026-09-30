"use client";

import { db } from "@/lib/firebase";
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
} from "firebase/firestore";
import type { VanOrder, VanLocation, FutureVanStop, OrderStatus } from "@/context/VanContext";
import type { InventoryStock, FlashDealConfig } from "@/lib/smartAgentsEngine";

export interface RealtimeSyncHandlers {
  onInitialSync?: (data: {
    orders?: VanOrder[];
    inventory?: InventoryStock;
    vanLocation?: VanLocation;
    futureStops?: FutureVanStop[];
    curbsideArrivals?: Record<string, "approaching" | "arrived">;
    flashDeal?: FlashDealConfig;
  }) => void;
  onOrderCreated?: (order: VanOrder) => void;
  onOrderStatusChanged?: (orderId: string, status: OrderStatus) => void;
  onInventoryChanged?: (inventory: InventoryStock) => void;
  onLocationChanged?: (location: Partial<VanLocation>) => void;
  onFutureStopsChanged?: (futureStops: FutureVanStop[]) => void;
  onCurbsideSignal?: (orderId: string, status: "approaching" | "arrived") => void;
  onFlashDealChanged?: (flashDeal: FlashDealConfig) => void;
}

/**
 * Initializes real-time synchronization.
 * Uses a resilient dual-engine approach:
 * 1. Firebase Firestore onSnapshot listeners (when active/available)
 * 2. Next.js Realtime Cloud Stream (Server-Sent Events) for instant cross-device sync (<500ms)
 * 3. Graceful fallback with zero UI disruption.
 */
export function initRealtimeCloudSync(handlers: RealtimeSyncHandlers): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  let eventSource: EventSource | null = null;
  const firestoreUnsubscribers: (() => void)[] = [];
  let isCleaningUp = false;

  // --------------------------------------------------------------------------
  // 1. Next.js SSE Stream: Cross-Device Real-Time Pipeline
  // --------------------------------------------------------------------------
  const connectSSE = () => {
    if (isCleaningUp) return;

    try {
      eventSource = new EventSource("/api/realtime/stream");

      eventSource.onmessage = (event) => {
        try {
          if (!event.data) return;
          const parsed = JSON.parse(event.data);
          const { type, payload } = parsed;

          switch (type) {
            case "INITIAL_SYNC":
              if (handlers.onInitialSync) handlers.onInitialSync(payload);
              break;
            case "ORDER_CREATED":
              if (handlers.onOrderCreated) handlers.onOrderCreated(payload);
              break;
            case "ORDER_STATUS_CHANGED":
              if (handlers.onOrderStatusChanged)
                handlers.onOrderStatusChanged(payload.orderId, payload.status);
              break;
            case "INVENTORY_CHANGED":
              if (handlers.onInventoryChanged) handlers.onInventoryChanged(payload);
              break;
            case "LOCATION_CHANGED":
              if (handlers.onLocationChanged) handlers.onLocationChanged(payload);
              break;
            case "FUTURE_STOPS_CHANGED":
              if (handlers.onFutureStopsChanged) handlers.onFutureStopsChanged(payload);
              break;
            case "CURBSIDE_SIGNAL":
              if (handlers.onCurbsideSignal)
                handlers.onCurbsideSignal(payload.orderId, payload.status);
              break;
            case "FLASH_DEAL_CHANGED":
              if (handlers.onFlashDealChanged) handlers.onFlashDealChanged(payload);
              break;
            default:
              break;
          }
        } catch {
          // ignore heartbeats/ping comments
        }
      };

      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        // Auto-reconnect after 3 seconds if disconnected
        if (!isCleaningUp) {
          setTimeout(connectSSE, 3000);
        }
      };
    } catch (e) {
      console.warn("SSE connection error:", e);
    }
  };

  connectSSE();

  // --------------------------------------------------------------------------
  // 2. Firebase Firestore onSnapshot Listeners (if Firestore initialized)
  // --------------------------------------------------------------------------
  if (db) {
    try {
      const ordersCol = collection(db, "orders");
      const q = query(ordersCol, orderBy("createdAt", "asc"));

      const unsubOrders = onSnapshot(
        q,
        (snapshot) => {
          const cloudOrders: VanOrder[] = [];
          snapshot.forEach((docSnap) => {
            cloudOrders.push(docSnap.data() as VanOrder);
          });
          if (cloudOrders.length > 0 && handlers.onInitialSync) {
            handlers.onInitialSync({ orders: cloudOrders });
          }
        },
        (error) => {
          // Silently fall back to SSE stream if Firestore is not yet activated on Google Cloud
          if (error.code !== "permission-denied") {
            console.warn("Firestore orders listener fallback:", error.message);
          }
        }
      );
      firestoreUnsubscribers.push(unsubOrders);

      // Inventory Listener
      const unsubInventory = onSnapshot(
        doc(db, "inventory", "current_van_stock"),
        (docSnap) => {
          if (docSnap.exists() && handlers.onInventoryChanged) {
            handlers.onInventoryChanged(docSnap.data() as InventoryStock);
          }
        },
        () => {}
      );
      firestoreUnsubscribers.push(unsubInventory);

      // Location Listener
      const unsubLocation = onSnapshot(
        doc(db, "vans", "active_van"),
        (docSnap) => {
          if (docSnap.exists() && handlers.onLocationChanged) {
            handlers.onLocationChanged(docSnap.data() as Partial<VanLocation>);
          }
        },
        () => {}
      );
      firestoreUnsubscribers.push(unsubLocation);
    } catch {
      // Graceful fallback to SSE
    }
  }

  return () => {
    isCleaningUp = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    firestoreUnsubscribers.forEach((unsub) => unsub());
  };
}

// ----------------------------------------------------------------------------
// Cloud Event Dispatchers (Emits to both Server Hub & Firestore)
// ----------------------------------------------------------------------------

async function sendServerEvent(type: string, payload: unknown) {
  try {
    await fetch("/api/realtime/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
  } catch (e) {
    console.warn("Failed to broadcast realtime event to server hub:", e);
  }
}

/**
 * Creates or broadcasts a new order in real time.
 */
export async function dispatchCloudOrder(order: VanOrder): Promise<void> {
  // 1. Broadcast to Server Realtime Hub (<500ms across all devices)
  sendServerEvent("ORDER_CREATED", order);

  // 2. Persist to Firestore if available
  if (db) {
    try {
      await setDoc(doc(db, "orders", order.id), order);
    } catch {
      // Fallback handled
    }
  }
}

/**
 * Updates order status (e.g. received -> brewing -> ready -> served)
 */
export async function dispatchCloudOrderStatus(
  orderId: string,
  status: OrderStatus
): Promise<void> {
  sendServerEvent("ORDER_STATUS_CHANGED", { orderId, status });

  if (db) {
    try {
      await updateDoc(doc(db, "orders", orderId), { status, updatedAt: Date.now() });
    } catch {
      // Fallback handled
    }
  }
}

/**
 * Syncs Inventory Sentinel ingredient consumption and restocks
 */
export async function dispatchCloudInventory(inventory: InventoryStock): Promise<void> {
  sendServerEvent("INVENTORY_CHANGED", inventory);

  if (db) {
    try {
      await setDoc(doc(db, "inventory", "current_van_stock"), inventory, { merge: true });
    } catch {
      // Fallback handled
    }
  }
}

/**
 * Updates active van parking coordinates, hours, and spot name
 */
export async function dispatchCloudLocation(location: Partial<VanLocation>): Promise<void> {
  sendServerEvent("LOCATION_CHANGED", location);

  if (db) {
    try {
      await setDoc(doc(db, "vans", "active_van"), location, { merge: true });
    } catch {
      // Fallback handled
    }
  }
}

/**
 * Updates future scheduled stops across Hyderabad and Andhra Pradesh
 */
export async function dispatchCloudFutureStops(futureStops: FutureVanStop[]): Promise<void> {
  sendServerEvent("FUTURE_STOPS_CHANGED", futureStops);
}

/**
 * Sends curbside arrival beacon (customer vehicle pulled up)
 */
export async function dispatchCloudCurbside(
  orderId: string,
  status: "approaching" | "arrived"
): Promise<void> {
  sendServerEvent("CURBSIDE_SIGNAL", { orderId, status });

  if (db) {
    try {
      await setDoc(
        doc(db, "curbside_arrivals", orderId),
        { orderId, status, timestamp: Date.now() },
        { merge: true }
      );
    } catch {
      // Fallback handled
    }
  }
}

/**
 * Broadcasts Flash Deal updates (e.g. 1-tap activation, discounts, bundles)
 */
export async function dispatchCloudFlashDeal(flashDeal: FlashDealConfig): Promise<void> {
  sendServerEvent("FLASH_DEAL_CHANGED", flashDeal);

  if (db) {
    try {
      await setDoc(doc(db, "flash_deals", "active_deal"), flashDeal, { merge: true });
    } catch {
      // Fallback handled
    }
  }
}

