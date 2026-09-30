// Context Assembler & Data Retrieval for Agent 6: ❤️ Guest Sentiment Guardian
// Fetches order history, customer profile, and operational telemetry while minimizing PII.

import {
  OrderContext,
  CustomerProfileContext,
} from "./types";

// In-Memory store of orders for lookup & correlation
const ORDERS_DB = new Map<string, OrderContext>();

// In-Memory customer profiles for recovery tracking & abuse prevention
const CUSTOMER_PROFILES_DB = new Map<string, CustomerProfileContext>();

export function registerOrderForContext(order: OrderContext): void {
  ORDERS_DB.set(order.orderId, order);
}

export function registerCustomerProfile(profile: CustomerProfileContext): void {
  CUSTOMER_PROFILES_DB.set(profile.customerId, profile);
}

export function getOrderContext(orderId?: string): OrderContext | null {
  if (!orderId) return null;
  return ORDERS_DB.get(orderId) || null;
}

export function getCustomerProfile(customerId?: string): CustomerProfileContext | null {
  if (!customerId) return null;
  return CUSTOMER_PROFILES_DB.get(customerId) || null;
}

export function clearGuestContextStores(): void {
  ORDERS_DB.clear();
  CUSTOMER_PROFILES_DB.clear();
}

// Seed default mock orders and customer profiles
const now = Date.now();

registerOrderForContext({
  orderId: "ord-101",
  orderNumber: "#101",
  customerId: "cust-01",
  storeId: "van-01",
  totalAmount: 380,
  items: [
    { id: "c-1", name: "Single-Origin Cappuccino", quantity: 1, price: 220 },
    { id: "d-1", name: "Butter Croissant", quantity: 1, price: 160 },
  ],
  status: "served",
  pickupType: "curbside",
  createdAt: now - 35 * 60 * 1000,
  readyAt: now - 15 * 60 * 1000,
  servedAt: now - 13 * 60 * 1000,
  actualWaitMinutes: 20, // 20 min wait! Target was 8 min
  targetWaitMinutes: 8,
});

registerOrderForContext({
  orderId: "ord-102",
  orderNumber: "#102",
  customerId: "cust-02",
  storeId: "van-01",
  totalAmount: 450,
  items: [
    { id: "c-2", name: "Iced Spanish Latte", quantity: 2, price: 450 },
  ],
  status: "served",
  pickupType: "walkup",
  createdAt: now - 40 * 60 * 1000,
  actualWaitMinutes: 6,
  targetWaitMinutes: 8,
});

registerCustomerProfile({
  customerId: "cust-01",
  name: "Arjun Verma",
  phone: "+919876543210",
  email: "arjun.v@cybercorp.com",
  totalOrders: 14,
  recentRecoveriesCount30Days: 0,
  marketingConsent: true,
});

registerCustomerProfile({
  customerId: "cust-02",
  name: "Priya Sharma",
  phone: "+919876543211",
  email: "priya.s@fintechhub.in",
  totalOrders: 6,
  recentRecoveriesCount30Days: 1,
  lastRecoveryTimestamp: now - 12 * 24 * 60 * 60 * 1000,
  marketingConsent: true,
});

registerCustomerProfile({
  customerId: "cust-03-abuser",
  name: "Repeat Claimer",
  phone: "+919876543299",
  totalOrders: 3,
  recentRecoveriesCount30Days: 3, // EXCEEDED THRESHOLD (>= 2)
  lastRecoveryTimestamp: now - 2 * 24 * 60 * 60 * 1000,
  marketingConsent: true,
});
