/**
 * BREW Coffee Platform — Phase 6.6.1 Voice Call Attempt Repository
 *
 * Durable Firestore & In-Memory repositories for asynchronous voice call attempts.
 * Implements monotonic rank ordering, idempotent duplicate handling, terminal-state immutability,
 * and constant-time providerCallId indexing.
 */

import { getAdminFirestore } from "../../firebaseAdmin";
import {
  CorrelateWebhookParams,
  CreateVoiceCallAttemptParams,
  isTerminalVoiceCallStatus,
  UpdateVoiceCallAttemptStatusParams,
  VOICE_CALL_STATUS_RANKS,
  VoiceCallAttemptRecord,
  VoiceCallAttemptRepository,
  VoiceCallAttemptUpdateResult,
} from "./types";
import {
  CorrelateWebhookParamsSchema,
  CreateVoiceCallAttemptParamsSchema,
  UpdateVoiceCallAttemptStatusParamsSchema,
  VoiceCallAttemptRecordSchema,
} from "./schemas";

/**
 * Computes state transition result following monotonic rank and terminal immutability invariants.
 */
export function evaluateStatusUpdate(
  current: VoiceCallAttemptRecord,
  params: UpdateVoiceCallAttemptStatusParams,
  nowIso: string
): VoiceCallAttemptUpdateResult {
  const incomingStatus = params.status;
  const incomingRank = VOICE_CALL_STATUS_RANKS[incomingStatus];
  const eventTime = params.timestamp || nowIso;

  // 1. Idempotent duplicate: identical status received again
  if (current.status === incomingStatus) {
    return {
      outcome: "idempotent_duplicate",
      attempt: { ...current },
      reason: `Attempt is already in state '${incomingStatus}'`,
    };
  }

  // 2. Terminal state conflict & immutability: terminal attempts cannot be mutated
  if (current.isTerminal) {
    if (isTerminalVoiceCallStatus(incomingStatus)) {
      return {
        outcome: "terminal_conflict",
        attempt: {
          ...current,
          terminalConflict: {
            conflictingStatus: incomingStatus,
            receivedAt: eventTime,
            reason: `Attempt is already terminal in state '${current.status}' and cannot transition to '${incomingStatus}'`,
            rawProviderMetadata: params.rawProviderMetadata,
          },
          updatedAt: nowIso,
        },
        reason: `Attempt is already terminal in state '${current.status}' and cannot transition to '${incomingStatus}'`,
      };
    }
    return {
      outcome: "ignored_out_of_order",
      attempt: { ...current },
      reason: `Attempt is already terminal in state '${current.status}'; ignoring non-terminal event '${incomingStatus}'`,
    };
  }

  // 3. Monotonic rank ordering: delayed/out-of-order events with lower rank are ignored
  if (incomingRank < current.statusRank) {
    return {
      outcome: "ignored_out_of_order",
      attempt: { ...current },
      reason: `Incoming status '${incomingStatus}' (rank ${incomingRank}) is lower than current status '${current.status}' (rank ${current.statusRank})`,
    };
  }

  // 4. Valid forward state transition
  const updated: VoiceCallAttemptRecord = {
    ...current,
    status: incomingStatus,
    statusRank: incomingRank,
    isTerminal: isTerminalVoiceCallStatus(incomingStatus),
    updatedAt: nowIso,
  };

  if (incomingStatus === "ringing" && !updated.ringingAt) {
    updated.ringingAt = eventTime;
  } else if (incomingStatus === "answered" && !updated.answeredAt) {
    updated.answeredAt = eventTime;
  } else if (isTerminalVoiceCallStatus(incomingStatus)) {
    if (!updated.completedAt) {
      updated.completedAt = eventTime;
    }
    if (typeof params.durationSeconds === "number") {
      updated.durationSeconds = Math.max(0, Math.floor(params.durationSeconds));
    }
    if (params.errorCode) {
      updated.errorCode = params.errorCode.trim();
    }
    if (params.errorMessage) {
      updated.errorMessage = params.errorMessage.trim();
    }
  }

  if (params.rawProviderMetadata) {
    updated.rawProviderMetadata = {
      ...(updated.rawProviderMetadata || {}),
      ...params.rawProviderMetadata,
    };
  }

  return {
    outcome: "updated",
    attempt: updated,
  };
}

/**
 * In-Memory Voice Call Attempt Repository
 * Ultra-fast, zero-dependency repository for tests and local simulation harnesses.
 */
export class InMemoryVoiceCallAttemptRepository implements VoiceCallAttemptRepository {
  private attempts = new Map<string, VoiceCallAttemptRecord>();
  private providerIndex = new Map<string, string>(); // providerCallId -> internal attemptId

  async createAttempt(params: CreateVoiceCallAttemptParams): Promise<VoiceCallAttemptRecord> {
    const validated = CreateVoiceCallAttemptParamsSchema.parse(params);
    const existing = this.attempts.get(validated.id);
    if (existing) {
      return JSON.parse(JSON.stringify(existing));
    }

    const now = new Date().toISOString();
    const initiatedAt = validated.initiatedAt || now;

    if (validated.providerCallId) {
      const existingMapped = this.providerIndex.get(validated.providerCallId);
      if (existingMapped && existingMapped !== validated.id) {
        throw new Error(
          `Provider call ID conflict: '${validated.providerCallId}' is already mapped to attempt '${existingMapped}'. Duplicate providerCallIds are forbidden.`
        );
      }
    }

    const record: VoiceCallAttemptRecord = {
      id: validated.id,
      deliveryId: validated.deliveryId,
      sessionId: validated.sessionId,
      phoneNumberMasked: validated.phoneNumberMasked,
      channel: "voice",
      provider: validated.provider,
      direction: "outbound",
      status: "initiated",
      statusRank: VOICE_CALL_STATUS_RANKS.initiated,
      isTerminal: false,
      initiationState: validated.initiationState || (validated.providerCallId ? "accepted" : "pending"),
      claimOwner: validated.claimOwner || null,
      claimToken: validated.claimToken || null,
      leaseExpiresAt: validated.leaseExpiresAt || null,
      terminalConflict: null,
      providerCallId: validated.providerCallId || null,
      initiatedAt,
      createdAt: now,
      updatedAt: now,
      rawProviderMetadata: validated.metadata ? { ...validated.metadata } : undefined,
    };

    const parsed = VoiceCallAttemptRecordSchema.parse(record);
    this.attempts.set(parsed.id, parsed);

    if (parsed.providerCallId) {
      this.providerIndex.set(parsed.providerCallId, parsed.id);
    }

    return JSON.parse(JSON.stringify(parsed));
  }

  async getById(id: string): Promise<VoiceCallAttemptRecord | null> {
    const record = this.attempts.get(id);
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  async getByProviderCallId(providerCallId: string): Promise<VoiceCallAttemptRecord | null> {
    const internalId = this.providerIndex.get(providerCallId);
    if (!internalId) return null;
    return this.getById(internalId);
  }

  async attachProviderCallId(
    id: string,
    providerCallId: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    const existing = this.attempts.get(id);
    if (!existing) {
      throw new Error(`VoiceCallAttempt '${id}' not found to attach providerCallId.`);
    }

    if (existing.providerCallId === providerCallId) {
      return JSON.parse(JSON.stringify(existing));
    }

    if (existing.providerCallId && existing.providerCallId !== providerCallId) {
      throw new Error(
        `Provider call ID conflict for attempt '${id}': already attached to '${existing.providerCallId}', cannot reassign to '${providerCallId}'.`
      );
    }

    const existingMapped = this.providerIndex.get(providerCallId);
    if (existingMapped && existingMapped !== id) {
      throw new Error(
        `Provider call ID conflict: '${providerCallId}' is already mapped to attempt '${existingMapped}'. Duplicate providerCallIds are forbidden.`
      );
    }

    const now = timestamp || new Date().toISOString();
    const updated: VoiceCallAttemptRecord = {
      ...existing,
      providerCallId,
      initiationState: "accepted",
      claimOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };

    this.attempts.set(id, updated);
    this.providerIndex.set(providerCallId, id);
    return JSON.parse(JSON.stringify(updated));
  }

  async markInitiationAccepted(
    id: string,
    providerCallId: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    return this.attachProviderCallId(id, providerCallId, timestamp);
  }

  async markInitiationUncertain(
    id: string,
    reason: string,
    message?: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    const existing = this.attempts.get(id);
    if (!existing) {
      throw new Error(`VoiceCallAttempt '${id}' not found.`);
    }
    const now = timestamp || new Date().toISOString();
    const updated: VoiceCallAttemptRecord = {
      ...existing,
      initiationState: "uncertain",
      uncertainAt: now,
      uncertainReason: reason,
      errorCode: reason,
      errorMessage: message || reason,
      claimOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
    this.attempts.set(id, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async markInitiationRejected(
    id: string,
    errorCode: string,
    errorMessage?: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    const existing = this.attempts.get(id);
    if (!existing) {
      throw new Error(`VoiceCallAttempt '${id}' not found.`);
    }
    const now = timestamp || new Date().toISOString();
    const updated: VoiceCallAttemptRecord = {
      ...existing,
      initiationState: "rejected",
      status: "failed",
      statusRank: VOICE_CALL_STATUS_RANKS.failed,
      isTerminal: true,
      errorCode,
      errorMessage: errorMessage || errorCode,
      claimOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
    this.attempts.set(id, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async recoverExpiredInitiation(
    id: string,
    now: Date,
    reason?: string
  ): Promise<VoiceCallAttemptRecord | null> {
    const existing = this.attempts.get(id);
    if (!existing) return null;

    if (existing.initiationState !== "in_flight") {
      return null;
    }

    if (existing.providerCallId) {
      return null;
    }

    if (!existing.leaseExpiresAt) {
      return null;
    }

    const leaseExpiryTime = new Date(existing.leaseExpiresAt).getTime();
    if (leaseExpiryTime > now.getTime()) {
      return null;
    }

    const nowIso = now.toISOString();
    const updated: VoiceCallAttemptRecord = {
      ...existing,
      initiationState: "uncertain",
      uncertainAt: nowIso,
      uncertainReason: reason || "Initiation lease expired without persisted outcome",
      errorCode: "EXPIRED_INITIATION_LEASE",
      errorMessage: reason || "Initiation lease expired without persisted outcome",
      claimOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    };

    this.attempts.set(id, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async correlateWebhookByAttemptId(
    params: CorrelateWebhookParams
  ): Promise<VoiceCallAttemptUpdateResult> {
    const validated = CorrelateWebhookParamsSchema.parse(params);
    const existing = this.attempts.get(validated.attemptId);
    if (!existing) {
      throw new Error(`VoiceCallAttempt '${validated.attemptId}' not found for webhook correlation.`);
    }

    if (existing.sessionId !== validated.sessionId) {
      throw new Error(
        `Session mismatch in webhook correlation: attempt '${validated.attemptId}' belongs to session '${existing.sessionId}', but webhook reported session '${validated.sessionId}'.`
      );
    }

    if (existing.provider !== validated.provider) {
      throw new Error(
        `Provider mismatch in webhook correlation: attempt '${validated.attemptId}' belongs to provider '${existing.provider}', but webhook reported provider '${validated.provider}'.`
      );
    }

    if (existing.providerCallId && existing.providerCallId !== validated.providerCallId) {
      throw new Error(
        `Provider call ID conflict for attempt '${validated.attemptId}': already attached to '${existing.providerCallId}', cannot reassign to '${validated.providerCallId}'.`
      );
    }

    const existingMapped = this.providerIndex.get(validated.providerCallId);
    if (existingMapped && existingMapped !== validated.attemptId) {
      throw new Error(
        `Provider call ID conflict: '${validated.providerCallId}' is already mapped to attempt '${existingMapped}'. Duplicate providerCallIds are forbidden.`
      );
    }

    const nowIso = new Date().toISOString();
    const eventTime = validated.timestamp || nowIso;

    const baseRecord: VoiceCallAttemptRecord = {
      ...existing,
      providerCallId: validated.providerCallId,
      initiationState:
        existing.initiationState === "in_flight" ||
        existing.initiationState === "uncertain" ||
        existing.initiationState === "pending"
          ? "accepted"
          : existing.initiationState,
      claimOwner: null,
      claimToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    };

    const evaluation = evaluateStatusUpdate(
      baseRecord,
      {
        status: validated.status,
        timestamp: eventTime,
        durationSeconds: validated.durationSeconds,
        errorCode: validated.errorCode,
        errorMessage: validated.errorMessage,
        rawProviderMetadata: validated.rawProviderMetadata,
      },
      nowIso
    );

    this.attempts.set(validated.attemptId, evaluation.attempt);
    this.providerIndex.set(validated.providerCallId, validated.attemptId);

    return {
      outcome: evaluation.outcome,
      attempt: JSON.parse(JSON.stringify(evaluation.attempt)),
      reason: evaluation.reason,
    };
  }

  async updateStatus(
    id: string,
    params: UpdateVoiceCallAttemptStatusParams
  ): Promise<VoiceCallAttemptUpdateResult> {
    const validated = UpdateVoiceCallAttemptStatusParamsSchema.parse(params);
    const existing = this.attempts.get(id);
    if (!existing) {
      throw new Error(`VoiceCallAttempt '${id}' not found.`);
    }

    const now = new Date().toISOString();
    const evaluation = evaluateStatusUpdate(existing, validated, now);

    if (evaluation.outcome === "updated" || evaluation.outcome === "terminal_conflict") {
      this.attempts.set(id, evaluation.attempt);
    }

    return {
      outcome: evaluation.outcome,
      attempt: JSON.parse(JSON.stringify(evaluation.attempt)),
      reason: evaluation.reason,
    };
  }

  async updateStatusByProviderCallId(
    providerCallId: string,
    params: UpdateVoiceCallAttemptStatusParams
  ): Promise<VoiceCallAttemptUpdateResult> {
    const internalId = this.providerIndex.get(providerCallId);
    if (!internalId) {
      throw new Error(`VoiceCallAttempt with providerCallId '${providerCallId}' not found.`);
    }
    return this.updateStatus(internalId, params);
  }

  clear(): void {
    this.attempts.clear();
    this.providerIndex.clear();
  }
}

/**
 * Server-Authoritative Firestore Voice Call Attempt Repository
 * Uses atomic Firestore transactions for multi-worker concurrency safety and
 * maintains indexed provider mappings.
 */
export class FirestoreVoiceCallAttemptRepository implements VoiceCallAttemptRepository {
  private collectionName = "voice_call_attempts";
  private mappingCollectionName = "voice_call_provider_mappings";
  private dbProvider?: () => FirebaseFirestore.Firestore | null;

  constructor(dbProvider?: () => FirebaseFirestore.Firestore | null) {
    this.dbProvider = dbProvider;
  }

  private getDb(): FirebaseFirestore.Firestore {
    const db = this.dbProvider ? this.dbProvider() : getAdminFirestore();
    if (!db) {
      throw new Error("Firestore Admin DB unavailable in FirestoreVoiceCallAttemptRepository.");
    }
    return db;
  }

  async createAttempt(params: CreateVoiceCallAttemptParams): Promise<VoiceCallAttemptRecord> {
    const validated = CreateVoiceCallAttemptParamsSchema.parse(params);
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(validated.id);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (snap.exists) {
        return snap.data() as VoiceCallAttemptRecord;
      }

      const now = new Date().toISOString();
      const initiatedAt = validated.initiatedAt || now;

      const record: VoiceCallAttemptRecord = {
        id: validated.id,
        deliveryId: validated.deliveryId,
        sessionId: validated.sessionId,
        phoneNumberMasked: validated.phoneNumberMasked,
        channel: "voice",
        provider: validated.provider,
        direction: "outbound",
        status: "initiated",
        statusRank: VOICE_CALL_STATUS_RANKS.initiated,
        isTerminal: false,
        initiationState: validated.initiationState || (validated.providerCallId ? "accepted" : "pending"),
        claimOwner: validated.claimOwner || null,
        claimToken: validated.claimToken || null,
        leaseExpiresAt: validated.leaseExpiresAt || null,
        terminalConflict: null,
        providerCallId: validated.providerCallId || null,
        initiatedAt,
        createdAt: now,
        updatedAt: now,
        rawProviderMetadata: validated.metadata ? { ...validated.metadata } : undefined,
      };

      const parsed = VoiceCallAttemptRecordSchema.parse(record);
      transaction.set(docRef, parsed);

      if (parsed.providerCallId) {
        const mappingRef = db.collection(this.mappingCollectionName).doc(parsed.providerCallId);
        const mappingSnap = await transaction.get(mappingRef);
        if (mappingSnap.exists) {
          const mappingData = mappingSnap.data();
          if (mappingData && mappingData.attemptId !== parsed.id) {
            throw new Error(
              `Provider call ID conflict: '${parsed.providerCallId}' is already mapped to attempt '${mappingData.attemptId}'. Duplicate providerCallIds are forbidden.`
            );
          }
        }
        transaction.set(mappingRef, {
          attemptId: parsed.id,
          createdAt: now,
        });
      }

      return parsed;
    });
  }

  async getById(id: string): Promise<VoiceCallAttemptRecord | null> {
    const db = this.getDb();
    const snap = await db.collection(this.collectionName).doc(id).get();
    if (!snap.exists) return null;
    return snap.data() as VoiceCallAttemptRecord;
  }

  async getByProviderCallId(providerCallId: string): Promise<VoiceCallAttemptRecord | null> {
    const db = this.getDb();
    // 1. Try fast primary index mapping doc
    try {
      const mappingSnap = await db.collection(this.mappingCollectionName).doc(providerCallId).get();
      if (mappingSnap.exists) {
        const data = mappingSnap.data();
        if (data && typeof data.attemptId === "string") {
          return await this.getById(data.attemptId);
        }
      }
    } catch {
      // Fall through to collection query
    }

    // 2. Query collection directly by providerCallId
    const querySnap = await db
      .collection(this.collectionName)
      .where("providerCallId", "==", providerCallId)
      .limit(1)
      .get();

    if (querySnap.empty) return null;
    return querySnap.docs[0].data() as VoiceCallAttemptRecord;
  }

  async attachProviderCallId(
    id: string,
    providerCallId: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(id);
    const mappingRef = db.collection(this.mappingCollectionName).doc(providerCallId);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new Error(`VoiceCallAttempt '${id}' not found to attach providerCallId.`);
      }

      const existing = snap.data() as VoiceCallAttemptRecord;
      if (existing.providerCallId === providerCallId) {
        return existing;
      }

      if (existing.providerCallId && existing.providerCallId !== providerCallId) {
        throw new Error(
          `Provider call ID conflict for attempt '${id}': already attached to '${existing.providerCallId}', cannot reassign to '${providerCallId}'.`
        );
      }

      const mappingSnap = await transaction.get(mappingRef);
      if (mappingSnap.exists) {
        const mappingData = mappingSnap.data();
        if (mappingData && mappingData.attemptId !== id) {
          throw new Error(
            `Provider call ID conflict: '${providerCallId}' is already mapped to attempt '${mappingData.attemptId}'. Duplicate providerCallIds are forbidden.`
          );
        }
      }

      const now = timestamp || new Date().toISOString();
      const updated: VoiceCallAttemptRecord = {
        ...existing,
        providerCallId,
        initiationState: "accepted",
        claimOwner: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };

      transaction.set(docRef, updated, { merge: true });
      transaction.set(mappingRef, {
        attemptId: id,
        createdAt: now,
      });

      return updated;
    });
  }

  async markInitiationAccepted(
    id: string,
    providerCallId: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    return this.attachProviderCallId(id, providerCallId, timestamp);
  }

  async markInitiationUncertain(
    id: string,
    reason: string,
    message?: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(id);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new Error(`VoiceCallAttempt '${id}' not found.`);
      }

      const existing = snap.data() as VoiceCallAttemptRecord;
      const now = timestamp || new Date().toISOString();
      const updated: VoiceCallAttemptRecord = {
        ...existing,
        initiationState: "uncertain",
        uncertainAt: now,
        uncertainReason: reason,
        errorCode: reason,
        errorMessage: message || reason,
        claimOwner: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };

      transaction.set(docRef, updated, { merge: true });
      return updated;
    });
  }

  async markInitiationRejected(
    id: string,
    errorCode: string,
    errorMessage?: string,
    timestamp?: string
  ): Promise<VoiceCallAttemptRecord> {
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(id);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new Error(`VoiceCallAttempt '${id}' not found.`);
      }

      const existing = snap.data() as VoiceCallAttemptRecord;
      const now = timestamp || new Date().toISOString();
      const updated: VoiceCallAttemptRecord = {
        ...existing,
        initiationState: "rejected",
        status: "failed",
        statusRank: VOICE_CALL_STATUS_RANKS.failed,
        isTerminal: true,
        errorCode,
        errorMessage: errorMessage || errorCode,
        claimOwner: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };

      transaction.set(docRef, updated, { merge: true });
      return updated;
    });
  }

  async recoverExpiredInitiation(
    id: string,
    now: Date,
    reason?: string
  ): Promise<VoiceCallAttemptRecord | null> {
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(id);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) return null;

      const existing = snap.data() as VoiceCallAttemptRecord;
      if (existing.initiationState !== "in_flight") {
        return null;
      }

      if (existing.providerCallId) {
        return null;
      }

      if (!existing.leaseExpiresAt) {
        return null;
      }

      const leaseExpiryTime = new Date(existing.leaseExpiresAt).getTime();
      if (leaseExpiryTime > now.getTime()) {
        return null;
      }

      const nowIso = now.toISOString();
      const updated: VoiceCallAttemptRecord = {
        ...existing,
        initiationState: "uncertain",
        uncertainAt: nowIso,
        uncertainReason: reason || "Initiation lease expired without persisted outcome",
        errorCode: "EXPIRED_INITIATION_LEASE",
        errorMessage: reason || "Initiation lease expired without persisted outcome",
        claimOwner: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      };

      transaction.set(docRef, updated, { merge: true });
      return updated;
    });
  }

  async correlateWebhookByAttemptId(
    params: CorrelateWebhookParams
  ): Promise<VoiceCallAttemptUpdateResult> {
    const validated = CorrelateWebhookParamsSchema.parse(params);
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(validated.attemptId);
    const mappingRef = db.collection(this.mappingCollectionName).doc(validated.providerCallId);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new Error(`VoiceCallAttempt '${validated.attemptId}' not found for webhook correlation.`);
      }

      const existing = snap.data() as VoiceCallAttemptRecord;

      if (existing.sessionId !== validated.sessionId) {
        throw new Error(
          `Session mismatch in webhook correlation: attempt '${validated.attemptId}' belongs to session '${existing.sessionId}', but webhook reported session '${validated.sessionId}'.`
        );
      }

      if (existing.provider !== validated.provider) {
        throw new Error(
          `Provider mismatch in webhook correlation: attempt '${validated.attemptId}' belongs to provider '${existing.provider}', but webhook reported provider '${validated.provider}'.`
        );
      }

      if (existing.providerCallId && existing.providerCallId !== validated.providerCallId) {
        throw new Error(
          `Provider call ID conflict for attempt '${validated.attemptId}': already attached to '${existing.providerCallId}', cannot reassign to '${validated.providerCallId}'.`
        );
      }

      const mappingSnap = await transaction.get(mappingRef);
      if (mappingSnap.exists) {
        const mappingData = mappingSnap.data();
        if (mappingData && mappingData.attemptId !== validated.attemptId) {
          throw new Error(
            `Provider call ID conflict: '${validated.providerCallId}' is already mapped to attempt '${mappingData.attemptId}'. Duplicate providerCallIds are forbidden.`
          );
        }
      }

      const nowIso = new Date().toISOString();
      const eventTime = validated.timestamp || nowIso;

      const baseRecord: VoiceCallAttemptRecord = {
        ...existing,
        providerCallId: validated.providerCallId,
        initiationState:
          existing.initiationState === "in_flight" ||
          existing.initiationState === "uncertain" ||
          existing.initiationState === "pending"
            ? "accepted"
            : existing.initiationState,
        claimOwner: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      };

      const evaluation = evaluateStatusUpdate(
        baseRecord,
        {
          status: validated.status,
          timestamp: eventTime,
          durationSeconds: validated.durationSeconds,
          errorCode: validated.errorCode,
          errorMessage: validated.errorMessage,
          rawProviderMetadata: validated.rawProviderMetadata,
        },
        nowIso
      );

      transaction.set(docRef, evaluation.attempt, { merge: true });
      transaction.set(mappingRef, {
        attemptId: validated.attemptId,
        createdAt: nowIso,
      });

      return evaluation;
    });
  }

  async updateStatus(
    id: string,
    params: UpdateVoiceCallAttemptStatusParams
  ): Promise<VoiceCallAttemptUpdateResult> {
    const validated = UpdateVoiceCallAttemptStatusParamsSchema.parse(params);
    const db = this.getDb();
    const docRef = db.collection(this.collectionName).doc(id);

    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(docRef);
      if (!snap.exists) {
        throw new Error(`VoiceCallAttempt '${id}' not found.`);
      }

      const existing = snap.data() as VoiceCallAttemptRecord;
      const now = new Date().toISOString();
      const evaluation = evaluateStatusUpdate(existing, validated, now);

      if (evaluation.outcome === "updated" || evaluation.outcome === "terminal_conflict") {
        transaction.set(docRef, evaluation.attempt, { merge: true });
      }

      return evaluation;
    });
  }

  async updateStatusByProviderCallId(
    providerCallId: string,
    params: UpdateVoiceCallAttemptStatusParams
  ): Promise<VoiceCallAttemptUpdateResult> {
    const attempt = await this.getByProviderCallId(providerCallId);
    if (!attempt) {
      throw new Error(`VoiceCallAttempt with providerCallId '${providerCallId}' not found.`);
    }
    return this.updateStatus(attempt.id, params);
  }
}
