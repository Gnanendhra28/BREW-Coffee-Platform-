// Autonomous Action Policy, Idempotency, and Barista Notification Cooldown Engine
// Enforces:
// 1. Mandatory idempotency across repeated events (e.g. 3x VEHICLE_APPROACHING)
// 2. Barista notification deduplication and cooldowns (prevent notification spamming)
// 3. Operational safety rules (never prioritize cancelled orders, unknown orders, or no-shows)

import { CurbsideUrgencyLevel, CurbsideAction } from "./types";

interface IdempotencyRecord {
  timestamp: number;
  action: CurbsideAction;
  urgency: CurbsideUrgencyLevel;
  notificationSent: boolean;
}

// In-memory idempotency cache
const CURBSIDE_IDEMPOTENCY_STORE = new Map<string, IdempotencyRecord>();
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 15; // 15-minute operational window

// Notification debounce tracking: orderId -> lastNotificationTimestamp
const NOTIFICATION_COOLDOWN_STORE = new Map<string, { timestamp: number; urgency: CurbsideUrgencyLevel }>();
const NOTIFICATION_COOLDOWN_MS = 1000 * 45; // 45-second notification debounce

/**
 * Generates a deterministic idempotency key for curbside actions.
 */
export function generateCurbsideIdempotencyKey(
  storeId: string,
  orderId: string,
  eventType: string,
  timeBucketWindowMs: number = IDEMPOTENCY_TTL_MS
): string {
  const bucket = Math.floor(Date.now() / timeBucketWindowMs);
  return `${storeId}:${orderId}:${eventType}:${bucket}`;
}

/**
 * Checks whether an incoming curbside action has already been handled in the current window.
 */
export function isCurbsideActionDuplicate(idempotencyKey: string): {
  isDuplicate: boolean;
  existingRecord?: IdempotencyRecord;
} {
  const existing = CURBSIDE_IDEMPOTENCY_STORE.get(idempotencyKey);
  if (!existing) return { isDuplicate: false };

  if (Date.now() - existing.timestamp > IDEMPOTENCY_TTL_MS) {
    CURBSIDE_IDEMPOTENCY_STORE.delete(idempotencyKey);
    return { isDuplicate: false };
  }

  return { isDuplicate: true, existingRecord: existing };
}

/**
 * Registers an executed curbside action into the idempotency store.
 */
export function registerCurbsideAction(
  idempotencyKey: string,
  action: CurbsideAction,
  urgency: CurbsideUrgencyLevel,
  notificationSent: boolean
): void {
  CURBSIDE_IDEMPOTENCY_STORE.set(idempotencyKey, {
    timestamp: Date.now(),
    action,
    urgency,
    notificationSent,
  });
}

/**
 * Determines whether a notification to the Barista should be dispatched or throttled.
 * Rule: Allow immediately if urgency escalates to CRITICAL, otherwise enforce cooldown.
 */
export function shouldDispatchBaristaNotification(
  orderId: string,
  urgency: CurbsideUrgencyLevel
): boolean {
  if (urgency === "NORMAL") return false;

  const last = NOTIFICATION_COOLDOWN_STORE.get(orderId);
  const now = Date.now();

  // Urgent/Critical immediate bypass if escalating
  if (urgency === "CRITICAL" && (!last || last.urgency !== "CRITICAL")) {
    NOTIFICATION_COOLDOWN_STORE.set(orderId, { timestamp: now, urgency });
    return true;
  }

  if (last && now - last.timestamp < NOTIFICATION_COOLDOWN_MS) {
    return false; // throttled by cooldown
  }

  NOTIFICATION_COOLDOWN_STORE.set(orderId, { timestamp: now, urgency });
  return true;
}

/**
 * Validates operational safety before taking any action on an order.
 */
export function validateOrderActionSafety(params: {
  orderId: string;
  isCancelled?: boolean;
  isServed?: boolean;
  isNoShow?: boolean;
  orderExists: boolean;
}): { valid: boolean; reason?: string } {
  if (!params.orderExists) {
    return { valid: false, reason: `Order ID '${params.orderId}' not found in active order registry.` };
  }
  if (params.isCancelled) {
    return { valid: false, reason: `Order ID '${params.orderId}' is cancelled. No curbside acceleration permitted.` };
  }
  if (params.isNoShow) {
    return { valid: false, reason: `Order ID '${params.orderId}' marked as customer no-show.` };
  }
  if (params.isServed) {
    return { valid: false, reason: `Order ID '${params.orderId}' is already served.` };
  }

  return { valid: true };
}

/**
 * Resets idempotency and cooldown caches (useful for testing and shift resets).
 */
export function resetCurbsidePolicyCaches(): void {
  CURBSIDE_IDEMPOTENCY_STORE.clear();
  NOTIFICATION_COOLDOWN_STORE.clear();
}
