"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { CartItem } from "./CartContext";
import {
  InventoryStock,
  DEFAULT_INVENTORY_STOCK,
  deductOrderIngredients,
  FlashDealConfig,
  DEFAULT_FLASH_DEAL,
} from "@/lib/smartAgentsEngine";
import {
  initRealtimeCloudSync,
  dispatchCloudOrder,
  dispatchCloudOrderStatus,
  dispatchCloudInventory,
  dispatchCloudLocation,
  dispatchCloudFutureStops,
  dispatchCloudCurbside,
} from "@/lib/realtimeDb";

export type OrderStatus = "received" | "brewing" | "ready" | "served" | "cancelled";

export interface VanOrder {
  id: string;
  orderNumber: string; // e.g. #101, #102
  customerName: string;
  customerPhone?: string;
  items: CartItem[];
  notes?: string;
  totalAmount: number;
  status: OrderStatus;
  createdAt: number;
  pickupType: "walkup" | "curbside";
  vehicleInfo?: string; // for curbside (e.g. "Silver Honda Civic")
  vanLocationName?: string; // Van spot name where order was placed
  curbsideArrivalStatus?: "approaching" | "arrived";
  paymentStatus?: "pending" | "paid" | "failed";
  paymentId?: string;
  paymentMethod?: string;
}

export interface VanLocation {
  spotName: string;
  address: string;
  city: string;
  hours: string;
  status: "serving" | "moving" | "closed" | "break";
  notes?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
}

export interface FutureVanStop {
  id: string;
  date: string; // e.g. "Tomorrow, Sep 21" or "2026-09-22"
  dayOfWeek: string; // e.g. "Monday", "Tuesday"
  state: "Telangana" | "Andhra Pradesh";
  city: string; // e.g. "Hyderabad", "Visakhapatnam", "Vijayawada"
  spotName: string; // e.g. "DLF Cybercity, Gachibowli"
  address: string;
  hours: string; // e.g. "7:30 AM — 4:00 PM"
  status: "scheduled" | "confirmed" | "special_event";
  badge?: string;
  notes?: string;
  createdAt: number;
}

interface VanContextType {
  orders: VanOrder[];
  activeOrders: VanOrder[];
  nowServingOrders: VanOrder[];
  brewingOrders: VanOrder[];
  vanLocation: VanLocation;
  futureStops: FutureVanStop[];
  soldOutItemIds: string[];
  inventory: InventoryStock;
  consumeIngredients: (items: { name: string; quantity: number }[]) => void;
  restockInventory: (patch?: Partial<InventoryStock>) => void;
  flashDeal: FlashDealConfig;
  toggleFlashDeal: (active?: boolean) => void;
  updateFlashDeal: (deal: Partial<FlashDealConfig>) => void;
  curbsideArrivals: Record<string, "approaching" | "arrived">;
  updateCurbsideArrival: (orderId: string, status: "approaching" | "arrived") => void;
  createOrder: (order: {
    customerName: string;
    customerPhone?: string;
    items: CartItem[];
    notes?: string;
    totalAmount: number;
    pickupType?: "walkup" | "curbside";
    vehicleInfo?: string;
    vanLocationName?: string;
    paymentStatus?: "pending" | "paid" | "failed";
    paymentId?: string;
    paymentMethod?: string;
  }) => string;
  updateOrderStatus: (orderId: string, status: OrderStatus) => void;
  toggleSoldOut: (itemId: string) => void;
  updateVanLocation: (location: Partial<VanLocation>) => void;
  addFutureStop: (stop: Omit<FutureVanStop, "id" | "createdAt">) => string;
  updateFutureStop: (id: string, stop: Partial<FutureVanStop>) => void;
  deleteFutureStop: (id: string) => void;
  setStopAsLiveToday: (id: string) => void;
  estimatedWaitMinutes: number;
}

const VanContext = createContext<VanContextType | undefined>(undefined);

const ORDERS_STORAGE_KEY = "brew_van_orders_v2";
const SOLDOUT_STORAGE_KEY = "brew_van_soldout_v2";
const LOCATION_STORAGE_KEY = "brew_van_location_v2";
const FUTURE_STOPS_STORAGE_KEY = "brew_future_stops_v2";
const INVENTORY_STORAGE_KEY = "brew_van_inventory_v2";
const FLASH_DEAL_STORAGE_KEY = "brew_flash_deal_v2";
const CURBSIDE_STORAGE_KEY = "brew_curbside_arrivals_v2";

const DEFAULT_LOCATION: VanLocation = {
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
};

const INITIAL_DEMO_FUTURE_STOPS: FutureVanStop[] = [];

const INITIAL_DEMO_ORDERS: VanOrder[] = [
  {
    id: "ord-101",
    orderNumber: "101",
    customerName: "Arjun Reddy",
    items: [
      { id: "c-3", name: "Single-Origin Cappuccino", price: 220, image: "/assets/cup1.webp", category: "Coffee", quantity: 1 },
      { id: "d-4", name: "Cinnamon Roll", price: 180, image: "/assets/desserts /Cinnamon Roll.webp", category: "Desserts", quantity: 1 },
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
      { id: "c-1", name: "Affogato", price: 240, image: "/assets/coffee/affagato.webp", category: "Coffee", quantity: 2 },
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
      { id: "c-2", name: "Americano", price: 180, image: "/assets/coffee/americino.webp", category: "Coffee", quantity: 1 },
      { id: "t-2", name: "Earl Grey", price: 160, image: "/assets/TEA/Earl Grey.webp", category: "Tea", quantity: 1 },
    ],
    totalAmount: 340,
    status: "brewing",
    createdAt: Date.now() - 1000 * 60 * 2,
    pickupType: "curbside",
    vehicleInfo: "White Thar, Hazard lights on (Near Gate 2)",
    vanLocationName: "Jubilee Hills Road No. 36 (Hyderabad)",
  },
];

export const VanProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [orders, setOrders] = useState<VanOrder[]>(INITIAL_DEMO_ORDERS);
  const [soldOutItemIds, setSoldOutItemIds] = useState<string[]>([]);
  const [vanLocation, setVanLocation] = useState<VanLocation>(DEFAULT_LOCATION);
  const [futureStops, setFutureStops] = useState<FutureVanStop[]>(INITIAL_DEMO_FUTURE_STOPS);
  const [inventory, setInventory] = useState<InventoryStock>(DEFAULT_INVENTORY_STOCK);
  const [flashDeal, setFlashDeal] = useState<FlashDealConfig>(DEFAULT_FLASH_DEAL);
  const [curbsideArrivals, setCurbsideArrivals] = useState<Record<string, "approaching" | "arrived">>({
    "ord-103": "approaching",
  });
  const [isInitialized, setIsInitialized] = useState(false);

  // Load state on mount and subscribe to cross-tab updates
  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        try {
          const storedOrders = localStorage.getItem(ORDERS_STORAGE_KEY);
          if (storedOrders) {
            const parsed = JSON.parse(storedOrders);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const backfilled = parsed.map((o: VanOrder) => ({
                ...o,
                vanLocationName: o.vanLocationName || "HITEC City — Cyber Towers (Hyderabad)",
              }));
              setOrders(backfilled);
            }
          }
          const storedSoldOut = localStorage.getItem(SOLDOUT_STORAGE_KEY);
          if (storedSoldOut) {
            setSoldOutItemIds(JSON.parse(storedSoldOut));
          }
          const storedLocation = localStorage.getItem(LOCATION_STORAGE_KEY);
          if (storedLocation) {
            setVanLocation(JSON.parse(storedLocation));
          }
          const storedFuture = localStorage.getItem(FUTURE_STOPS_STORAGE_KEY);
          if (storedFuture) {
            const parsedFuture = JSON.parse(storedFuture);
            if (Array.isArray(parsedFuture)) {
              const realStops = parsedFuture.filter(
                (s: FutureVanStop) =>
                  !["stop-fut-1", "stop-fut-2", "stop-fut-3", "stop-fut-4", "stop-fut-5"].includes(s.id)
              );
              setFutureStops(realStops);
            }
          }
          const storedInventory = localStorage.getItem(INVENTORY_STORAGE_KEY);
          if (storedInventory) {
            setInventory(JSON.parse(storedInventory));
          }
          const storedDeal = localStorage.getItem(FLASH_DEAL_STORAGE_KEY);
          if (storedDeal) {
            setFlashDeal(JSON.parse(storedDeal));
          }
          const storedCurbside = localStorage.getItem(CURBSIDE_STORAGE_KEY);
          if (storedCurbside) {
            setCurbsideArrivals(JSON.parse(storedCurbside));
          }
        } catch (err) {
          console.error("Failed to load Van state", err);
        } finally {
          setIsInitialized(true);
        }
      }
    });

    // Storage event listener for real-time multi-tab sync
    const handleStorage = (e: StorageEvent) => {
      if (e.key === ORDERS_STORAGE_KEY && e.newValue) {
        try {
          setOrders(JSON.parse(e.newValue));
        } catch {}
      }
      if (e.key === SOLDOUT_STORAGE_KEY && e.newValue) {
        try {
          setSoldOutItemIds(JSON.parse(e.newValue));
        } catch {}
      }
      if (e.key === LOCATION_STORAGE_KEY && e.newValue) {
        try {
          setVanLocation(JSON.parse(e.newValue));
        } catch {}
      }
      if (e.key === FUTURE_STOPS_STORAGE_KEY && e.newValue) {
        try {
          setFutureStops(JSON.parse(e.newValue));
        } catch {}
      }
      if (e.key === INVENTORY_STORAGE_KEY && e.newValue) {
        try {
          setInventory(JSON.parse(e.newValue));
        } catch {}
      }
      if (e.key === FLASH_DEAL_STORAGE_KEY && e.newValue) {
        try {
          setFlashDeal(JSON.parse(e.newValue));
        } catch {}
      }
      if (e.key === CURBSIDE_STORAGE_KEY && e.newValue) {
        try {
          setCurbsideArrivals(JSON.parse(e.newValue));
        } catch {}
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("storage", handleStorage);
      return () => window.removeEventListener("storage", handleStorage);
    }
  }, []);

  // Real-Time Cloud Synchronization Engine (<500ms multi-device updates)
  useEffect(() => {
    const unsubCloud = initRealtimeCloudSync({
      onInitialSync: (data) => {
        if (data.orders && data.orders.length > 0) {
          setOrders(data.orders);
        }
        if (data.inventory) {
          setInventory(data.inventory);
        }
        if (data.vanLocation) {
          setVanLocation(data.vanLocation);
        }
        if (data.futureStops && data.futureStops.length > 0) {
          setFutureStops(data.futureStops);
        }
        if (data.curbsideArrivals) {
          setCurbsideArrivals(data.curbsideArrivals);
        }
      },
      onOrderCreated: (newOrder) => {
        setOrders((prev) => {
          if (prev.some((o) => o.id === newOrder.id)) return prev;
          return [...prev, newOrder];
        });
      },
      onOrderStatusChanged: (orderId, status) => {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status } : o))
        );
      },
      onInventoryChanged: (inv) => {
        setInventory(inv);
      },
      onLocationChanged: (loc) => {
        setVanLocation((prev) => ({ ...prev, ...loc }));
      },
      onFutureStopsChanged: (stops) => {
        setFutureStops(stops);
      },
      onCurbsideSignal: (orderId, status) => {
        setCurbsideArrivals((prev) => ({ ...prev, [orderId]: status }));
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, curbsideArrivalStatus: status } : o))
        );
      },
    });

    return () => unsubCloud();
  }, []);

  // Save changes
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(orders));
    }
  }, [orders, isInitialized]);

  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(SOLDOUT_STORAGE_KEY, JSON.stringify(soldOutItemIds));
    }
  }, [soldOutItemIds, isInitialized]);

  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(vanLocation));
    }
  }, [vanLocation, isInitialized]);

  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(FUTURE_STOPS_STORAGE_KEY, JSON.stringify(futureStops));
    }
  }, [futureStops, isInitialized]);

  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
    }
  }, [inventory, isInitialized]);

  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(FLASH_DEAL_STORAGE_KEY, JSON.stringify(flashDeal));
    }
  }, [flashDeal, isInitialized]);

  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(CURBSIDE_STORAGE_KEY, JSON.stringify(curbsideArrivals));
    }
  }, [curbsideArrivals, isInitialized]);

  const consumeIngredients = (items: { name: string; quantity: number }[]) => {
    setInventory((prev) => {
      const next = deductOrderIngredients(prev, items);
      dispatchCloudInventory(next);
      return next;
    });
  };

  const restockInventory = (patch?: Partial<InventoryStock>) => {
    const next = patch
      ? {
          ...inventory,
          ...patch,
          lastRestockedAt: Date.now(),
        }
      : {
          ...DEFAULT_INVENTORY_STOCK,
          lastRestockedAt: Date.now(),
        };
    setInventory(next);
    dispatchCloudInventory(next);
  };

  const toggleFlashDeal = (active?: boolean) => {
    setFlashDeal((prev) => ({
      ...prev,
      isActive: typeof active === "boolean" ? active : !prev.isActive,
      expiresAt: Date.now() + 1000 * 60 * 60 * 2,
    }));
  };

  const updateFlashDeal = (dealPatch: Partial<FlashDealConfig>) => {
    setFlashDeal((prev) => ({ ...prev, ...dealPatch }));
  };

  const updateCurbsideArrival = (orderId: string, status: "approaching" | "arrived") => {
    setCurbsideArrivals((prev) => ({
      ...prev,
      [orderId]: status,
    }));
    // Also update order if present
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, curbsideArrivalStatus: status } : o))
    );
    dispatchCloudCurbside(orderId, status);
  };

  const createOrder = (orderData: {
    customerName: string;
    customerPhone?: string;
    items: CartItem[];
    notes?: string;
    totalAmount: number;
    pickupType?: "walkup" | "curbside";
    vehicleInfo?: string;
    vanLocationName?: string;
    paymentStatus?: "pending" | "paid" | "failed";
    paymentId?: string;
    paymentMethod?: string;
  }): string => {
    // Generate sequential token number 101-999
    const lastNum = orders.length > 0 ? parseInt(orders[orders.length - 1].orderNumber, 10) : 100;
    const nextNum = isNaN(lastNum) ? 101 : (lastNum % 900) + 1;
    const orderNumber = String(nextNum);
    const orderId = "ord-" + orderNumber + "-" + Math.random().toString(36).substring(2, 6);

    const newOrder: VanOrder = {
      id: orderId,
      orderNumber,
      customerName: orderData.customerName || "Sanctuary Guest",
      customerPhone: orderData.customerPhone,
      items: orderData.items,
      notes: orderData.notes,
      totalAmount: orderData.totalAmount,
      status: "received",
      createdAt: Date.now(),
      pickupType: orderData.pickupType || "walkup",
      vehicleInfo: orderData.vehicleInfo,
      vanLocationName:
        orderData.vanLocationName || vanLocation.spotName || "HITEC City — Cyber Towers (Hyderabad)",
      paymentStatus: orderData.paymentStatus || "pending",
      paymentId: orderData.paymentId,
      paymentMethod: orderData.paymentMethod || "UPI / Cards",
    };

    setOrders((prev) => [...prev, newOrder]);
    dispatchCloudOrder(newOrder);

    // Automatically trigger Inventory Sentinel deduction
    const updatedInventory = deductOrderIngredients(inventory, orderData.items);
    setInventory(updatedInventory);
    dispatchCloudInventory(updatedInventory);

    return orderId;
  };

  const updateOrderStatus = (orderId: string, status: OrderStatus) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, status } : o))
    );
    dispatchCloudOrderStatus(orderId, status);
  };

  const toggleSoldOut = (itemId: string) => {
    setSoldOutItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  };

  const updateVanLocation = (locationPatch: Partial<VanLocation>) => {
    setVanLocation((prev) => {
      const next = { ...prev, ...locationPatch };
      dispatchCloudLocation(next);
      return next;
    });
  };

  const addFutureStop = (stopData: Omit<FutureVanStop, "id" | "createdAt">): string => {
    const id = `stop-fut-${Date.now()}`;
    const newStop: FutureVanStop = {
      ...stopData,
      id,
      createdAt: Date.now(),
    };
    setFutureStops((prev) => {
      const next = [newStop, ...prev];
      dispatchCloudFutureStops(next);
      return next;
    });
    return id;
  };

  const updateFutureStop = (id: string, patch: Partial<FutureVanStop>) => {
    setFutureStops((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch } : s));
      dispatchCloudFutureStops(next);
      return next;
    });
  };

  const deleteFutureStop = (id: string) => {
    setFutureStops((prev) => {
      const next = prev.filter((s) => s.id !== id);
      dispatchCloudFutureStops(next);
      return next;
    });
  };

  const setStopAsLiveToday = (stopId: string) => {
    const stop = futureStops.find((s) => s.id === stopId);
    if (!stop) return;
    const nextLoc: VanLocation = {
      spotName: stop.spotName,
      address: stop.address,
      city: `${stop.city}, ${stop.state}`,
      hours: stop.hours,
      status: "serving",
      notes: stop.notes || `Stationed at ${stop.spotName}`,
      coordinates:
        stop.state === "Andhra Pradesh"
          ? { lat: 17.6868, lng: 83.2185 }
          : { lat: 17.4504, lng: 78.3808 },
    };
    setVanLocation(nextLoc);
    dispatchCloudLocation(nextLoc);
  };

  // Filtered queues
  const activeOrders = orders.filter((o) => o.status !== "served" && o.status !== "cancelled");
  const nowServingOrders = orders.filter((o) => o.status === "ready");
  const brewingOrders = orders.filter((o) => o.status === "brewing" || o.status === "received");

  // Approximate wait time: ~2-3 mins per active drink in queue
  const totalDrinksInQueue = brewingOrders.reduce(
    (sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0),
    0
  );
  const estimatedWaitMinutes = Math.max(3, Math.min(25, Math.ceil(totalDrinksInQueue * 2.2)));

  return (
    <VanContext.Provider
      value={{
        orders,
        activeOrders,
        nowServingOrders,
        brewingOrders,
        vanLocation,
        futureStops,
        soldOutItemIds,
        inventory,
        consumeIngredients,
        restockInventory,
        flashDeal,
        toggleFlashDeal,
        updateFlashDeal,
        curbsideArrivals,
        updateCurbsideArrival,
        createOrder,
        updateOrderStatus,
        toggleSoldOut,
        updateVanLocation,
        addFutureStop,
        updateFutureStop,
        deleteFutureStop,
        setStopAsLiveToday,
        estimatedWaitMinutes,
      }}
    >
      {children}
    </VanContext.Provider>
  );
};

export const useVan = () => {
  const context = useContext(VanContext);
  if (!context) {
    throw new Error("useVan must be used within a VanProvider");
  }
  return context;
};
