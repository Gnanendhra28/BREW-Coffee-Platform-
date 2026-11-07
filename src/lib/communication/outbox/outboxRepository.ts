/**
 * BREW Coffee Platform — Phase 6.3.3 Communication Outbox Repository
 * Dual implementation: In-Memory (unit/testing) and Firestore (durable serverless execution).
 */

import { randomUUID } from "crypto";
import {
  CommunicationDeliveryRecord,
  ClaimContext,
  DeliveryStatus,
  WhatsAppMessageStatus,
} from "../types";
import { CommunicationDeliveryRecordSchema } from "../schemas";
import { getAdminFirestore } from "../../firebaseAdmin";
import { StaleClaimError } from "../errors";
import { getEffectiveCallAttemptCount } from "./outboxModel";
import {
  VoiceBookingSession,
  VoiceSessionRepository,
  isTerminalVoiceState,
} from "../../voiceBooking/types";
import {
  deserializeSessionFromFirestore,
  serializeSessionForFirestore,
  VOICE_BOOKING_COLLECTION,
} from "../../voiceBooking/repositories/firestoreSessionRepository";

export interface CommunicationOutboxRepository {
  /**
   * Atomically claims up to `limit` eligible deliveries for processing.
   * Eligible criteria:
   * 1. status === 'pending'
   * 2. status === 'failed' AND attemptCount < maxAttempts AND (nextRetryAt === null OR nextRetryAt <= now)
   * 3. status === 'processing' AND leaseExpiresAt <= now (lease expired recovery)
   */
  claimEligibleDeliveries(
    claimOwner: string,
    leaseDurationMs: number,
    limit: number,
    now: Date
  ): Promise<CommunicationDeliveryRecord[]>;

  /**
   * Mandatory conditional worker-update operation with claim fencing.
   * Transactionally verifies that:
   * - Document exists
   * - status === 'processing'
   * - claimOwner === claimContext.claimOwner
   * - claimedAt === claimContext.claimedAt
   * - claimToken === claimContext.claimToken (fencing token check)
   * - lease is still active (leaseExpiresAt > now)
   * Rejects without modifying if ownership, token, or lease is lost.
   */
  updateClaimedDelivery(
    delivery: CommunicationDeliveryRecord,
    claimContext: ClaimContext,
    now: Date
  ): Promise<void>;

  getDeliveryById(deliveryId: string): Promise<CommunicationDeliveryRecord | null>;

  getDeliveriesBySessionId(sessionId: string): Promise<CommunicationDeliveryRecord[]>;

  getDeliveryByProviderMessageId?(providerMessageId: string): Promise<CommunicationDeliveryRecord | null>;

  updateDeliveryStatusByProviderMessageId?(
    providerMessageId: string,
    status: DeliveryStatus,
    providerStatus: WhatsAppMessageStatus,
    timestamp: string
  ): Promise<boolean>;

  /**
   * Transactionally mutates a voice booking session guarded by delivery claim ownership.
   * Atomically verifies that the delivery is in 'processing' state with matching claimOwner,
   * claimToken, claimedAt, and active lease (leaseExpiresAt > now).
   * Reads session, applies mutator, checks revision, and writes session in the same transaction.
   * If claim is stale, expired, or invalidated by a concurrent reclaim, rejects with StaleClaimError
   * and guarantees no partial or stale session mutation is written.
   */
  mutateSessionWithClaimFencing(
    deliveryId: string,
    claimContext: ClaimContext,
    sessionId: string,
    now: Date,
    mutator: (session: VoiceBookingSession) => VoiceBookingSession | void,
    sessionRepository?: VoiceSessionRepository,
    outboxDeliveries?: CommunicationDeliveryRecord[]
  ): Promise<boolean>;

  /**
   * Computes authoritative outbox operational and monitoring metrics.
   * Returns delivery counts by status, stale lease counts, oldest pending delivery age,
   * channel distribution, and failure reason breakdowns.
   */
  getMetrics?(now?: Date): Promise<OutboxMetricsSummary>;
}

export interface MetricComponentFidelity {
  fidelity: "exact" | "sampled";
  isExact: boolean;
  sampleLimit?: number;
  sampleSize?: number;
  notes?: string;
}

export interface OutboxMetricsFidelityBreakdown {
  counts: MetricComponentFidelity;
  channelBreakdown: MetricComponentFidelity;
  staleLeases: MetricComponentFidelity;
  oldestPendingAge: MetricComponentFidelity;
  failureReasons: MetricComponentFidelity;
}

export interface OutboxMetricsSummary {
  counts: {
    pending: number;
    processing: number;
    dispatched: number;
    blocked: number;
    failed: number;
    permanently_failed: number;
    total: number;
  };
  staleLeasesCount: number;
  oldestPendingAgeSeconds: number | null;
  channelBreakdown: {
    whatsapp: number;
    voice: number;
  };
  failureReasons: Record<string, number>;
  evaluatedAt: string;
  fidelity: "exact" | "sampled";
  isExact: boolean;
  sampleDetails?: {
    sampleSize?: number;
    sampleLimit?: number;
    reason: string;
    sampledComponents?: string[];
  };
  components?: OutboxMetricsFidelityBreakdown;
}

export interface MetricsCalculationOptions {
  fidelity?: "exact" | "sampled";
  sampleReason?: string;
  sampleSize?: number;
  components?: Partial<OutboxMetricsFidelityBreakdown>;
}

/**
 * Shared metrics calculation function across in-memory and Firestore stores.
 */
export function computeOutboxMetricsFromRecords(
  records: CommunicationDeliveryRecord[],
  evalTime: Date = new Date(),
  options: MetricsCalculationOptions = {}
): OutboxMetricsSummary {
  const counts = {
    pending: 0,
    processing: 0,
    dispatched: 0,
    blocked: 0,
    failed: 0,
    permanently_failed: 0,
    total: records.length,
  };
  let staleLeasesCount = 0;
  let oldestPendingCreatedAt: number | null = null;
  const channelBreakdown = {
    whatsapp: 0,
    voice: 0,
  };
  const failureReasons: Record<string, number> = {};
  const nowMs = evalTime.getTime();

  for (const record of records) {
    if (record.status in counts) {
      counts[record.status as keyof typeof counts]++;
    }

    if (record.channel === "whatsapp" || record.channel === "voice") {
      channelBreakdown[record.channel]++;
    }

    if (
      record.status === "processing" &&
      record.leaseExpiresAt &&
      new Date(record.leaseExpiresAt).getTime() <= nowMs
    ) {
      staleLeasesCount++;
    }

    if (record.status === "pending") {
      const createdMs = new Date(record.createdAt).getTime();
      if (!isNaN(createdMs)) {
        if (oldestPendingCreatedAt === null || createdMs < oldestPendingCreatedAt) {
          oldestPendingCreatedAt = createdMs;
        }
      }
    }

    if (record.lastError?.code) {
      const code = record.lastError.code;
      failureReasons[code] = (failureReasons[code] || 0) + 1;
    }
  }

  const oldestPendingAgeSeconds =
    oldestPendingCreatedAt !== null
      ? Math.max(0, Math.floor((nowMs - oldestPendingCreatedAt) / 1000))
      : null;

  const isSampledExplicitly = options.fidelity === "sampled";
  const customComponents = options.components;

  const countsFidelity: MetricComponentFidelity = customComponents?.counts || {
    fidelity: isSampledExplicitly ? "sampled" : "exact",
    isExact: !isSampledExplicitly,
    sampleSize: records.length,
  };

  const channelBreakdownFidelity: MetricComponentFidelity = customComponents?.channelBreakdown || {
    fidelity: isSampledExplicitly ? "sampled" : "exact",
    isExact: !isSampledExplicitly,
    sampleSize: records.length,
  };

  const staleLeasesFidelity: MetricComponentFidelity = customComponents?.staleLeases || {
    fidelity: isSampledExplicitly ? "sampled" : "exact",
    isExact: !isSampledExplicitly,
    sampleSize: records.length,
  };

  const oldestPendingAgeFidelity: MetricComponentFidelity = customComponents?.oldestPendingAge || {
    fidelity: isSampledExplicitly ? "sampled" : "exact",
    isExact: !isSampledExplicitly,
    sampleSize: records.length,
  };

  const failureReasonsFidelity: MetricComponentFidelity = customComponents?.failureReasons || {
    fidelity: isSampledExplicitly ? "sampled" : "exact",
    isExact: !isSampledExplicitly,
    sampleSize: records.length,
  };

  const components: OutboxMetricsFidelityBreakdown = {
    counts: countsFidelity,
    channelBreakdown: channelBreakdownFidelity,
    staleLeases: staleLeasesFidelity,
    oldestPendingAge: oldestPendingAgeFidelity,
    failureReasons: failureReasonsFidelity,
  };

  // Phase 6.5.3: Do not report complete metrics as exact while any component is sampled.
  const hasAnySampledComponent =
    !countsFidelity.isExact ||
    !channelBreakdownFidelity.isExact ||
    !staleLeasesFidelity.isExact ||
    !oldestPendingAgeFidelity.isExact ||
    !failureReasonsFidelity.isExact;

  const isExact = !hasAnySampledComponent;
  const fidelity: "exact" | "sampled" = isExact ? "exact" : "sampled";

  return {
    counts,
    staleLeasesCount,
    oldestPendingAgeSeconds,
    channelBreakdown,
    failureReasons,
    evaluatedAt: evalTime.toISOString(),
    fidelity,
    isExact,
    sampleDetails:
      fidelity === "sampled"
        ? {
            sampleSize: options.sampleSize ?? records.length,
            reason: options.sampleReason || "Sampled estimate from subset of records",
            sampledComponents: [
              !countsFidelity.isExact ? "counts" : null,
              !channelBreakdownFidelity.isExact ? "channelBreakdown" : null,
              !staleLeasesFidelity.isExact ? "staleLeases" : null,
              !oldestPendingAgeFidelity.isExact ? "oldestPendingAge" : null,
              !failureReasonsFidelity.isExact ? "failureReasons" : null,
            ].filter(Boolean) as string[],
          }
        : undefined,
    components,
  };
}

function deepCloneDelivery(d: CommunicationDeliveryRecord): CommunicationDeliveryRecord {
  return JSON.parse(JSON.stringify(d));
}

const internalSeeders = new WeakMap<
  InMemoryCommunicationOutboxRepository,
  (record: CommunicationDeliveryRecord) => void
>();

const internalCounters = new WeakMap<
  InMemoryCommunicationOutboxRepository,
  () => number
>();

/**
 * Per-key asynchronous mutex to coordinate operations on individual delivery records.
 * Concurrent operations on different delivery keys proceed without blocking.
 */
class KeyedAsyncMutex {
  private tailMap = new Map<string, Promise<unknown>>();

  isLocked(key: string): boolean {
    return this.tailMap.has(key);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tailMap.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = prev.then(
      () => current,
      () => current
    );
    this.tailMap.set(key, tail);

    tail.finally(() => {
      if (this.tailMap.get(key) === tail) {
        this.tailMap.delete(key);
      }
    });

    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Ephemeral In-Memory Outbox Repository for tests and local development.
 */
export class InMemoryCommunicationOutboxRepository implements CommunicationOutboxRepository {
  #store: Map<string, CommunicationDeliveryRecord> = new Map();
  #tokenGenerator: () => string;
  #mutex = new KeyedAsyncMutex();
  #rotationOffset = 0;

  constructor(tokenGenerator?: () => string) {
    if (tokenGenerator !== undefined && typeof tokenGenerator !== "function") {
      throw new TypeError(
        "InMemoryCommunicationOutboxRepository constructor expects an optional tokenGenerator function, not an external store or object."
      );
    }
    this.#tokenGenerator = tokenGenerator || (() => `claim_tok_${randomUUID()}`);

    internalSeeders.set(this, (record: CommunicationDeliveryRecord) => {
      const validated = CommunicationDeliveryRecordSchema.parse(record);
      this.#store.set(validated.id, deepCloneDelivery(validated));
    });

    internalCounters.set(this, () => this.#store.size);
  }

  isDeliveryLocked(deliveryId: string): boolean {
    return this.#mutex.isLocked(deliveryId);
  }

  getRotationOffset(): number {
    return this.#rotationOffset;
  }

  setRotationOffset(offset: number): void {
    this.#rotationOffset = ((offset % 3) + 3) % 3;
  }

  async claimEligibleDeliveries(
    claimOwner: string,
    leaseDurationMs: number,
    limit: number,
    now: Date
  ): Promise<CommunicationDeliveryRecord[]> {
    const claimed: CommunicationDeliveryRecord[] = [];
    const nowTime = now.getTime();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(nowTime + leaseDurationMs).toISOString();

    // Group-fair candidate partition (Phase 6.5.2 & Phase 6.5.3):
    // Partitions candidates into expired leases, due retries, and pending.
    const expiredLeases: CommunicationDeliveryRecord[] = [];
    const dueRetries: CommunicationDeliveryRecord[] = [];
    const pending: CommunicationDeliveryRecord[] = [];

    for (const record of Array.from(this.#store.values())) {
      const effectiveCallAttempts = getEffectiveCallAttemptCount(record);
      const maxAttempts = record.maxAttempts || 3;

      if (
        record.status === "processing" &&
        Boolean(record.leaseExpiresAt && new Date(record.leaseExpiresAt).getTime() <= nowTime)
      ) {
        expiredLeases.push(record);
      } else if (
        record.status === "failed" &&
        effectiveCallAttempts < maxAttempts &&
        (!record.nextRetryAt || new Date(record.nextRetryAt).getTime() <= nowTime)
      ) {
        dueRetries.push(record);
      } else if (record.status === "pending") {
        pending.push(record);
      }
    }

    // True Rotating Queue Fairness (Phase 6.5.3):
    // Rotate the starting candidate group across successive batches:
    // Group 0: expired leases
    // Group 1: due retries
    // Group 2: pending deliveries
    // This ensures that even with batch sizes of 1 and 2, no eligible candidate group
    // is permanently starved under sustained backlogs in other groups.
    const groupCount = 3;
    const startGroup = this.#rotationOffset % groupCount;
    this.#rotationOffset = (this.#rotationOffset + 1) % groupCount;

    const baseBuckets = [expiredLeases, dueRetries, pending];
    const orderedBuckets = [
      baseBuckets[startGroup],
      baseBuckets[(startGroup + 1) % groupCount],
      baseBuckets[(startGroup + 2) % groupCount],
    ];

    const candidates: CommunicationDeliveryRecord[] = [];
    let idx = 0;
    let addedAny = true;

    while (
      candidates.length < limit * groupCount &&
      addedAny &&
      (idx < expiredLeases.length || idx < dueRetries.length || idx < pending.length)
    ) {
      addedAny = false;
      for (const bucket of orderedBuckets) {
        if (idx < bucket.length && candidates.length < limit * groupCount) {
          candidates.push(bucket[idx]);
          addedAny = true;
        }
      }
      idx++;
    }

    for (const record of candidates) {
      if (claimed.length >= limit) break;

      // Coordinate claim acquisition with per-delivery mutex
      await this.#mutex.runExclusive(record.id, async () => {
        if (claimed.length >= limit) return;
        const currentRecord = this.#store.get(record.id);
        if (!currentRecord) return;

        const currentEffectiveCallAttempts = getEffectiveCallAttemptCount(currentRecord);
        const currentMaxAttempts = currentRecord.maxAttempts || 3;
        const isPending = currentRecord.status === "pending";
        const isRetryableFailed =
          currentRecord.status === "failed" &&
          currentEffectiveCallAttempts < currentMaxAttempts &&
          (!currentRecord.nextRetryAt || new Date(currentRecord.nextRetryAt).getTime() <= nowTime);
        const isExpiredLease =
          currentRecord.status === "processing" &&
          Boolean(
            currentRecord.leaseExpiresAt &&
            new Date(currentRecord.leaseExpiresAt).getTime() <= nowTime
          );

        if (isPending || isRetryableFailed || isExpiredLease) {
          const nextAttemptCount = currentRecord.attemptCount + 1;
          const claimToken = this.#tokenGenerator();

          let nextCallAttemptCount = currentEffectiveCallAttempts;
          let currentAttemptId = currentRecord.currentAttemptId || null;

          if (isPending || isRetryableFailed || !currentAttemptId) {
            nextCallAttemptCount += 1;
            currentAttemptId = `${currentRecord.id}_call${nextCallAttemptCount}`;
          }

          const updated: CommunicationDeliveryRecord = {
            ...deepCloneDelivery(currentRecord),
            status: "processing",
            claimOwner,
            claimToken,
            claimedAt: nowIso,
            leaseExpiresAt,
            attemptCount: nextAttemptCount,
            callAttemptCount: nextCallAttemptCount,
            currentAttemptId,
            updatedAt: nowIso,
          };

          this.#store.set(updated.id, updated);
          claimed.push(deepCloneDelivery(updated));
        }
      });
    }

    return claimed;
  }

  async updateClaimedDelivery(
    delivery: CommunicationDeliveryRecord,
    claimContext: ClaimContext,
    now: Date
  ): Promise<void> {
    return this.#mutex.runExclusive(delivery.id, async () => {
      const existing = this.#store.get(delivery.id);
      if (!existing) {
        throw new StaleClaimError(`Delivery record '${delivery.id}' not found.`);
      }

      if (existing.status !== "processing") {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' status is '${existing.status}', expected 'processing'.`
        );
      }

      if (existing.claimOwner !== claimContext.claimOwner) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' is claimed by '${existing.claimOwner}', not '${claimContext.claimOwner}'.`
        );
      }

      if (existing.claimToken !== claimContext.claimToken) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' claimToken mismatch: held '${existing.claimToken}', attempted '${claimContext.claimToken}'.`
        );
      }

      if (existing.claimedAt !== claimContext.claimedAt) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' claimedAt '${existing.claimedAt}' does not match expected '${claimContext.claimedAt}'.`
        );
      }

      if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime()) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' lease expired at '${existing.leaseExpiresAt}', current time is '${now.toISOString()}'.`
        );
      }

      const validated = CommunicationDeliveryRecordSchema.parse(delivery);
      this.#store.set(validated.id, deepCloneDelivery(validated));
    });
  }

  async getDeliveryById(deliveryId: string): Promise<CommunicationDeliveryRecord | null> {
    const item = this.#store.get(deliveryId);
    return item ? deepCloneDelivery(item) : null;
  }

  async getDeliveriesBySessionId(sessionId: string): Promise<CommunicationDeliveryRecord[]> {
    const results: CommunicationDeliveryRecord[] = [];
    for (const record of this.#store.values()) {
      if (record.sessionId === sessionId) {
        results.push(deepCloneDelivery(record));
      }
    }
    return results;
  }

  async getDeliveryByProviderMessageId(providerMessageId: string): Promise<CommunicationDeliveryRecord | null> {
    for (const item of this.#store.values()) {
      if (item.providerResult?.providerMessageId === providerMessageId) {
        return deepCloneDelivery(item);
      }
    }
    return null;
  }

  async updateDeliveryStatusByProviderMessageId(
    providerMessageId: string,
    status: DeliveryStatus,
    providerStatus: WhatsAppMessageStatus,
    timestamp: string
  ): Promise<boolean> {
    for (const [id, item] of this.#store.entries()) {
      if (item.providerResult?.providerMessageId === providerMessageId) {
        const updated = deepCloneDelivery(item);
        updated.status = status;
        if (updated.providerResult) {
          updated.providerResult.status = providerStatus;
        }
        updated.updatedAt = timestamp;
        this.#store.set(id, updated);
        return true;
      }
    }
    return false;
  }

  async mutateSessionWithClaimFencing(
    deliveryId: string,
    claimContext: ClaimContext,
    sessionId: string,
    now: Date,
    mutator: (session: VoiceBookingSession) => VoiceBookingSession | void,
    sessionRepository?: VoiceSessionRepository,
    outboxDeliveries?: CommunicationDeliveryRecord[]
  ): Promise<boolean> {
    return this.#mutex.runExclusive(deliveryId, async () => {
      const existing = this.#store.get(deliveryId);
      if (!existing) {
        throw new StaleClaimError(`Delivery record '${deliveryId}' not found.`);
      }
      if (existing.status !== "processing") {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' is in status '${existing.status}', expected 'processing'.`
        );
      }
      if (existing.claimOwner !== claimContext.claimOwner) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' is claimed by '${existing.claimOwner}', not '${claimContext.claimOwner}'.`
        );
      }
      if (existing.claimToken !== claimContext.claimToken) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' claimToken mismatch: held '${existing.claimToken}', attempted '${claimContext.claimToken}'.`
        );
      }
      if (existing.claimedAt !== claimContext.claimedAt) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' claimedAt mismatch: held '${existing.claimedAt}', attempted '${claimContext.claimedAt}'.`
        );
      }
      if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime()) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' lease expired at '${existing.leaseExpiresAt}', current time is '${now.toISOString()}'.`
        );
      }

      if (!sessionRepository) {
        throw new Error("VoiceSessionRepository must be provided to mutateSessionWithClaimFencing in memory.");
      }

      const session = await sessionRepository.getById(sessionId);
      if (!session) return false;
      if (isTerminalVoiceState(session.state)) return true;

      const modified = mutator(session);
      const targetSession = modified || session;
      if (
        outboxDeliveries &&
        outboxDeliveries.length > 0 &&
        typeof (sessionRepository as unknown as { saveWithOutbox?: unknown }).saveWithOutbox === "function"
      ) {
        await (sessionRepository as unknown as { saveWithOutbox: (sess: VoiceBookingSession, rev: number, delivs: CommunicationDeliveryRecord[]) => Promise<void> }).saveWithOutbox(
          targetSession,
          session.revision,
          outboxDeliveries
        );
      } else {
        await sessionRepository.save(targetSession, session.revision);
      }

      return true;
    });
  }

  async getMetrics(now?: Date): Promise<OutboxMetricsSummary> {
    const evalTime = now || new Date();
    const records = Array.from(this.#store.values()).map((d) => deepCloneDelivery(d));
    return computeOutboxMetricsFromRecords(records, evalTime);
  }
}

/**
 * Internal package-private helper used exclusively by TestInMemoryCommunicationOutboxRepository
 * in testFixture.ts. Not exported from the public communication barrel (index.ts).
 */
export function internalSeedOutboxRecord(
  repo: InMemoryCommunicationOutboxRepository,
  record: CommunicationDeliveryRecord
): void {
  const seeder = internalSeeders.get(repo);
  if (!seeder) {
    throw new Error("Unable to seed delivery: repository instance has no registered seeder.");
  }
  seeder(record);
}

/**
 * Internal package-private helper used exclusively by TestInMemoryCommunicationOutboxRepository
 * in testFixture.ts. Not exported from the public communication barrel (index.ts).
 */
export function internalGetOutboxRecordCount(
  repo: InMemoryCommunicationOutboxRepository
): number {
  const counter = internalCounters.get(repo);
  return counter ? counter() : 0;
}

export interface FirestoreCommunicationOutboxRepositoryOptions {
  allowLocalFallback?: boolean;
}

/**
 * Server-Authoritative Firestore Outbox Repository
 */
export class FirestoreCommunicationOutboxRepository implements CommunicationOutboxRepository {
  private collectionName = "booking_communication_outbox";
  private tokenGenerator: () => string;
  private dbProvider?: () => FirebaseFirestore.Firestore | null;
  private fallbackRotationOffset = 0;
  private allowLocalFallback: boolean;

  constructor(
    tokenGeneratorOrOptions?: (() => string) | FirestoreCommunicationOutboxRepositoryOptions,
    dbProvider?: (() => FirebaseFirestore.Firestore | null) | FirestoreCommunicationOutboxRepositoryOptions,
    options?: FirestoreCommunicationOutboxRepositoryOptions
  ) {
    let opts: FirestoreCommunicationOutboxRepositoryOptions | undefined;

    if (typeof tokenGeneratorOrOptions === "object" && tokenGeneratorOrOptions !== null) {
      opts = tokenGeneratorOrOptions;
      this.tokenGenerator = () => `claim_tok_${randomUUID()}`;
      this.dbProvider = undefined;
    } else {
      this.tokenGenerator = tokenGeneratorOrOptions || (() => `claim_tok_${randomUUID()}`);
      if (typeof dbProvider === "object" && dbProvider !== null) {
        opts = dbProvider;
        this.dbProvider = undefined;
      } else {
        this.dbProvider = dbProvider;
        opts = options;
      }
    }

    this.allowLocalFallback = Boolean(opts?.allowLocalFallback);
  }

  setAllowLocalFallback(allow: boolean): void {
    this.allowLocalFallback = allow;
  }

  isLocalFallbackAllowed(): boolean {
    return this.allowLocalFallback;
  }

  getRotationOffset(): number {
    return this.fallbackRotationOffset;
  }

  setRotationOffset(offset: number): void {
    const target = ((offset % 3) + 3) % 3;
    this.fallbackRotationOffset = target;
    const db = this.getDb();
    if (db && typeof db.collection === "function") {
      try {
        const col = db.collection(this.collectionName);
        if (col && typeof col.doc === "function") {
          col.doc("_rotation_cursor")
            .set(
              {
                cursor: target,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            )
            .catch(() => {});
        }
      } catch {
        // Safe no-op on non-standard mock collections
      }
    }
  }

  /**
   * Retrieves the current shared, persistent rotation cursor from Firestore.
   */
  async getSharedRotationCursor(): Promise<number> {
    const db = this.getDb();
    if (!db || typeof db.collection !== "function") {
      if (this.allowLocalFallback) return this.fallbackRotationOffset % 3;
      throw new Error("[OUTBOX_ROTATION_ERROR] Firestore Admin DB unavailable to read rotation cursor.");
    }
    try {
      const col = db.collection(this.collectionName);
      if (!col || typeof col.doc !== "function") {
        if (this.allowLocalFallback) return this.fallbackRotationOffset % 3;
        throw new Error("[OUTBOX_ROTATION_ERROR] Firestore collection does not implement doc().");
      }
      const cursorRef = col.doc("_rotation_cursor");
      const snap = await cursorRef.get();
      if (!snap || !snap.exists) return 0;
      const data = snap.data();
      return typeof data?.cursor === "number" ? ((Math.floor(data.cursor) % 3) + 3) % 3 : 0;
    } catch (err) {
      if (this.allowLocalFallback) return this.fallbackRotationOffset % 3;
      throw new Error(
        `[OUTBOX_ROTATION_ERROR] Failed to read rotation cursor: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Atomically advances the shared rotation cursor in Firestore and returns the prior cursor value.
   * Ensures that concurrent worker instances and independent repository instances advance
   * the rotation cursor safely without losing updates or overwriting each other.
   * 
   * FAIL-CLOSED IN PRODUCTION (Phase 6.5.5):
   * In production, if the Firestore transaction fails or if the database does not support
   * distributed cursor operations, the error is propagated rather than silently falling back
   * to instance-local rotation (which would compromise queue fairness across distributed workers).
   * Local fallback is only permitted when explicitly configured via allowLocalFallback: true.
   */
  private async getAndAdvanceRotationCursor(db: FirebaseFirestore.Firestore): Promise<number> {
    const col = db?.collection?.(this.collectionName);
    if (!col || typeof col.doc !== "function" || typeof db.runTransaction !== "function") {
      if (this.allowLocalFallback) {
        const fallback = this.fallbackRotationOffset % 3;
        this.fallbackRotationOffset = (this.fallbackRotationOffset + 1) % 3;
        return fallback;
      }
      throw new Error(
        `[OUTBOX_ROTATION_UNSUPPORTED_MOCK] Firestore database does not implement collection().doc() or runTransaction(). ` +
        `Distributed queue rotation requires full Firestore support or explicit { allowLocalFallback: true } test configuration.`
      );
    }

    const cursorRef = col.doc("_rotation_cursor");
    try {
      return await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(cursorRef);
        let currentOffset = 0;
        if (snap && snap.exists) {
          const data = snap.data();
          if (data && typeof data.cursor === "number" && Number.isFinite(data.cursor)) {
            currentOffset = Math.floor(data.cursor);
          }
        }
        const nextOffset = (currentOffset + 1) % 3;
        transaction.set(
          cursorRef,
          {
            cursor: nextOffset,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        return ((currentOffset % 3) + 3) % 3;
      });
    } catch (txError) {
      if (this.allowLocalFallback) {
        const fallback = this.fallbackRotationOffset % 3;
        this.fallbackRotationOffset = (this.fallbackRotationOffset + 1) % 3;
        return fallback;
      }
      // In production, propagate cursor transaction errors so the worker reports failure
      // rather than silently losing distributed fairness.
      throw new Error(
        `[OUTBOX_ROTATION_TRANSACTION_FAILED] Distributed rotation cursor transaction failed: ${
          txError instanceof Error ? txError.message : String(txError)
        }`
      );
    }
  }

  /**
   * Sets the shared rotation cursor directly in Firestore for deterministic test isolation.
   */
  async setSharedRotationCursor(cursor: number): Promise<void> {
    const target = ((Math.floor(cursor) % 3) + 3) % 3;
    this.fallbackRotationOffset = target;
    const db = this.getDb();
    if (!db || typeof db.collection !== "function") {
      if (this.allowLocalFallback) return;
      throw new Error("[OUTBOX_ROTATION_ERROR] Firestore Admin DB unavailable to set rotation cursor.");
    }
    try {
      const col = db.collection(this.collectionName);
      if (!col || typeof col.doc !== "function") {
        if (this.allowLocalFallback) return;
        throw new Error("[OUTBOX_ROTATION_ERROR] Firestore collection does not implement doc().");
      }
      await col.doc("_rotation_cursor").set(
        {
          cursor: target,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (err) {
      if (this.allowLocalFallback) return;
      throw new Error(
        `[OUTBOX_ROTATION_ERROR] Failed to set rotation cursor: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private getDb(): FirebaseFirestore.Firestore | null {
    return this.dbProvider ? this.dbProvider() : getAdminFirestore();
  }

  async claimEligibleDeliveries(
    claimOwner: string,
    leaseDurationMs: number,
    limit: number,
    now: Date
  ): Promise<CommunicationDeliveryRecord[]> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }

    const nowIso = now.toISOString();
    const nowTime = now.getTime();
    const leaseExpiresAt = new Date(nowTime + leaseDurationMs).toISOString();

    // Candidate Selection Strategy (Phase 6.5.2 & Phase 6.5.4 Distributed Queue Fairness):
    // Active leases (processing with leaseExpiresAt > now) and not-yet-due retries (failed with nextRetryAt > now)
    // must NEVER starve eligible deliveries, and a backlog of pending deliveries must NEVER starve
    // expired leases or due retries.
    // Successive batches rotate the starting candidate group across:
    // Group 0: expired leases
    // Group 1: due retries
    // Group 2: pending deliveries
    // In Phase 6.5.4, this rotation state is shared and persistent in Firestore via atomic transaction,
    // ensuring independent repository instances and concurrent workers advance the cursor fairly.

    let expiredDocs: FirebaseFirestore.QueryDocumentSnapshot[];
    let retryDocs: FirebaseFirestore.QueryDocumentSnapshot[];
    let pendingDocs: FirebaseFirestore.QueryDocumentSnapshot[];

    const queryLimit = Math.max(limit, 3);

    try {
      [expiredDocs, retryDocs, pendingDocs] = await Promise.all([
        db
          .collection(this.collectionName)
          .where("status", "==", "processing")
          .where("leaseExpiresAt", "<=", nowIso)
          .limit(queryLimit)
          .get()
          .then((s) => s.docs),
        db
          .collection(this.collectionName)
          .where("status", "==", "failed")
          .where("nextRetryAt", "<=", nowIso)
          .limit(queryLimit)
          .get()
          .then((s) => s.docs),
        db
          .collection(this.collectionName)
          .where("status", "==", "pending")
          .limit(queryLimit)
          .get()
          .then((s) => s.docs),
      ]);
    } catch (queryErr) {
      // Fail visibly when configured indexed queries cannot execute rather than falling back
      // to blind unordered scans that hide eligible deliveries.
      throw new Error(
        `[OUTBOX_INDEX_QUERY_ERROR] Configured indexed candidate query failed: ${
          queryErr instanceof Error ? queryErr.message : String(queryErr)
        }. Ensure composite indexes in firestore.indexes.json are deployed.`
      );
    }

    // Filter due retries to ensure maxAttempts hasn't already been reached
    const eligibleRetryDocs = retryDocs.filter((d) => {
      const data = d.data() as CommunicationDeliveryRecord;
      const effectiveAttempts = getEffectiveCallAttemptCount(data);
      const max = data.maxAttempts || 3;
      return effectiveAttempts < max;
    });

    // Distributed Rotating Queue Fairness (Phase 6.5.4):
    // Atomically advance shared rotation cursor across repository instances & workers
    const startGroup = await this.getAndAdvanceRotationCursor(db);
    this.fallbackRotationOffset = (startGroup + 1) % 3;

    const baseBuckets = [expiredDocs, eligibleRetryDocs, pendingDocs];
    const orderedBuckets = [
      baseBuckets[startGroup],
      baseBuckets[(startGroup + 1) % 3],
      baseBuckets[(startGroup + 2) % 3],
    ];

    // Fair rotating round-robin interleaving across candidate groups
    const candidateDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    const seenCandidateIds = new Set<string>();

    let addedAny = true;
    let bucketIndex = 0;

    while (candidateDocs.length < limit && addedAny) {
      addedAny = false;
      for (const bucket of orderedBuckets) {
        if (bucketIndex < bucket.length && candidateDocs.length < limit) {
          const doc = bucket[bucketIndex];
          if (!seenCandidateIds.has(doc.id)) {
            seenCandidateIds.add(doc.id);
            candidateDocs.push(doc);
            addedAny = true;
          }
        }
      }
      bucketIndex++;
    }

    const claimed: CommunicationDeliveryRecord[] = [];

    for (const doc of candidateDocs) {
      if (claimed.length >= limit) break;

      const data = doc.data() as CommunicationDeliveryRecord;
      const isPending = data.status === "pending";
      const effectiveCallAttempts = getEffectiveCallAttemptCount(data);
      const maxAttempts = data.maxAttempts || 3;
      const isRetryableFailed =
        data.status === "failed" &&
        effectiveCallAttempts < maxAttempts &&
        (!data.nextRetryAt || new Date(data.nextRetryAt).getTime() <= now.getTime());
      const isExpiredLease =
        data.status === "processing" &&
        Boolean(data.leaseExpiresAt && new Date(data.leaseExpiresAt).getTime() <= now.getTime());

      if (isPending || isRetryableFailed || isExpiredLease) {
        try {
          const success = await db.runTransaction(async (transaction: FirebaseFirestore.Transaction) => {
            const freshDoc = await transaction.get(doc.ref);
            if (!freshDoc.exists) return false;
            const freshData = freshDoc.data() as CommunicationDeliveryRecord;

            // Re-verify eligibility under transaction lock
            const stillPending = freshData.status === "pending";
            const freshEffectiveCallAttempts = getEffectiveCallAttemptCount(freshData);
            const freshMaxAttempts = freshData.maxAttempts || 3;
            const stillRetryableFailed =
              freshData.status === "failed" &&
              freshEffectiveCallAttempts < freshMaxAttempts &&
              (!freshData.nextRetryAt || new Date(freshData.nextRetryAt).getTime() <= now.getTime());
            const stillExpiredLease =
              freshData.status === "processing" &&
              Boolean(freshData.leaseExpiresAt && new Date(freshData.leaseExpiresAt).getTime() <= now.getTime());

            if (!stillPending && !stillRetryableFailed && !stillExpiredLease) {
              return false;
            }

            const nextAttemptCount = freshData.attemptCount + 1;
            const claimToken = this.tokenGenerator();

            let nextCallAttemptCount = freshEffectiveCallAttempts;
            let currentAttemptId = freshData.currentAttemptId || null;

            if (stillPending || stillRetryableFailed || !currentAttemptId) {
              // Genuinely new call attempt (initial attempt or retry after failed attempt)
              nextCallAttemptCount += 1;
              currentAttemptId = `${freshData.id}_call${nextCallAttemptCount}`;
            }
            // If stillExpiredLease and currentAttemptId is already set:
            // preserve existing nextCallAttemptCount and currentAttemptId (in-flight attempt recovery)

            const updated: CommunicationDeliveryRecord = {
              ...freshData,
              status: "processing",
              claimOwner,
              claimToken,
              claimedAt: nowIso,
              leaseExpiresAt,
              attemptCount: nextAttemptCount,
              callAttemptCount: nextCallAttemptCount,
              currentAttemptId,
              updatedAt: nowIso,
            };

            transaction.set(doc.ref, updated);
            return updated;
          });

          if (success) {
            claimed.push(success);
          }
        } catch {
          // Contention on this delivery; continue to next candidate
        }
      }
    }

    return claimed;
  }

  async updateClaimedDelivery(
    delivery: CommunicationDeliveryRecord,
    claimContext: ClaimContext,
    now: Date
  ): Promise<void> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }

    const docRef = db.collection(this.collectionName).doc(delivery.id);

    await db.runTransaction(async (transaction: FirebaseFirestore.Transaction) => {
      // 1. Transaction Read Phase: Must read doc before writes
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new StaleClaimError(`Delivery record '${delivery.id}' not found.`);
      }

      const existing = snap.data() as CommunicationDeliveryRecord;

      // 2. Transaction Validation Phase: Verify lease ownership & active lease
      if (existing.status !== "processing") {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' status is '${existing.status}', expected 'processing'.`
        );
      }

      if (existing.claimOwner !== claimContext.claimOwner) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' is claimed by '${existing.claimOwner}', not '${claimContext.claimOwner}'.`
        );
      }

      if (existing.claimToken !== claimContext.claimToken) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' claimToken mismatch: held '${existing.claimToken}', attempted '${claimContext.claimToken}'.`
        );
      }

      if (existing.claimedAt !== claimContext.claimedAt) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' claimedAt '${existing.claimedAt}' does not match expected '${claimContext.claimedAt}'.`
        );
      }

      if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= now.getTime()) {
        throw new StaleClaimError(
          `Delivery '${delivery.id}' lease expired at '${existing.leaseExpiresAt}', current time is '${now.toISOString()}'.`
        );
      }

      // 3. Transaction Write Phase
      const validated = CommunicationDeliveryRecordSchema.parse(delivery);
      transaction.set(docRef, validated);
    });
  }

  async getDeliveryById(deliveryId: string): Promise<CommunicationDeliveryRecord | null> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }
    const doc = await db.collection(this.collectionName).doc(deliveryId).get();
    if (!doc.exists) return null;
    return doc.data() as CommunicationDeliveryRecord;
  }

  async getDeliveriesBySessionId(sessionId: string): Promise<CommunicationDeliveryRecord[]> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }
    const snap = await db
      .collection(this.collectionName)
      .where("sessionId", "==", sessionId)
      .get();

    return snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => d.data() as CommunicationDeliveryRecord);
  }

  async getDeliveryByProviderMessageId(providerMessageId: string): Promise<CommunicationDeliveryRecord | null> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }
    const snap = await db
      .collection(this.collectionName)
      .where("providerResult.providerMessageId", "==", providerMessageId)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].data() as CommunicationDeliveryRecord;
  }

  async updateDeliveryStatusByProviderMessageId(
    providerMessageId: string,
    status: DeliveryStatus,
    providerStatus: WhatsAppMessageStatus,
    timestamp: string
  ): Promise<boolean> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }
    const snap = await db
      .collection(this.collectionName)
      .where("providerResult.providerMessageId", "==", providerMessageId)
      .limit(1)
      .get();
    if (snap.empty) return false;
    await snap.docs[0].ref.update({
      status,
      "providerResult.status": providerStatus,
      updatedAt: timestamp,
    });
    return true;
  }

  async mutateSessionWithClaimFencing(
    deliveryId: string,
    claimContext: ClaimContext,
    sessionId: string,
    now: Date,
    mutator: (session: VoiceBookingSession) => VoiceBookingSession | void,
    _sessionRepository?: VoiceSessionRepository,
    outboxDeliveries?: CommunicationDeliveryRecord[]
  ): Promise<boolean> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }

    const deliveryRef = db.collection(this.collectionName).doc(deliveryId);
    const sessionRef = db.collection(VOICE_BOOKING_COLLECTION).doc(sessionId);

    return await db.runTransaction(async (transaction: FirebaseFirestore.Transaction) => {
      // 1. Transaction Read Phase: Read both delivery and session
      const deliveryDoc = await transaction.get(deliveryRef);
      if (!deliveryDoc.exists) {
        throw new StaleClaimError(`Delivery '${deliveryId}' not found.`);
      }
      const delivery = deliveryDoc.data() as CommunicationDeliveryRecord;
      if (delivery.status !== "processing") {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' is in status '${delivery.status}', expected 'processing'.`
        );
      }
      if (delivery.claimOwner !== claimContext.claimOwner) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' is claimed by '${delivery.claimOwner}', not '${claimContext.claimOwner}'.`
        );
      }
      if (delivery.claimToken !== claimContext.claimToken) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' claimToken mismatch: held '${delivery.claimToken}', attempted '${claimContext.claimToken}'.`
        );
      }
      if (delivery.claimedAt !== claimContext.claimedAt) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' claimedAt mismatch: held '${delivery.claimedAt}', attempted '${claimContext.claimedAt}'.`
        );
      }
      if (!delivery.leaseExpiresAt || new Date(delivery.leaseExpiresAt).getTime() <= now.getTime()) {
        throw new StaleClaimError(
          `Delivery '${deliveryId}' lease expired at '${delivery.leaseExpiresAt}', current time is '${now.toISOString()}'.`
        );
      }

      const sessionDoc = await transaction.get(sessionRef);
      if (!sessionDoc.exists) {
        return false;
      }
      const session = deserializeSessionFromFirestore(sessionDoc.data());
      if (isTerminalVoiceState(session.state)) {
        return true;
      }

      // 2. Mutation Phase
      const modified = mutator(session);
      const targetSession = modified || session;
      targetSession.revision = (session.revision || 1) + 1;
      const serialized = serializeSessionForFirestore(targetSession);

      // 3. Transaction Write Phase: Write the session inside this same transaction
      transaction.set(sessionRef, serialized);
      if (outboxDeliveries && outboxDeliveries.length > 0) {
        for (const outboxRecord of outboxDeliveries) {
          const outboxRef = db.collection(this.collectionName).doc(outboxRecord.id);
          transaction.set(outboxRef, outboxRecord);
        }
      }
      return true;
    });
  }

  async getMetrics(now?: Date): Promise<OutboxMetricsSummary> {
    const db = this.getDb();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreCommunicationOutboxRepository.");
    }
    const evalTime = now || new Date();
    const evalMs = evalTime.getTime();
    const col = db.collection(this.collectionName);

    // Scalable, Bounded Approach (Phase 6.5.1):
    // Avoid loading unbounded full collections into memory.
    // Use Firestore count aggregations (.count().get()) for document counts (0 payload/PII).
    // Use bounded projections (.select(...).limit(...)) for timestamp calculations and failure codes.
    try {
      const [
        pendingSnap,
        processingSnap,
        dispatchedSnap,
        blockedSnap,
        failedSnap,
        permFailedSnap,
        waSnap,
        voiceSnap,
      ] = await Promise.all([
        col.where("status", "==", "pending").count().get(),
        col.where("status", "==", "processing").count().get(),
        col.where("status", "==", "dispatched").count().get(),
        col.where("status", "==", "blocked").count().get(),
        col.where("status", "==", "failed").count().get(),
        col.where("status", "==", "permanently_failed").count().get(),
        col.where("channel", "==", "whatsapp").count().get(),
        col.where("channel", "==", "voice").count().get(),
      ]);

      const counts = {
        pending: pendingSnap.data().count,
        processing: processingSnap.data().count,
        dispatched: dispatchedSnap.data().count,
        blocked: blockedSnap.data().count,
        failed: failedSnap.data().count,
        permanently_failed: permFailedSnap.data().count,
        total: 0,
      };
      counts.total =
        counts.pending +
        counts.processing +
        counts.dispatched +
        counts.blocked +
        counts.failed +
        counts.permanently_failed;

      const channelBreakdown = {
        whatsapp: waSnap.data().count,
        voice: voiceSnap.data().count,
      };

      // Bounded read for stale leases (only 'processing' docs, selecting only leaseExpiresAt, capped at 250)
      let staleLeasesCount = 0;
      if (counts.processing > 0) {
        const activeLeaseSnap = await col
          .where("status", "==", "processing")
          .select("leaseExpiresAt")
          .limit(250)
          .get();

        for (const doc of activeLeaseSnap.docs) {
          const lease = doc.data().leaseExpiresAt;
          if (lease && new Date(lease).getTime() <= evalMs) {
            staleLeasesCount++;
          }
        }
      }

      // Bounded read for oldest pending delivery (limit 50, selecting only createdAt, zero PII)
      let oldestPendingAgeSeconds: number | null = null;
      if (counts.pending > 0) {
        const pendingAgeSnap = await col
          .where("status", "==", "pending")
          .select("createdAt")
          .limit(50)
          .get();

        let oldestMs: number | null = null;
        for (const doc of pendingAgeSnap.docs) {
          const created = doc.data().createdAt;
          if (created) {
            const ms = new Date(created).getTime();
            if (!isNaN(ms) && (oldestMs === null || ms < oldestMs)) {
              oldestMs = ms;
            }
          }
        }
        if (oldestMs !== null) {
          oldestPendingAgeSeconds = Math.max(0, Math.floor((evalMs - oldestMs) / 1000));
        }
      }

      // Bounded read for recent failure reasons (limit 100, selecting only lastError.code)
      const failureReasons: Record<string, number> = {};
      if (counts.failed > 0 || counts.permanently_failed > 0) {
        const failureSnap = await col
          .where("status", "in", ["failed", "permanently_failed"])
          .select("lastError.code")
          .limit(100)
          .get();

        for (const doc of failureSnap.docs) {
          const code = doc.data().lastError?.code;
          if (typeof code === "string" && code.trim()) {
            failureReasons[code] = (failureReasons[code] || 0) + 1;
          }
        }
      }

      // Phase 6.5.3 Accurate Metrics Fidelity:
      // Document counts and channel breakdown are exact Firestore count aggregations.
      // Stale leases, oldest pending age, and failure reasons are bounded projection samples.
      // The complete metrics response MUST NOT be reported as 'exact' while any component is sampled.
      const countsFidelity: MetricComponentFidelity = {
        fidelity: "exact",
        isExact: true,
        notes: "Exact Firestore count aggregation (.count().get())",
      };

      const channelBreakdownFidelity: MetricComponentFidelity = {
        fidelity: "exact",
        isExact: true,
        notes: "Exact Firestore count aggregation (.count().get())",
      };

      const staleLeasesFidelity: MetricComponentFidelity = {
        fidelity: "sampled",
        isExact: false,
        sampleLimit: 250,
        notes: "Bounded projection query capped at 250 documents",
      };

      const oldestPendingAgeFidelity: MetricComponentFidelity = {
        fidelity: "sampled",
        isExact: false,
        sampleLimit: 50,
        notes: "Bounded projection query capped at 50 documents",
      };

      const failureReasonsFidelity: MetricComponentFidelity = {
        fidelity: "sampled",
        isExact: false,
        sampleLimit: 100,
        notes: "Bounded projection query capped at 100 documents",
      };

      const components: OutboxMetricsFidelityBreakdown = {
        counts: countsFidelity,
        channelBreakdown: channelBreakdownFidelity,
        staleLeases: staleLeasesFidelity,
        oldestPendingAge: oldestPendingAgeFidelity,
        failureReasons: failureReasonsFidelity,
      };

      return {
        counts,
        staleLeasesCount,
        oldestPendingAgeSeconds,
        channelBreakdown,
        failureReasons,
        evaluatedAt: evalTime.toISOString(),
        fidelity: "sampled",
        isExact: false,
        sampleDetails: {
          sampleLimit: 250,
          reason:
            "Bounded sample queries used for staleLeases (limit 250), oldestPendingAge (limit 50), and failureReasons (limit 100); aggregate document counts are exact.",
          sampledComponents: ["staleLeases", "oldestPendingAge", "failureReasons"],
        },
        components,
      };
    } catch (error) {
      // Phase 6.5.2: Remove misleading partial metrics.
      // Do not silently return a 500-record fallback as complete metrics when Firestore aggregation fails.
      // Fail visibly on aggregation failures so monitoring systems receive an explicit error rather than
      // an unannounced partial count.
      throw new Error(
        `[OUTBOX_METRICS_AGGREGATION_FAILED] Firestore count aggregation failed: ${
          error instanceof Error ? error.message : String(error)
        }. Exact outbox metrics could not be aggregated.`
      );
    }
  }
}
