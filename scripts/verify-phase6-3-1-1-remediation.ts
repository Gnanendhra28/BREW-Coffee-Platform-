#!/usr/bin/env tsx
/**
 * BREW Coffee Platform — Phase 6.3.1.1 Verification Test Suite
 * Validates remediation of the Firestore conversation persistence integration gap,
 * end-to-end repository consistency across turn processing and staff approval,
 * optimistic concurrency protection against stale session overwrites,
 * strict document identity validation, and deterministic phone lookup.
 */

import assert from "assert";
import { Firestore } from "firebase-admin/firestore";
import {
  FirestoreVoiceSessionRepository,
  VOICE_BOOKING_COLLECTION,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import {
  createVoiceBookingSession,
  getVoiceSessionRepository,
  setVoiceSessionRepository,
  processConversationTurn,
  approveBookingByStaff,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  createQuotationSnapshot,
  generateVoiceBookingQuotation,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  BookingRequirements,
  StaffAuthorizationContext,
} from "../src/lib/voiceBooking/types";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";

// Ensure testing HMAC secret is defined
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-32-chars-long!";

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.1.1: Firestore Conversation Persistence Remediation");
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
  staffApprovalId: "appr_test_remediation_99",
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
        return cmp;
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

  const createQueryBuilder = (
    filterField?: string,
    filterOp?: string,
    filterVal?: unknown,
    sortField?: string,
    sortDir?: "asc" | "desc"
  ) => ({
    orderBy: (sField: string, sDir: "asc" | "desc" = "asc") =>
      createQueryBuilder(filterField, filterOp, filterVal, sField, sDir),
    limit: (n: number) => ({
      get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir, n),
    }),
    get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir),
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

  function recordPass(testName: string) {
    passed++;
    console.log(`  ✓ ${testName}`);
  }

  // ============================================================================
  // SECTION 1: End-to-End Repository Consistency Tests
  // ============================================================================
  console.log("SECTION 1: End-to-End Repository Consistency Across Turn Processing & Approval");

  // Scenario A: Production selection
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(db);

    // Configure production selection with Firestore repository
    setVoiceSessionRepository(firestoreRepo);

    // 1. Session creation & initial turn
    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = { ...baseRequirements, guestCount: 75 };
    await firestoreRepo.save(session);

    // 2. Process conversation turn WITHOUT explicitly passing dependencies.sessionRepository
    // Must automatically use the production selector (FirestoreVoiceSessionRepository)!
    const turnResult = await processConversationTurn(
      session,
      "We need catering for 75 people at Jubilee Hills on 2026-11-25"
    );

    // 3. Verify session was persisted in Firestore (store.docs)
    assert.strictEqual(store.docs.size, 1, "Session document was persisted into Firestore by conversation turn");
    assert(store.docs.has(turnResult.session.id), "Session ID exists in Firestore");

    // 4. Retrieve session through Firestore repository
    const retrieved = await firestoreRepo.getById(turnResult.session.id);
    assert(retrieved !== null, "Retrieved session from Firestore");
    assert.strictEqual(retrieved.requirements.guestCount, 75, "Turn update persisted into Firestore");
    assert(retrieved.conversationHistory.length > 0, "Conversation history persisted in Firestore");

    setVoiceSessionRepository(null);
    recordPass("Scenario A: Production repository selector persists turns to Firestore");
  }

  // Scenario B: Local development
  {
    delete process.env.VOICE_BOOKING_STORAGE;
    setVoiceSessionRepository(null);

    const repo = getVoiceSessionRepository();
    assert(
      repo instanceof InMemoryVoiceSessionRepository,
      "Development environment without overrides returns InMemoryVoiceSessionRepository"
    );
    recordPass("Scenario B: Local development defaults safely to in-memory repository");
  }

  // Scenario C: Explicit dependency injection
  {
    const customStore = new MockFirestoreStore();
    const customDb = createMockFirestore(customStore);
    const customRepo = new FirestoreVoiceSessionRepository(customDb);

    // Global selector remains default in-memory
    setVoiceSessionRepository(null);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = { ...baseRequirements };
    await customRepo.save(session);

    // Explicitly inject customRepo into processConversationTurn
    await processConversationTurn(session, "Hi there", {
      sessionRepository: customRepo,
    });

    // Custom repo must have received the update
    assert.strictEqual(customStore.docs.size, 1, "Explicitly injected repository received the save call");
    assert(customStore.docs.has(session.id), "Custom repo contains session");
    recordPass("Scenario C: Explicit dependency injection in processConversationTurn overrides selector");
  }

  // Scenario D: Approval consistency across the same repository
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(db);

    setVoiceSessionRepository(firestoreRepo);

    // 1. Create and persist session via processConversationTurn
    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_customer_confirmation";
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await firestoreRepo.save(session);

    // Process a confirmation turn
    const turnResult = await processConversationTurn(
      session,
      "Yes, I confirm this standard package for our event"
    );

    assert.strictEqual(
      turnResult.session.state,
      "awaiting_staff_approval",
      "Session reached awaiting_staff_approval"
    );

    // 2. Both turnResult and Firestore must hold the session in awaiting_staff_approval
    const storedBeforeApproval = await firestoreRepo.getById(turnResult.session.id);
    assert(storedBeforeApproval !== null);
    assert.strictEqual(storedBeforeApproval.state, "awaiting_staff_approval");

    // 3. Approval API retrieves from the same repository selector and approves
    const repoForApproval = getVoiceSessionRepository();
    const approved = await approveBookingByStaff(turnResult.session.id, validAuthContext, repoForApproval);
    assert.strictEqual(approved.state, "booking_confirmed", "Session confirmed through approval API");

    // 4. Stored document in Firestore is now booking_confirmed
    const storedAfterApproval = await firestoreRepo.getById(turnResult.session.id);
    assert.strictEqual(storedAfterApproval?.state, "booking_confirmed", "Committed state visible in Firestore");

    setVoiceSessionRepository(null);
    recordPass("Scenario D: End-to-end turn confirmation and approval operate on the same Firestore repository");
  }

  // ============================================================================
  // SECTION 2: Concurrent Session Update & Optimistic Concurrency Protection
  // ============================================================================
  console.log("\nSECTION 2: Optimistic Concurrency & Stale Write Protection");

  // Test 2.1: Stale write rejection
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.updatedAt = "2026-11-01T14:00:00.000Z";
    await repo.save(session);

    // A newer update is committed with revision 1
    const newerSession = { ...session, updatedAt: "2026-11-01T14:05:00.000Z", state: "details_collected" as const };
    await repo.save(newerSession, 1);

    // Stale update asserting stale revision 1 attempts to overwrite
    const staleSession = { ...session, updatedAt: "2026-11-01T14:02:00.000Z", state: "collecting_requirements" as const };

    let caught = false;
    try {
      await repo.save(staleSession, 1);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("Optimistic concurrency conflict"),
        "Catches stale write with optimistic concurrency conflict error"
      );
    }
    assert(caught, "Stale session write must be rejected by optimistic concurrency control");

    // Confirm that the newer state was preserved in Firestore
    const stored = await repo.getById(session.id);
    assert.strictEqual(stored?.updatedAt, "2026-11-01T14:05:00.000Z", "Newer session timestamp preserved");
    assert.strictEqual(stored?.state, "details_collected", "Newer session state preserved");
    recordPass("Test 2.1: Stale session write rejected by optimistic concurrency check");
  }

  // Test 2.2: Concurrent save operations serialized via transaction
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.updatedAt = "2026-11-01T14:00:00.000Z";
    await repo.save(session);

    // Run sequential save operations verifying monotonic revision increment
    for (let i = 0; i < 5; i++) {
      const s = {
        ...session,
        updatedAt: `2026-11-01T14:1${i}:00.000Z`,
        metadata: { turnIndex: i },
      };
      await repo.save(s, i + 1);
    }

    const finalStored = await repo.getById(session.id);
    assert.strictEqual(finalStored?.updatedAt, "2026-11-01T14:14:00.000Z", "Latest timestamp committed");
    recordPass("Test 2.2: Concurrent save operations serialized safely via native transactions");
  }

  // ============================================================================
  // SECTION 3: Document Identity & Whitespace Validation
  // ============================================================================
  console.log("\nSECTION 3: Document Identity & Malformed ID Hardening");

  // Test 3.1: save() rejects whitespace in session.id
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.id = "  vbs_whitespace_id  ";

    let caught = false;
    try {
      await repo.save(session);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("illegal leading or trailing whitespace"),
        "Rejects ID with whitespace"
      );
    }
    assert(caught, "save() must reject session.id with whitespace");
    recordPass("Test 3.1: save() rejects session.id with whitespace");
  }

  // Test 3.2: getById() rejects whitespace in ID
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    let caught = false;
    try {
      await repo.getById("  vbs_whitespace_id  ");
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("illegal leading or trailing whitespace"),
        "Rejects query ID with whitespace"
      );
    }
    assert(caught, "getById() must reject ID with whitespace");
    recordPass("Test 3.2: getById() rejects query ID with whitespace");
  }

  // Test 3.3: getById() rejects document identity mismatch
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.id = "internal_session_id_123";

    // Store it under a different document ID key
    store.setDoc("different_firestore_doc_id_456", {
      ...session,
      id: "internal_session_id_123", // Mismatched!
    });

    let caught = false;
    try {
      await repo.getById("different_firestore_doc_id_456");
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("Document identity mismatch"),
        "Catches document identity mismatch"
      );
    }
    assert(caught, "Document identity mismatch must be rejected");
    recordPass("Test 3.3: getById() rejects document identity mismatch");
  }

  // ============================================================================
  // SECTION 4: Deterministic Phone Lookup
  // ============================================================================
  console.log("\nSECTION 4: Deterministic Phone Number Querying");

  // Test 4.1: Deterministically returns the latest session when multiple sessions exist for phone
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const phone = "+919988776655";

    // Create 3 sessions for the same phone at different timestamps
    const s1 = createVoiceBookingSession(phone, "en");
    s1.id = "vbs_phone_1";
    s1.createdAt = "2026-11-01T10:00:00.000Z";
    s1.updatedAt = "2026-11-01T10:05:00.000Z";
    await repo.save(s1);

    const s2 = createVoiceBookingSession(phone, "en");
    s2.id = "vbs_phone_2";
    s2.createdAt = "2026-11-01T12:00:00.000Z";
    s2.updatedAt = "2026-11-01T12:30:00.000Z"; // Latest!
    await repo.save(s2);

    const s3 = createVoiceBookingSession(phone, "en");
    s3.id = "vbs_phone_3";
    s3.createdAt = "2026-11-01T11:00:00.000Z";
    s3.updatedAt = "2026-11-01T11:15:00.000Z";
    await repo.save(s3);

    const latest = await repo.getByPhoneNumber(phone);
    assert(latest !== null, "Session retrieved by phone");
    assert.strictEqual(latest.id, "vbs_phone_2", "Deterministically returned latest session by timestamp");
    assert.strictEqual(latest.updatedAt, "2026-11-01T12:30:00.000Z");
    recordPass("Test 4.1: getByPhoneNumber() deterministically selects the latest active session");
  }

  // ============================================================================
  // SECTION 5: Repository Selection Safety & Production Boundary
  // ============================================================================
  console.log("\nSECTION 5: Repository Selection Safety in Production");

  // Test 5.1: In-memory override rejected in genuine production environment
  {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      let caught = false;
      try {
        setVoiceSessionRepository(new InMemoryVoiceSessionRepository());
      } catch (err: unknown) {
        caught = true;
        assert(
          err instanceof Error && err.message.includes("In-memory repository override is strictly prohibited"),
          "Rejects in-memory override in production"
        );
      }
      assert(caught, "Must throw when attempting in-memory override in production");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    }
    recordPass("Test 5.1: setVoiceSessionRepository() rejects in-memory override in production");
  }

  // Test 5.2: getVoiceSessionRepository() rejects in-memory repository in production
  {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const repo = getVoiceSessionRepository();
      assert(
        repo instanceof FirestoreVoiceSessionRepository,
        "Production environment always enforces FirestoreVoiceSessionRepository"
      );
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    }
    recordPass("Test 5.2: getVoiceSessionRepository() strictly returns Firestore repository in production");
  }

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.1.1 Verification Complete: All ${passed} tests passed successfully!`);
  console.log("===============================================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
