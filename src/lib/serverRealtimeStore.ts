// Global In-Memory Real-Time Server State Hub for Cross-Device Synchronization
// Enables instant (<500ms) sync across multiple phones, laptops, and outdoor displays.

import type { VanOrder, VanLocation, FutureVanStop, OrderStatus } from "@/context/VanContext";
import {
  type InventoryStock,
  DEFAULT_INVENTORY_STOCK,
  type FlashDealConfig,
  DEFAULT_FLASH_DEAL,
} from "@/lib/smartAgentsEngine";

export interface ServerRealtimeEvent {
  type:
    | "ORDER_CREATED"
    | "ORDER_STATUS_CHANGED"
    | "INVENTORY_CHANGED"
    | "LOCATION_CHANGED"
    | "FUTURE_STOPS_CHANGED"
    | "CURBSIDE_SIGNAL"
    | "FLASH_DEAL_CHANGED"
    | "INITIAL_SYNC";
  payload: unknown;
  timestamp: number;
}

type Subscriber = (event: ServerRealtimeEvent) => void;

interface ServerRealtimeState {
  orders: VanOrder[];
  inventory: InventoryStock;
  vanLocation: VanLocation;
  futureStops: FutureVanStop[];
  curbsideArrivals: Record<string, string>;
  flashDeal: FlashDealConfig;
  subscribers: Set<Subscriber>;
}

// In Next.js dev and production, ensure the state persists across hot-reloads via globalThis
const globalKey = Symbol.for("brew.realtime.store");

interface GlobalWithRealtime {
  [globalKey]?: ServerRealtimeState;
}

const g = globalThis as unknown as GlobalWithRealtime;

if (!g[globalKey]) {
  g[globalKey] = {
    orders: [
      {
        id: "ord-101",
        orderNumber: "101",
        customerName: "Arjun Reddy",
        items: [
          { id: "c-3", name: "Single-Origin Cappuccino", price: 220, image: "/assets/cup1.png", category: "Coffee", quantity: 1 },
          { id: "d-4", name: "Cinnamon Roll", price: 180, image: "/assets/desserts /Cinnamon Roll.png", category: "Desserts", quantity: 1 },
        ],
        notes: "Oat milk for cappuccino please!",
        totalAmount: 400,
        status: "ready",
        createdAt: Date.now() - 1000 * 60 * 7,
        pickupType: "walkup",
        vanLocationName: "HITEC City — Cyber Towers (Hyderabad)",
      },
      {
        id: "ord-102",
        orderNumber: "102",
        customerName: "Sravani Rao",
        items: [
          { id: "c-1", name: "Affogato", price: 240, image: "/assets/coffee/affagato.png", category: "Coffee", quantity: 2 },
        ],
        notes: "Extra vanilla bean gelato",
        totalAmount: 480,
        status: "brewing",
        createdAt: Date.now() - 1000 * 60 * 4,
        pickupType: "walkup",
        vanLocationName: "Financial District — Waverock (Hyderabad)",
      },
      {
        id: "ord-103",
        orderNumber: "103",
        customerName: "Karthik Varma",
        items: [
          { id: "c-2", name: "Americano", price: 180, image: "/assets/coffee/americino.png", category: "Coffee", quantity: 1 },
          { id: "t-2", name: "Earl Grey", price: 160, image: "/assets/TEA/Earl Grey.png", category: "Tea", quantity: 1 },
        ],
        totalAmount: 340,
        status: "brewing",
        createdAt: Date.now() - 1000 * 60 * 2,
        pickupType: "curbside",
        vehicleInfo: "White Thar, Hazard lights on (Near Gate 2)",
        vanLocationName: "Jubilee Hills Road No. 36 (Hyderabad)",
      },
    ],
    inventory: {
      ...DEFAULT_INVENTORY_STOCK,
    },
    vanLocation: {
      spotName: "HITEC City — Cyber Towers & Mindspace Plaza",
      address: "Phase 2, HITEC City Main Rd, Madhapur",
      city: "Hyderabad, Telangana",
      hours: "7:00 AM — 11:00 PM",
      status: "serving",
      notes: "Stationed right outside Cyber Towers Gate 2 promenade. Dedicated curbside delivery active for HITEC City tech parks.",
      coordinates: {
        lat: 17.4504,
        lng: 78.3808,
      },
    },
    futureStops: [],
    curbsideArrivals: {
      "ord-103": "approaching",
    },
    flashDeal: {
      ...DEFAULT_FLASH_DEAL,
    },
    subscribers: new Set(),
  };
}

const store = g[globalKey]!;

export function subscribeToRealtimeServer(subscriber: Subscriber): () => void {
  store.subscribers.add(subscriber);
  return () => {
    store.subscribers.delete(subscriber);
  };
}

export function broadcastRealtimeEvent(event: ServerRealtimeEvent): void {
  // Update internal store based on event type
  if (event.type === "ORDER_CREATED") {
    store.orders.push(event.payload as VanOrder);
  } else if (event.type === "ORDER_STATUS_CHANGED") {
    const { orderId, status } = event.payload as { orderId: string; status: OrderStatus };
    store.orders = store.orders.map((o) => (o.id === orderId ? { ...o, status } : o));
  } else if (event.type === "INVENTORY_CHANGED") {
    store.inventory = { ...store.inventory, ...(event.payload as Partial<InventoryStock>) };
  } else if (event.type === "LOCATION_CHANGED") {
    store.vanLocation = { ...store.vanLocation, ...(event.payload as Partial<VanLocation>) };
  } else if (event.type === "FUTURE_STOPS_CHANGED") {
    store.futureStops = event.payload as FutureVanStop[];
  } else if (event.type === "CURBSIDE_SIGNAL") {
    const { orderId, status } = event.payload as { orderId: string; status: string };
    store.curbsideArrivals[orderId] = status;
    store.orders = store.orders.map((o) =>
      o.id === orderId ? { ...o, curbsideArrivalStatus: status as "approaching" | "arrived" } : o
    );
  } else if (event.type === "FLASH_DEAL_CHANGED") {
    store.flashDeal = { ...store.flashDeal, ...(event.payload as Partial<FlashDealConfig>) };
  }

  // Broadcast to all active subscribers
  store.subscribers.forEach((sub) => {
    try {
      sub(event);
    } catch (e) {
      console.error("Subscriber dispatch failed:", e);
    }
  });
}

export function getRealtimeServerSnapshot() {
  return {
    orders: store.orders,
    inventory: store.inventory,
    vanLocation: store.vanLocation,
    futureStops: store.futureStops,
    curbsideArrivals: store.curbsideArrivals,
    flashDeal: store.flashDeal,
  };
}
