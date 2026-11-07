/**
 * BREW Coffee Platform — Phase 6.2.1 Voice Booking Session Repository
 * In-memory repository implementation with deep cloning to ensure caller immutability.
 * 
 * ⚠️ CRITICAL DURABILITY & PROCESS LIFECYCLE NOTICE:
 * - This repository stores session data in an ephemeral in-process JavaScript Map.
 * - IT LACKS DURABILITY ACROSS PROCESS RESTARTS: all sessions, customer confirmation states,
 *   and staff approval audit records are completely lost when the server restarts or re-deploys.
 * - In multi-instance or serverless environments (e.g., Cloud Run, Vercel), in-memory repositories
 *   do not share state across concurrent requests or pods.
 * - This implementation is intended strictly for local development and unit/integration testing.
 *   Production deployment requires a durable, distributed datastore (e.g. Firestore or PostgreSQL).
 */

import {
  AtomicApprovalResult,
  AtomicRejectionResult,
  IncompleteSessionLookupError,
  isTerminalVoiceState,
  maskVoicePhoneNumber,
  OptimisticConcurrencyConflictError,
  StaffAuthorizationContext,
  StaffRejectionAuthorizationContext,
  TerminalSessionImmutableError,
  validateScanBudget,
  VoiceBookingSession,
  VoiceSessionLookupIntegrityError,
  VoiceSessionLookupOptions,
  VoiceSessionRepository,
} from "../types";
import { VoiceBookingSessionSchema } from "../schemas";
import { isValidStrictIsoUtc } from "../../communication/schemas";
import { CommunicationDeliveryRecord } from "../../communication/types";
import { CommunicationDeliveryRecordSchema } from "../../communication/schemas";
import { createOutboxDeliveriesForTransition } from "../../communication/outbox/outboxModel";
import { validateStoredRevision } from "./firestoreSessionRepository";
import {
  computeOfficialVanRequestId,
  computeScheduleDayDocId,
  computeScheduleSlotDocId,
  createVanRequestRecordFromSession,
  deriveBookingTimeSlot,
  ScheduleReservationEntry,
  validateOfficialBookingIdentity,
} from "../vanRequestBridge";
import {
  checkSlotAvailability,
  parseTimeSlot,
  reserveSlot,
} from "../../eventBookingConcierge/policy";
import { verifyQuotationIntegrity } from "../quotationAdapter";

class IndexedSessionMap extends Map<string, VoiceBookingSession> {
  private phoneIndex: Map<string, Set<string>>;

  constructor(phoneIndex: Map<string, Set<string>>) {
    super();
    this.phoneIndex = phoneIndex;
  }

  override set(key: string, value: VoiceBookingSession): this {
    const existing = super.get(key);
    if (existing && existing.phoneNumber && typeof existing.phoneNumber === "string") {
      const oldNorm = existing.phoneNumber.trim();
      const newNorm = value && typeof value === "object" && typeof value.phoneNumber === "string"
        ? value.phoneNumber.trim()
        : "";
      if (oldNorm.length > 0 && oldNorm !== newNorm) {
        const oldSet = this.phoneIndex.get(oldNorm);
        if (oldSet) {
          oldSet.delete(key);
          if (oldSet.size === 0) {
            this.phoneIndex.delete(oldNorm);
          }
        }
      }
    }

    super.set(key, value);

    if (value && typeof value === "object" && typeof value.phoneNumber === "string") {
      const norm = value.phoneNumber.trim();
      if (norm.length > 0) {
        let set = this.phoneIndex.get(norm);
        if (!set) {
          set = new Set<string>();
          this.phoneIndex.set(norm, set);
        }
        set.add(key);
      }
    }
    return this;
  }

  override delete(key: string): boolean {
    const existing = super.get(key);
    if (existing && existing.phoneNumber && typeof existing.phoneNumber === "string") {
      const norm = existing.phoneNumber.trim();
      if (norm.length > 0) {
        const set = this.phoneIndex.get(norm);
        if (set) {
          set.delete(key);
          if (set.size === 0) {
            this.phoneIndex.delete(norm);
          }
        }
      }
    }
    return super.delete(key);
  }

  override clear(): void {
    super.clear();
    this.phoneIndex.clear();
  }
}

export class InMemoryVoiceSessionRepository implements VoiceSessionRepository {
  readonly isDurable: boolean = false;
  readonly storageType = "memory" as const;
  private phoneIndex: Map<string, Set<string>> = new Map();
  private sessions: Map<string, VoiceBookingSession>;
  private officialVanRequests: Map<string, Record<string, unknown>> = new Map();
  private scheduleSlots: Map<string, Record<string, unknown>> = new Map();
  private scheduleDays: Map<string, { id: string; eventDate: string; reservations: ScheduleReservationEntry[]; updatedAt: string }> = new Map();
  private sessionLocks: Map<string, Promise<void>> = new Map();
  private outbox: Map<string, CommunicationDeliveryRecord> = new Map();

  constructor() {
    this.sessions = new IndexedSessionMap(this.phoneIndex);
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
    this.officialVanRequests.clear();
    this.scheduleSlots.clear();
    this.scheduleDays.clear();
    this.sessionLocks.clear();
    this.outbox.clear();
    this.lastScanInspectedCount = 0;
  }

  getScheduleSlot(slotDocId: string): Record<string, unknown> | null {
    const slot = this.scheduleSlots.get(slotDocId);
    return slot ? JSON.parse(JSON.stringify(slot)) : null;
  }

  getScheduleDay(dayDocId: string): Record<string, unknown> | null {
    const day = this.scheduleDays.get(dayDocId);
    return day ? JSON.parse(JSON.stringify(day)) : null;
  }

  public getPhoneIndex(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.phoneIndex;
  }

  public getIndexedPhoneCount(): number {
    return this.phoneIndex.size;
  }

  public getIndexedSessionCount(phone: string): number {
    const set = this.phoneIndex.get(phone.trim());
    return set ? set.size : 0;
  }

  async getById(id: string): Promise<VoiceBookingSession | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    return JSON.parse(JSON.stringify(session));
  }

  async save(session: VoiceBookingSession, expectedRevision?: number): Promise<void> {
    if (!session || typeof session !== "object") {
      throw new Error("Cannot save session: session must be a valid object.");
    }
    if (!session.id || typeof session.id !== "string" || session.id.trim().length === 0) {
      throw new Error("Cannot save session: missing or empty session.id.");
    }

    const sessionId = session.id;
    const immutableExpectedRevision: number | undefined = expectedRevision;
    const isCreateOperation = immutableExpectedRevision === undefined;

    const clone: VoiceBookingSession = JSON.parse(JSON.stringify(session));
    const existing = this.sessions.get(sessionId);

    if (existing) {
      // Create-only semantics check: reject duplicate creation
      if (isCreateOperation) {
        throw new OptimisticConcurrencyConflictError(
          `Cannot create session '${sessionId}': document already exists in store. Concurrent create rejected.`
        );
      }

      // 1. Terminal state protection: reject ordinary saves if stored document is terminal
      const hasAudit = Boolean(existing.staffApprovalAudit);
      if (isTerminalVoiceState(existing.state) || hasAudit) {
        throw new TerminalSessionImmutableError(
          `Cannot update session '${sessionId}' in terminal state '${existing.state}'. Terminal sessions are immutable.`
        );
      }

      // 2. Strict revision validation
      const existingRevision = validateStoredRevision(existing.revision, sessionId);

      if (existingRevision !== immutableExpectedRevision) {
        throw new OptimisticConcurrencyConflictError(
          `Optimistic concurrency conflict on session '${sessionId}': expected revision ${immutableExpectedRevision}, but stored revision is ${existingRevision}. Stale write rejected.`
        );
      }

      // 3. Monotonic revision increment
      const nextRevision = existingRevision + 1;
      clone.revision = nextRevision;
      this.sessions.set(sessionId, clone);
      session.revision = nextRevision;
    } else {
      // Document does not exist in store
      if (!isCreateOperation) {
        throw new OptimisticConcurrencyConflictError(
          `Cannot update session '${sessionId}': document does not exist in store. Expected revision was ${immutableExpectedRevision}. Stale update on missing or deleted session rejected.`
        );
      }

      // Brand new session initialization via explicit create
      clone.revision = 1;
      this.sessions.set(sessionId, clone);
      session.revision = 1;
    }

    // Official van_requests persistence bridge
    const isOfficialLifecycle =
      Boolean(clone.officialBookingId) ||
      clone.state === "customer_confirmed" ||
      clone.state === "awaiting_staff_approval" ||
      clone.state === "booking_confirmed";

    if (isOfficialLifecycle) {
      const vanRequestId = computeOfficialVanRequestId(sessionId);
      const existingVan = this.officialVanRequests.get(vanRequestId);
      validateOfficialBookingIdentity(clone, existingVan);
      const vanRecord = createVanRequestRecordFromSession(
        clone,
        "pending",
        undefined,
        existingVan
      );
      this.officialVanRequests.set(vanRequestId, vanRecord);
    }
  }

  async saveWithOutbox(
    session: VoiceBookingSession,
    expectedRevision: number,
    outboxDeliveries: CommunicationDeliveryRecord[]
  ): Promise<void> {
    const validatedDeliveries = outboxDeliveries.map((d) =>
      CommunicationDeliveryRecordSchema.parse(d)
    );

    await this.save(session, expectedRevision);

    for (const delivery of validatedDeliveries) {
      this.outbox.set(delivery.id, JSON.parse(JSON.stringify(delivery)));
    }
  }

  public lastScanInspectedCount = 0;

  public getLastScanInspectedCount(): number {
    return this.lastScanInspectedCount;
  }

  private validateSessionCandidate(
    candidate: unknown,
    maskedPhone: string
  ): VoiceBookingSession {
    if (!candidate || typeof candidate !== "object") {
      throw new VoiceSessionLookupIntegrityError(
        maskedPhone,
        "unknown",
        "Document payload is null or not an object"
      );
    }

    const candObj = candidate as Record<string, unknown>;
    const candId = candObj.id;

    if (typeof candId !== "string" || candId.trim().length === 0) {
      throw new VoiceSessionLookupIntegrityError(
        maskedPhone,
        String(candId ?? "unknown"),
        "Invalid or empty session ID"
      );
    }

    // Strict validation of createdAt and updatedAt timestamps
    if (
      !candObj.createdAt ||
      typeof candObj.createdAt !== "string" ||
      !isValidStrictIsoUtc(candObj.createdAt)
    ) {
      throw new VoiceSessionLookupIntegrityError(
        maskedPhone,
        candId,
        `Session has missing, malformed, or non-UTC createdAt timestamp (${String(candObj.createdAt)})`
      );
    }

    if (
      !candObj.updatedAt ||
      typeof candObj.updatedAt !== "string" ||
      !isValidStrictIsoUtc(candObj.updatedAt)
    ) {
      throw new VoiceSessionLookupIntegrityError(
        maskedPhone,
        candId,
        `Session has missing, malformed, or non-UTC updatedAt timestamp (${String(candObj.updatedAt)})`
      );
    }

    // Revision validation
    if ("revision" in candObj) {
      validateStoredRevision(candObj.revision, candId);
    }

    // Full schema validation
    try {
      return VoiceBookingSessionSchema.parse(candidate);
    } catch (schemaErr) {
      const msg = schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
      throw new VoiceSessionLookupIntegrityError(
        maskedPhone,
        candId,
        `Schema validation failed: ${msg}`
      );
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
    const maskedPhone = maskVoicePhoneNumber(trimmedPhone);

    this.lastScanInspectedCount = 0;

    const candidateIds = this.phoneIndex.get(trimmedPhone);
    if (!candidateIds || candidateIds.size === 0) {
      return null;
    }

    const validSessions: VoiceBookingSession[] = [];
    let hasMoreBeyondBudget = false;

    for (const sessionId of candidateIds) {
      this.lastScanInspectedCount++;
      if (this.lastScanInspectedCount > maxBudget) {
        // Documented 1-candidate truncation probe
        hasMoreBeyondBudget = true;
        break;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }

      const validated = this.validateSessionCandidate(session, maskedPhone);
      validSessions.push(validated);
    }

    // If additional records exist beyond the budget, fail closed with IncompleteSessionLookupError
    if (hasMoreBeyondBudget) {
      throw new IncompleteSessionLookupError(trimmedPhone, maxBudget);
    }

    if (validSessions.length === 0) {
      return null;
    }

    // Sort in memory by createdAt descending, tie-breaking on document ID descending
    validSessions.sort((a, b) => {
      const timeA = Date.parse(a.createdAt);
      const timeB = Date.parse(b.createdAt);
      if (timeB !== timeA) return timeB - timeA;
      return b.id.localeCompare(a.id);
    });

    if (!options?.activeOnly) {
      return JSON.parse(JSON.stringify(validSessions[0]));
    }

    const active = validSessions.find(
      (s) => !isTerminalVoiceState(s.state) && !Boolean(s.staffApprovalAudit)
    );
    return active ? JSON.parse(JSON.stringify(active)) : null;
  }

  /**
   * Atomically evaluates pre-conditions, executes the approval transition, and commits
   * the approved state and audit record together in a single atomic/serialized operation.
   * 
   * PROCESS-LOCAL CONCURRENCY SPECIFICATION:
   * - Uses a per-session mutex queue to serialize concurrent approval attempts within
   *   the local Node.js process.
   * - Approval succeeds ONLY when the stored session is currently 'awaiting_staff_approval'
   *   and has no existing staffApprovalAudit record.
   * - Exactly ONE concurrent caller will succeed (returning HTTP 200 via route handlers).
   * - All concurrent or subsequent callers will find the session already transitioned to
   *   'booking_confirmed' and fail closed with error 'already_approved' (HTTP 409 Conflict).
   * 
   * ⚠️ HORIZONTAL DISTRIBUTED CONCURRENCY NOTICE:
   * - This mutex is strictly process-local. It does NOT protect across multiple serverless
   *   instances or containers (e.g. multi-pod Cloud Run or Vercel).
   * - A future production Firestore repository must implement this exact conditional write
   *   using a Cloud Firestore transaction (`runTransaction`) or database row lock.
   */
  async atomicApproveBooking(
    sessionId: string,
    authContext: StaffAuthorizationContext,
    transitionFn: (
      session: VoiceBookingSession,
      authContext: StaffAuthorizationContext
    ) => VoiceBookingSession
  ): Promise<AtomicApprovalResult> {
    // Wait for any existing in-flight operation on this sessionId
    while (this.sessionLocks.has(sessionId)) {
      await this.sessionLocks.get(sessionId);
    }

    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.sessionLocks.set(sessionId, lockPromise);

    try {
      const rawSession = this.sessions.get(sessionId);
      if (!rawSession) {
        return {
          success: false,
          error: "session_not_found",
          message: `Voice booking session not found: ${sessionId}`,
        };
      }

      // Document identity check
      if (rawSession.id !== sessionId) {
        return {
          success: false,
          error: "invalid_state",
          message: `Document identity mismatch: stored session ID '${rawSession.id}' does not match requested session ID '${sessionId}'.`,
        };
      }

      const vanRequestId = computeOfficialVanRequestId(sessionId);
      const existingVan = this.officialVanRequests.get(vanRequestId);

      // Duplicate approval check
      const hasExistingAudit = Boolean(rawSession.staffApprovalAudit);
      const isVanConfirmed = existingVan && existingVan.status === "confirmed";
      if (rawSession.state === "booking_confirmed" || hasExistingAudit || isVanConfirmed) {
        return {
          success: false,
          error: "already_approved",
          message: `Booking session '${sessionId}' has already been approved and confirmed. Duplicate approval rejected.`,
        };
      }

      // State validation check
      if (rawSession.state !== "awaiting_staff_approval") {
        return {
          success: false,
          error: "invalid_state",
          message: `Cannot approve booking: session is in state '${rawSession.state}', expected 'awaiting_staff_approval'.`,
        };
      }

      // Enforce mandatory official booking bridge & identity integrity
      if (!existingVan) {
        return {
          success: false,
          error: "invalid_state",
          message: "Cannot approve booking: official van_requests record does not exist in store.",
        };
      }

      try {
        validateOfficialBookingIdentity(rawSession, existingVan, {
          requireOfficialBridge: true,
          requireExistingRecord: true,
        });
      } catch (identityErr) {
        return {
          success: false,
          error: "invalid_state",
          message: identityErr instanceof Error ? identityErr.message : "Official booking identity validation failed",
        };
      }

      // Mandatory quotation integrity revalidation
      const integrity = verifyQuotationIntegrity(
        rawSession.quotationSnapshot,
        rawSession.requirements,
        rawSession.quotation
      );
      if (!integrity.isMatch) {
        return {
          success: false,
          error: "invalid_state",
          message: `Cannot approve booking: quotation integrity validation failed (${
            integrity.reason || integrity.mismatchedFields.join(", ")
          })`,
        };
      }

      // Double-booking & distributed interval-overlap scheduling check
      let timeSlot: string;
      try {
        timeSlot = deriveBookingTimeSlot(rawSession);
      } catch (tsErr) {
        return {
          success: false,
          error: "invalid_state",
          message: tsErr instanceof Error ? tsErr.message : "Failed to derive valid booking time slot",
        };
      }

      const eventDate = rawSession.requirements?.eventDate as string;
      const slotDocId = computeScheduleSlotDocId(eventDate, timeSlot);
      const dayDocId = computeScheduleDayDocId(eventDate);

      // Check 1: Exact slot collision
      const existingSlot = this.scheduleSlots.get(slotDocId);
      if (existingSlot && existingSlot.bookingId !== vanRequestId && existingSlot.status !== "cancelled") {
        return {
          success: false,
          error: "invalid_state",
          message: `Resource collision: The date slot '${eventDate} (${timeSlot})' is already booked by reservation #${String(
            existingSlot.bookingId
          )}.`,
        };
      }

      // Check 2: Daily interval overlap collision
      const parsedCurrent = parseTimeSlot(timeSlot);
      if (!parsedCurrent) {
        return {
          success: false,
          error: "invalid_state",
          message: `Invalid time slot format '${timeSlot}'.`,
        };
      }

      const existingDay = this.scheduleDays.get(dayDocId);
      const dayReservations = existingDay?.reservations || [];
      for (const res of dayReservations) {
        if (res.bookingId !== vanRequestId && res.status !== "cancelled") {
          if (parsedCurrent.startMinutes < res.endMinutes && res.startMinutes < parsedCurrent.endMinutes) {
            return {
              success: false,
              error: "invalid_state",
              message: `Resource collision: The requested date slot '${eventDate} (${timeSlot})' overlaps with existing reservation #${res.bookingId} (${res.timeSlot}).`,
            };
          }
        }
      }

      // Check 3: Process-local policy check (in-memory repository testing only)
      const policySlotCheck = checkSlotAvailability(eventDate, timeSlot);
      if (!policySlotCheck.isAvailable && policySlotCheck.conflictingBookingId !== vanRequestId) {
        return {
          success: false,
          error: "invalid_state",
          message: `Resource collision: The date slot '${eventDate} (${timeSlot})' is already booked by reservation #${policySlotCheck.conflictingBookingId}.`,
        };
      }

      // Execute transition and commit atomic state update together
      const existingRevision = validateStoredRevision(rawSession.revision, sessionId);
      const sessionClone: VoiceBookingSession = JSON.parse(JSON.stringify(rawSession));
      const approvedSession = transitionFn(sessionClone, authContext);
      approvedSession.revision = existingRevision + 1;
      approvedSession.officialBookingId = vanRequestId;
      if (!approvedSession.metadata) approvedSession.metadata = {};
      approvedSession.metadata.officialBookingId = vanRequestId;
      approvedSession.metadata.bookingSource = "voice_booking";

      let confirmedVanRecord: Record<string, unknown>;
      try {
        confirmedVanRecord = createVanRequestRecordFromSession(
          approvedSession,
          "confirmed",
          authContext,
          existingVan
        );
      } catch (vanReqErr) {
        return {
          success: false,
          error: "invalid_state",
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

      this.sessions.set(sessionId, JSON.parse(JSON.stringify(approvedSession)));
      this.officialVanRequests.set(vanRequestId, confirmedVanRecord);
      this.scheduleSlots.set(slotDocId, slotReservationRecord);
      this.scheduleDays.set(dayDocId, dayScheduleRecord);

      // Atomically write booking_confirmed outbox deliveries
      const confirmedDeliveries = createOutboxDeliveriesForTransition(approvedSession);
      for (const d of confirmedDeliveries) {
        this.outbox.set(d.id, JSON.parse(JSON.stringify(d)));
      }

      try {
        reserveSlot(eventDate, timeSlot, vanRequestId, "voice_booking");
      } catch (e) {
        console.warn("Non-fatal: in-memory slot reservation failed in mock:", e);
      }

      return {
        success: true,
        session: approvedSession,
        officialBooking: confirmedVanRecord || undefined,
      };
    } finally {
      this.sessionLocks.delete(sessionId);
      releaseLock();
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
    while (this.sessionLocks.has(sessionId)) {
      await this.sessionLocks.get(sessionId);
    }

    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.sessionLocks.set(sessionId, lockPromise);

    try {
      const rawSession = this.sessions.get(sessionId);
      if (!rawSession) {
        return {
          success: false,
          error: "session_not_found",
          message: `Voice booking session not found: ${sessionId}`,
        };
      }

      if (rawSession.id !== sessionId) {
        return {
          success: false,
          error: "invalid_state",
          message: `Document identity mismatch: stored session ID '${rawSession.id}' does not match requested session ID '${sessionId}'.`,
        };
      }

      const vanRequestId = computeOfficialVanRequestId(sessionId);
      const existingVan = this.officialVanRequests.get(vanRequestId);

      if (rawSession.state === "booking_confirmed" || rawSession.staffApprovalAudit) {
        return {
          success: false,
          error: "already_processed",
          message: `Booking session '${sessionId}' has already been approved and confirmed. Conflict rejected.`,
        };
      }

      if (rawSession.state === "customer_declined" || rawSession.staffRejectionAudit) {
        return {
          success: false,
          error: "already_processed",
          message: `Booking session '${sessionId}' has already been rejected. Duplicate rejection rejected.`,
        };
      }

      if (rawSession.state !== "awaiting_staff_approval") {
        return {
          success: false,
          error: "invalid_state",
          message: `Cannot reject booking: session is in state '${rawSession.state}', expected 'awaiting_staff_approval'.`,
        };
      }

      const existingRevision = validateStoredRevision(rawSession.revision, sessionId);
      const sessionClone: VoiceBookingSession = JSON.parse(JSON.stringify(rawSession));
      const rejectedSession = transitionFn(sessionClone, authContext);
      rejectedSession.revision = existingRevision + 1;

      // Update van_requests record if present
      if (existingVan) {
        existingVan.status = "declined";
        existingVan.rejectionReason = authContext.reason;
        existingVan.rejectedAt = rejectedSession.staffRejectionAudit?.rejectedAt;
        existingVan.rejectedBy = authContext.staffIdentity;
        this.officialVanRequests.set(vanRequestId, existingVan);
      }

      this.sessions.set(sessionId, VoiceBookingSessionSchema.parse(rejectedSession));

      return {
        success: true,
        session: rejectedSession,
        officialBooking: existingVan || undefined,
      };
    } finally {
      this.sessionLocks.delete(sessionId);
      releaseLock();
    }
  }

  async getOfficialBooking(id: string): Promise<Record<string, unknown> | null> {
    const record = this.officialVanRequests.get(id);
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  async getOutboxDeliveries(sessionId?: string): Promise<CommunicationDeliveryRecord[]> {
    const list: CommunicationDeliveryRecord[] = [];
    for (const record of this.outbox.values()) {
      if (!sessionId || record.sessionId === sessionId) {
        list.push(JSON.parse(JSON.stringify(record)));
      }
    }
    return list;
  }

  getOutboxStore(): Map<string, CommunicationDeliveryRecord> {
    return this.outbox;
  }

  async getAllSessions(): Promise<VoiceBookingSession[]> {
    return Array.from(this.sessions.values()).map((s) => JSON.parse(JSON.stringify(s)));
  }
}
