/**
 * BREW Coffee Platform — Phase 6.3.2.1 Verification Suite
 * Firestore Transaction Ordering, Booking Integrity & Slot Reservation Hardening
 * 
 * Verifies:
 * 1. Transaction read ordering guard: get() after set() throws in simulator
 * 2. Valid approval commits session, van_requests, and schedule_slots together
 * 3. In-memory repository performs atomic slot reservation without race conditions
 * 4. Fabricated crowd size ("50 guests") is rejected when requirements are missing
 * 5. Fabricated location ("TBD") is rejected when requirements are missing
 * 6. Missing event date fails validation
 * 7. Missing quotation fails validation
 * 8. Official booking ID matching requirement: arbitrary client ID is rejected
 * 9. Mismatched document ID in van_requests is rejected
 * 10. Mismatched voiceSessionId in van_requests is rejected
 * 11. Conflicting ownership/source metadata is rejected
 * 12. Slot conflict in schedule_slots prevents approval
 * 13. Failed slot reservation rolls back all writes
 * 14. Manual booking via existing /api/request-van continues to work
 * 15. Parity between in-memory and Firestore implementations
 */

process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "events@brewcoffee.internal";

import assert from "assert";
import {
  BookingRequirements,
  StaffAuthorizationContext,
  VoiceBookingSession,
  OptimisticConcurrencyConflictError,
  TerminalSessionImmutableError,
  InvalidOfficialBookingBridgeDataError,
} from "../src/lib/voiceBooking/types";
import {
  createVoiceBookingSession,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  InMemoryVoiceSessionRepository,
} from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  FirestoreVoiceSessionRepository,
  VOICE_BOOKING_COLLECTION,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import {
  computeOfficialVanRequestId,
  computeScheduleSlotDocId,
  createVanRequestRecordFromSession,
  validateOfficialBookingIdentity,
  deriveBookingTimeSlot,
  VAN_REQUESTS_COLLECTION,
  SCHEDULE_SLOTS_COLLECTION,
} from "../src/lib/voiceBooking/vanRequestBridge";
import {
  createQuotationSnapshot,
  generateVoiceBookingQuotation,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  clearPolicyRegistries,
} from "../src/lib/eventBookingConcierge/policy";
import { VanRequestInputSchema } from "../src/lib/agentSchemas";

// HMAC secret for snapshot hashing in testing
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-32-chars-long!";

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.2.1: Transaction Ordering & Hardening Suite");
console.log("   Test Mode: Strict Simulator Read Guard & Dual-Store Integrity Engine");
console.log("===============================================================================\n");

let passedCount = 0;

function recordPass(desc: string) {
  passedCount++;
  console.log(`  ✓ ${desc}`);
}

const validAuthContext: StaffAuthorizationContext = {
  staffIdentity: "barista_op_42",
  staffRole: "barista",
  staffApprovalId: "appr_test_778899",
};

const sampleTransitionFn = (
  session: VoiceBookingSession,
  auth: StaffAuthorizationContext
): VoiceBookingSession => {
  session.state = "booking_confirmed";
  session.staffApprovalId = auth.staffApprovalId;
  session.staffApprovalAudit = {
    staffIdentity: auth.staffIdentity,
    staffRole: auth.staffRole as "barista",
    staffApprovalId: auth.staffApprovalId,
    approvedAt: new Date().toISOString(),
    sessionId: session.id,
  };
  return session;
};

/**
 * High-fidelity Mock Firestore with strict read-before-write validation.
 */
class HardenedMockFirestore {
  public docs: Map<string, { data: Record<string, unknown>; version: number }> = new Map();
  public transactionAttempts = 0;

  private makeKey(col: string, id: string): string {
    return `${col}:::${id.trim()}`;
  }

  getDoc(col: string, id: string) {
    const key = this.makeKey(col, id);
    const entry = this.docs.get(key);
    if (!entry) return null;
    return {
      exists: true,
      data: () => JSON.parse(JSON.stringify(entry.data)),
      version: entry.version,
    };
  }

  setDoc(col: string, id: string, data: Record<string, unknown>) {
    const key = this.makeKey(col, id);
    const existing = this.docs.get(key);
    const version = (existing?.version || 0) + 1;
    this.docs.set(key, {
      data: JSON.parse(JSON.stringify(data)),
      version,
    });
  }

  createFirestoreInstance(options?: { failOnTxAttempt?: number }) {
    const collection = (colName: string) => ({
      doc: (id: string) => {
        const trimmedId = id.trim();
        return {
          id: trimmedId,
          colName,
          get: async () => {
            const doc = this.getDoc(colName, trimmedId);
            if (!doc) {
              return { exists: false, data: () => undefined, id: trimmedId, colName };
            }
            return { exists: true, data: doc.data, id: trimmedId, colName };
          },
          set: async (data: Record<string, unknown>) => {
            this.setDoc(colName, trimmedId, data);
          },
        };
      },
    });

    return {
      collection,
      runTransaction: async <T>(
        updateFunction: (transaction: {
          get: (ref: { id: string; colName?: string }) => Promise<{ exists: boolean; data: () => unknown }>;
          set: (ref: { id: string; colName?: string }, data: Record<string, unknown>) => void;
        }) => Promise<T>
      ): Promise<T> => {
        const maxRetries = 5;
        let attempt = 0;

        while (attempt < maxRetries) {
          attempt++;
          this.transactionAttempts++;

          if (options?.failOnTxAttempt && this.transactionAttempts === options.failOnTxAttempt) {
            throw new Error(`Simulated transient transaction failure on attempt ${this.transactionAttempts}`);
          }

          const stagedWrites = new Map<string, { col: string; id: string; data: Record<string, unknown> }>();
          const readVersions = new Map<string, number>();
          let hasWritten = false;

          const txContext = {
            get: async (ref: { id: string; colName?: string }) => {
              if (hasWritten) {
                throw new Error("Firestore transaction read-after-write violation: all reads must occur before any writes.");
              }
              const col = ref.colName || (ref.id.startsWith("enq_") ? VAN_REQUESTS_COLLECTION : (ref.id.includes("___") ? SCHEDULE_SLOTS_COLLECTION : VOICE_BOOKING_COLLECTION));
              const key = this.makeKey(col, ref.id);
              const doc = this.docs.get(key);
              readVersions.set(key, doc?.version || 0);

              if (!doc) {
                return { exists: false, data: () => undefined, id: ref.id, colName: col };
              }
              return { exists: true, data: () => JSON.parse(JSON.stringify(doc.data)), id: ref.id, colName: col };
            },
            set: (ref: { id: string; colName?: string }, data: Record<string, unknown>) => {
              hasWritten = true;
              const col = ref.colName || (ref.id.startsWith("enq_") ? VAN_REQUESTS_COLLECTION : (ref.id.includes("___") ? SCHEDULE_SLOTS_COLLECTION : VOICE_BOOKING_COLLECTION));
              stagedWrites.set(this.makeKey(col, ref.id), { col, id: ref.id, data });
            },
          };

          try {
            const result = await updateFunction(txContext);

            // Verify optimistic locks on commit
            for (const [key, readVersion] of readVersions.entries()) {
              const currentDoc = this.docs.get(key);
              const currentVersion = currentDoc?.version || 0;
              if (currentVersion !== readVersion) {
                throw new Error("Contention detected: optimistic lock conflict.");
              }
            }

            // Commit all staged writes atomically
            for (const write of stagedWrites.values()) {
              this.setDoc(write.col, write.id, write.data);
            }

            return result;
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes("Contention detected") && attempt < maxRetries) {
              continue;
            }
            throw err;
          }
        }
        throw new Error("Transaction aborted: maximum retries exceeded.");
      },
    };
  }
}

function buildValidRequirements(overrides?: Partial<BookingRequirements>): BookingRequirements {
  return {
    guestCount: 60,
    eventDate: "2026-11-25",
    startTime: "10:00",
    durationHours: 3,
    venueAddress: "Jubilee Hills, Road No 36, Hyderabad",
    eventType: "corporate",
    beveragePreferences: ["Cortado", "Cold Brew"],
    selectedTier: "STANDARD",
    handoffRequested: false,
    customerConfirmed: true,
    confidenceScore: 0.95,
    missingFields: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

async function runHardeningTests() {
  clearPolicyRegistries();

  // ===========================================================================
  // Scenario 1: Firestore transaction read ordering guard in simulator
  // ===========================================================================
  console.log("▶ Scenario 1: Firestore transaction read ordering: get() after set() throws in simulator");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;

    // 1A. Directly test that calling get() after set() throws the violation
    let guardCaught = false;
    try {
      await db.runTransaction(async (tx) => {
        const ref1 = db.collection("test_col").doc("doc_1");
        const ref2 = db.collection("test_col").doc("doc_2");
        tx.set(ref1 as unknown as FirebaseFirestore.DocumentReference, { a: 1 });
        await tx.get(ref2 as unknown as FirebaseFirestore.DocumentReference);
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Firestore transaction read-after-write violation")) {
        guardCaught = true;
      }
    }
    assert.strictEqual(guardCaught, true, "Simulator guard must throw read-after-write violation");

    // 1B. Verify that FirestoreVoiceSessionRepository.save() does NOT violate this order
    const repo = new FirestoreVoiceSessionRepository(db);
    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    // Initial creation: all reads must precede writes
    await repo.save(session);
    assert.strictEqual(session.revision, 1);

    // Update operation: all reads must precede writes
    session.requirements.guestCount = 70;
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session, 1);
    assert.strictEqual(session.revision, 2);

    recordPass("Simulator detects read-after-write, and FirestoreVoiceSessionRepository.save() completes with strict read-before-write ordering");
  }

  // ===========================================================================
  // Scenario 2: Valid approval commits session, van_requests, and slot reservation together
  // ===========================================================================
  console.log("▶ Scenario 2: Valid approval commits session, van_requests, and slot reservation together");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543211", "en");
    session.requirements = buildValidRequirements({ eventDate: "2026-12-01", startTime: "14:00" });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await repo.save(session);

    const result = await repo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.session?.state, "booking_confirmed");
    assert.strictEqual(result.officialBooking?.status, "confirmed");

    // Verify all 3 documents exist in the store
    const sessionDoc = mock.getDoc(VOICE_BOOKING_COLLECTION, session.id);
    assert.ok(sessionDoc && sessionDoc.data().state === "booking_confirmed");

    const vanId = computeOfficialVanRequestId(session.id);
    const vanDoc = mock.getDoc(VAN_REQUESTS_COLLECTION, vanId);
    assert.ok(vanDoc && vanDoc.data().status === "confirmed");

    const timeSlot = deriveBookingTimeSlot(session);
    const slotDocId = computeScheduleSlotDocId("2026-12-01", timeSlot);
    const slotDoc = mock.getDoc(SCHEDULE_SLOTS_COLLECTION, slotDocId);
    assert.ok(slotDoc, "Slot reservation record must be committed to schedule_slots");
    assert.strictEqual(slotDoc?.data().status, "reserved");
    assert.strictEqual(slotDoc?.data().bookingId, vanId);

    recordPass("Valid approval commits voice session, van_requests, and schedule_slots atomically");
  }

  // ===========================================================================
  // Scenario 3: In-memory repository performs atomic slot reservation without race conditions
  // ===========================================================================
  console.log("▶ Scenario 3: In-memory repository performs atomic slot reservation without race conditions");
  {
    const inMemoryRepo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543212", "en");
    session.requirements = buildValidRequirements({ eventDate: "2026-12-02", startTime: "09:00" });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await inMemoryRepo.save(session);

    // Fire 2 concurrent approval attempts on the same session
    const [res1, res2] = await Promise.all([
      inMemoryRepo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn),
      inMemoryRepo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn),
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const duplicates = [res1, res2].filter((r) => r.error === "already_approved");

    assert.strictEqual(successes.length, 1, "Exactly one concurrent approval must succeed");
    assert.strictEqual(duplicates.length, 1, "Concurrent contender must fail with already_approved");

    const timeSlot = deriveBookingTimeSlot(session);
    const slotDocId = computeScheduleSlotDocId("2026-12-02", timeSlot);
    const slotRecord = inMemoryRepo.getScheduleSlot(slotDocId);
    assert.ok(slotRecord, "Schedule slot record must be present");
    assert.strictEqual(slotRecord?.status, "reserved");

    recordPass("In-memory repository atomically serializes approval and reserves slot without race conditions");
  }

  // ===========================================================================
  // Scenario 4: Fabricated crowd size ("50 guests") is rejected when requirements are missing
  // ===========================================================================
  console.log("▶ Scenario 4: Fabricated crowd size ('50 guests') is rejected when requirements are missing");
  {
    const session = createVoiceBookingSession("+919876543213", "en");
    session.requirements = buildValidRequirements();
    session.requirements.guestCount = null as unknown as number; // Missing guest count
    session.quotation = generateVoiceBookingQuotation(buildValidRequirements(), session.id);

    let caught = false;
    try {
      createVanRequestRecordFromSession(session);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("guestCount")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Must throw InvalidOfficialBookingBridgeDataError on missing/invalid guestCount");
    recordPass("Fabricated crowd size fallback is eliminated; missing guestCount throws InvalidOfficialBookingBridgeDataError");
  }

  // ===========================================================================
  // Scenario 5: Fabricated location ("TBD") is rejected when requirements are missing
  // ===========================================================================
  console.log("▶ Scenario 5: Fabricated location ('TBD') is rejected when requirements are missing");
  {
    const session = createVoiceBookingSession("+919876543214", "en");
    session.requirements = buildValidRequirements();
    session.requirements.venueAddress = null as unknown as string; // Missing location
    session.quotation = generateVoiceBookingQuotation(buildValidRequirements(), session.id);

    let caught = false;
    try {
      createVanRequestRecordFromSession(session);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("venueAddress")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Must throw InvalidOfficialBookingBridgeDataError on missing venueAddress");
    recordPass("Fabricated location fallback is eliminated; missing venueAddress throws InvalidOfficialBookingBridgeDataError");
  }

  // ===========================================================================
  // Scenario 6: Missing event date fails validation
  // ===========================================================================
  console.log("▶ Scenario 6: Missing event date fails validation");
  {
    const session = createVoiceBookingSession("+919876543215", "en");
    session.requirements = buildValidRequirements();
    session.requirements.eventDate = null as unknown as string; // Missing eventDate
    session.quotation = generateVoiceBookingQuotation(buildValidRequirements(), session.id);

    let caught = false;
    try {
      createVanRequestRecordFromSession(session);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("eventDate")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Must throw InvalidOfficialBookingBridgeDataError on missing eventDate");
    recordPass("Missing eventDate strictly throws InvalidOfficialBookingBridgeDataError");
  }

  // ===========================================================================
  // Scenario 7: Missing quotation fails validation
  // ===========================================================================
  console.log("▶ Scenario 7: Missing quotation fails validation");
  {
    const session = createVoiceBookingSession("+919876543216", "en");
    session.requirements = buildValidRequirements();
    session.quotation = null; // Missing quotation

    let caught = false;
    try {
      createVanRequestRecordFromSession(session);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("quotation")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Must throw InvalidOfficialBookingBridgeDataError on missing quotation");
    recordPass("Missing quotation strictly throws InvalidOfficialBookingBridgeDataError");
  }

  // ===========================================================================
  // Scenario 8: Official booking ID matching requirement: arbitrary client ID is rejected
  // ===========================================================================
  console.log("▶ Scenario 8: Official booking ID matching requirement: arbitrary client ID is rejected");
  {
    const session = createVoiceBookingSession("+919876543217", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.officialBookingId = "custom_client_supplied_id_999";

    let caught = false;
    try {
      validateOfficialBookingIdentity(session);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("Official booking ID mismatch")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Arbitrary officialBookingId must be rejected");
    recordPass("Arbitrary client-supplied officialBookingId is strictly rejected");
  }

  // ===========================================================================
  // Scenario 9: Mismatched document ID in van_requests is rejected
  // ===========================================================================
  console.log("▶ Scenario 9: Mismatched document ID in van_requests is rejected");
  {
    const session = createVoiceBookingSession("+919876543218", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    const existingCorruptedVan = {
      id: "enq_voice_completely_different_session_id",
      voiceSessionId: session.id,
      source: "voice_booking",
    };

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, existingCorruptedVan);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("record ID mismatch")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Mismatched document ID must be rejected");
    recordPass("Mismatched document ID in van_requests document is strictly rejected");
  }

  // ===========================================================================
  // Scenario 10: Mismatched voiceSessionId in van_requests is rejected
  // ===========================================================================
  console.log("▶ Scenario 10: Mismatched voiceSessionId in van_requests is rejected");
  {
    const session = createVoiceBookingSession("+919876543219", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    const existingCorruptedVan = {
      id: computeOfficialVanRequestId(session.id),
      voiceSessionId: "foreign_session_12345",
      source: "voice_booking",
    };

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, existingCorruptedVan);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("ownership mismatch")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Mismatched voiceSessionId must be rejected");
    recordPass("Mismatched voiceSessionId in van_requests is strictly rejected");
  }

  // ===========================================================================
  // Scenario 11: Conflicting ownership/source metadata is rejected
  // ===========================================================================
  console.log("▶ Scenario 11: Conflicting ownership/source metadata is rejected");
  {
    const session = createVoiceBookingSession("+919876543220", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    const existingCorruptedVan = {
      id: computeOfficialVanRequestId(session.id),
      voiceSessionId: session.id,
      source: "manual_web_submission", // Not voice_booking
    };

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, existingCorruptedVan);
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("source mismatch")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Conflicting source metadata must be rejected");
    recordPass("Conflicting non-voice_booking source metadata is strictly rejected");
  }

  // ===========================================================================
  // Scenario 12: Slot conflict in schedule_slots prevents approval
  // ===========================================================================
  console.log("▶ Scenario 12: Slot conflict in schedule_slots prevents approval");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);

    const conflictDate = "2026-12-05";
    const conflictSlot = "10:00-13:00";
    const conflictSlotDocId = computeScheduleSlotDocId(conflictDate, conflictSlot);

    // Pre-reserve the slot by a foreign booking
    mock.setDoc(SCHEDULE_SLOTS_COLLECTION, conflictSlotDocId, {
      id: conflictSlotDocId,
      eventDate: conflictDate,
      timeSlot: conflictSlot,
      bookingId: "enq_voice_other_foreign_session",
      status: "reserved",
    });

    const session = createVoiceBookingSession("+919876543221", "en");
    session.requirements = buildValidRequirements({ eventDate: conflictDate, startTime: "10:00", durationHours: 3 });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await repo.save(session);

    const result = await repo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "invalid_state");
    assert.ok(result.message?.includes("Resource collision"), "Message must explain resource collision");
    recordPass("Pre-existing slot reservation in schedule_slots safely blocks conflicting approval");
  }

  // ===========================================================================
  // Scenario 13: Failed slot reservation rolls back all writes
  // ===========================================================================
  console.log("▶ Scenario 13: Failed slot reservation rolls back all writes");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);

    const conflictDate = "2026-12-06";
    const conflictSlot = "11:00-15:00";
    const conflictSlotDocId = computeScheduleSlotDocId(conflictDate, conflictSlot);

    // Pre-reserve slot
    mock.setDoc(SCHEDULE_SLOTS_COLLECTION, conflictSlotDocId, {
      id: conflictSlotDocId,
      eventDate: conflictDate,
      timeSlot: conflictSlot,
      bookingId: "enq_voice_prior_booking",
      status: "reserved",
    });

    const session = createVoiceBookingSession("+919876543222", "en");
    session.requirements = buildValidRequirements({ eventDate: conflictDate, startTime: "11:00", durationHours: 4 });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await repo.save(session);

    const initialRevision = session.revision;

    // Attempt approval which will fail on slot check
    const result = await repo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn);
    assert.strictEqual(result.success, false);

    // Verify session in store was NOT modified to booking_confirmed
    const storedSession = await repo.getById(session.id);
    assert.strictEqual(storedSession?.state, "awaiting_staff_approval");
    assert.strictEqual(storedSession?.revision, initialRevision);
    assert.strictEqual(storedSession?.staffApprovalAudit, null);

    // Verify official van record was NOT confirmed
    const vanId = computeOfficialVanRequestId(session.id);
    const storedVan = await repo.getOfficialBooking(vanId);
    assert.strictEqual(storedVan?.status, "pending");

    recordPass("Failed slot collision leaves both session and van_requests cleanly unchanged");
  }

  // ===========================================================================
  // Scenario 14: Manual booking via existing /api/request-van continues to work
  // ===========================================================================
  console.log("▶ Scenario 14: Manual booking via existing /api/request-van continues to work");
  {
    const manualPayload = {
      contact: "+919876543223",
      organization: "Tech Innovation Summit",
      location: "Banjara Hills, Hyderabad",
      eventDate: "2026-12-15",
      crowdSize: "150 guests",
      notes: "Requires VIP espresso bar setup",
      idempotencyKey: "manual_req_test_001",
    };

    const parsed = VanRequestInputSchema.parse(manualPayload);
    assert.strictEqual(parsed.contact, manualPayload.contact);
    assert.strictEqual(parsed.organization, manualPayload.organization);
    assert.strictEqual(parsed.location, manualPayload.location);
    assert.strictEqual(parsed.eventDate, manualPayload.eventDate);
    assert.strictEqual(parsed.crowdSize, manualPayload.crowdSize);

    recordPass("Manual van catering enquiry schema validation executes seamlessly without alteration");
  }

  // ===========================================================================
  // Scenario 15: Parity between in-memory and Firestore implementations
  // ===========================================================================
  console.log("▶ Scenario 15: Parity between in-memory and Firestore implementations");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const firestoreRepo = new FirestoreVoiceSessionRepository(db);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const dateFs = "2026-12-20";
    const dateMem = "2026-12-21";
    const startTime = "15:00";

    // Create session in Firestore repo
    const fsSession = createVoiceBookingSession("+919876543224", "en");
    fsSession.requirements = buildValidRequirements({ eventDate: dateFs, startTime });
    fsSession.quotation = generateVoiceBookingQuotation(fsSession.requirements, fsSession.id);
    fsSession.quotationSnapshot = createQuotationSnapshot(fsSession.requirements);
    fsSession.state = "awaiting_staff_approval";
    fsSession.officialBookingId = computeOfficialVanRequestId(fsSession.id);
    fsSession.metadata = { officialBookingId: fsSession.officialBookingId };
    await firestoreRepo.save(fsSession);

    // Create equivalent session in InMemory repo
    const memSession = createVoiceBookingSession("+919876543225", "en");
    memSession.requirements = buildValidRequirements({ eventDate: dateMem, startTime });
    memSession.quotation = generateVoiceBookingQuotation(memSession.requirements, memSession.id);
    memSession.quotationSnapshot = createQuotationSnapshot(memSession.requirements);
    memSession.state = "awaiting_staff_approval";
    memSession.officialBookingId = computeOfficialVanRequestId(memSession.id);
    memSession.metadata = { officialBookingId: memSession.officialBookingId };
    await inMemoryRepo.save(memSession);

    // 1. Both approve successfully
    const fsApprove = await firestoreRepo.atomicApproveBooking(fsSession.id, validAuthContext, sampleTransitionFn);
    const memApprove = await inMemoryRepo.atomicApproveBooking(memSession.id, validAuthContext, sampleTransitionFn);

    assert.strictEqual(fsApprove.success, true);
    assert.strictEqual(memApprove.success, true);
    assert.strictEqual(fsApprove.session?.state, memApprove.session?.state);
    assert.strictEqual(fsApprove.officialBooking?.status, memApprove.officialBooking?.status);

    // 2. Both reject duplicate approval identically
    const fsDup = await firestoreRepo.atomicApproveBooking(fsSession.id, validAuthContext, sampleTransitionFn);
    const memDup = await inMemoryRepo.atomicApproveBooking(memSession.id, validAuthContext, sampleTransitionFn);

    assert.strictEqual(fsDup.success, false);
    assert.strictEqual(memDup.success, false);
    assert.strictEqual(fsDup.error, "already_approved");
    assert.strictEqual(memDup.error, "already_approved");

    // 3. Both reject saves on confirmed/terminal session with stale revision
    let fsStaleCaught = false;
    try {
      await firestoreRepo.save(fsSession, 1);
    } catch (err) {
      if (err instanceof OptimisticConcurrencyConflictError || err instanceof TerminalSessionImmutableError) {
        fsStaleCaught = true;
      }
    }
    let memStaleCaught = false;
    try {
      await inMemoryRepo.save(memSession, 1);
    } catch (err) {
      if (err instanceof OptimisticConcurrencyConflictError || err instanceof TerminalSessionImmutableError) {
        memStaleCaught = true;
      }
    }
    assert.strictEqual(fsStaleCaught, true);
    assert.strictEqual(memStaleCaught, true);

    recordPass("Complete operational contract parity verified between InMemory and Firestore repositories");
  }

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.2.1 Verification Complete: ${passedCount}/15 Scenarios Passed, 0 Failed`);
  console.log("===============================================================================");
}

runHardeningTests().catch((err) => {
  console.error("Verification failed with uncaught error:", err);
  process.exit(1);
});
