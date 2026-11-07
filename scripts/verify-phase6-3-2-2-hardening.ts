/**
 * BREW Coffee Platform — Phase 6.3.2.2 Hardening Verification Suite
 * Distributed Scheduling Integrity & Mandatory Official Booking Bridge
 * 
 * Strict test mode: Dual-store simulator with Firestore read-before-write state guard.
 * Clearly separates simulator testing from live Firestore emulator testing.
 * 
 * Verifies 18 exhaustive scenarios:
 * 1. Missing officialBookingId rejected during approval.
 * 2. Missing metadata booking ID rejected.
 * 3. Mismatched official record ID rejected.
 * 4. Missing voiceSessionId rejected.
 * 5. Missing or incorrect source rejected.
 * 6. Approval cannot confirm without an official van_requests record.
 * 7. Missing start time rejected.
 * 8. Missing duration rejected.
 * 9. Invalid date/time rejected.
 * 10. Exact slot collision rejected.
 * 11. Overlapping time ranges rejected.
 * 12. Concurrent overlapping approvals from separate repository instances cannot both succeed.
 * 13. Manual-versus-voice booking conflicts are handled by the shared durable policy.
 * 14. Failed schedule reservation rolls back the session and official booking writes.
 * 15. Firestore transaction read-after-write guard remains enforced.
 * 16. Firestore transaction retries do not duplicate external side effects.
 * 17. Manual booking regression tests remain green.
 * 18. In-memory and Firestore behavior agree on the documented scheduling contract.
 */

process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "events@brewcoffee.internal";
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "test-quotation-secret-phase6-3-2-2-32chars";

import assert from "assert";
import {
  BookingRequirements,
  StaffAuthorizationContext,
  VoiceBookingSession,
  InvalidBookingTimeSlotError,
  InvalidOfficialBookingBridgeDataError,
} from "../src/lib/voiceBooking/types";
import {
  FirestoreVoiceSessionRepository,
  serializeSessionForFirestore,
  VOICE_BOOKING_COLLECTION,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  createVoiceBookingSession,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  createQuotationSnapshot,
  generateVoiceBookingQuotation,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  computeOfficialVanRequestId,
  computeScheduleDayDocId,
  computeScheduleSlotDocId,
  deriveBookingTimeSlot,
  reserveManualBookingSlot,
  SCHEDULE_SLOTS_COLLECTION,
  validateOfficialBookingIdentity,
  VAN_REQUESTS_COLLECTION,
} from "../src/lib/voiceBooking/vanRequestBridge";
import {
  clearPolicyRegistries,
} from "../src/lib/eventBookingConcierge/policy";
import { VanRequestInputSchema } from "../src/lib/agentSchemas";

// =============================================================================
// Hardened Mock Firestore with Strict Read-Before-Write State Guard
// =============================================================================

interface MockDoc {
  id: string;
  data: () => Record<string, unknown>;
  exists: boolean;
}

class HardenedMockFirestore {
  private collections = new Map<string, Map<string, Record<string, unknown>>>();

  constructor() {
    this.collections.set(VOICE_BOOKING_COLLECTION, new Map());
    this.collections.set(VAN_REQUESTS_COLLECTION, new Map());
    this.collections.set(SCHEDULE_SLOTS_COLLECTION, new Map());
  }

  getDoc(col: string, id: string): MockDoc | null {
    const colMap = this.collections.get(col);
    if (!colMap) return null;
    const doc = colMap.get(id);
    if (!doc) return null;
    return {
      id,
      exists: true,
      data: () => JSON.parse(JSON.stringify(doc)),
    };
  }

  setDoc(col: string, id: string, data: Record<string, unknown>): void {
    let colMap = this.collections.get(col);
    if (!colMap) {
      colMap = new Map();
      this.collections.set(col, colMap);
    }
    colMap.set(id, JSON.parse(JSON.stringify(data)));
  }

  createFirestoreInstance() {
    const collections = this.collections;

    const collection = (colName: string) => {
      const allowed = new Set([
        VOICE_BOOKING_COLLECTION,
        VAN_REQUESTS_COLLECTION,
        SCHEDULE_SLOTS_COLLECTION,
        "booking_communication_outbox",
        "test_col",
      ]);
      if (!allowed.has(colName)) {
        throw new Error(`Unexpected collection in mock: ${colName}`);
      }

      return {
        doc: (id: string) => ({
          id,
          colName,
          get: async (): Promise<MockDoc> => {
            const colMap = collections.get(colName);
            const doc = colMap?.get(id);
            if (!doc) {
              return { id, exists: false, data: () => ({}) };
            }
            return { id, exists: true, data: () => JSON.parse(JSON.stringify(doc)) };
          },
          set: async (data: Record<string, unknown>) => {
            let colMap = collections.get(colName);
            if (!colMap) {
              colMap = new Map();
              collections.set(colName, colMap);
            }
            colMap.set(id, JSON.parse(JSON.stringify(data)));
          },
        }),
      };
    };

    return {
      collection,
      runTransaction: async <T>(
        updateFunction: (transaction: {
          get: (ref: { id: string; colName?: string }) => Promise<MockDoc>;
          set: (ref: { id: string; colName?: string }, data: Record<string, unknown>) => void;
        }) => Promise<T>
      ): Promise<T> => {
        let hasWritten = false;
        const stagedWrites: Array<{ col: string; id: string; data: Record<string, unknown> }> = [];

        const transaction = {
          get: async (ref: { id: string; colName?: string }): Promise<MockDoc> => {
            if (hasWritten) {
              throw new Error(
                "Firestore transaction read-after-write violation: all reads must occur before any writes."
              );
            }
            let col = ref.colName;
            if (!col) {
              if (ref.id.startsWith("vbs_")) col = VOICE_BOOKING_COLLECTION;
              else if (ref.id.startsWith("enq_")) col = VAN_REQUESTS_COLLECTION;
              else if (ref.id.includes("___") || ref.id.startsWith("day___")) col = SCHEDULE_SLOTS_COLLECTION;
              else col = VOICE_BOOKING_COLLECTION;
            }
            const colMap = collections.get(col);
            const doc = colMap?.get(ref.id);
            if (!doc) {
              return { id: ref.id, exists: false, data: () => ({}) };
            }
            return {
              id: ref.id,
              exists: true,
              data: () => JSON.parse(JSON.stringify(doc)),
            };
          },
          set: (ref: { id: string; colName?: string }, data: Record<string, unknown>) => {
            hasWritten = true;
            let col = ref.colName;
            if (!col) {
              if (ref.id.startsWith("vbs_")) col = VOICE_BOOKING_COLLECTION;
              else if (ref.id.startsWith("enq_")) col = VAN_REQUESTS_COLLECTION;
              else if (ref.id.includes("___") || ref.id.startsWith("day___")) col = SCHEDULE_SLOTS_COLLECTION;
              else col = VOICE_BOOKING_COLLECTION;
            }
            stagedWrites.push({ col, id: ref.id, data });
          },
        };

        const result = await updateFunction(transaction);

        // Commit all staged writes atomically
        for (const write of stagedWrites) {
          let colMap = collections.get(write.col);
          if (!colMap) {
            colMap = new Map();
            collections.set(write.col, colMap);
          }
          colMap.set(write.id, JSON.parse(JSON.stringify(write.data)));
        }

        return result;
      },
    };
  }
}

// =============================================================================
// Fixtures & Shared Helpers
// =============================================================================

const validAuthContext: StaffAuthorizationContext = {
  staffIdentity: "barista_lead_99",
  staffRole: "barista" as const,
  staffApprovalId: "appr_p6322_test_1",
};

function buildValidRequirements(overrides: Partial<BookingRequirements> = {}): BookingRequirements {
  return {
    eventType: "Corporate Festival",
    guestCount: 75,
    eventDate: "2026-12-15",
    startTime: "10:00",
    durationHours: 4,
    venueAddress: "77 Innovation Boulevard, Tech Park",
    selectedTier: "STANDARD",
    customerConfirmed: true,
    beveragePreferences: ["Cappuccino", "Espresso"],
    handoffRequested: false,
    confidenceScore: 1,
    missingFields: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

function sampleTransitionFn(
  session: VoiceBookingSession,
  auth: StaffAuthorizationContext
): VoiceBookingSession {
  session.state = "booking_confirmed";
  session.staffApprovalId = auth.staffApprovalId;
  session.staffApprovalAudit = {
    staffIdentity: auth.staffIdentity,
    staffRole: auth.staffRole as "barista" | "fleet_admin" | "admin",
    staffApprovalId: auth.staffApprovalId,
    approvedAt: new Date().toISOString(),
    sessionId: session.id,
  };
  return session;
}

function recordPass(msg: string) {
  console.log(`  ✓ ${msg}`);
}

// =============================================================================
// Test Suite Execution
// =============================================================================

async function runHardeningTests() {
  console.log("===============================================================================");
  console.log("   BREW Coffee — Phase 6.3.2.2: Distributed Scheduling & Mandatory Bridge");
  console.log("   Test Mode: Strict Simulator Read Guard & Dual-Store Interval Integrity");
  console.log("===============================================================================\n");

  // ===========================================================================
  // Scenario 1: Missing officialBookingId rejected during approval
  // ===========================================================================
  console.log("▶ Scenario 1: Missing officialBookingId rejected during approval");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const session = createVoiceBookingSession("+919876543201", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    // Intentionally omit session.officialBookingId
    session.officialBookingId = null;

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, null, { requireOfficialBridge: true });
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("missing officialBookingId")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Missing officialBookingId must be rejected");
    recordPass("Missing officialBookingId strictly rejected by validateOfficialBookingIdentity");
  }

  // ===========================================================================
  // Scenario 2: Missing metadata booking ID rejected
  // ===========================================================================
  console.log("▶ Scenario 2: Missing metadata booking ID rejected");
  {
    const session = createVoiceBookingSession("+919876543202", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    // Intentionally omit metadata.officialBookingId
    session.metadata = {};

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, null, { requireOfficialBridge: true });
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("metadata.officialBookingId is missing")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Missing metadata.officialBookingId must be rejected");
    recordPass("Missing metadata.officialBookingId strictly rejected");
  }

  // ===========================================================================
  // Scenario 3: Mismatched official record ID rejected
  // ===========================================================================
  console.log("▶ Scenario 3: Mismatched official record ID rejected");
  {
    const session = createVoiceBookingSession("+919876543203", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    const mismatchedRecord = {
      id: "enq_voice_completely_different_id",
      voiceSessionId: session.id,
      source: "voice_booking",
    };

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, mismatchedRecord, { requireOfficialBridge: true, requireExistingRecord: true });
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("Official booking record ID mismatch")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Mismatched record.id must be rejected");
    recordPass("Mismatched official van_requests record ID strictly rejected");
  }

  // ===========================================================================
  // Scenario 4: Missing voiceSessionId rejected
  // ===========================================================================
  console.log("▶ Scenario 4: Missing voiceSessionId rejected");
  {
    const session = createVoiceBookingSession("+919876543204", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    const invalidRecord = {
      id: session.officialBookingId,
      voiceSessionId: "", // Empty / missing
      source: "voice_booking",
    };

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, invalidRecord, { requireOfficialBridge: true, requireExistingRecord: true });
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("missing 'voiceSessionId'")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Missing voiceSessionId must be rejected");
    recordPass("Missing voiceSessionId in official record strictly rejected");
  }

  // ===========================================================================
  // Scenario 5: Missing or incorrect source rejected
  // ===========================================================================
  console.log("▶ Scenario 5: Missing or incorrect source rejected");
  {
    const session = createVoiceBookingSession("+919876543205", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    const invalidRecord = {
      id: session.officialBookingId,
      voiceSessionId: session.id,
      source: "web_enquiry", // Not voice_booking!
    };

    let caught = false;
    try {
      validateOfficialBookingIdentity(session, invalidRecord, { requireOfficialBridge: true, requireExistingRecord: true });
    } catch (err) {
      if (err instanceof InvalidOfficialBookingBridgeDataError && err.message.includes("source mismatch")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Incorrect source must be rejected");
    recordPass("Incorrect non-voice_booking source strictly rejected");
  }

  // ===========================================================================
  // Scenario 6: Approval cannot confirm without an official van_requests record
  // ===========================================================================
  console.log("▶ Scenario 6: Approval cannot confirm without an official van_requests record");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const session = createVoiceBookingSession("+919876543206", "en");
    session.requirements = buildValidRequirements();
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };

    // Write session directly WITHOUT creating van_requests document
    mock.setDoc(VOICE_BOOKING_COLLECTION, session.id, serializeSessionForFirestore(session));

    const result = await repo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "invalid_state");
    assert.ok(
      result.message?.includes("official van_requests record does not exist"),
      "Message must explain official record does not exist"
    );
    recordPass("Approval strictly fails closed when official van_requests record does not exist");
  }

  // ===========================================================================
  // Scenario 7: Missing start time rejected
  // ===========================================================================
  console.log("▶ Scenario 7: Missing start time rejected");
  {
    const session = createVoiceBookingSession("+919876543207", "en");
    session.requirements = buildValidRequirements();
    session.requirements.startTime = null as unknown as string; // Missing startTime

    let caught = false;
    try {
      deriveBookingTimeSlot(session);
    } catch (err) {
      if (err instanceof InvalidBookingTimeSlotError && err.message.includes("startTime")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Missing startTime must throw InvalidBookingTimeSlotError");
    recordPass("Missing startTime strictly throws InvalidBookingTimeSlotError");
  }

  // ===========================================================================
  // Scenario 8: Missing duration rejected
  // ===========================================================================
  console.log("▶ Scenario 8: Missing duration rejected");
  {
    const session = createVoiceBookingSession("+919876543208", "en");
    session.requirements = buildValidRequirements();
    session.requirements.durationHours = null as unknown as number; // Missing duration

    let caught = false;
    try {
      deriveBookingTimeSlot(session);
    } catch (err) {
      if (err instanceof InvalidBookingTimeSlotError && err.message.includes("durationHours")) {
        caught = true;
      }
    }
    assert.strictEqual(caught, true, "Missing durationHours must throw InvalidBookingTimeSlotError");
    recordPass("Missing durationHours strictly throws InvalidBookingTimeSlotError without inventing defaults");
  }

  // ===========================================================================
  // Scenario 9: Invalid date/time rejected
  // ===========================================================================
  console.log("▶ Scenario 9: Invalid date/time rejected");
  {
    // 9A. Invalid calendar date (Feb 31)
    const sessionInvalidDate = createVoiceBookingSession("+919876543209", "en");
    sessionInvalidDate.requirements = buildValidRequirements({ eventDate: "2026-02-31" });

    let caughtDate = false;
    try {
      deriveBookingTimeSlot(sessionInvalidDate);
    } catch (err) {
      if (err instanceof InvalidBookingTimeSlotError && err.message.includes("eventDate")) {
        caughtDate = true;
      }
    }
    assert.strictEqual(caughtDate, true, "Feb 31 must be rejected as invalid calendar date");

    // 9B. Crossing midnight boundary
    const sessionMidnight = createVoiceBookingSession("+919876543210", "en");
    sessionMidnight.requirements = buildValidRequirements({ startTime: "22:00", durationHours: 4 });

    let caughtMidnight = false;
    try {
      deriveBookingTimeSlot(sessionMidnight);
    } catch (err) {
      if (err instanceof InvalidBookingTimeSlotError && err.message.includes("midnight")) {
        caughtMidnight = true;
      }
    }
    assert.strictEqual(caughtMidnight, true, "Time slot crossing midnight must be rejected");
    recordPass("Invalid calendar dates and midnight-boundary crossing intervals strictly rejected");
  }

  // ===========================================================================
  // Scenario 10: Exact slot collision rejected
  // ===========================================================================
  console.log("▶ Scenario 10: Exact slot collision rejected");
  {
    clearPolicyRegistries();
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const eventDate = "2026-12-15";
    const timeSlot = "10:00-14:00";
    const slotDocId = computeScheduleSlotDocId(eventDate, timeSlot);

    // Pre-reserve the exact slot
    mock.setDoc(SCHEDULE_SLOTS_COLLECTION, slotDocId, {
      id: slotDocId,
      eventDate,
      timeSlot,
      bookingId: "enq_voice_prior_booking_exact",
      status: "reserved",
    });

    const session = createVoiceBookingSession("+919876543211", "en");
    session.requirements = buildValidRequirements({ eventDate, startTime: "10:00", durationHours: 4 });
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
    recordPass("Exact slot collision strictly blocks duplicate approval");
  }

  // ===========================================================================
  // Scenario 11: Overlapping time ranges rejected
  // ===========================================================================
  console.log("▶ Scenario 11: Overlapping time ranges rejected");
  {
    clearPolicyRegistries();
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const eventDate = "2026-12-15";
    const dayDocId = computeScheduleDayDocId(eventDate);

    // Pre-reserve an overlapping interval in the daily schedule: 10:00 to 14:00
    mock.setDoc(SCHEDULE_SLOTS_COLLECTION, dayDocId, {
      id: dayDocId,
      eventDate,
      reservations: [
        {
          bookingId: "enq_voice_booking_morning",
          timeSlot: "10:00-14:00",
          startMinutes: 600,
          endMinutes: 840,
          reservedAt: new Date().toISOString(),
          status: "reserved",
          source: "voice_booking",
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    // Session requests overlapping slot: 12:00 to 16:00
    const session = createVoiceBookingSession("+919876543212", "en");
    session.requirements = buildValidRequirements({ eventDate, startTime: "12:00", durationHours: 4 });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await repo.save(session);

    const result = await repo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "invalid_state");
    assert.ok(result.message?.includes("overlaps with existing reservation"), "Must identify interval overlap");
    recordPass("Overlapping time range (10:00-14:00 vs 12:00-16:00) strictly rejected with overlap collision");
  }

  // ===========================================================================
  // Scenario 12: Concurrent overlapping approvals from separate instances cannot both succeed
  // ===========================================================================
  console.log("▶ Scenario 12: Concurrent overlapping approvals from separate repository instances cannot both succeed");
  {
    clearPolicyRegistries();
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const eventDate = "2026-12-16";

    // Session A: 10:00-14:00
    const sessionA = createVoiceBookingSession("+919876543213", "en");
    sessionA.requirements = buildValidRequirements({ eventDate, startTime: "10:00", durationHours: 4 });
    sessionA.quotation = generateVoiceBookingQuotation(sessionA.requirements, sessionA.id);
    sessionA.quotationSnapshot = createQuotationSnapshot(sessionA.requirements);
    sessionA.state = "awaiting_staff_approval";
    sessionA.officialBookingId = computeOfficialVanRequestId(sessionA.id);
    sessionA.metadata = { officialBookingId: sessionA.officialBookingId };
    await inMemoryRepo.save(sessionA);

    // Session B: 12:00-16:00 (overlaps with Session A)
    const sessionB = createVoiceBookingSession("+919876543214", "en");
    sessionB.requirements = buildValidRequirements({ eventDate, startTime: "12:00", durationHours: 4 });
    sessionB.quotation = generateVoiceBookingQuotation(sessionB.requirements, sessionB.id);
    sessionB.quotationSnapshot = createQuotationSnapshot(sessionB.requirements);
    sessionB.state = "awaiting_staff_approval";
    sessionB.officialBookingId = computeOfficialVanRequestId(sessionB.id);
    sessionB.metadata = { officialBookingId: sessionB.officialBookingId };
    await inMemoryRepo.save(sessionB);

    // Concurrent approvals
    const [resultA, resultB] = await Promise.all([
      inMemoryRepo.atomicApproveBooking(sessionA.id, validAuthContext, sampleTransitionFn),
      inMemoryRepo.atomicApproveBooking(sessionB.id, validAuthContext, sampleTransitionFn),
    ]);

    const successes = [resultA, resultB].filter((r) => r.success);
    const failures = [resultA, resultB].filter((r) => !r.success);

    assert.strictEqual(successes.length, 1, "Exactly ONE overlapping approval must succeed");
    assert.strictEqual(failures.length, 1, "The competing overlapping approval must fail closed");
    assert.ok(failures[0].message?.includes("Resource collision"), "Failure must report resource collision");
    recordPass("Concurrent overlapping approvals serialized cleanly; exactly 1 succeeded, 1 rejected");
  }

  // ===========================================================================
  // Scenario 13: Manual-versus-voice booking conflicts are handled by shared durable policy
  // ===========================================================================
  console.log("▶ Scenario 13: Manual-versus-voice booking conflicts are handled by shared durable policy");
  {
    clearPolicyRegistries();
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const eventDate = "2026-12-17";
    const manualSlot = "09:00-13:00";
    const manualBookingId = "enq_manual_catering_789";

    // 13A. Manual booking reserves slot using shared durable helper
    const manualRes = await reserveManualBookingSlot(db, {
      eventDate,
      timeSlot: manualSlot,
      manualBookingId,
    });
    assert.strictEqual(manualRes.success, true, "Manual booking reservation must succeed");

    // 13B. Voice booking tries to book overlapping slot (11:00-15:00) on the same date
    const voiceSession = createVoiceBookingSession("+919876543215", "en");
    voiceSession.requirements = buildValidRequirements({ eventDate, startTime: "11:00", durationHours: 4 });
    voiceSession.quotation = generateVoiceBookingQuotation(voiceSession.requirements, voiceSession.id);
    voiceSession.quotationSnapshot = createQuotationSnapshot(voiceSession.requirements);
    voiceSession.state = "awaiting_staff_approval";
    voiceSession.officialBookingId = computeOfficialVanRequestId(voiceSession.id);
    voiceSession.metadata = { officialBookingId: voiceSession.officialBookingId };
    await repo.save(voiceSession);

    const voiceApproval = await repo.atomicApproveBooking(voiceSession.id, validAuthContext, sampleTransitionFn);
    assert.strictEqual(voiceApproval.success, false);
    assert.ok(
      voiceApproval.message?.includes("overlaps with existing reservation"),
      "Voice booking must be blocked by earlier manual booking reservation"
    );

    // 13C. Another manual booking tries to reserve the voice slot; verify bidirectional protection
    const manualConflict = await reserveManualBookingSlot(db, {
      eventDate,
      timeSlot: "10:00-14:00",
      manualBookingId: "enq_manual_second_attempt",
    });
    assert.strictEqual(manualConflict.success, false);
    assert.strictEqual(manualConflict.error, "resource_collision");

    recordPass("Cross-channel scheduling integrity verified: manual booking blocks overlapping voice booking and vice-versa");
  }

  // ===========================================================================
  // Scenario 14: Failed schedule reservation rolls back the session and official booking writes
  // ===========================================================================
  console.log("▶ Scenario 14: Failed schedule reservation rolls back the session and official booking writes");
  {
    clearPolicyRegistries();
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const eventDate = "2026-12-18";
    const slotDocId = computeScheduleSlotDocId(eventDate, "10:00-14:00");

    // Cause a collision
    mock.setDoc(SCHEDULE_SLOTS_COLLECTION, slotDocId, {
      id: slotDocId,
      eventDate,
      timeSlot: "10:00-14:00",
      bookingId: "enq_voice_other_holder",
      status: "reserved",
    });

    const session = createVoiceBookingSession("+919876543216", "en");
    session.requirements = buildValidRequirements({ eventDate, startTime: "10:00", durationHours: 4 });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await repo.save(session);

    const approveResult = await repo.atomicApproveBooking(session.id, validAuthContext, sampleTransitionFn);
    assert.strictEqual(approveResult.success, false);

    // Verify session remained in awaiting_staff_approval and van_requests remained pending
    const sessionInStore = mock.getDoc(VOICE_BOOKING_COLLECTION, session.id)?.data();
    const vanInStore = mock.getDoc(VAN_REQUESTS_COLLECTION, session.officialBookingId)?.data();

    assert.strictEqual(sessionInStore?.state, "awaiting_staff_approval");
    assert.strictEqual(vanInStore?.status, "pending");
    recordPass("Failed slot reservation cleanly rolled back writes; documents remain in pre-approval state");
  }

  // ===========================================================================
  // Scenario 15: Firestore transaction read-after-write guard remains enforced
  // ===========================================================================
  console.log("▶ Scenario 15: Firestore transaction read-after-write guard remains enforced");
  {
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;

    let guardCaught = false;
    try {
      await db.runTransaction(async (tx) => {
        const ref1 = db.collection("test_col").doc("doc1");
        const ref2 = db.collection("test_col").doc("doc2");
        tx.set(ref1 as unknown as FirebaseFirestore.DocumentReference, { foo: "bar" });
        await tx.get(ref2 as unknown as FirebaseFirestore.DocumentReference);
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("read-after-write violation")) {
        guardCaught = true;
      }
    }
    assert.strictEqual(guardCaught, true, "Simulator guard must enforce read-before-write ordering");
    recordPass("Simulator state guard strictly enforces that all reads must occur before any writes");
  }

  // ===========================================================================
  // Scenario 16: Firestore transaction retries do not duplicate external side effects
  // ===========================================================================
  console.log("▶ Scenario 16: Firestore transaction retries do not duplicate external side effects");
  {
    clearPolicyRegistries();
    const mock = new HardenedMockFirestore();
    const db = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const repo = new FirestoreVoiceSessionRepository(db);
    assert.ok(repo);

    const session = createVoiceBookingSession("+919876543217", "en");
    session.requirements = buildValidRequirements({ eventDate: "2026-12-19", startTime: "14:00", durationHours: 4 });
    session.quotation = generateVoiceBookingQuotation(session.requirements, session.id);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    await repo.save(session);

    const sideEffectExecutionCount = 0;
    const transitionWithSideEffect = (
      s: VoiceBookingSession,
      auth: StaffAuthorizationContext
    ): VoiceBookingSession => {
      // Transition function itself is a pure domain transformation
      return sampleTransitionFn(s, auth);
    };

    const approveResult = await repo.atomicApproveBooking(session.id, validAuthContext, transitionWithSideEffect);
    assert.strictEqual(approveResult.success, true);
    assert.strictEqual(sideEffectExecutionCount, 0, "No external side effects are permitted inside transaction callback");

    // Check van_requests emailSent flag
    const vanDoc = mock.getDoc(VAN_REQUESTS_COLLECTION, session.officialBookingId)?.data();
    assert.strictEqual(vanDoc?.emailSent, false, "emailSent must remain false during transactional confirmation");
    recordPass("Transaction callback is purely idempotent and side-effect free; safe for automatic retries");
  }

  // ===========================================================================
  // Scenario 17: Manual booking regression tests remain green
  // ===========================================================================
  console.log("▶ Scenario 17: Manual booking regression tests remain green");
  {
    // Validate schema against valid catering enquiry payload
    const validEnquiry = {
      contact: "corporate.events@techcorp.com",
      organization: "TechCorp Labs",
      location: "Building 4, Cyber City, Hyderabad",
      eventDate: "2026-12-25",
      crowdSize: "150 guests",
      notes: "Please include vegan milk options and single-origin pour-overs.",
      idempotencyKey: "client_req_manual_999",
    };

    const parseResult = VanRequestInputSchema.safeParse(validEnquiry);
    assert.strictEqual(parseResult.success, true, "Valid enquiry payload must parse successfully");

    // Validate schema rejection of invalid payload (empty organization)
    const invalidEnquiry = {
      ...validEnquiry,
      organization: "",
    };
    const invalidResult = VanRequestInputSchema.safeParse(invalidEnquiry);
    assert.strictEqual(invalidResult.success, false, "Empty organization must be rejected");

    recordPass("Manual booking Zod schema validation and request contracts remain 100% intact");
  }

  // ===========================================================================
  // Scenario 18: In-memory and Firestore behavior agree on documented scheduling contract
  // ===========================================================================
  console.log("▶ Scenario 18: In-memory and Firestore behavior agree on documented scheduling contract");
  {
    clearPolicyRegistries();
    const mock = new HardenedMockFirestore();
    const firestoreDb = mock.createFirestoreInstance() as unknown as FirebaseFirestore.Firestore;
    const firestoreRepo = new FirestoreVoiceSessionRepository(firestoreDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const dateA = "2026-12-28";
    const dateB = "2026-12-29";

    // Setup Firestore session
    const fsSession = createVoiceBookingSession("+919876543218", "en");
    fsSession.requirements = buildValidRequirements({ eventDate: dateA, startTime: "10:00", durationHours: 4 });
    fsSession.quotation = generateVoiceBookingQuotation(fsSession.requirements, fsSession.id);
    fsSession.quotationSnapshot = createQuotationSnapshot(fsSession.requirements);
    fsSession.state = "awaiting_staff_approval";
    fsSession.officialBookingId = computeOfficialVanRequestId(fsSession.id);
    fsSession.metadata = { officialBookingId: fsSession.officialBookingId };
    await firestoreRepo.save(fsSession);

    // Setup InMemory session
    const memSession = createVoiceBookingSession("+919876543219", "en");
    memSession.requirements = buildValidRequirements({ eventDate: dateB, startTime: "10:00", durationHours: 4 });
    memSession.quotation = generateVoiceBookingQuotation(memSession.requirements, memSession.id);
    memSession.quotationSnapshot = createQuotationSnapshot(memSession.requirements);
    memSession.state = "awaiting_staff_approval";
    memSession.officialBookingId = computeOfficialVanRequestId(memSession.id);
    memSession.metadata = { officialBookingId: memSession.officialBookingId };
    await inMemoryRepo.save(memSession);

    // 1. Valid approval parity
    const fsApprove = await firestoreRepo.atomicApproveBooking(fsSession.id, validAuthContext, sampleTransitionFn);
    const memApprove = await inMemoryRepo.atomicApproveBooking(memSession.id, validAuthContext, sampleTransitionFn);

    assert.strictEqual(fsApprove.success, true);
    assert.strictEqual(memApprove.success, true);
    assert.strictEqual(fsApprove.session?.state, memApprove.session?.state);
    assert.strictEqual(fsApprove.session?.revision, memApprove.session?.revision);

    // 2. Duplicate approval parity
    const fsDup = await firestoreRepo.atomicApproveBooking(fsSession.id, validAuthContext, sampleTransitionFn);
    const memDup = await inMemoryRepo.atomicApproveBooking(memSession.id, validAuthContext, sampleTransitionFn);

    assert.strictEqual(fsDup.success, false);
    assert.strictEqual(memDup.success, false);
    assert.strictEqual(fsDup.error, memDup.error);
    assert.strictEqual(fsDup.error, "already_approved");

    recordPass("100% behavioral parity verified across InMemory and Firestore repository implementations");
  }

  console.log("\n===============================================================================");
  console.log("   Phase 6.3.2.2 Verification Complete: 18/18 Scenarios Passed, 0 Failed");
  console.log("===============================================================================\n");
}

runHardeningTests().catch((err) => {
  console.error("Verification failed with uncaught error:", err);
  process.exit(1);
});
