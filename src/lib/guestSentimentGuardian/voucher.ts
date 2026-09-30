// Authoritative Voucher Generation & Idempotency Store for Agent 6: ❤️ Guest Sentiment Guardian
// Guarantees:
// 1. Exact schema compliance with BREWCARExxxx pattern (/^BREWCARE\d{4}$/)
// 2. Strict idempotency (1 review = 1 voucher, duplicate executions return identical record)
// 3. Expiration date bounding (14-day validity window)

import { VoucherRecord } from "./types";

const VOUCHERS_DB = new Map<string, VoucherRecord>(); // voucherId -> record
const VOUCHER_IDEMPOTENCY_MAP = new Map<string, string>(); // idempotencyKey -> voucherId

export function resetVoucherStore(): void {
  VOUCHERS_DB.clear();
  VOUCHER_IDEMPOTENCY_MAP.clear();
}

export function generateVoucherIdempotencyKey(storeId: string, feedbackId: string): string {
  return `${storeId}:${feedbackId}:VOUCHER`;
}

export interface IssueVoucherParams {
  storeId: string;
  feedbackId: string;
  customerId?: string;
  amount: number;
  validityDays?: number;
}

/**
 * Deterministically issues or returns an existing idempotent voucher.
 */
export function issueCustomerRecoveryVoucher(params: IssueVoucherParams): {
  voucher: VoucherRecord;
  isExisting: boolean;
} {
  const idempotencyKey = generateVoucherIdempotencyKey(params.storeId, params.feedbackId);

  // Check if voucher already exists for this feedback
  const existingId = VOUCHER_IDEMPOTENCY_MAP.get(idempotencyKey);
  if (existingId) {
    const existingRecord = VOUCHERS_DB.get(existingId);
    if (existingRecord) {
      return { voucher: existingRecord, isExisting: true };
    }
  }

  // Generate deterministic 4-digit code using pseudo-hash of idempotency key
  let hashNum = 0;
  for (let i = 0; i < idempotencyKey.length; i++) {
    hashNum = (hashNum * 31 + idempotencyKey.charCodeAt(i)) % 9000;
  }
  const codeSuffix = 1000 + Math.abs(hashNum);
  const code = `BREWCARE${codeSuffix}`;

  const now = Date.now();
  const validityDays = params.validityDays ?? 14;
  const expiresAt = now + validityDays * 24 * 60 * 60 * 1000;
  const voucherId = `vouch-${now}-${Math.random().toString(36).substring(2, 6)}`;

  const voucher: VoucherRecord = {
    voucherId,
    code,
    customerId: params.customerId,
    storeId: params.storeId,
    amount: params.amount,
    issuedAt: now,
    expiresAt,
    isRedeemed: false,
    idempotencyKey,
  };

  VOUCHERS_DB.set(voucherId, voucher);
  VOUCHER_IDEMPOTENCY_MAP.set(idempotencyKey, voucherId);

  return { voucher, isExisting: false };
}

export function getVoucher(voucherId: string): VoucherRecord | undefined {
  return VOUCHERS_DB.get(voucherId);
}

export function listVouchers(storeId?: string): VoucherRecord[] {
  const all = Array.from(VOUCHERS_DB.values());
  if (storeId) {
    return all.filter((v) => v.storeId === storeId);
  }
  return all;
}
