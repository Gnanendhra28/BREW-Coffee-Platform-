// Autonomous Action Policy, Safety Validation, and Idempotency Management
// Enforces:
// 1. Mandatory idempotency across repeated trigger events
// 2. Pre-publish inventory revalidation (guard against race conditions)
// 3. Strict promotion state machine transitions

import { PromotionStatus, YieldFlashDealRecord } from "./types";

const IDEMPOTENCY_STORE = new Map<string, YieldFlashDealRecord>();
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 30; // 30-minute operational window

export const VALID_PROMOTION_TRANSITIONS: Record<PromotionStatus, PromotionStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "ACTIVE", "CANCELLED"],
  PENDING_APPROVAL: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED", "EXPIRED", "COMPLETED", "CANCELLED"],
  PAUSED: ["ACTIVE", "EXPIRED", "CANCELLED"],
  EXPIRED: [],   // Terminal
  CANCELLED: [], // Terminal
  COMPLETED: [], // Terminal
};

/**
 * Generates deterministic idempotency key for flash deal creations.
 */
export function generateYieldIdempotencyKey(
  storeId: string,
  bundleId: string,
  windowMs: number = IDEMPOTENCY_TTL_MS
): string {
  const timeBucket = Math.floor(Date.now() / windowMs);
  return `${storeId}:${bundleId}:${timeBucket}:FLASH_DEAL`;
}

/**
 * Checks whether a flash deal for this candidate has already been generated.
 */
export function isDealDuplicate(idempotencyKey: string): {
  isDuplicate: boolean;
  existingDeal?: YieldFlashDealRecord;
} {
  const existing = IDEMPOTENCY_STORE.get(idempotencyKey);
  if (!existing) return { isDuplicate: false };

  if (Date.now() - existing.createdAt > IDEMPOTENCY_TTL_MS) {
    IDEMPOTENCY_STORE.delete(idempotencyKey);
    return { isDuplicate: false };
  }

  return { isDuplicate: true, existingDeal: existing };
}

/**
 * Registers an active flash deal record into the idempotency store.
 */
export function registerYieldDeal(idempotencyKey: string, deal: YieldFlashDealRecord): void {
  IDEMPOTENCY_STORE.set(idempotencyKey, deal);
}

/**
 * Validates a promotion state machine transition.
 */
export function isValidPromotionTransition(from: PromotionStatus, to: PromotionStatus): boolean {
  if (from === to) return true;
  return Boolean(VALID_PROMOTION_TRANSITIONS[from]?.includes(to));
}

/**
 * Pre-publishing safety check: Re-validates that live pastry inventory has not sold out.
 */
export function validateInventoryBeforePublish(
  deal: YieldFlashDealRecord,
  currentLiveStock: number
): { valid: boolean; reason?: string } {
  if (currentLiveStock <= 0) {
    return {
      valid: false,
      reason: `Live inventory for '${deal.candidate.pastryName}' is now 0 (sold out). Flash deal cancelled before publish.`,
    };
  }

  if (currentLiveStock < 2) {
    return {
      valid: false,
      reason: `Live inventory for '${deal.candidate.pastryName}' dropped to ${currentLiveStock}. Surplus condition no longer exists.`,
    };
  }

  if (Date.now() >= deal.expiresAt) {
    return {
      valid: false,
      reason: `Flash deal expired before publication. Current time exceeds campaign expiration.`,
    };
  }

  return { valid: true };
}

/**
 * Clears idempotency store (useful for testing shifts).
 */
export function clearYieldIdempotencyStore(): void {
  IDEMPOTENCY_STORE.clear();
}
