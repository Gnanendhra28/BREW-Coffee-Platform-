// Validated State Transition Engine for Curbside Drive-Thru Expediter
// Enforces:
// 1. Strict finite state machine transitions
// 2. Rejection of illegal transitions (e.g. COMPLETED -> PREPARING, CANCELLED -> READY)
// 3. Seamless bidirectional mapping with existing OrderStatus ('received', 'brewing', 'ready', 'served', 'cancelled')

import { CurbsideLifecycleState } from "./types";
import { OrderStatus } from "@/context/VanContext";

export const VALID_LIFECYCLE_TRANSITIONS: Record<CurbsideLifecycleState, CurbsideLifecycleState[]> = {
  ORDER_CREATED: ["CONFIRMED", "PREPARING", "CANCELLED", "FAILED"],
  CONFIRMED: ["PREPARING", "VEHICLE_APPROACHING", "CANCELLED", "FAILED"],
  PREPARING: ["READY", "VEHICLE_APPROACHING", "VEHICLE_ARRIVED", "CANCELLED", "FAILED"],
  VEHICLE_APPROACHING: ["PREPARING", "READY", "VEHICLE_ARRIVED", "CANCELLED", "NO_SHOW"],
  READY: ["VEHICLE_APPROACHING", "VEHICLE_ARRIVED", "HANDOFF_IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"],
  VEHICLE_ARRIVED: ["HANDOFF_IN_PROGRESS", "READY", "COMPLETED", "CANCELLED", "NO_SHOW"],
  HANDOFF_IN_PROGRESS: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [], // Terminal state
  CANCELLED: [], // Terminal state
  FAILED: [],    // Terminal state
  NO_SHOW: [],   // Terminal state
};

/**
 * Checks whether a lifecycle state transition is valid.
 */
export function isValidTransition(
  fromState: CurbsideLifecycleState,
  toState: CurbsideLifecycleState
): boolean {
  if (fromState === toState) return true; // idempotent self-transition
  const allowed = VALID_LIFECYCLE_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.includes(toState));
}

/**
 * Validates and applies a lifecycle state transition with informative error responses.
 */
export function validateAndTransition(
  fromState: CurbsideLifecycleState,
  toState: CurbsideLifecycleState
): { success: boolean; nextState: CurbsideLifecycleState; error?: string } {
  if (fromState === toState) {
    return { success: true, nextState: toState };
  }

  if (!isValidTransition(fromState, toState)) {
    return {
      success: false,
      nextState: fromState,
      error: `Invalid curbside lifecycle transition from '${fromState}' to '${toState}'. State was preserved as '${fromState}'.`,
    };
  }

  return { success: true, nextState: toState };
}

/**
 * Maps existing application OrderStatus to the most appropriate CurbsideLifecycleState.
 */
export function mapOrderStatusToLifecycle(
  status: OrderStatus,
  curbsideSignal?: "approaching" | "arrived"
): CurbsideLifecycleState {
  if (status === "cancelled") return "CANCELLED";
  if (status === "served") return "COMPLETED";

  if (curbsideSignal === "arrived") return "VEHICLE_ARRIVED";
  if (curbsideSignal === "approaching") return "VEHICLE_APPROACHING";

  switch (status) {
    case "received":
      return "ORDER_CREATED";
    case "brewing":
      return "PREPARING";
    case "ready":
      return "READY";
    default:
      return "ORDER_CREATED";
  }
}

/**
 * Maps CurbsideLifecycleState back into the existing core OrderStatus.
 */
export function mapLifecycleToOrderStatus(state: CurbsideLifecycleState): OrderStatus {
  switch (state) {
    case "ORDER_CREATED":
    case "CONFIRMED":
      return "received";
    case "PREPARING":
    case "VEHICLE_APPROACHING":
      return "brewing";
    case "READY":
    case "VEHICLE_ARRIVED":
    case "HANDOFF_IN_PROGRESS":
      return "ready";
    case "COMPLETED":
      return "served";
    case "CANCELLED":
    case "FAILED":
    case "NO_SHOW":
      return "cancelled";
    default:
      return "received";
  }
}
