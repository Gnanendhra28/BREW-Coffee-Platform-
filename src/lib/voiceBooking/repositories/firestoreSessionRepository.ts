if (typeof window !== "undefined") {
  throw new Error("FirestoreVoiceSessionRepository must only be executed in a server environment.");
}

import type { Firestore } from "firebase-admin/firestore";
import { FieldPath } from "firebase-admin/firestore";
import { getAdminFirestore } from "../../firebaseAdmin";
import {
  AtomicApprovalResult,
  AtomicRejectionResult,
  IncompleteSessionLookupError,
  InvalidSessionLookupBudgetError,
  isTerminalVoiceState,
  OptimisticConcurrencyConflictError,
  StaffAuthorizationContext,
  StaffRejectionAuthorizationContext,
  TerminalSessionImmutableError,
  validateScanBudget,
  VoiceBookingSession,
  VoiceBookingState,
  VoiceSessionLookupIntegrityError,
  VoiceSessionLookupOptions,
  VoiceSessionRepository,
} from "../types";
import {
  StaffAuthorizationContextSchema,
  StaffRejectionAuthorizationContextSchema,
  VoiceBookingSessionSchema,
} from "../schemas";
import { isValidStrictIsoUtc } from "../../communication/schemas";
import { verifyQuotationIntegrity } from "../quotationAdapter";
import {
  computeOfficialVanRequestId,
  computeScheduleDayDocId,
  computeScheduleSlotDocId,
  createVanRequestRecordFromSession,
  deriveBookingTimeSlot,
  SCHEDULE_SLOTS_COLLECTION,
  ScheduleReservationEntry,
  validateOfficialBookingIdentity,
  VAN_REQUESTS_COLLECTION,
} from "../vanRequestBridge";
import {
  parseTimeSlot,
  reserveSlot,
} from "../../eventBookingConcierge/policy";
import { CommunicationDeliveryRecord } from "../../communication/types";
import { CommunicationDeliveryRecordSchema } from "../../communication/schemas";
import { createOutboxDeliveriesForTransition } from "../../communication/outbox/outboxModel";

export const VOICE_BOOKING_COLLECTION = "voice_booking_sessions";
export const OUTBOX_COLLECTION = "booking_communication_outbox";

function maskPhoneNumber(phone?: string): string {
  if (!phone || typeof phone !== "string" || phone.length < 4) return "***";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/**
 * Recursively converts Firestore Timestamps to strict ISO 8601 UTC strings.
 */
function normalizeFirestoreData(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;

  // Handle Firestore Timestamp object with toDate method
  if (
    "toDate" in (obj as Record<string, unknown>) &&
    typeof (obj as { toDate: () => Date }).toDate === "function"
  ) {
    try {
      const d = (obj as { toDate: () => Date }).toDate();
      if (!d || !(d instanceof Date) || isNaN(d.getTime())) {
        return null;
      }
      return d.toISOString();
    } catch {
      return null;
    }
  }

  if (Array.isArray(obj)) {
    return obj.map(normalizeFirestoreData);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = normalizeFirestoreData(value);
  }
  return result;
}

/**
 * Serializes a VoiceBookingSession for Cloud Firestore storage.
 * Ensures clean JSON compatibility and removes undefined fields.
 */
export function serializeSessionForFirestore(
  session: VoiceBookingSession
): Record<string, unknown> {
  // Validate schema before serialization
  const validated = VoiceBookingSessionSchema.parse(session);
  return JSON.parse(JSON.stringify(validated));
}

/**
 * Strict validator for stored concurrency revision tokens.
 * - Distinguishes genuinely absent legacy revision (undefined) from present but malformed values.
 * - Baseline policy: ONLY absent/undefined is treated as baseline revision 1.
 * - Rejects null, strings, booleans, NaN, Infinity, fractional values, zero, and negative values.
 */
export function validateStoredRevision(rawRevision: unknown, sessionId: string): number {
  if (rawRevision === undefined) {
    return 1; // Documented legacy baseline
  }

  if (typeof rawRevision !== "number") {
    throw new Error(
      `Corrupted session document in Firestore: stored revision for session '${sessionId}' is invalid type '${rawRevision === null ? "null" : typeof rawRevision}'. Must be an integer >= 1 or absent.`
    );
  }

  if (!Number.isFinite(rawRevision)) {
    throw new Error(
      `Corrupted session document in Firestore: stored revision for session '${sessionId}' is non-finite (${rawRevision}). Must be an integer >= 1.`
    );
  }

  if (!Number.isInteger(rawRevision)) {
    throw new Error(
      `Corrupted session document in Firestore: stored revision for session '${sessionId}' is fractional (${rawRevision}). Must be an integer >= 1.`
    );
  }

  if (rawRevision < 1) {
    throw new Error(
      `Corrupted session document in Firestore: stored revision for session '${sessionId}' must be >= 1, received ${rawRevision}.`
    );
  }

  return rawRevision;
}

/**
 * Deserializes and validates raw Firestore data into a typed VoiceBookingSession.
 * Fails closed if data is corrupted or malformed.
 */
export function deserializeSessionFromFirestore(
  data: unknown
): VoiceBookingSession {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid stored session: document data is null or not an object.");
  }
  const normalized = normalizeFirestoreData(data);
  const rawData = normalized as Record<string, unknown>;

  // Fail closed if stored revision field is present but malformed
  if ("revision" in rawData) {
    validateStoredRevision(rawData.revision, (rawData.id as string) || "unknown");
  }

  // Strict validation: createdAt and updatedAt must be present and valid ISO UTC strings
  if (!("createdAt" in rawData) || typeof rawData.createdAt !== "string" || !isValidStrictIsoUtc(rawData.createdAt)) {
    throw new Error(
      `Corrupted session document in Firestore: session '${(rawData.id as string) || "unknown"}' has missing, malformed, or non-UTC createdAt timestamp (${String(rawData.createdAt)}).`
    );
  }

  if (!("updatedAt" in rawData) || typeof rawData.updatedAt !== "string" || !isValidStrictIsoUtc(rawData.updatedAt)) {
    throw new Error(
      `Corrupted session document in Firestore: session '${(rawData.id as string) || "unknown"}' has missing, malformed, or non-UTC updatedAt timestamp (${String(rawData.updatedAt)}).`
    );
  }

  const parseResult = VoiceBookingSessionSchema.safeParse(normalized);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    throw new Error(`Corrupted session document in Firestore: ${issues}`);
  }
  return parseResult.data as VoiceBookingSession;
}

export type PostCommitSlotSyncFn = (
  eventDate: string,
  timeSlot: string,
  bookingId: string,
  source?: "voice_booking" | "manual_request"
) => boolean | void;

export interface FirestoreVoiceSessionRepositoryOptions {
  /**
   * Internal test seam for post-commit local registry synchronization.
   * Defaults to production `reserveSlot` from eventBookingConcierge/policy.
   * Executed strictly AFTER Firestore transaction commits; never inside transaction.
   */
  postCommitSyncFn?: PostCommitSlotSyncFn;
}

/**
 * Authoritative Cloud Firestore implementation of VoiceSessionRepository.
 * Provides distributed multi-instance durability and atomic transactions.
 */
export class FirestoreVoiceSessionRepository implements VoiceSessionRepository {
  readonly isDurable: boolean = true;
  readonly storageType = "firestore" as const;
  private injectedDb?: Firestore | null;
  private postCommitSyncFn: PostCommitSlotSyncFn;

  constructor(
    db?: Firestore | null,
    options?: FirestoreVoiceSessionRepositoryOptions
  ) {
    this.injectedDb = db;
    this.postCommitSyncFn = options?.postCommitSyncFn || reserveSlot;
  }

  private getDb(): Firestore {
    if (this.injectedDb !== undefined) {
      if (!this.injectedDb) {
        throw new Error(
          "Firestore Voice Session Repository requires configured Cloud Firestore in production integration. In-memory fallback is prohibited."
        );
      }
      return this.injectedDb;
    }

    const db = getAdminFirestore();
    if (!db) {
      throw new Error(
        "Firestore Voice Session Repository requires configured Cloud Firestore in production integration. In-memory fallback is prohibited."
      );
    }
    return db;
  }

  async getById(id: string): Promise<VoiceBookingSession | null> {
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      return null;
    }

    const trimmedId = id.trim();
    if (trimmedId !== id) {
      throw new Error(`Invalid session ID '${id}': contains illegal leading or trailing whitespace.`);
    }

    try {
      const db = this.getDb();
      const docSnap = await db.collection(VOICE_BOOKING_COLLECTION).doc(trimmedId).get();
      if (!docSnap.exists) {
        return null;
      }

      const session = deserializeSessionFromFirestore(docSnap.data());
      // Enforce strict document identity: stored session.id must match Firestore document ID
      if (session.id !== docSnap.id) {
        throw new Error(
          `Document identity mismatch: stored session ID '${session.id}' does not match Firestore document ID '${docSnap.id}'.`
        );
      }

      return session;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("Corrupted session document") ||
          err.message.includes("Document identity mismatch"))
      ) {
        console.error(`[FIRESTORE REPO] Validation failure for session ID ${id}:`, err.message);
        throw err;
      }
      console.error(`[FIRESTORE REPO] Error retrieving session ${id}:`, err instanceof Error ? err.message : err);
      throw err;
    }
  }

  async save(session: VoiceBookingSession, expectedRevision?: number): Promise<void> {
    if (!session || typeof session !== "object") {
      throw new Error("Cannot save session: session must be a valid object.");
    }
    if (!session.id || typeof session.id !== "string" || session.id.trim().length === 0) {
      throw new Error("Cannot save session: missing or empty session.id.");
    }
    if (session.id.trim() !== session.id) {
      throw new Error(
        `Cannot save session: session.id '${session.id}' contains illegal leading or trailing whitespace.`
      );
    }

    const sessionId = session.id;

    // 1. Capture the expected revision into an immutable local constant BEFORE calling runTransaction
    const immutableExpectedRevision: number | undefined = expectedRevision;
    const isCreateOperation = immutableExpectedRevision === undefined;

    const db = this.getDb();
    const docRef = db.collection(VOICE_BOOKING_COLLECTION).doc(sessionId);

    let committedRevision: number | null = null;

    try {
      await db.runTransaction(async (transaction) => {
        // --- 1. STRICT TRANSACTION READ PHASE (ALL READS MUST PRECEDE ALL WRITES) ---
        const existingDoc = await transaction.get(docRef);
        let existingVanDoc: { exists: boolean; data: () => unknown } | null = null;
        let vanRequestRef: FirebaseFirestore.DocumentReference | null = null;

        const isOfficialLifecycle =
          session.state === "customer_confirmed" ||
          session.state === "awaiting_staff_approval" ||
          session.state === "booking_confirmed";

        if (isOfficialLifecycle) {
          const vanRequestId = computeOfficialVanRequestId(sessionId);
          vanRequestRef = db.collection(VAN_REQUESTS_COLLECTION).doc(vanRequestId);
          existingVanDoc = (await transaction.get(vanRequestRef)) as {
            exists: boolean;
            data: () => unknown;
          };
        }

        // --- 2. VALIDATION & RECORD PREPARATION PHASE ---
        if (!existingDoc.exists) {
          // If the document does not exist and expectedRevision is defined, reject the operation
          // with OptimisticConcurrencyConflictError, regardless of whether the expected revision is 1 or higher.
          if (!isCreateOperation) {
            throw new OptimisticConcurrencyConflictError(
              `Cannot update session '${sessionId}': document does not exist in store. Expected revision was ${immutableExpectedRevision}. Stale update on missing or deleted session rejected.`
            );
          }

          let vanData: Record<string, unknown> | null = null;
          if (isOfficialLifecycle && vanRequestRef) {
            validateOfficialBookingIdentity(
              session,
              existingVanDoc?.exists ? (existingVanDoc.data() as Record<string, unknown>) : null
            );
            vanData = createVanRequestRecordFromSession(
              session,
              "pending",
              undefined,
              existingVanDoc?.exists ? (existingVanDoc.data() as Record<string, unknown>) : null
            );
          }

          // Only an explicit create operation (expectedRevision === undefined) may create a missing document.
          committedRevision = 1;
          const serialized = serializeSessionForFirestore({
            ...session,
            revision: 1,
          });

          // --- 3. STRICT TRANSACTION WRITE PHASE (WRITES FOLLOW ALL READS) ---
          transaction.set(docRef, serialized);
          if (vanData && vanRequestRef) {
            transaction.set(vanRequestRef, vanData);
          }
          return;
        }

        // Document exists:
        if (isCreateOperation) {
          // Explicit create-only semantics: reject duplicate creation
          throw new OptimisticConcurrencyConflictError(
            `Cannot create session '${sessionId}': document already exists in store. Concurrent create rejected.`
          );
        }

        const existingData = existingDoc.data() as Record<string, unknown> | undefined;

        // Document identity check
        if (existingData && typeof existingData.id === "string" && existingData.id !== sessionId) {
          throw new Error(
            `Document identity mismatch: stored session ID '${existingData.id}' does not match update session ID '${sessionId}'.`
          );
        }

        // 1. Terminal state protection: reject ordinary saves if stored document is terminal
        const existingState = existingData?.state as VoiceBookingState | undefined;
        const hasAudit = Boolean(existingData?.staffApprovalAudit);
        if ((existingState && isTerminalVoiceState(existingState)) || hasAudit) {
          throw new TerminalSessionImmutableError(
            `Cannot update session '${sessionId}' in terminal state '${existingState}'. Terminal sessions are immutable.`
          );
        }

        // 2. Strict revision validation: reject malformed stored revisions
        const existingRevision = validateStoredRevision(existingData?.revision, sessionId);

        // 3. Strict CAS check against immutable local constant
        if (existingRevision !== immutableExpectedRevision) {
          throw new OptimisticConcurrencyConflictError(
            `Optimistic concurrency conflict on session '${sessionId}': expected revision ${immutableExpectedRevision}, but stored revision is ${existingRevision}. Stale write rejected.`
          );
        }

        let vanData: Record<string, unknown> | null = null;
        if (isOfficialLifecycle && vanRequestRef) {
          validateOfficialBookingIdentity(
            session,
            existingVanDoc?.exists ? (existingVanDoc.data() as Record<string, unknown>) : null
          );
          vanData = createVanRequestRecordFromSession(
            session,
            "pending",
            undefined,
            existingVanDoc?.exists ? (existingVanDoc.data() as Record<string, unknown>) : null
          );
        }

        // 4. Monotonic increment computed from successfully validated stored revision
        const nextRevision = existingRevision + 1;
        committedRevision = nextRevision;

        // Serialize a copy without mutating caller's session object inside transaction callback
        const serialized = serializeSessionForFirestore({
          ...session,
          revision: nextRevision,
        });

        // --- 3. STRICT TRANSACTION WRITE PHASE (WRITES FOLLOW ALL READS) ---
        transaction.set(docRef, serialized);
        if (vanData && vanRequestRef) {
          transaction.set(vanRequestRef, vanData);
        }
      });

      // ONLY update caller-visible session revision after transaction has successfully completed
      if (committedRevision !== null) {
        session.revision = committedRevision;
      }
    } catch (err) {
      if (
        err instanceof OptimisticConcurrencyConflictError ||
        err instanceof TerminalSessionImmutableError
      ) {
        throw err;
      }
      console.error(
        `[FIRESTORE REPO] Error saving session ${sessionId} (phone: ${maskPhoneNumber(session.phoneNumber)}):`,
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  }

  async saveWithOutbox(
    session: VoiceBookingSession,
    expectedRevision: number,
    outboxDeliveries: CommunicationDeliveryRecord[]
  ): Promise<void> {
    if (!session || typeof session !== "object") {
      throw new Error("Cannot save session: session must be a valid object.");
    }
    if (!session.id || typeof session.id !== "string" || session.id.trim().length === 0) {
      throw new Error("Cannot save session: missing or empty session.id.");
    }
    if (session.id.trim() !== session.id) {
      throw new Error(
        `Cannot save session: session.id '${session.id}' contains illegal leading or trailing whitespace.`
      );
    }

    const validatedDeliveries = outboxDeliveries.map((d) =>
      CommunicationDeliveryRecordSchema.parse(d)
    );

    const sessionId = session.id;
    const immutableExpectedRevision: number = expectedRevision;

    const db = this.getDb();
    const docRef = db.collection(VOICE_BOOKING_COLLECTION).doc(sessionId);

    let committedRevision: number | null = null;

    try {
      await db.runTransaction(async (transaction) => {
        // --- 1. STRICT TRANSACTION READ PHASE (ALL READS MUST PRECEDE ALL WRITES) ---
        const existingDoc = await transaction.get(docRef);
        let existingVanDoc: { exists: boolean; data: () => unknown } | null = null;
        let vanRequestRef: FirebaseFirestore.DocumentReference | null = null;

        const isOfficialLifecycle =
          session.state === "customer_confirmed" ||
          session.state === "awaiting_staff_approval" ||
          session.state === "booking_confirmed";

        if (isOfficialLifecycle) {
          const vanRequestId = computeOfficialVanRequestId(sessionId);
          vanRequestRef = db.collection(VAN_REQUESTS_COLLECTION).doc(vanRequestId);
          existingVanDoc = (await transaction.get(vanRequestRef)) as {
            exists: boolean;
            data: () => unknown;
          };
        }

        const outboxRefs: FirebaseFirestore.DocumentReference[] = [];
        for (const delivery of validatedDeliveries) {
          const dRef = db.collection(OUTBOX_COLLECTION).doc(delivery.id);
          outboxRefs.push(dRef);
          await transaction.get(dRef);
        }

        // --- 2. VALIDATION & RECORD PREPARATION PHASE ---
        if (!existingDoc.exists) {
          throw new OptimisticConcurrencyConflictError(
            `Cannot update session '${sessionId}': document does not exist in store. Expected revision was ${immutableExpectedRevision}. Stale update on missing or deleted session rejected.`
          );
        }

        const existingData = existingDoc.data() as Record<string, unknown> | undefined;

        if (existingData && typeof existingData.id === "string" && existingData.id !== sessionId) {
          throw new Error(
            `Document identity mismatch: stored session ID '${existingData.id}' does not match update session ID '${sessionId}'.`
          );
        }

        const existingState = existingData?.state as VoiceBookingState | undefined;
        const hasAudit = Boolean(existingData?.staffApprovalAudit);
        if ((existingState && isTerminalVoiceState(existingState)) || hasAudit) {
          throw new TerminalSessionImmutableError(
            `Cannot update session '${sessionId}' in terminal state '${existingState}'. Terminal sessions are immutable.`
          );
        }

        const existingRevision = validateStoredRevision(existingData?.revision, sessionId);

        if (existingRevision !== immutableExpectedRevision) {
          throw new OptimisticConcurrencyConflictError(
            `Optimistic concurrency conflict on session '${sessionId}': expected revision ${immutableExpectedRevision}, but stored revision is ${existingRevision}. Stale write rejected.`
          );
        }

        let vanData: Record<string, unknown> | null = null;
        if (isOfficialLifecycle && vanRequestRef) {
          validateOfficialBookingIdentity(
            session,
            existingVanDoc?.exists ? (existingVanDoc.data() as Record<string, unknown>) : null
          );
          vanData = createVanRequestRecordFromSession(
            session,
            "pending",
            undefined,
            existingVanDoc?.exists ? (existingVanDoc.data() as Record<string, unknown>) : null
          );
        }

        const nextRevision = existingRevision + 1;
        committedRevision = nextRevision;

        const serialized = serializeSessionForFirestore({
          ...session,
          revision: nextRevision,
        });

        // --- 3. STRICT TRANSACTION WRITE PHASE (WRITES FOLLOW ALL READS) ---
        transaction.set(docRef, serialized);
        if (vanData && vanRequestRef) {
          transaction.set(vanRequestRef, vanData);
        }
        for (let i = 0; i < validatedDeliveries.length; i++) {
          transaction.set(outboxRefs[i], validatedDeliveries[i]);
        }
      });

      if (committedRevision !== null) {
        session.revision = committedRevision;
      }
    } catch (err) {
      if (
        err instanceof OptimisticConcurrencyConflictError ||
        err instanceof TerminalSessionImmutableError
      ) {
        throw err;
      }
      console.error(
        `[FIRESTORE REPO] Error saving session with outbox ${sessionId} (phone: ${maskPhoneNumber(session.phoneNumber)}):`,
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  }

  async getByPhoneNumber(
    phone: string,
    options?: VoiceSessionLookupOptions
  ): Promise<VoiceBookingSession | null> {
    const maxBudget = validateScanBudget(options?.maxScanBudget);

    if (!phone || typeof phone !== "string" || phone.trim().length === 0) {
      return null;
    }

    const trimmedPhone = phone.trim();
    const maskedPhone = maskPhoneNumber(trimmedPhone);
    const db = this.getDb();

    try {
      let baseQuery = db
        .collection(VOICE_BOOKING_COLLECTION)
        .where("phoneNumber", "==", trimmedPhone);

      // Order by document ID for stable cursor pagination without omitting documents missing createdAt
      if (typeof (baseQuery as unknown as { orderBy?: unknown }).orderBy !== "function") {
        throw new Error("Firestore query implementation does not support orderBy(FieldPath.documentId())");
      }
      baseQuery = (baseQuery as unknown as { orderBy: (field: unknown, dir?: string) => typeof baseQuery })
        .orderBy(FieldPath.documentId(), "asc");

      const pageSize = Math.min(25, maxBudget);
      let totalScanned = 0;
      let lastDocSnapshot: unknown = null;
      const validSessions: VoiceBookingSession[] = [];
      let endOfCollectionReached = false;

      while (totalScanned < maxBudget) {
        const batchLimit = Math.min(pageSize, maxBudget - totalScanned);
        let pageQuery = baseQuery.limit(batchLimit);

        if (lastDocSnapshot) {
          if (typeof (pageQuery as unknown as { startAfter?: unknown }).startAfter !== "function") {
            throw new Error("Firestore query implementation does not support cursor pagination startAfter()");
          }
          pageQuery = (pageQuery as unknown as { startAfter: (doc: unknown) => typeof pageQuery }).startAfter(lastDocSnapshot);
        }

        const snapshot = await (pageQuery as { get: () => Promise<FirebaseFirestore.QuerySnapshot> }).get();
        if (snapshot.empty) {
          endOfCollectionReached = true;
          break;
        }

        for (const docSnap of snapshot.docs) {
          const rawData = docSnap.data();

          // 1. Validate raw document structure & identity
          if (!rawData || typeof rawData !== "object") {
            throw new VoiceSessionLookupIntegrityError(
              maskedPhone,
              docSnap.id,
              "Document payload is null or not an object"
            );
          }

          const storedId = (rawData as Record<string, unknown>).id;
          if (typeof storedId !== "string" || storedId !== docSnap.id) {
            throw new VoiceSessionLookupIntegrityError(
              maskedPhone,
              docSnap.id,
              `Document identity mismatch: stored id '${storedId}' does not match Firestore document ID '${docSnap.id}'`
            );
          }

          // 2. Validate deserialization, timestamps, schema, and revision (fail closed)
          let session: VoiceBookingSession;
          try {
            session = deserializeSessionFromFirestore(rawData);
          } catch (deserErr) {
            const reason = deserErr instanceof Error ? deserErr.message : String(deserErr);
            throw new VoiceSessionLookupIntegrityError(
              maskedPhone,
              docSnap.id,
              `Document failed deserialization/schema validation: ${reason}`
            );
          }

          validSessions.push(session);
        }

        totalScanned += snapshot.docs.length;
        lastDocSnapshot = snapshot.docs[snapshot.docs.length - 1];

        if (snapshot.docs.length < batchLimit) {
          endOfCollectionReached = true;
          break;
        }
      }

      // If we scanned up to maxBudget, verify whether additional documents exist in Firestore
      if (!endOfCollectionReached && totalScanned >= maxBudget) {
        let probeQuery = baseQuery.limit(1);
        if (lastDocSnapshot) {
          if (typeof (probeQuery as unknown as { startAfter?: unknown }).startAfter !== "function") {
            throw new Error("Firestore query implementation does not support cursor pagination startAfter() on probe");
          }
          probeQuery = (probeQuery as unknown as { startAfter: (doc: unknown) => typeof probeQuery }).startAfter(lastDocSnapshot);
        }
        const probeSnap = await (probeQuery as { get: () => Promise<FirebaseFirestore.QuerySnapshot> }).get();
        if (!probeSnap.empty) {
          throw new IncompleteSessionLookupError(trimmedPhone, totalScanned);
        }
      }

      if (validSessions.length === 0) {
        return null;
      }

      // Once the complete matching set within budget is validated, sort in memory:
      // Primary: createdAt descending, Tie-breaker: document ID descending
      validSessions.sort((a, b) => {
        const timeA = Date.parse(a.createdAt);
        const timeB = Date.parse(b.createdAt);
        if (timeB !== timeA) return timeB - timeA;
        return b.id.localeCompare(a.id);
      });

      if (!options?.activeOnly) {
        return validSessions[0];
      }

      // activeOnly returns the first non-terminal session in sorted order
      const active = validSessions.find(
        (s) => !isTerminalVoiceState(s.state) && !Boolean(s.staffApprovalAudit)
      );
      return active ?? null;
    } catch (err) {
      if (
        err instanceof IncompleteSessionLookupError ||
        err instanceof VoiceSessionLookupIntegrityError ||
        err instanceof InvalidSessionLookupBudgetError
      ) {
        throw err;
      }
      console.error(
        `[FIRESTORE REPO] Error querying session by phone ${maskedPhone}:`,
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  }

  /**
   * Atomically evaluates pre-conditions, quotation integrity, executes approval transition,
   * and commits the approved state and audit record together in a single Cloud Firestore transaction.
   * 
   * DISTRIBUTED TRANSACTION GUARANTEE:
   * - Uses native Firestore `runTransaction()` with optimistic concurrency control.
   * - Multiple concurrent approval attempts will contend on the session document;
   *   exactly ONE will succeed and transition the document to 'booking_confirmed'.
   * - All concurrent or subsequent callers will see the committed state and abort with
   *   'already_approved' (HTTP 409 Conflict).
   * - The transaction callback is idempotent and side-effect free, safe for automatic retries.
   */
  async atomicApproveBooking(
    sessionId: string,
    authContext: StaffAuthorizationContext,
    transitionFn: (
      session: VoiceBookingSession,
      authContext: StaffAuthorizationContext
    ) => VoiceBookingSession
  ): Promise<AtomicApprovalResult> {
    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return {
        success: false,
        error: "invalid_state",
        message: "Session ID must be a non-empty string.",
      };
    }

    if (sessionId.trim() !== sessionId) {
      return {
        success: false,
        error: "invalid_state",
        message: `Invalid session ID '${sessionId}': contains illegal leading or trailing whitespace.`,
      };
    }

    const authValidation = StaffAuthorizationContextSchema.safeParse(authContext);
    if (!authValidation.success) {
      return {
        success: false,
        error: "invalid_state",
        message: `Invalid StaffAuthorizationContext: ${authValidation.error.message}`,
      };
    }

    const validAuthContext = authValidation.data;
    const db = this.getDb();
    const docRef = db.collection(VOICE_BOOKING_COLLECTION).doc(sessionId.trim());
    const vanRequestId = computeOfficialVanRequestId(sessionId.trim());
    const vanRequestRef = db.collection(VAN_REQUESTS_COLLECTION).doc(vanRequestId);

    try {
      const result = await db.runTransaction(async (transaction) => {
        // --- 1. STRICT TRANSACTION READ PHASE (ALL READS BEFORE ANY WRITES) ---
        const docSnap = await transaction.get(docRef);
        const vanSnap = (await transaction.get(vanRequestRef)) as {
          exists: boolean;
          data: () => unknown;
        };

        if (!docSnap.exists) {
          return {
            success: false,
            error: "session_not_found" as const,
            message: `Voice booking session not found: ${sessionId}`,
          };
        }

        // 2. Deserialize and validate stored document
        let rawSession: VoiceBookingSession;
        try {
          rawSession = deserializeSessionFromFirestore(docSnap.data());
        } catch (deserErr) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: deserErr instanceof Error ? deserErr.message : "Stored session data is corrupted",
          };
        }

        // 2b. Enforce strict document identity
        if (rawSession.id !== docSnap.id) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: `Document identity mismatch: stored session ID '${rawSession.id}' does not match Firestore document ID '${docSnap.id}'.`,
          };
        }

        // 3. Duplicate approval check
        const hasExistingAudit = Boolean(rawSession.staffApprovalAudit);
        const isVanConfirmed =
          vanSnap.exists &&
          (vanSnap.data() as Record<string, unknown>)?.status === "confirmed";
        if (rawSession.state === "booking_confirmed" || hasExistingAudit || isVanConfirmed) {
          return {
            success: false,
            error: "already_approved" as const,
            message: `Booking session '${sessionId}' has already been approved and confirmed. Duplicate approval rejected.`,
          };
        }

        // 4. State validation check
        if (rawSession.state !== "awaiting_staff_approval") {
          return {
            success: false,
            error: "invalid_state" as const,
            message: `Cannot approve booking: session is in state '${rawSession.state}', expected 'awaiting_staff_approval'.`,
          };
        }

        // 5. Enforce official booking bridge requirement & identity integrity
        if (!vanSnap.exists) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: "Cannot approve booking: official van_requests record does not exist in store.",
          };
        }

        const existingVanData = vanSnap.data() as Record<string, unknown>;
        try {
          validateOfficialBookingIdentity(rawSession, existingVanData, {
            requireOfficialBridge: true,
            requireExistingRecord: true,
          });
        } catch (identityErr) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: identityErr instanceof Error ? identityErr.message : "Official booking identity validation failed",
          };
        }

        // 5. Mandatory quotation integrity revalidation inside transaction
        const integrity = verifyQuotationIntegrity(
          rawSession.quotationSnapshot,
          rawSession.requirements,
          rawSession.quotation
        );
        if (!integrity.isMatch) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: `Cannot approve booking: quotation integrity validation failed (${
              integrity.reason || integrity.mismatchedFields.join(", ")
            })`,
          };
        }

        // 5b. Slot capacity and distributed interval-overlap reservation check
        let timeSlot: string;
        try {
          timeSlot = deriveBookingTimeSlot(rawSession);
        } catch (tsErr) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: tsErr instanceof Error ? tsErr.message : "Failed to derive valid booking time slot",
          };
        }

        const eventDate = rawSession.requirements?.eventDate as string;
        const slotDocId = computeScheduleSlotDocId(eventDate, timeSlot);
        const dayDocId = computeScheduleDayDocId(eventDate);

        const slotRef = db.collection(SCHEDULE_SLOTS_COLLECTION).doc(slotDocId);
        const dayRef = db.collection(SCHEDULE_SLOTS_COLLECTION).doc(dayDocId);

        const slotSnap = (await transaction.get(slotRef)) as {
          exists: boolean;
          data: () => unknown;
        };
        const daySnap = (await transaction.get(dayRef)) as {
          exists: boolean;
          data: () => unknown;
        };

        // Check 1: Exact slot collision
        if (slotSnap.exists) {
          const slotData = slotSnap.data() as Record<string, unknown>;
          if (slotData && slotData.bookingId !== vanRequestId && slotData.status !== "cancelled") {
            return {
              success: false,
              error: "invalid_state" as const,
              message: `Resource collision: The date slot '${eventDate} (${timeSlot})' is already booked by reservation #${String(
                slotData.bookingId
              )}.`,
            };
          }
        }

        // Check 2: Daily interval overlap collision
        const parsedCurrent = parseTimeSlot(timeSlot);
        if (!parsedCurrent) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: `Invalid time slot format '${timeSlot}'.`,
          };
        }

        const existingDayData = daySnap.exists ? (daySnap.data() as Record<string, unknown>) : null;
        const dayReservations = (existingDayData?.reservations as ScheduleReservationEntry[] | undefined) || [];

        for (const res of dayReservations) {
          if (res.bookingId !== vanRequestId && res.status !== "cancelled") {
            if (parsedCurrent.startMinutes < res.endMinutes && res.startMinutes < parsedCurrent.endMinutes) {
              return {
                success: false,
                error: "invalid_state" as const,
                message: `Resource collision: The requested date slot '${eventDate} (${timeSlot})' overlaps with existing reservation #${res.bookingId} (${res.timeSlot}).`,
              };
            }
          }
        }

        // 6. Execute domain approval transition
        let approvedSession: VoiceBookingSession;
        try {
          approvedSession = transitionFn(rawSession, validAuthContext);
        } catch (transErr) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: transErr instanceof Error ? transErr.message : "Approval transition failed",
          };
        }

        // 6b. Increment monotonic revision on approval commit using validated stored revision
        const existingRevision = validateStoredRevision(rawSession.revision, sessionId);
        approvedSession.revision = existingRevision + 1;
        approvedSession.officialBookingId = vanRequestId;
        if (!approvedSession.metadata) approvedSession.metadata = {};
        approvedSession.metadata.officialBookingId = vanRequestId;
        approvedSession.metadata.bookingSource = "voice_booking";

        // 7. Validate and serialize approved session
        const serialized = serializeSessionForFirestore(approvedSession);

        // 7b. Construct official confirmed van_requests record and durable slot records
        let confirmedVanRequest: Record<string, unknown>;
        try {
          confirmedVanRequest = createVanRequestRecordFromSession(
            approvedSession,
            "confirmed",
            validAuthContext,
            existingVanData
          );
        } catch (vanReqErr) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: vanReqErr instanceof Error ? vanReqErr.message : "Failed to construct official van request record",
          };
        }

        const slotReservationRecord = {
          id: slotDocId,
          eventDate,
          timeSlot,
          startMinutes: parsedCurrent.startMinutes,
          endMinutes: parsedCurrent.endMinutes,
          bookingId: vanRequestId,
          reservedAt: new Date().toISOString(),
          status: "reserved",
          source: "voice_booking",
        };

        const updatedReservations: ScheduleReservationEntry[] = [
          ...dayReservations.filter((r) => r.bookingId !== vanRequestId),
          {
            bookingId: vanRequestId,
            timeSlot,
            startMinutes: parsedCurrent.startMinutes,
            endMinutes: parsedCurrent.endMinutes,
            reservedAt: new Date().toISOString(),
            status: "reserved",
            source: "voice_booking",
          },
        ];

        const dayScheduleRecord = {
          id: dayDocId,
          eventDate,
          reservations: updatedReservations,
          updatedAt: new Date().toISOString(),
        };

        // Construct booking_confirmed outbox delivery records
        const confirmedDeliveries = createOutboxDeliveriesForTransition(approvedSession);
        for (const delivery of confirmedDeliveries) {
          const dRef = db.collection(OUTBOX_COLLECTION).doc(delivery.id);
          await transaction.get(dRef);
        }

        // --- 8. STRICT TRANSACTION WRITE PHASE (WRITES FOLLOW ALL READS) ---
        transaction.set(docRef, serialized);
        transaction.set(vanRequestRef, confirmedVanRequest);
        transaction.set(slotRef, slotReservationRecord);
        transaction.set(dayRef, dayScheduleRecord);
        for (const delivery of confirmedDeliveries) {
          const dRef = db.collection(OUTBOX_COLLECTION).doc(delivery.id);
          transaction.set(dRef, delivery);
        }

        return {
          success: true,
          session: approvedSession,
          officialBooking: confirmedVanRequest,
          eventDate,
          timeSlot,
          vanRequestId,
          isBridgeActive: true,
        };
      });

      if (result.success && result.eventDate && result.timeSlot && result.vanRequestId) {
        try {
          this.postCommitSyncFn(result.eventDate, result.timeSlot, result.vanRequestId, "voice_booking");
        } catch (e) {
          console.warn("Non-fatal: in-memory slot reservation failed after successful Firestore commit:", e);
        }
      }

      return {
        success: result.success,
        session: result.session,
        officialBooking: result.officialBooking,
        error: result.error,
        message: result.message,
      };
    } catch (txError) {
      console.error(
        `[FIRESTORE REPO] Transaction failed during approval of session ${sessionId}:`,
        txError instanceof Error ? txError.message : txError
      );
      throw txError;
    }
  }

  async atomicRejectBooking(
    sessionId: string,
    authContext: StaffRejectionAuthorizationContext,
    transitionFn: (
      session: VoiceBookingSession,
      authContext: StaffRejectionAuthorizationContext
    ) => VoiceBookingSession
  ): Promise<AtomicRejectionResult> {
    const parseResult = StaffRejectionAuthorizationContextSchema.safeParse(authContext);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join(".") || "context"}: ${i.message}`)
        .join("; ");
      throw new Error(`Staff authorization failure: invalid StaffRejectionAuthorizationContext (${issues})`);
    }

    const validAuthContext = parseResult.data;
    const db = this.getDb();
    const docRef = db.collection(VOICE_BOOKING_COLLECTION).doc(sessionId);
    const vanRequestId = computeOfficialVanRequestId(sessionId);
    const vanRequestRef = db.collection(VAN_REQUESTS_COLLECTION).doc(vanRequestId);

    try {
      return await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(docRef);
        if (!snap.exists) {
          return {
            success: false,
            error: "session_not_found" as const,
            message: `Voice booking session not found: ${sessionId}`,
          };
        }

        const rawSession = deserializeSessionFromFirestore(snap.data());

        if (rawSession.id !== sessionId) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: `Document identity mismatch: document path ID '${sessionId}' does not match payload session.id '${rawSession.id}'.`,
          };
        }

        const vanSnap = await transaction.get(vanRequestRef);

        if (rawSession.state === "booking_confirmed" || rawSession.staffApprovalAudit) {
          return {
            success: false,
            error: "already_processed" as const,
            message: `Booking session '${sessionId}' has already been approved and confirmed. Conflict rejected.`,
          };
        }

        if (rawSession.state === "customer_declined" || rawSession.staffRejectionAudit) {
          return {
            success: false,
            error: "already_processed" as const,
            message: `Booking session '${sessionId}' has already been rejected. Duplicate rejection rejected.`,
          };
        }

        if (rawSession.state !== "awaiting_staff_approval") {
          return {
            success: false,
            error: "invalid_state" as const,
            message: `Cannot reject booking: session is in state '${rawSession.state}', expected 'awaiting_staff_approval'.`,
          };
        }

        let rejectedSession: VoiceBookingSession;
        try {
          rejectedSession = transitionFn(rawSession, validAuthContext);
        } catch (transErr) {
          return {
            success: false,
            error: "invalid_state" as const,
            message: transErr instanceof Error ? transErr.message : "Rejection transition failed",
          };
        }

        const existingRevision = validateStoredRevision(rawSession.revision, sessionId);
        rejectedSession.revision = existingRevision + 1;

        const serialized = serializeSessionForFirestore(rejectedSession);
        transaction.set(docRef, serialized);

        if (vanSnap.exists) {
          transaction.update(vanRequestRef, {
            status: "declined",
            rejectionReason: validAuthContext.reason,
            rejectedAt: rejectedSession.staffRejectionAudit?.rejectedAt,
            rejectedBy: validAuthContext.staffIdentity,
            updatedAt: new Date().toISOString(),
          });
        }

        return {
          success: true,
          session: rejectedSession,
        };
      });
    } catch (txError) {
      console.error(
        `[FIRESTORE REPO] Transaction failed during rejection of session ${sessionId}:`,
        txError instanceof Error ? txError.message : txError
      );
      throw txError;
    }
  }

  async getOfficialBooking(id: string): Promise<Record<string, unknown> | null> {
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      return null;
    }
    const db = this.getDb();
    const snap = await db.collection(VAN_REQUESTS_COLLECTION).doc(id.trim()).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  }

  async getOutboxDeliveries(sessionId?: string): Promise<CommunicationDeliveryRecord[]> {
    const db = this.getDb();
    let query: FirebaseFirestore.Query = db.collection(OUTBOX_COLLECTION);
    if (sessionId) {
      query = query.where("sessionId", "==", sessionId);
    }
    const snap = await query.get();
    return snap.docs.map((doc) => doc.data() as CommunicationDeliveryRecord);
  }

  async getAllSessions(): Promise<VoiceBookingSession[]> {
    const db = this.getDb();
    try {
      const snap = await db.collection(VOICE_BOOKING_COLLECTION).orderBy("createdAt", "desc").limit(50).get();
      return snap.docs.map((doc) => deserializeSessionFromFirestore(doc.data()));
    } catch {
      return [];
    }
  }
}
