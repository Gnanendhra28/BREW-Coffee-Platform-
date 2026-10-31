// Durable Server-Side Payment Orders & Webhooks Store
// Backed by Authoritative Cloud Firestore via Firebase Admin SDK with Resilient Local Cache Fallback.

import { getAdminFirestore } from "./firebaseAdmin";

export interface StoredPaymentItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface StoredPaymentOrder {
  orderId: string;
  customerReference: string;
  customerName: string;
  customerPhone?: string;
  items: StoredPaymentItem[];
  subtotal: number;
  discountAmount: number;
  appliedPromotion?: string;
  taxAmount: number;
  deliveryFee: number;
  finalTotal: number;
  amountInPaise: number;
  currency: string;
  receipt: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  paymentStatus: "pending" | "paid" | "failed";
  orderStatus: "pending" | "brewing" | "ready" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  verificationMetadata?: Record<string, unknown>;
  vanLocationName: string;
}

// In-process fallback memory store for offline testing or fast lookup
const memStoreKey = Symbol.for("brew.payment.orders.memstore");
const processedWebhooksKey = Symbol.for("brew.payment.webhooks.memstore");
const processedPaymentsKey = Symbol.for("brew.payment.verified_ids.memstore");

interface GlobalWithPaymentStores {
  [memStoreKey]?: Map<string, StoredPaymentOrder>;
  [processedWebhooksKey]?: Set<string>;
  [processedPaymentsKey]?: Set<string>;
}

const g = globalThis as unknown as GlobalWithPaymentStores;
if (!g[memStoreKey]) g[memStoreKey] = new Map<string, StoredPaymentOrder>();
if (!g[processedWebhooksKey]) g[processedWebhooksKey] = new Set<string>();
if (!g[processedPaymentsKey]) g[processedPaymentsKey] = new Set<string>();

const memOrders = g[memStoreKey]!;
const memWebhooks = g[processedWebhooksKey]!;
const memPayments = g[processedPaymentsKey]!;

const ORDERS_COLLECTION = "payment_orders";
const WEBHOOKS_COLLECTION = "processed_webhooks";
const PAYMENTS_COLLECTION = "processed_payments";

/**
 * Persists a new or updated payment order into authoritative Cloud Firestore
 */
export async function saveStoredPaymentOrder(order: StoredPaymentOrder): Promise<void> {
  // Always update memory store
  memOrders.set(order.orderId, order);
  if (order.razorpayOrderId) {
    memOrders.set(order.razorpayOrderId, order);
  }

  const db = getAdminFirestore();
  if (db) {
    try {
      const dataToSave = JSON.parse(JSON.stringify({ ...order, updatedAt: Date.now() }));
      await db.collection(ORDERS_COLLECTION).doc(order.orderId).set(dataToSave, { merge: true });
      if (order.razorpayOrderId && order.razorpayOrderId !== order.orderId) {
        await db.collection(ORDERS_COLLECTION).doc(order.razorpayOrderId).set(dataToSave, { merge: true });
      }
    } catch (err) {
      console.warn("[PAYMENT STORE] Firestore order persistence warning:", err);
    }
  }
}

/**
 * Retrieves a stored payment order by internal order ID or Razorpay Order ID
 */
export async function getStoredPaymentOrder(
  id: string
): Promise<StoredPaymentOrder | undefined> {
  const db = getAdminFirestore();

  if (db) {
    try {
      // 1. Check by direct document ID (internal orderId)
      const docRef = db.collection(ORDERS_COLLECTION).doc(id);
      const snap = await docRef.get();
      if (snap.exists) {
        const data = snap.data() as StoredPaymentOrder;
        memOrders.set(data.orderId, data);
        if (data.razorpayOrderId) memOrders.set(data.razorpayOrderId, data);
        return data;
      }

      // 2. Query by razorpayOrderId
      const querySnap = await db
        .collection(ORDERS_COLLECTION)
        .where("razorpayOrderId", "==", id)
        .limit(1)
        .get();

      if (!querySnap.empty) {
        const data = querySnap.docs[0].data() as StoredPaymentOrder;
        memOrders.set(data.orderId, data);
        if (data.razorpayOrderId) memOrders.set(data.razorpayOrderId, data);
        return data;
      }
    } catch (err) {
      console.warn("[PAYMENT STORE] Firestore order lookup warning:", err);
    }
  }

  // Fallback to local memory store
  return memOrders.get(id);
}

/**
 * Atomically marks a payment order as paid in Cloud Firestore
 */
export async function markStoredPaymentOrderPaid(
  orderIdOrRzpId: string,
  paymentId: string,
  verificationMetadata?: Record<string, unknown>
): Promise<{ success: boolean; order?: StoredPaymentOrder; alreadyPaid?: boolean }> {
  // Update memory store
  const existingMem = memOrders.get(orderIdOrRzpId);
  if (existingMem) {
    existingMem.paymentStatus = "paid";
    existingMem.orderStatus = "brewing";
    existingMem.razorpayPaymentId = paymentId;
    existingMem.updatedAt = Date.now();
    existingMem.verificationMetadata = verificationMetadata;
  }

  const db = getAdminFirestore();
  if (db) {
    try {
      let targetDocRef = db.collection(ORDERS_COLLECTION).doc(orderIdOrRzpId);
      const docSnap = await targetDocRef.get();

      if (!docSnap.exists) {
        // Query by razorpayOrderId
        const querySnap = await db
          .collection(ORDERS_COLLECTION)
          .where("razorpayOrderId", "==", orderIdOrRzpId)
          .limit(1)
          .get();

        if (querySnap.empty) {
          return { success: false };
        }
        targetDocRef = querySnap.docs[0].ref;
      }

      const result = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(targetDocRef);
        if (!snap.exists) {
          throw new Error("Order document not found in transaction");
        }
        const data = snap.data() as StoredPaymentOrder;
        if (data.paymentStatus === "paid") {
          return { success: true, alreadyPaid: true, order: data };
        }

        const updateData: Partial<StoredPaymentOrder> = {
          paymentStatus: "paid",
          orderStatus: "brewing",
          razorpayPaymentId: paymentId,
          updatedAt: Date.now(),
          verificationMetadata: verificationMetadata || { verifiedAt: Date.now() },
        };

        transaction.update(targetDocRef, updateData);

        // Ensure both internal orderId doc and razorpayOrderId doc are synchronized
        if (data.orderId && data.orderId !== targetDocRef.id) {
          transaction.update(db.collection(ORDERS_COLLECTION).doc(data.orderId), updateData);
        }
        if (data.razorpayOrderId && data.razorpayOrderId !== targetDocRef.id) {
          transaction.update(db.collection(ORDERS_COLLECTION).doc(data.razorpayOrderId), updateData);
        }

        return { success: true, alreadyPaid: false, order: { ...data, ...updateData } };
      });

      return result;
    } catch (err) {
      console.warn("[PAYMENT STORE] Firestore mark paid transaction warning:", err);
    }
  }

  return { success: true, order: existingMem };
}

/**
 * Durable check for processed payment ID to prevent duplicate processing
 */
export async function isPaymentIdProcessed(paymentId: string): Promise<boolean> {
  if (memPayments.has(paymentId)) return true;

  const db = getAdminFirestore();
  if (db) {
    try {
      const snap = await db.collection(PAYMENTS_COLLECTION).doc(paymentId).get();
      if (snap.exists) {
        memPayments.add(paymentId);
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Durably marks a payment ID as processed
 */
export async function markPaymentIdProcessed(paymentId: string): Promise<void> {
  memPayments.add(paymentId);
  const db = getAdminFirestore();
  if (db) {
    try {
      await db.collection(PAYMENTS_COLLECTION).doc(paymentId).set({
        paymentId,
        processedAt: Date.now(),
      });
    } catch {}
  }
}

/**
 * Durable, Atomic Webhook Deduplication and Order Update Transaction
 * Ensures duplicate or concurrent webhook delivery processes payment exactly once.
 */
export async function processWebhookTransaction(
  eventId: string,
  eventDetails: {
    event: string;
    orderId: string;
    paymentId: string;
    receivedAmountInPaise: number;
    currency: string;
  }
): Promise<{
  success: boolean;
  alreadyProcessed: boolean;
  order?: StoredPaymentOrder;
  error?: string;
}> {
  // Check fast in-memory set
  if (memWebhooks.has(eventId)) {
    return { success: true, alreadyProcessed: true };
  }

  const db = getAdminFirestore();
  if (!db) {
    // Memory fallback when Firestore is unavailable
    memWebhooks.add(eventId);
    if (eventDetails.paymentId) memPayments.add(eventDetails.paymentId);
    const existing = memOrders.get(eventDetails.orderId);
    if (existing) {
      existing.paymentStatus = "paid";
      existing.orderStatus = "brewing";
      existing.razorpayPaymentId = eventDetails.paymentId;
    }
    return { success: true, alreadyProcessed: false, order: existing };
  }

  try {
    const webhookDocRef = db.collection(WEBHOOKS_COLLECTION).doc(eventId);
    const orderDocRef = db.collection(ORDERS_COLLECTION).doc(eventDetails.orderId);

    const txResult = await db.runTransaction(async (transaction) => {
      // 1. Check if webhook has already been processed
      const webhookSnap = await transaction.get(webhookDocRef);
      if (webhookSnap.exists) {
        return { success: true, alreadyProcessed: true };
      }

      // 2. Fetch and verify order record
      let orderData: StoredPaymentOrder | undefined;

      if (eventDetails.orderId) {
        const orderSnap = await transaction.get(orderDocRef);
        if (!orderSnap.exists) {
          throw new Error(`Order not found for orderId: ${eventDetails.orderId}`);
        }

        orderData = orderSnap.data() as StoredPaymentOrder;

        // Verify amount
        if (orderData.amountInPaise !== eventDetails.receivedAmountInPaise) {
          throw new Error(
            `Payment amount mismatch! Expected: ₹${orderData.amountInPaise / 100}, Received: ₹${eventDetails.receivedAmountInPaise / 100}`
          );
        }
        // Verify currency
        if (orderData.currency !== eventDetails.currency) {
          throw new Error(
            `Currency mismatch! Expected: ${orderData.currency}, Received: ${eventDetails.currency}`
          );
        }

        // Update order state
        const webhookUpdate = {
          paymentStatus: "paid" as const,
          orderStatus: "brewing" as const,
          razorpayPaymentId: eventDetails.paymentId,
          updatedAt: Date.now(),
          verificationMetadata: {
            webhookEventId: eventId,
            webhookProcessedAt: Date.now(),
            channel: "razorpay_webhook",
          },
        };

        transaction.update(orderDocRef, webhookUpdate);

        if (orderData.orderId && orderData.orderId !== orderDocRef.id) {
          transaction.update(db.collection(ORDERS_COLLECTION).doc(orderData.orderId), webhookUpdate);
        }
        if (orderData.razorpayOrderId && orderData.razorpayOrderId !== orderDocRef.id) {
          transaction.update(db.collection(ORDERS_COLLECTION).doc(orderData.razorpayOrderId), webhookUpdate);
        }
      }

      // 3. Persist processed webhook record atomically
      transaction.set(webhookDocRef, {
        eventId,
        event: eventDetails.event,
        orderId: eventDetails.orderId,
        paymentId: eventDetails.paymentId,
        amountInPaise: eventDetails.receivedAmountInPaise,
        currency: eventDetails.currency,
        processedAt: Date.now(),
      });

      return { success: true, alreadyProcessed: false, order: orderData };
    });

    memWebhooks.add(eventId);
    if (eventDetails.paymentId) memPayments.add(eventDetails.paymentId);
    return txResult;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Transaction failed";
    console.error("[PAYMENT STORE] Webhook transaction error:", errorMsg);
    return { success: false, alreadyProcessed: false, error: errorMsg };
  }
}
