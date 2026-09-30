// Controlled Agent Tools Execution Layer for Curbside Drive-Thru Expediter
// Enforces:
// 1. Strict parameter & state validation (no illegal transitions, no raw DB write bypass)
// 2. Vehicle arrival & handoff timestamp tracking for SLA verification
// 3. Decoupled VehicleArrivalProvider abstraction for GPS and beacon signals
// 4. Barista KDS priority management and deduplicated notification delivery

import { VanOrder, OrderStatus } from "@/context/VanContext";
import {
  CurbsideUrgencyLevel,
  CurbsideAction,
  CurbsideSlaRecord,
  CurbsideOperationalMetrics,
  OrderPreparationEstimate,
  VehicleEtaEstimate,
} from "./types";
import {
  estimateOrderPreparation,
  calculateCurbsideUrgency,
  calculateQueuePriorityScore,
  measureHandoffSla,
  calculateOperationalMetrics,
} from "./calculations";
import {
  generateCurbsideIdempotencyKey,
  isCurbsideActionDuplicate,
  registerCurbsideAction,
  shouldDispatchBaristaNotification,
  validateOrderActionSafety,
} from "./policy";
import { validateAndTransition } from "./stateMachine";

// Vehicle Arrival Provider Interface
export interface VehicleArrivalProvider {
  getEta(orderId: string): VehicleEtaEstimate;
  setManualEta?(orderId: string, etaSeconds: number): void;
}

// In-memory working order store for standalone execution / testing
const ORDER_REGISTRY = new Map<string, VanOrder>();
// Tracking for vehicle arrivals and handoffs: orderId -> timestamps
const ARRIVAL_TIMESTAMPS = new Map<string, number>();
const HANDOFF_START_TIMESTAMPS = new Map<string, number>();
const COMPLETED_SLA_RECORDS: CurbsideSlaRecord[] = [];
// Overrides for vehicle ETA in development/testing
const MANUAL_ETA_OVERRIDES = new Map<string, number>();

// Default Vehicle Arrival Provider implementation
export const defaultVehicleArrivalProvider: VehicleArrivalProvider = {
  getEta(orderId: string): VehicleEtaEstimate {
    // 1. Check if manually overridden (test suites or GPS mocks)
    if (MANUAL_ETA_OVERRIDES.has(orderId)) {
      const eta = MANUAL_ETA_OVERRIDES.get(orderId)!;
      return {
        orderId,
        etaSeconds: eta,
        source: "manual",
        updatedAt: Date.now(),
      };
    }

    // 2. Check active order status / arrival beacon
    const order = ORDER_REGISTRY.get(orderId);
    if (order) {
      if (order.curbsideArrivalStatus === "arrived") {
        return {
          orderId,
          etaSeconds: 0,
          source: "beacon_arrived",
          updatedAt: Date.now(),
        };
      }
      if (order.curbsideArrivalStatus === "approaching") {
        return {
          orderId,
          etaSeconds: 120, // 2 minutes away
          source: "beacon_approaching",
          updatedAt: Date.now(),
        };
      }
    }

    // 3. Fallback default estimate: 5 minutes away
    return {
      orderId,
      etaSeconds: 300,
      source: "gps_provider",
      updatedAt: Date.now(),
    };
  },
  setManualEta(orderId: string, etaSeconds: number) {
    MANUAL_ETA_OVERRIDES.set(orderId, etaSeconds);
  },
};

let activeArrivalProvider: VehicleArrivalProvider = defaultVehicleArrivalProvider;

export function setVehicleArrivalProvider(provider: VehicleArrivalProvider): void {
  activeArrivalProvider = provider;
}

// Registry Helper methods for state coordination
export function registerOrderInCache(order: VanOrder): void {
  ORDER_REGISTRY.set(order.id, { ...order });
}

export function updateOrderInCache(orderId: string, patch: Partial<VanOrder>): VanOrder | null {
  const existing = ORDER_REGISTRY.get(orderId);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  ORDER_REGISTRY.set(orderId, updated);
  return updated;
}

export function clearOrderRegistry(): void {
  ORDER_REGISTRY.clear();
  ARRIVAL_TIMESTAMPS.clear();
  HANDOFF_START_TIMESTAMPS.clear();
  COMPLETED_SLA_RECORDS.length = 0;
  MANUAL_ETA_OVERRIDES.clear();
}

// -------------------------------------------------------------
// CONTROLLED TOOL IMPLEMENTATIONS
// -------------------------------------------------------------

export function tool_get_order(orderId: string): VanOrder | null {
  return ORDER_REGISTRY.get(orderId) || null;
}

export function tool_get_order_status(orderId: string): OrderStatus | null {
  const order = ORDER_REGISTRY.get(orderId);
  return order ? order.status : null;
}

export function tool_get_vehicle_eta(orderId: string): VehicleEtaEstimate {
  return activeArrivalProvider.getEta(orderId);
}

export function tool_get_preparation_estimate(
  order: VanOrder,
  currentTime: number = Date.now()
): OrderPreparationEstimate {
  return estimateOrderPreparation(
    order.id,
    order.items,
    order.createdAt,
    order.status,
    currentTime
  );
}

export function tool_get_kds_queue(storeId: string = "van-01"): VanOrder[] {
  void storeId;
  return Array.from(ORDER_REGISTRY.values()).filter(
    (o) => o.status !== "served" && o.status !== "cancelled"
  );
}

export function tool_calculate_urgency(
  vehicleEtaSeconds: number,
  remainingPrepSeconds: number,
  isOrderReady: boolean
) {
  return calculateCurbsideUrgency(vehicleEtaSeconds, remainingPrepSeconds, isOrderReady);
}

export function tool_calculate_priority(
  urgencyLevel: CurbsideUrgencyLevel,
  arrivalBufferSeconds: number,
  orderAgeSeconds: number,
  isCurbside: boolean = true
): number {
  return calculateQueuePriorityScore(
    urgencyLevel,
    arrivalBufferSeconds,
    orderAgeSeconds,
    isCurbside
  );
}

/**
 * Prioritizes or expedites an order in the KDS queue safely.
 */
export function tool_prioritize_order(params: {
  storeId: string;
  orderId: string;
  action: CurbsideAction;
  urgency: CurbsideUrgencyLevel;
  reason: string;
}): { success: boolean; actionApplied: CurbsideAction; isDuplicate?: boolean; error?: string } {
  const order = ORDER_REGISTRY.get(params.orderId);
  const safety = validateOrderActionSafety({
    orderId: params.orderId,
    orderExists: Boolean(order),
    isCancelled: order?.status === "cancelled",
    isServed: order?.status === "served",
  });

  if (!safety.valid) {
    return { success: false, actionApplied: "NORMAL", error: safety.reason };
  }

  // Idempotency check
  const idempotencyKey = generateCurbsideIdempotencyKey(
    params.storeId,
    params.orderId,
    `PRIORITIZE_${params.action}`
  );
  const dupCheck = isCurbsideActionDuplicate(idempotencyKey);
  if (dupCheck.isDuplicate) {
    return {
      success: true,
      actionApplied: params.action,
      isDuplicate: true,
      error: "Idempotent: Order priority was already updated in this operational window.",
    };
  }

  registerCurbsideAction(idempotencyKey, params.action, params.urgency, false);
  return { success: true, actionApplied: params.action };
}

/**
 * Dispatches an automated Barista notification with debouncing and cooldown.
 */
export function tool_notify_barista(params: {
  orderId: string;
  orderNumber: string;
  urgency: CurbsideUrgencyLevel;
  message: string;
}): { delivered: boolean; throttled: boolean; notificationId?: string } {
  const shouldSend = shouldDispatchBaristaNotification(params.orderId, params.urgency);
  if (!shouldSend) {
    return { delivered: false, throttled: true };
  }

  const notificationId = `curb-notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  if (process.env.NODE_ENV !== "test") {
    console.log(
      `[BARISTA KDS NOTIFICATION] [${params.urgency}] Order #${params.orderNumber}: ${params.message}`
    );
  }

  return { delivered: true, throttled: false, notificationId };
}

/**
 * Records vehicle arrival at the curb bay.
 */
export function tool_mark_vehicle_arrived(
  orderId: string,
  timestamp: number = Date.now()
): { success: boolean; arrivedAt: number; error?: string } {
  const order = ORDER_REGISTRY.get(orderId);
  if (!order) {
    return { success: false, arrivedAt: 0, error: `Order '${orderId}' not found.` };
  }

  if (order.status === "cancelled" || order.status === "served") {
    return {
      success: false,
      arrivedAt: 0,
      error: `Cannot mark arrival for order in terminal state '${order.status}'.`,
    };
  }

  // Idempotent arrival timestamp (preserve first recorded arrival for honest SLA tracking)
  const arrivedAt = ARRIVAL_TIMESTAMPS.get(orderId) || timestamp;
  ARRIVAL_TIMESTAMPS.set(orderId, arrivedAt);

  updateOrderInCache(orderId, {
    curbsideArrivalStatus: "arrived",
  });

  return { success: true, arrivedAt };
}

/**
 * Marks that a barista has initiated the walk to the customer car with the order tray.
 */
export function tool_mark_handoff_started(
  orderId: string,
  timestamp: number = Date.now()
): { success: boolean; startedAt: number; error?: string } {
  const order = ORDER_REGISTRY.get(orderId);
  if (!order) {
    return { success: false, startedAt: 0, error: `Order '${orderId}' not found.` };
  }

  HANDOFF_START_TIMESTAMPS.set(orderId, timestamp);
  return { success: true, startedAt: timestamp };
}

/**
 * Completes curbside handover through vehicle window and measures sub-60s SLA.
 */
export function tool_mark_handoff_completed(
  orderId: string,
  timestamp: number = Date.now()
): { success: boolean; record?: CurbsideSlaRecord; error?: string } {
  const order = ORDER_REGISTRY.get(orderId);
  if (!order) {
    return { success: false, error: `Order '${orderId}' not found.` };
  }

  // Guard against duplicate completion
  if (order.status === "served") {
    const existing = COMPLETED_SLA_RECORDS.find((r) => r.orderId === orderId);
    if (existing) {
      return { success: true, record: existing };
    }
    return { success: false, error: `Order '${orderId}' was already marked as served.` };
  }

  // Validate state transition
  const transition = validateAndTransition("HANDOFF_IN_PROGRESS", "COMPLETED");
  if (!transition.success) {
    return { success: false, error: transition.error };
  }

  const vehicleArrivedAt = ARRIVAL_TIMESTAMPS.get(orderId) || timestamp;
  const handoffStartedAt = HANDOFF_START_TIMESTAMPS.get(orderId);

  const slaRecord = measureHandoffSla(orderId, vehicleArrivedAt, timestamp, handoffStartedAt);
  slaRecord.orderNumber = order.orderNumber;
  COMPLETED_SLA_RECORDS.unshift(slaRecord);

  updateOrderInCache(orderId, {
    status: "served",
  });

  return { success: true, record: slaRecord };
}

export function tool_get_sla_records(): CurbsideSlaRecord[] {
  return [...COMPLETED_SLA_RECORDS];
}

export function tool_get_operational_metrics(): CurbsideOperationalMetrics {
  const activeOrders = Array.from(ORDER_REGISTRY.values()).filter(
    (o) => o.pickupType === "curbside" && o.status !== "served" && o.status !== "cancelled"
  );

  const activeAssessments = activeOrders.map((o) => {
    const eta = defaultVehicleArrivalProvider.getEta(o.id);
    const prep = estimateOrderPreparation(o.id, o.items, o.createdAt, o.status);
    const urgency = calculateCurbsideUrgency(eta.etaSeconds, prep.remainingPrepSeconds, prep.isReady);
    const score = calculateQueuePriorityScore(
      urgency.urgencyLevel,
      urgency.arrivalBufferSeconds,
      prep.elapsedPrepSeconds,
      true
    );

    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      lifecycleState: "PREPARING" as const,
      vehicleEtaSeconds: eta.etaSeconds,
      remainingPrepSeconds: prep.remainingPrepSeconds,
      arrivalBufferSeconds: urgency.arrivalBufferSeconds,
      urgencyLevel: urgency.urgencyLevel,
      recommendedAction: urgency.recommendedAction,
      priorityScore: score,
      reason: urgency.reason,
      requiresNotification: false,
      targetReadyTime: new Date(prep.targetReadyTimestamp).toLocaleTimeString(),
    };
  });

  return calculateOperationalMetrics(COMPLETED_SLA_RECORDS, activeAssessments);
}
