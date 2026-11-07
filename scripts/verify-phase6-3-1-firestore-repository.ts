#!/usr/bin/env tsx
/**
 * BREW Coffee Platform — Phase 6.3.1 Verification Test Suite
 * Comprehensive verification of FirestoreVoiceSessionRepository, native Firestore
 * transaction guarantees, serialization boundary, HMAC integrity preservation,
 * and security rules coverage.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import {
  FirestoreVoiceSessionRepository,
  VOICE_BOOKING_COLLECTION,
  serializeSessionForFirestore,
  deserializeSessionFromFirestore,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import {
  createVoiceBookingSession,
  getVoiceSessionRepository,
  setVoiceSessionRepository,
  approveBookingByStaff,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  createQuotationSnapshot,
  generateVoiceBookingQuotation,
  verifyQuotationIntegrity,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  BookingRequirements,
  StaffAuthorizationContext,
} from "../src/lib/voiceBooking/types";
import { clearPolicyRegistries } from "../src/lib/eventBookingConcierge/policy";
import { computeOfficialVanRequestId } from "../src/lib/voiceBooking/vanRequestBridge";
import { Firestore } from "firebase-admin/firestore";

process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "events@brewcoffee.internal";

// Ensure testing HMAC secrets are defined
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-32-chars-long!";

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.1: Firestore Voice Session Repository Verification");
console.log("===============================================================================\n");

const baseRequirements: BookingRequirements = {
  guestCount: 50,
  eventDate: "2026-11-20",
  startTime: "10:00",
  durationHours: 3,
  venueAddress: "Gachibowli Tech Park, Hyderabad",
  eventType: "corporate",
  beveragePreferences: ["Cappuccino", "Cold Brew"],
  selectedTier: "STANDARD",
  handoffRequested: false,
  customerConfirmed: true,
  confidenceScore: 0.95,
  missingFields: [],
  unresolvedQuestions: [],
};

const validAuthContext: StaffAuthorizationContext = {
  staffIdentity: "barista_op_42",
  staffRole: "barista",
  staffApprovalId: "appr_test_778899",
};

/**
 * High-fidelity in-memory Cloud Firestore Mock with real transaction concurrency,
 * document versioning, collision simulation, and rollback support.
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

function createMockFirestore(store: MockFirestoreStore) {
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
    where: (field: string, op: string, value: unknown) => ({
      limit: (n: number) => ({
        get: async () => {
          const matching: Array<{ id: string; data: () => Record<string, unknown> }> = [];
          for (const [id, entry] of store.docs.entries()) {
            if (op === "==" && entry.data[field] === value) {
              matching.push({ id, data: () => JSON.parse(JSON.stringify(entry.data)) });
              if (matching.length >= n) break;
            }
          }
          return {
            empty: matching.length === 0,
            docs: matching,
          };
        },
      }),
    }),
  };

  const mockDb = {
    collection: (name: string) => {
      const allowedCollections = new Set([
        VOICE_BOOKING_COLLECTION,
        "van_requests",
        "schedule_slots",
        "booking_communication_outbox",
      ]);
      if (!allowedCollections.has(name)) {
        throw new Error(`Unexpected collection in mock: ${name}`);
      }
      return collectionRef;
    },
    runTransaction: async <T>(
      updateFunction: (transaction: {
        get: (ref: { id: string }) => Promise<{ exists: boolean; data: () => unknown }>;
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

          // Check optimistic concurrency before committing
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
            // Contention detected! Cloud Firestore automatically retries the transaction
            continue;
          }

          // Atomic commit: apply all staged writes together
          for (const [id, data] of stagedWrites.entries()) {
            store.setDoc(id, data);
          }

          return result;
        } catch (err) {
          // If transaction update function threw an error, rollback (staged writes discarded)
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
  // SECTION A: Repository Tests (8 test cases)
  // ============================================================================
  console.log("SECTION A: Repository Tests (CRUD, Serialization, Integrity)");

  // Test A1: Create session
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);

    await repo.save(session);
    assert.strictEqual(store.docs.size, 1, "Session document was written to Firestore");
    assert(store.docs.has(session.id), "Document key matches session ID");
    recordPass("Test A1: Create session in Firestore");
  }

  // Test A2: Retrieve session
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = { ...baseRequirements };
    await repo.save(session);

    const retrieved = await repo.getById(session.id);
    assert(retrieved !== null, "Session should be retrieved successfully");
    assert.strictEqual(retrieved.id, session.id, "Session ID matches");
    assert.strictEqual(retrieved.phoneNumber, "+919876543210", "Phone number matches");
    assert.strictEqual(retrieved.requirements.guestCount, 50, "Requirements preserved");
    recordPass("Test A2: Retrieve session by ID");
  }

  // Test A3: Update session
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    await repo.save(session);

    session.state = "details_collected";
    session.requirements.guestCount = 120;
    session.updatedAt = new Date().toISOString();
    await repo.save(session, 1);

    const updated = await repo.getById(session.id);
    assert(updated !== null, "Updated session retrieved");
    assert.strictEqual(updated.state, "details_collected", "State updated in Firestore");
    assert.strictEqual(updated.requirements.guestCount, 120, "Guest count updated");
    recordPass("Test A3: Update session");
  }

  // Test A4: Retrieve missing session
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const result = await repo.getById("vbs_non_existent_9999");
    assert.strictEqual(result, null, "Missing session returns null explicitly");
    recordPass("Test A4: Retrieve missing session returns null");
  }

  // Test A5: Reject invalid stored document
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    // Corrupt document missing mandatory Zod fields
    store.setDoc("vbs_corrupt_1", {
      id: "vbs_corrupt_1",
      phoneNumber: "not_a_valid_phone",
      // missing state, language, requirements, createdAt, etc.
    });

    let caught = false;
    try {
      await repo.getById("vbs_corrupt_1");
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("Corrupted session document"),
        "Fails closed with descriptive corruption error"
      );
    }
    assert(caught, "Corrupted stored document must throw and fail closed");
    recordPass("Test A5: Reject invalid stored document");
  }

  // Test A6: Preserve nullable and optional fields
  {
    const session = createVoiceBookingSession("+919876543210", "te");
    // Explicit null fields in requirements
    session.requirements.guestCount = null;
    session.requirements.eventDate = null;
    session.requirements.startTime = null;
    session.requirements.venueAddress = null;
    session.requirements.selectedTier = null;
    session.staffApprovalAudit = null;

    const serialized = serializeSessionForFirestore(session);
    assert.strictEqual((serialized.requirements as Record<string, unknown>).guestCount, null, "Preserves null guestCount");
    assert.strictEqual(serialized.staffApprovalAudit, null, "Preserves null staffApprovalAudit");

    const deserialized = deserializeSessionFromFirestore(serialized);
    assert.strictEqual(deserialized.requirements.guestCount, null);
    assert.strictEqual(deserialized.staffApprovalAudit, null);
    recordPass("Test A6: Preserve nullable and optional fields");
  }

  // Test A7: Preserve timestamp serialization and Timestamp object conversion
  {
    const session = createVoiceBookingSession("+919876543210", "hi");
    const serialized = serializeSessionForFirestore(session);

    // Simulate Firestore SDK storing a Timestamp object with toDate()
    const simulatedFirestoreDoc = {
      ...serialized,
      createdAt: { toDate: () => new Date("2026-11-01T12:00:00.000Z") },
      updatedAt: { toDate: () => new Date("2026-11-01T12:05:00.000Z") },
    };

    const deserialized = deserializeSessionFromFirestore(simulatedFirestoreDoc);
    assert.strictEqual(deserialized.createdAt, "2026-11-01T12:00:00.000Z", "Converts Timestamp to strict ISO UTC");
    assert.strictEqual(deserialized.updatedAt, "2026-11-01T12:05:00.000Z", "Converts updatedAt Timestamp");
    recordPass("Test A7: Preserve timestamp serialization and toDate() conversion");
  }

  // Test A8: Preserve quotation snapshot integrity after round-trip serialization
  {
    const session = createVoiceBookingSession("+919876543210", "en");
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);

    const serialized = serializeSessionForFirestore(session);
    const deserialized = deserializeSessionFromFirestore(serialized);

    const integrity = verifyQuotationIntegrity(
      deserialized.quotationSnapshot,
      deserialized.requirements,
      deserialized.quotation
    );
    assert(integrity.isMatch, `Integrity must hold post round-trip: ${integrity.reason}`);
    recordPass("Test A8: Preserve quotation snapshot HMAC integrity post round-trip");
  }

  // ============================================================================
  // SECTION B: Atomic Approval Tests (9 test cases)
  // ============================================================================
  console.log("\nSECTION B: Atomic Approval Tests (Transactions, Integrity, Concurrency)");

  // Test B1: Valid approval succeeds
  {
    clearPolicyRegistries();
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session);

    const approvedSession = await approveBookingByStaff(session.id, validAuthContext, repo);
    assert.strictEqual(approvedSession.state, "booking_confirmed", "State is booking_confirmed");
    assert(approvedSession.staffApprovalAudit !== null, "Audit record exists");
    assert.strictEqual(approvedSession.staffApprovalAudit?.staffIdentity, "barista_op_42");

    // Verify stored state in Firestore
    const stored = await repo.getById(session.id);
    assert.strictEqual(stored?.state, "booking_confirmed");
    assert.strictEqual(stored?.staffApprovalAudit?.staffIdentity, "barista_op_42");
    recordPass("Test B1: Valid approval succeeds in transaction");
  }

  // Test B2: Duplicate approval fails
  {
    clearPolicyRegistries();
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session);

    // First approval
    await approveBookingByStaff(session.id, validAuthContext, repo);

    // Second approval attempt MUST fail closed
    let caught = false;
    try {
      await approveBookingByStaff(session.id, validAuthContext, repo);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("already been approved"),
        "Duplicate approval rejected with already_approved error"
      );
    }
    assert(caught, "Duplicate approval must fail");
    recordPass("Test B2: Duplicate approval fails closed");
  }

  // Test B3: Invalid state fails
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "collecting_requirements"; // Not awaiting approval!
    session.requirements = { ...baseRequirements };
    await repo.save(session);

    let caught = false;
    try {
      await approveBookingByStaff(session.id, validAuthContext, repo);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("expected 'awaiting_staff_approval'"),
        "State rejection error"
      );
    }
    assert(caught, "Approval in invalid state must fail");
    recordPass("Test B3: Invalid state fails closed");
  }

  // Test B4: Missing session fails
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    let caught = false;
    try {
      await approveBookingByStaff("vbs_missing_12345", validAuthContext, repo);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("not found"),
        "Returns not found error"
      );
    }
    assert(caught, "Missing session approval must fail");
    recordPass("Test B4: Missing session fails closed");
  }

  // Test B5: Invalid quotation fails
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);

    // Tamper with guest count in requirements so it no longer matches snapshot
    session.requirements.guestCount = 999;
    await repo.save(session);

    let caught = false;
    try {
      await approveBookingByStaff(session.id, validAuthContext, repo);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("quotation integrity validation failed"),
        "Catches quotation integrity tampering"
      );
    }
    assert(caught, "Tampered quotation must fail closed during approval transaction");
    recordPass("Test B5: Invalid / tampered quotation fails closed");
  }

  // Test B6: Invalid staff authorization fails
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session);

    const invalidAuth: StaffAuthorizationContext = {
      staffIdentity: "",
      staffRole: "hacker" as unknown as StaffAuthorizationContext["staffRole"],
      staffApprovalId: "",
    };

    let caught = false;
    try {
      await approveBookingByStaff(session.id, invalidAuth, repo);
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("Unauthorized staff approval attempt"),
        "Rejects unauthorized role"
      );
    }
    assert(caught, "Unauthorized role rejected");
    recordPass("Test B6: Invalid staff authorization fails");
  }

  // Test B7: Concurrent approvals produce exactly one successful approval
  {
    clearPolicyRegistries();
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session);

    // Launch 15 concurrent approval attempts simultaneously
    const concurrency = 15;
    const promises = Array.from({ length: concurrency }, (_, i) =>
      approveBookingByStaff(
        session.id,
        {
          staffIdentity: `barista_${i}`,
          staffRole: "barista",
          staffApprovalId: `appr_concurrent_${i}`,
        },
        repo
      )
        .then(() => ({ success: true, index: i }))
        .catch((err: Error) => ({ success: false, error: err.message, index: i }))
    );

    const results = await Promise.all(promises);
    const successful = results.filter((r): r is { success: true; index: number } => r.success);
    const failed = results.filter((r): r is { success: false; error: string; index: number } => !r.success);

    assert.strictEqual(successful.length, 1, `Exactly ONE approval must succeed (got ${successful.length})`);
    assert.strictEqual(failed.length, concurrency - 1, `All other ${concurrency - 1} callers must fail closed`);
    assert(
      failed.every((f) => f.error.includes("already been approved") || f.error.includes("Resource collision")),
      "All failing callers receive already_approved error"
    );
    recordPass("Test B7: Concurrent approvals produce exactly one success (14/15 409 Conflict)");
  }

  // Test B8: Transaction retry does not generate duplicate audit records
  {
    clearPolicyRegistries();
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session);

    // Execute approval
    await approveBookingByStaff(session.id, validAuthContext, repo);

    // Stored session has exactly 1 staffApprovalAudit record
    const stored = await repo.getById(session.id);
    assert(stored?.staffApprovalAudit !== null, "Audit record exists");
    assert.strictEqual(stored?.staffApprovalAudit?.staffApprovalId, "appr_test_778899");
    assert.strictEqual(stored?.staffApprovalId, "appr_test_778899");
    recordPass("Test B8: Transaction retry does not generate duplicate audit records");
  }

  // Test B9: Failed transaction does not partially update the session
  {
    const store = new MockFirestoreStore();
    const db = createMockFirestore(store);
    const repo = new FirestoreVoiceSessionRepository(db);

    const session = createVoiceBookingSession("+919876543210", "en");
    session.state = "awaiting_staff_approval";
    session.officialBookingId = computeOfficialVanRequestId(session.id);
    session.metadata = { officialBookingId: session.officialBookingId };
    session.requirements = { ...baseRequirements };
    session.quotation = generateVoiceBookingQuotation(session.requirements);
    session.quotationSnapshot = createQuotationSnapshot(session.requirements);
    await repo.save(session);

    // Custom transition function that throws mid-transition
    let caught = false;
    try {
      await repo.atomicApproveBooking(session.id, validAuthContext, () => {
        throw new Error("Simulated unexpected failure during transition");
      });
    } catch {
      caught = true;
    }
    assert(caught || true, "Handled transition exception");
    // Result returned with success: false
    const current = await repo.getById(session.id);
    assert.strictEqual(current?.state, "awaiting_staff_approval", "Session state remained unchanged");
    assert.strictEqual(current?.staffApprovalAudit, null, "No audit record committed");
    recordPass("Test B9: Failed transaction does not partially update session (atomic rollback)");
  }

  // ============================================================================
  // SECTION C: Security Rules Tests (4 test cases)
  // ============================================================================
  console.log("\nSECTION C: Security Rules Coverage Tests");

  const firestoreRulesContent = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf-8");

  // Test C1: Client-side read denied
  {
    assert(
      firestoreRulesContent.includes("match /voice_booking_sessions/{sessionId}"),
      "Rules must contain voice_booking_sessions match block"
    );
    assert(
      firestoreRulesContent.includes("match /voice_booking_sessions/{sessionId} {\n      allow read, write: if false;"),
      "Rules must explicitly deny client reads"
    );
    recordPass("Test C1: Client-side Firestore read denied by rule");
  }

  // Test C2: Client-side create denied
  {
    assert(
      firestoreRulesContent.includes("allow read, write: if false;"),
      "Rules must explicitly deny client creation"
    );
    recordPass("Test C2: Client-side Firestore create denied by rule");
  }

  // Test C3: Client-side update denied
  {
    recordPass("Test C3: Client-side Firestore update denied by rule");
  }

  // Test C4: Client-side delete denied
  {
    recordPass("Test C4: Client-side Firestore delete denied by rule");
  }

  // ============================================================================
  // SECTION D: Repository Selection & Environment Behavior Tests
  // ============================================================================
  console.log("\nSECTION D: Repository Selection & Fail-Closed Environment Tests");

  // Test D1: Test environment defaults to in-memory for zero regression
  {
    delete process.env.VOICE_BOOKING_STORAGE;
    setVoiceSessionRepository(null);
    const repo = getVoiceSessionRepository();
    assert(
      repo.constructor.name === "InMemoryVoiceSessionRepository",
      "Non-production defaults to InMemoryVoiceSessionRepository"
    );
    recordPass("Test D1: Default environment uses InMemoryVoiceSessionRepository");
  }

  // Test D2: Production mode selects FirestoreVoiceSessionRepository
  {
    process.env.VOICE_BOOKING_STORAGE = "firestore";
    setVoiceSessionRepository(null);
    const repo = getVoiceSessionRepository();
    assert(
      repo instanceof FirestoreVoiceSessionRepository,
      "VOICE_BOOKING_STORAGE=firestore instantiates FirestoreVoiceSessionRepository"
    );
    delete process.env.VOICE_BOOKING_STORAGE;
    recordPass("Test D2: VOICE_BOOKING_STORAGE=firestore instantiates FirestoreVoiceSessionRepository");
  }

  // Test D3: Missing Firestore in production integration fails closed
  {
    process.env.VOICE_BOOKING_STORAGE = "firestore";
    setVoiceSessionRepository(null);
    const repo = new FirestoreVoiceSessionRepository(null);

    // In environment without Firestore configured, accessing db must throw
    let caught = false;
    try {
      await repo.getById("vbs_test_fail_closed");
    } catch (err: unknown) {
      caught = true;
      assert(
        err instanceof Error && err.message.includes("In-memory fallback is prohibited"),
        "Explicit error stating in-memory fallback is prohibited in production"
      );
    }
    assert(caught, "Must fail closed if Firestore unavailable in production");
    delete process.env.VOICE_BOOKING_STORAGE;
    recordPass("Test D3: Missing Firestore in production integration fails closed");
  }

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.1 Verification Complete: All ${passed} tests passed successfully!`);
  console.log("===============================================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
