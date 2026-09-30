// Autonomous Action Policy, Safety Validation, and Idempotency Management
import { ActionRiskTier, RestockRequest } from "./types";

export interface ActionSafetyCheckResult {
  valid: boolean;
  riskTier: ActionRiskTier;
  requiresApproval: boolean;
  reason?: string;
}

// In-memory idempotency cache to prevent duplicate actions across cycles
const IDEMPOTENCY_STORE = new Map<string, { timestamp: number; request: RestockRequest }>();

// Expiration window for idempotency keys (e.g. 30 minutes)
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 30;

/**
 * Generates deterministic idempotency key for an inventory action.
 * Formula: `${storeId}:${ingredientId}:${riskPeriod}:${actionType}`
 */
export function generateIdempotencyKey(
  storeId: string,
  ingredientId: string,
  actionType: string = "RESTOCK_REQUEST",
  windowMs: number = IDEMPOTENCY_TTL_MS
): string {
  // Round timestamp to current risk window bucket
  const timeBucket = Math.floor(Date.now() / windowMs);
  return `${storeId}:${ingredientId}:${timeBucket}:${actionType}`;
}

/**
 * Checks whether an action with this idempotency key was already created.
 */
export function isActionDuplicate(idempotencyKey: string): { isDuplicate: boolean; existingRequest?: RestockRequest } {
  const existing = IDEMPOTENCY_STORE.get(idempotencyKey);
  if (!existing) return { isDuplicate: false };

  // Check TTL
  if (Date.now() - existing.timestamp > IDEMPOTENCY_TTL_MS) {
    IDEMPOTENCY_STORE.delete(idempotencyKey);
    return { isDuplicate: false };
  }

  return { isDuplicate: true, existingRequest: existing.request };
}

/**
 * Registers an executed action in the idempotency store.
 */
export function registerAction(idempotencyKey: string, request: RestockRequest): void {
  IDEMPOTENCY_STORE.set(idempotencyKey, {
    timestamp: Date.now(),
    request,
  });
}

/**
 * Evaluates action safety boundaries and determines risk tier.
 * Rules:
 * - Negative or zero quantities -> INVALID
 * - Budget > ₹2,500 or packs > 3 -> HIGH RISK (Requires human approval)
 * - Standard reorder (cost <= ₹2,500) -> MEDIUM RISK
 * - Non-write analytics / alerts -> LOW RISK
 */
export function validateActionSafety(params: {
  storeId: string;
  ingredientId: string;
  quantityUnits: number;
  quantityPacks: number;
  estimatedCost: number;
  maxVanCapacity: number;
  currentStock: number;
}): ActionSafetyCheckResult {
  // 1. Guard against invalid IDs
  if (!params.storeId || !params.ingredientId) {
    return {
      valid: false,
      riskTier: "LOW",
      requiresApproval: false,
      reason: "Missing required storeId or ingredientId.",
    };
  }

  // 2. Guard against non-positive numbers
  if (params.quantityUnits <= 0 || params.quantityPacks <= 0) {
    return {
      valid: false,
      riskTier: "LOW",
      requiresApproval: false,
      reason: "Quantity must be strictly positive.",
    };
  }

  // 3. Guard against exceeding storage capacity
  if (params.currentStock + params.quantityUnits > params.maxVanCapacity * 1.5) {
    return {
      valid: false,
      riskTier: "HIGH",
      requiresApproval: true,
      reason: `Quantity exceeds mobile storage envelope (Max: ${params.maxVanCapacity}).`,
    };
  }

  // 4. Financial Risk Tier Classification
  // High Risk Threshold: Cost exceeds ₹2,500 or ordering > 4 bulk packs
  if (params.estimatedCost > 2500 || params.quantityPacks > 4) {
    return {
      valid: true,
      riskTier: "HIGH",
      requiresApproval: true,
      reason: `High risk: Estimated PO amount ₹${params.estimatedCost} or pack count (${params.quantityPacks}) exceeds auto-approval limits. Human barista approval required.`,
    };
  }

  // Standard medium risk reorder
  return {
    valid: true,
    riskTier: "MEDIUM",
    requiresApproval: false,
    reason: `Standard restock within van operational budget (₹${params.estimatedCost}).`,
  };
}

/**
 * Clears expired entries from the idempotency store.
 */
export function cleanExpiredIdempotencyKeys(): void {
  const now = Date.now();
  for (const [key, val] of IDEMPOTENCY_STORE.entries()) {
    if (now - val.timestamp > IDEMPOTENCY_TTL_MS) {
      IDEMPOTENCY_STORE.delete(key);
    }
  }
}
