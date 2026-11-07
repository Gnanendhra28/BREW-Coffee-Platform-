#!/usr/bin/env tsx
/**
 * BREW Coffee Platform — Phase 6.3.1.2 Verification Test Suite
 * Validates Firestore Optimistic Concurrency & Deterministic Lookup Hardening:
 * 1. Monotonic revision counter (revision >= 1) and CAS semantics on session updates.
 * 2. Stale revision detection throwing OptimisticConcurrencyConflictError.
 * 3. Terminal state protection throwing TerminalSessionImmutableError.
 * 4. Concurrent conversation turn simulation and race-free state transitions.
 * 5. Prevention of delayed conversation turn overwrite after staff approval.
 * 6. Transparent legacy document migration (Revision 1 baseline & backfill).
 * 7. Firestore-side deterministic phone lookup ordering (createdAt DESC) and ID tie-breaker.
 * 8. Active vs terminal session phone lookup distinction.
 * 9. InMemory and Firestore repository contract parity.
 */

import assert from "assert";
import { Firestore } from "firebase-admin/firestore";
import {
  FirestoreVoiceSessionRepository,
  VOICE_BOOKING_COLLECTION,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import {
  createVoiceBookingSession,
  processConversationTurn,
  approveBookingByStaff,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  createQuotationSnapshot,
  generateVoiceBookingQuotation,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  BookingRequirements,
  OptimisticConcurrencyConflictError,
  StaffAuthorizationContext,
  TerminalSessionImmutableError,
  TERMINAL_VOICE_STATES,
  VoiceBookingState,
} from "../src/lib/voiceBooking/types";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";

// Ensure testing HMAC secret is defined
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-32-chars-long!";

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.1.2: Concurrency & Lookup Hardening Verification");
console.log("===============================================================================\n");

const baseRequirements: BookingRequirements = {
  guestCount: 60,
  eventDate: "2026-11-25",
  startTime: "11:00",
  durationHours: 3,
  venueAddress: "Jubilee Hills Checkpost, Hyderabad",
  eventType: "corporate",
  beveragePreferences: ["Cappuccino", "Flat White"],
  selectedTier: "STANDARD",
  handoffRequested: false,
  customerConfirmed: true,
  confidenceScore: 0.95,
  missingFields: [],
  unresolvedQuestions: [],
};

const validAuthContext: StaffAuthorizationContext = {
  staffIdentity: "barista_op_99",
  staffRole: "barista",
  staffApprovalId: "appr_test_concurrency_99",
};

/**
 * High-fidelity in-memory Cloud Firestore Mock for test isolation.
 */
class MockFirestoreStore {
  public docs: Map<string, { data: Record<string, unknown>; version: number }> = new Map();
  public transactionAttempts = 0;

  getDoc(id: string) {
    const entry = this.docs.get(id);
    if (!entry) return null;
    return {
      exists: true,
      data: () => JSON.parse(JSON.stringify(entry.data)),
      version: entry.version,
    };
  }

  setDoc(id: string, data: Record<string, unknown>) {
    const existing = this.docs.get(id);
    const version = (existing?.version || 0) + 1;
    this.docs.set(id, {
      data: JSON.parse(JSON.stringify(data)),
      version,
    });
  }
}

function createMockFirestore(store: MockFirestoreStore): Firestore {
  const executeQuery = (
    filterField?: string,
    filterOp?: string,
    filterVal?: unknown,
    sortField?: string,
    sortDir?: "asc" | "desc",
    limitN?: number
  ) => {
    let matching: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    for (const [id, entry] of store.docs.entries()) {
      if (filterField && filterOp === "==") {
        if (entry.data[filterField] !== filterVal) continue;
      }
      matching.push({ id, data: () => JSON.parse(JSON.stringify(entry.data)) });
    }

    if (sortField) {
      matching.sort((a, b) => {
        const valA = a.data()[sortField];
        const valB = b.data()[sortField];
        let cmp = 0;
        if (typeof valA === "string" && typeof valB === "string") {
          cmp = valA.localeCompare(valB);
        } else if (typeof valA === "number" && typeof valB === "number") {
          cmp = valA - valB;
        }
        if (sortDir === "desc") cmp = -cmp;
        if (cmp !== 0) return cmp;
        return b.id.localeCompare(a.id);
      });
    }

    if (limitN !== undefined && limitN > 0) {
      matching = matching.slice(0, limitN);
    }

    return {
      empty: matching.length === 0,
      docs: matching,
    };
  };

  const createQueryBuilder = (filterField?: string, filterOp?: string, filterVal?: unknown) => ({
    orderBy: (sortField: string, sortDir: "asc" | "desc" = "asc") => ({
      limit: (n: number) => ({
        get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir, n),
      }),
      get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir),
    }),
    limit: (n: number) => ({
      get: async () => executeQuery(filterField, filterOp, filterVal, undefined, undefined, n),
    }),
    get: async () => executeQuery(filterField, filterOp, filterVal),
  });

  const collectionRef = {
    doc: (id: string) => {
      const trimmedId = id.trim();
      return {
        id: trimmedId,
        get: async () => {
          const doc = store.getDoc(trimmedId);
          if (!doc) {
            return { exists: false, data: () => undefined, id: trimmedId };
          }
          return { exists: true, data: doc.data, id: trimmedId };
        },
        set: async (data: Record<string, unknown>) => {
          store.setDoc(trimmedId, data);
        },
      };
    },
    where: (field: string, op: string, value: unknown) => createQueryBuilder(field, op, value),
    orderBy: (field: string, dir: "asc" | "desc" = "asc") => createQueryBuilder().orderBy(field, dir),
  };

  const mockDb = {
    collection: (name: string) => {
      const allowed = new Set([VOICE_BOOKING_COLLECTION, "van_requests", "schedule_slots"]);
      if (!allowed.has(name)) {
        throw new Error(`Unexpected collection in mock: ${name}`);
      }
      return collectionRef;
    },
    runTransaction: async <T>(
      updateFunction: (transaction: {
        get: (ref: { id: string }) => Promise<{ exists: boolean; data: () => unknown; id: string }>;
        set: (ref: { id: string }, data: Record<string, unknown>) => void;
      }) => Promise<T>
    ): Promise<T> => {
      const maxRetries = 5;
      let attempt = 0;

      while (attempt < maxRetries) {
        attempt++;
        store.transactionAttempts++;
        const stagedWrites = new Map<string, Record<string, unknown>>();
        const readVersions = new Map<string, number>();

        const tx = {
          get: async (ref: { id: string }) => {
            const doc = store.getDoc(ref.id);
            if (!doc) {
              readVersions.set(ref.id, 0);
              return { exists: false, data: () => undefined, id: ref.id };
            }
            readVersions.set(ref.id, doc.version);
            return { exists: true, data: doc.data, id: ref.id };
          },
          set: (ref: { id: string }, data: Record<string, unknown>) => {
            stagedWrites.set(ref.id, JSON.parse(JSON.stringify(data)));
          },
        };

        try {
          const result = await updateFunction(tx);

          let conflict = false;
          for (const [id, versionAtRead] of readVersions.entries()) {
            const current = store.getDoc(id);
            const currentVersion = current ? current.version : 0;
            if (currentVersion !== versionAtRead) {
              conflict = true;
              break;
            }
          }

          if (conflict) {
            continue;
          }

          for (const [id, data] of stagedWrites.entries()) {
            store.setDoc(id, data);
          }

          return result;
        } catch (err) {
          throw err;
        }
      }

      throw new Error("Transaction contention: maximum retries exceeded.");
    },
  };

  return mockDb as unknown as Firestore;
}

async function runTests() {
  let passed = 0;

  // ---------------------------------------------------------------------------
  // Scenario 1: Initial revision assignment on creation and persistence
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 1: Initial revision assignment on creation and persistence");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    const session = createVoiceBookingSession("+919876543210", "en");

    assert.strictEqual(session.revision, 1, "Session must be initialized with revision 1");

    await repo.save(session);

    const stored = await repo.getById(session.id);
    assert(stored, "Stored session must exist");
    assert.strictEqual(stored.revision, 1, "Persisted brand-new session must have revision 1");

    passed++;
    console.log("  ✔ Initial session creation assigns revision 1 and persists cleanly.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: Monotonic revision increment on successive saves
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 2: Monotonic revision increment on successive saves");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    const session = createVoiceBookingSession("+919876543210", "en");
    await repo.save(session); // revision 1

    // First update: assert expectedRevision 1 -> commits revision 2
    session.requirements.guestCount = 50;
    session.updatedAt = new Date().toISOString();
    await repo.save(session, 1);

    const check1 = await repo.getById(session.id);
    assert.strictEqual(check1?.revision, 2, "First update must increment revision to 2");
    assert.strictEqual(session.revision, 2, "Caller session object revision must be updated to 2");

    // Second update: assert expectedRevision 2 -> commits revision 3
    session.requirements.durationHours = 4;
    session.updatedAt = new Date().toISOString();
    await repo.save(session, 2);

    const check2 = await repo.getById(session.id);
    assert.strictEqual(check2?.revision, 3, "Second update must increment revision to 3");
    assert.strictEqual(session.revision, 3, "Caller session object revision must be updated to 3");

    passed++;
    console.log("  ✔ Successive updates monotonically increment revision (1 -> 2 -> 3).\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 3: Stale revision rejection / CAS conflict
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 3: Stale revision rejection / CAS conflict");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    const session = createVoiceBookingSession("+919876543210", "en");
    await repo.save(session); // stored revision 1

    // Another caller updates to revision 2
    const current = await repo.getById(session.id);
    assert(current);
    current.requirements.guestCount = 80;
    await repo.save(current, 1); // stored is now revision 2

    // Original caller attempts to save using stale revision 1
    let conflictCaught = false;
    try {
      await repo.save(session, 1);
    } catch (err: unknown) {
      if (err instanceof OptimisticConcurrencyConflictError) {
        conflictCaught = true;
        assert(err.message.includes("expected revision 1, but stored revision is 2"));
      }
    }

    assert(conflictCaught, "Must reject write with OptimisticConcurrencyConflictError on stale expectedRevision");

    // Confirm stored document was NOT overwritten
    const stored = await repo.getById(session.id);
    assert.strictEqual(stored?.revision, 2);
    assert.strictEqual(stored?.requirements.guestCount, 80);

    passed++;
    console.log("  ✔ Stale revision CAS rejection fails closed and preserves stored state.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 4: Concurrent conversation turn simulation
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 4: Concurrent conversation turn simulation");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    const initialSession = createVoiceBookingSession("+919876543210", "en");
    await repo.save(initialSession); // revision 1

    // Read session for Turn 1
    const turn1Session = await repo.getById(initialSession.id);
    assert(turn1Session);

    // Read session for Turn 2 concurrently (both read revision 1)
    const turn2Session = await repo.getById(initialSession.id);
    assert(turn2Session);

    // Turn 1 executes and commits -> revision becomes 2
    const turn1Result = await processConversationTurn(
      turn1Session,
      "50 guests in Jubilee Hills on November 25",
      { sessionRepository: repo }
    );
    assert.strictEqual(turn1Result.session.revision, 2);

    // Turn 2 executes late and attempts to commit using stale initial revision 1
    let turn2Conflict = false;
    try {
      await processConversationTurn(
        turn2Session, // carries stale revision 1
        "Make that 75 guests",
        { sessionRepository: repo }
      );
    } catch (err: unknown) {
      if (err instanceof OptimisticConcurrencyConflictError) {
        turn2Conflict = true;
      }
    }

    assert(turn2Conflict, "Concurrent Turn 2 must be rejected with OptimisticConcurrencyConflictError");

    // Verify Turn 1 changes were preserved
    const latest = await repo.getById(initialSession.id);
    assert.strictEqual(latest?.revision, 2);
    assert.strictEqual(latest?.requirements.guestCount, 50);

    passed++;
    console.log("  ✔ Concurrent conversation turn correctly rejected when reading stale revision.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 5: Stale conversation turn overwrite prevention after approval
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 5: Stale turn overwrite prevention after approval");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    // Prepare a session in awaiting_staff_approval with valid quotation & snapshot
    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    session.state = "awaiting_staff_approval";
    await repo.save(session); // stored revision 1

    // Worker A reads session in awaiting_staff_approval (revision 1)
    const workerASession = await repo.getById(session.id);
    assert(workerASession);

    // In parallel, staff approves the booking via atomicApproveBooking
    const approved = await approveBookingByStaff(session.id, validAuthContext, repo);
    assert.strictEqual(approved.state, "booking_confirmed");
    assert.strictEqual(approved.revision, 2, "Approval must increment revision to 2");

    // Worker A now attempts to save a conversation turn on its stale read
    let workerARejected = false;
    try {
      workerASession.requirements.guestCount = 100; // Attempting to tamper with approved booking
      await repo.save(workerASession, 1);
    } catch (err: unknown) {
      if (
        err instanceof OptimisticConcurrencyConflictError ||
        err instanceof TerminalSessionImmutableError
      ) {
        workerARejected = true;
      }
    }

    assert(workerARejected, "Delayed save after staff approval must be strictly rejected");

    // Confirm approved booking was NOT altered
    const finalStored = await repo.getById(session.id);
    assert.strictEqual(finalStored?.state, "booking_confirmed");
    assert.strictEqual(finalStored?.revision, 2);
    assert.strictEqual(finalStored?.requirements.guestCount, 60); // Retains original 60 guests
    assert.strictEqual(finalStored?.staffApprovalAudit?.staffIdentity, "barista_op_99");

    passed++;
    console.log("  ✔ Stale conversation turn cannot overwrite an approved booking.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 6: Protected terminal states immutability
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 6: Protected terminal states immutability");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    for (const terminalState of TERMINAL_VOICE_STATES) {
      const session = createVoiceBookingSession("+919876543210", "en");
      session.state = terminalState as VoiceBookingState;
      if (terminalState === "booking_confirmed") {
        session.staffApprovalAudit = {
          staffIdentity: "admin_1",
          staffRole: "admin",
          staffApprovalId: "appr_term_1",
          approvedAt: new Date().toISOString(),
          sessionId: session.id,
        };
      }
      // Seed terminal session into store
      store.setDoc(session.id, JSON.parse(JSON.stringify(session)));

      // Attempt ordinary save to modify or reopen
      const toUpdate = await repo.getById(session.id);
      assert(toUpdate);
      toUpdate.state = "collecting_requirements";

      let rejected = false;
      try {
        await repo.save(toUpdate, 1);
      } catch (err: unknown) {
        if (err instanceof TerminalSessionImmutableError) {
          rejected = true;
          assert(err.message.includes("Terminal sessions are immutable"));
        }
      }

      assert(
        rejected,
        `Updating session in terminal state '${terminalState}' must throw TerminalSessionImmutableError`
      );
    }

    passed++;
    console.log("  ✔ All 5 terminal states (booking_confirmed, customer_declined, human_handoff, cancelled, failed) are immutable.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 7: Safe legacy migration policy (Revision 1 baseline & backfill)
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 7: Safe legacy migration policy (Revision 1 baseline & backfill)");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    // Seed a legacy document created before Phase 6.3.1.2 without 'revision'
    const legacySession = createVoiceBookingSession("+919876543210", "en");
    const legacyRaw = JSON.parse(JSON.stringify(legacySession));
    delete legacyRaw.revision; // Deliberately omit revision
    store.setDoc(legacySession.id, legacyRaw);

    // Read back: deserializer must default missing revision to 1
    const readLegacy = await repo.getById(legacySession.id);
    assert(readLegacy, "Legacy session must be retrieved");
    assert.strictEqual(readLegacy.revision, 1, "Deserialization must baseline missing revision to 1");

    // Update with expectedRevision: 1 -> must succeed and backfill to revision 2
    readLegacy.requirements.guestCount = 45;
    await repo.save(readLegacy, 1);

    const migrated = await repo.getById(legacySession.id);
    assert.strictEqual(migrated?.revision, 2, "First save on legacy session must backfill revision to 2");

    // Attempting update on legacy document with wrong expectedRevision must fail closed
    const legacy2 = createVoiceBookingSession("+919876543210", "en");
    const legacyRaw2 = JSON.parse(JSON.stringify(legacy2));
    delete legacyRaw2.revision;
    store.setDoc(legacy2.id, legacyRaw2);

    let failedWrongRevision = false;
    try {
      await repo.save(legacy2, 99); // asserting 99 when stored is treated as 1
    } catch (err: unknown) {
      if (err instanceof OptimisticConcurrencyConflictError) {
        failedWrongRevision = true;
      }
    }
    assert(failedWrongRevision, "Must fail closed if caller asserts wrong revision on legacy doc");

    passed++;
    console.log("  ✔ Safe legacy migration baselines unversioned docs to revision 1 and cleanly backfills to 2.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 8: Deterministic phone lookup ordering with createdAt DESC & ID tie-breaker
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 8: Deterministic phone lookup ordering with createdAt DESC & ID tie-breaker");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));
    const testPhone = "+919999900001";

    // Create 3 sessions with distinct timestamps
    const s1 = createVoiceBookingSession(testPhone, "en");
    s1.id = "session_time_1";
    s1.createdAt = "2026-11-20T10:00:00.000Z";
    await repo.save(s1);

    const s2 = createVoiceBookingSession(testPhone, "en");
    s2.id = "session_time_2";
    s2.createdAt = "2026-11-20T12:00:00.000Z"; // Newer
    await repo.save(s2);

    const s3 = createVoiceBookingSession(testPhone, "en");
    s3.id = "session_time_3";
    s3.createdAt = "2026-11-20T11:00:00.000Z";
    await repo.save(s3);

    const latest = await repo.getByPhoneNumber(testPhone);
    assert.strictEqual(latest?.id, "session_time_2", "Must return session with latest createdAt (12:00:00)");

    // Test identical timestamp deterministic tie-breaker (ID descending)
    const tiePhone = "+919999900002";
    const sameTime = "2026-11-21T15:00:00.000Z";

    const sA = createVoiceBookingSession(tiePhone, "en");
    sA.id = "session_aaa";
    sA.createdAt = sameTime;
    await repo.save(sA);

    const sZ = createVoiceBookingSession(tiePhone, "en");
    sZ.id = "session_zzz";
    sZ.createdAt = sameTime;
    await repo.save(sZ);

    const tieResult = await repo.getByPhoneNumber(tiePhone);
    assert.strictEqual(
      tieResult?.id,
      "session_zzz",
      "Identical createdAt must deterministically tie-break on ID descending ('session_zzz')"
    );

    passed++;
    console.log("  ✔ Phone lookup deterministically orders by createdAt DESC with doc ID descending tie-breaker.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 9: Active vs terminal phone lookup distinction
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 9: Active vs terminal phone lookup distinction");
  {
    const store = new MockFirestoreStore();
    const repo = new FirestoreVoiceSessionRepository(createMockFirestore(store));
    const testPhone = "+919999900003";

    // Older active session
    const sActiveOlder = createVoiceBookingSession(testPhone, "en");
    sActiveOlder.id = "s_active_1";
    sActiveOlder.state = "collecting_requirements";
    sActiveOlder.createdAt = "2026-11-22T08:00:00.000Z";
    await repo.save(sActiveOlder);

    // Middle active session (latest active)
    const sActiveLatest = createVoiceBookingSession(testPhone, "en");
    sActiveLatest.id = "s_active_2";
    sActiveLatest.state = "details_collected";
    sActiveLatest.createdAt = "2026-11-22T10:00:00.000Z";
    await repo.save(sActiveLatest);

    // Newest session is terminal (customer cancelled)
    const sTerminalNewest = createVoiceBookingSession(testPhone, "en");
    sTerminalNewest.id = "s_terminal_3";
    sTerminalNewest.state = "cancelled";
    sTerminalNewest.createdAt = "2026-11-22T12:00:00.000Z";
    await repo.save(sTerminalNewest);

    // Default lookup (activeOnly omitted/false) returns the overall newest (terminal)
    const defaultLookup = await repo.getByPhoneNumber(testPhone);
    assert.strictEqual(defaultLookup?.id, "s_terminal_3", "Default lookup returns newest regardless of state");

    // Active-only lookup skips terminal sessions and finds the latest active session
    const activeLookup = await repo.getByPhoneNumber(testPhone, { activeOnly: true });
    assert.strictEqual(
      activeLookup?.id,
      "s_active_2",
      "Active-only lookup must return the latest non-terminal session ('s_active_2')"
    );

    // If only terminal sessions exist, activeOnly returns null
    const allTerminalPhone = "+919999900004";
    const termOnly = createVoiceBookingSession(allTerminalPhone, "en");
    termOnly.state = "human_handoff";
    await repo.save(termOnly);

    const noneActive = await repo.getByPhoneNumber(allTerminalPhone, { activeOnly: true });
    assert.strictEqual(noneActive, null, "Active-only lookup on all-terminal history must return null");

    passed++;
    console.log("  ✔ Active vs terminal phone lookup cleanly filters terminal sessions when activeOnly is requested.\n");
  }

  // ---------------------------------------------------------------------------
  // Scenario 10: InMemory vs Firestore repository contract parity
  // ---------------------------------------------------------------------------
  console.log("▶ Scenario 10: InMemory vs Firestore repository contract parity");
  {
    const inMemoryRepo = new InMemoryVoiceSessionRepository();
    const store = new MockFirestoreStore();
    const firestoreRepo = new FirestoreVoiceSessionRepository(createMockFirestore(store));

    const repos = [
      { name: "InMemoryVoiceSessionRepository", repo: inMemoryRepo },
      { name: "FirestoreVoiceSessionRepository", repo: firestoreRepo },
    ];

    for (const { name, repo } of repos) {
      // 1. Initial revision = 1
      const s = createVoiceBookingSession("+919876543299", "en");
      await repo.save(s);
      const read1 = await repo.getById(s.id);
      assert.strictEqual(read1?.revision, 1, `[${name}] Initial revision must be 1`);

      // 2. Monotonic increment on update (1 -> 2)
      read1.requirements.guestCount = 99;
      await repo.save(read1, 1);
      const read2 = await repo.getById(s.id);
      assert.strictEqual(read2?.revision, 2, `[${name}] Incremented revision must be 2`);

      // 3. Stale revision conflict rejection
      let conflict = false;
      try {
        await repo.save(read1, 1); // stale revision 1
      } catch (err: unknown) {
        if (err instanceof OptimisticConcurrencyConflictError) {
          conflict = true;
        }
      }
      assert(conflict, `[${name}] Must throw OptimisticConcurrencyConflictError on stale expectedRevision`);

      // 4. Terminal state immutability
      read2.state = "booking_confirmed";
      read2.staffApprovalAudit = {
        staffIdentity: "op",
        staffRole: "barista",
        staffApprovalId: "a1",
        approvedAt: new Date().toISOString(),
        sessionId: s.id,
      };
      // For inMemory, transition via atomicApproveBooking or direct store
      // Let's test terminal state protection when stored document is terminal
      if (name === "InMemoryVoiceSessionRepository") {
        (repo as InMemoryVoiceSessionRepository)["sessions"].set(s.id, JSON.parse(JSON.stringify(read2)));
      } else {
        store.setDoc(s.id, JSON.parse(JSON.stringify(read2)));
      }

      let termRejected = false;
      try {
        read2.requirements.guestCount = 1000;
        await repo.save(read2, 2);
      } catch (err: unknown) {
        if (err instanceof TerminalSessionImmutableError) {
          termRejected = true;
        }
      }
      assert(termRejected, `[${name}] Must throw TerminalSessionImmutableError when modifying terminal session`);

      // 5. Phone lookup activeOnly filter
      const phone = `+91987650000${name.length}`;
      const active1 = createVoiceBookingSession(phone, "en");
      active1.createdAt = "2026-11-20T10:00:00.000Z";
      await repo.save(active1);

      const term1 = createVoiceBookingSession(phone, "en");
      term1.createdAt = "2026-11-20T12:00:00.000Z";
      term1.state = "cancelled";
      if (name === "InMemoryVoiceSessionRepository") {
        (repo as InMemoryVoiceSessionRepository)["sessions"].set(term1.id, JSON.parse(JSON.stringify(term1)));
      } else {
        store.setDoc(term1.id, JSON.parse(JSON.stringify(term1)));
      }

      const activeFound = await repo.getByPhoneNumber(phone, { activeOnly: true });
      assert.strictEqual(activeFound?.id, active1.id, `[${name}] activeOnly must find active session`);
    }

    passed++;
    console.log("  ✔ Complete contract parity verified between InMemory and Firestore repositories.\n");
  }

  console.log("===============================================================================");
  console.log(`🎉 ALL ${passed}/10 PHASE 6.3.1.2 HARDENING SCENARIOS PASSED WITH ZERO FAILURES!`);
  console.log("===============================================================================\n");
}

runTests().catch((err) => {
  console.error("✖ Phase 6.3.1.2 verification failed with error:", err);
  process.exit(1);
});
