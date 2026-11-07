/**
 * BREW Coffee Platform — Phase 6.3.1.6 Verification Suite
 * Strict Scan-Budget Validation & Bounded Lookup Guarantees
 * 
 * Tests:
 * 1. Omitted budget defaults to 100 in both Firestore and InMemory repositories.
 * 2. Valid budget of 1 succeeds.
 * 3. Valid budget at hard maximum 500 succeeds.
 * 4. NaN rejected with InvalidSessionLookupBudgetError.
 * 5. Infinity and -Infinity rejected with InvalidSessionLookupBudgetError.
 * 6. Zero (0) rejected with InvalidSessionLookupBudgetError.
 * 7. Negative integer rejected with InvalidSessionLookupBudgetError.
 * 8. Fractional value rejected with InvalidSessionLookupBudgetError.
 * 9. Explicit null rejected with InvalidSessionLookupBudgetError.
 * 10. String value rejected with InvalidSessionLookupBudgetError.
 * 11. Value above hard maximum (>500) rejected with InvalidSessionLookupBudgetError.
 * 12. Invalid budget causes zero Firestore queries (verified via query execution counter).
 * 13. Invalid budget causes zero InMemory scans (verified via Map access counter).
 * 14. Contract parity across InMemory and Firestore implementations.
 * 15. Valid budget detects truncation and throws IncompleteSessionLookupError with general message.
 */

import assert from "assert";
import type { Firestore } from "firebase-admin/firestore";
import {
  createVoiceBookingSession,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  FirestoreVoiceSessionRepository,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import {
  DEFAULT_MAX_SCAN_BUDGET,
  HARD_MAX_SCAN_BUDGET,
  IncompleteSessionLookupError,
  InvalidSessionLookupBudgetError,
  validateScanBudget,
} from "../src/lib/voiceBooking/types";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";

// Ensure testing HMAC secret is defined
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-32-chars-long!";

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.1.6: Scan-Budget Validation & Parity Verification");
console.log("   Test Mode: Deterministic High-Fidelity Simulator & InMemory Engine");
console.log("===============================================================================\n");

function cloneStoreData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object") {
      if ("toDate" in v && typeof (v as { toDate: unknown }).toDate === "function") {
        result[k] = v;
      } else if (Array.isArray(v)) {
        result[k] = JSON.parse(JSON.stringify(v));
      } else {
        result[k] = cloneStoreData(v as Record<string, unknown>);
      }
    } else {
      result[k] = v;
    }
  }
  return result;
}

class MockFirestoreStore {
  public docs: Map<string, { data: Record<string, unknown>; version: number }> = new Map();
  public queryExecutionCount = 0;

  getDoc(id: string) {
    const entry = this.docs.get(id);
    if (!entry) return null;
    return {
      exists: true,
      data: () => cloneStoreData(entry.data),
      version: entry.version,
    };
  }

  setDoc(id: string, data: Record<string, unknown>) {
    const existing = this.docs.get(id);
    const version = (existing?.version || 0) + 1;
    this.docs.set(id, {
      data: cloneStoreData(data),
      version,
    });
  }

  deleteDoc(id: string): boolean {
    return this.docs.delete(id);
  }
}

function createMockFirestore(store: MockFirestoreStore): Firestore {
  const executeQuery = (
    filterField?: string,
    filterOp?: string,
    filterVal?: unknown,
    sortField?: unknown,
    sortDir?: "asc" | "desc",
    limitN?: number,
    startAfterDoc?: { id: string }
  ) => {
    store.queryExecutionCount++;

    let matching: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    for (const [id, entry] of store.docs.entries()) {
      if (filterField && filterOp === "==") {
        if (entry.data[filterField] !== filterVal) continue;
      }
      matching.push({ id, data: () => cloneStoreData(entry.data) });
    }

    if (sortField) {
      const isDocId =
        sortField === "__name__" ||
        sortField === "id" ||
        (typeof sortField === "object" &&
          sortField !== null &&
          "segments" in sortField &&
          (sortField as { segments: string[] }).segments[0] === "__name__");

      matching.sort((a, b) => {
        if (isDocId) {
          const cmp = a.id.localeCompare(b.id);
          return sortDir === "desc" ? -cmp : cmp;
        }

        const fieldName = String(sortField);
        const valA = a.data()[fieldName];
        const valB = b.data()[fieldName];
        let cmp = 0;
        if (typeof valA === "string" && typeof valB === "string") {
          cmp = valA.localeCompare(valB);
        } else if (typeof valA === "number" && typeof valB === "number") {
          cmp = valA - valB;
        }
        if (sortDir === "desc") cmp = -cmp;
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });
    }

    if (startAfterDoc) {
      const idx = matching.findIndex((m) => m.id === startAfterDoc.id);
      if (idx !== -1) {
        matching = matching.slice(idx + 1);
      }
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
    sortField?: unknown,
    sortDir?: "asc" | "desc",
    startAfterDoc?: { id: string }
  ) => ({
    orderBy: (sField: unknown, sDir: "asc" | "desc" = "asc") =>
      createQueryBuilder(filterField, filterOp, filterVal, sField, sDir, startAfterDoc),
    startAfter: (doc: { id: string }) =>
      createQueryBuilder(filterField, filterOp, filterVal, sortField, sortDir, doc),
    limit: (n: number) => ({
      startAfter: (doc: { id: string }) => ({
        get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir, n, doc),
      }),
      get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir, n, startAfterDoc),
    }),
    get: async () => executeQuery(filterField, filterOp, filterVal, sortField, sortDir, undefined, startAfterDoc),
  });

  return {
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: async () => {
          const d = store.getDoc(id);
          return {
            exists: d ? d.exists : false,
            data: () => (d ? d.data() : undefined),
          };
        },
      }),
      where: (field: string, op: string, val: unknown) =>
        createQueryBuilder(field, op, val),
      orderBy: (field: unknown, dir: "asc" | "desc" = "asc") =>
        createQueryBuilder(undefined, undefined, undefined, field, dir),
      limit: (n: number) => createQueryBuilder().limit(n),
      get: async () => executeQuery(),
    }),
    runTransaction: async <T>(updateFn: (tx: unknown) => Promise<T>): Promise<T> => {
      const transactionContext = {
        get: async (docRef: { id: string }) => {
          const doc = store.getDoc(docRef.id);
          return {
            exists: Boolean(doc),
            data: () => (doc ? doc.data() : undefined),
          };
        },
        set: (docRef: { id: string }, data: Record<string, unknown>) => {
          store.setDoc(docRef.id, data);
        },
        update: (docRef: { id: string }, data: Record<string, unknown>) => {
          const doc = store.getDoc(docRef.id);
          if (!doc) throw new Error("Document does not exist for update in transaction");
          store.setDoc(docRef.id, { ...doc.data(), ...data });
        },
      };
      return updateFn(transactionContext);
    },
  } as unknown as Firestore;
}

// Spying class to observe map iterations/reads on InMemory repository
class InstrumentableInMemoryRepository extends InMemoryVoiceSessionRepository {
  public mapReadCount = 0;

  constructor() {
    super();
    // Intercept internal sessions Map values iteration
    const originalValues = (this as unknown as { sessions: Map<string, unknown> }).sessions.values.bind(
      (this as unknown as { sessions: Map<string, unknown> }).sessions
    );
    (this as unknown as { sessions: Map<string, unknown> }).sessions.values = () => {
      this.mapReadCount++;
      return originalValues();
    };
  }
}

async function runTests() {
  let passed = 0;
  let total = 0;

  function recordPass(name: string) {
    passed++;
    total++;
    console.log(`  ✓ Test ${total}: ${name}`);
  }

  // --------------------------------------------------------------------------
  // Test 1: Omitted budget defaults to 100
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(DEFAULT_MAX_SCAN_BUDGET, 100);
    assert.strictEqual(validateScanBudget(undefined), 100);

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const session = createVoiceBookingSession("+919876543210");
    await firestoreRepo.save(session);
    await inMemoryRepo.save(session);

    // Call without options or without maxScanBudget
    const fsFound1 = await firestoreRepo.getByPhoneNumber("+919876543210");
    const fsFound2 = await firestoreRepo.getByPhoneNumber("+919876543210", {});
    const memFound1 = await inMemoryRepo.getByPhoneNumber("+919876543210");
    const memFound2 = await inMemoryRepo.getByPhoneNumber("+919876543210", {});

    assert.strictEqual(fsFound1?.id, session.id);
    assert.strictEqual(fsFound2?.id, session.id);
    assert.strictEqual(memFound1?.id, session.id);
    assert.strictEqual(memFound2?.id, session.id);

    recordPass("Omitted budget defaults to 100 in both Firestore and InMemory");
  }

  // --------------------------------------------------------------------------
  // Test 2: Valid budget of 1 succeeds
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(validateScanBudget(1), 1);

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const session = createVoiceBookingSession("+919876543210");
    await firestoreRepo.save(session);
    await inMemoryRepo.save(session);

    const fsResult = await firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 1 });
    const memResult = await inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 1 });

    assert.strictEqual(fsResult?.id, session.id);
    assert.strictEqual(memResult?.id, session.id);

    recordPass("Valid budget of 1 succeeds");
  }

  // --------------------------------------------------------------------------
  // Test 3: Valid budget at hard maximum 500 succeeds
  // --------------------------------------------------------------------------
  {
    assert.strictEqual(HARD_MAX_SCAN_BUDGET, 500);
    assert.strictEqual(validateScanBudget(500), 500);

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const session = createVoiceBookingSession("+919876543210");
    await firestoreRepo.save(session);
    await inMemoryRepo.save(session);

    const fsResult = await firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 500 });
    const memResult = await inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 500 });

    assert.strictEqual(fsResult?.id, session.id);
    assert.strictEqual(memResult?.id, session.id);

    recordPass("Valid budget at hard maximum (500) succeeds");
  }

  // --------------------------------------------------------------------------
  // Test 4: NaN rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(NaN),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("not finite")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: NaN }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: NaN }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("NaN rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 5: Infinity and -Infinity rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(Infinity),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    assert.throws(
      () => validateScanBudget(-Infinity),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: Infinity }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: -Infinity }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("Infinity and -Infinity rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 6: Zero (0) rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(0),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("greater than zero")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 0 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 0 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("Zero (0) rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 7: Negative integer rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(-1),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("greater than zero")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: -25 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: -25 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("Negative integer rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 8: Fractional value rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(10.5),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("integer")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 4.2 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 99.99 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("Fractional value rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 9: Explicit null rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(null),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("null")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: null as unknown as number }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: null as unknown as number }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("Explicit null rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 10: String value rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget("100"),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("string")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: "100" as unknown as number }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: "100" as unknown as number }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("String value rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 11: Value above hard maximum (>500) rejected with InvalidSessionLookupBudgetError
  // --------------------------------------------------------------------------
  {
    assert.throws(
      () => validateScanBudget(501),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError && err.reason.includes("exceeds hard maximum")
    );

    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    await assert.rejects(
      async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 501 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );
    await assert.rejects(
      async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: 1000 }),
      (err: unknown) => err instanceof InvalidSessionLookupBudgetError
    );

    recordPass("Value above hard maximum (>500) rejected with InvalidSessionLookupBudgetError");
  }

  // --------------------------------------------------------------------------
  // Test 12: Invalid budget causes zero Firestore queries
  // --------------------------------------------------------------------------
  {
    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);

    const session = createVoiceBookingSession("+919876543210");
    await firestoreRepo.save(session);

    // Reset query counter after save
    store.queryExecutionCount = 0;

    // Test a variety of invalid inputs and assert queryExecutionCount remains exactly 0
    const invalidBudgets: unknown[] = [NaN, Infinity, -Infinity, 0, -5, 12.5, null, "50", 501, 10000];
    for (const invalid of invalidBudgets) {
      await assert.rejects(
        async () => firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: invalid as number }),
        InvalidSessionLookupBudgetError
      );
    }

    assert.strictEqual(
      store.queryExecutionCount,
      0,
      `Expected 0 Firestore query executions on invalid budgets, got ${store.queryExecutionCount}`
    );

    recordPass("Invalid budget causes zero Firestore queries (counter verified)");
  }

  // --------------------------------------------------------------------------
  // Test 13: Invalid budget causes zero InMemory scans
  // --------------------------------------------------------------------------
  {
    const inMemoryRepo = new InstrumentableInMemoryRepository();
    const session = createVoiceBookingSession("+919876543210");
    await inMemoryRepo.save(session);

    inMemoryRepo.mapReadCount = 0;

    const invalidBudgets: unknown[] = [NaN, Infinity, -Infinity, 0, -5, 12.5, null, "50", 501, 10000];
    for (const invalid of invalidBudgets) {
      await assert.rejects(
        async () => inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: invalid as number }),
        InvalidSessionLookupBudgetError
      );
    }

    assert.strictEqual(
      inMemoryRepo.mapReadCount,
      0,
      `Expected 0 InMemory map iterations on invalid budgets, got ${inMemoryRepo.mapReadCount}`
    );

    recordPass("Invalid budget causes zero InMemory scans (counter verified)");
  }

  // --------------------------------------------------------------------------
  // Test 14: Contract parity across InMemory and Firestore
  // --------------------------------------------------------------------------
  {
    const testCases: Array<{ input: unknown; shouldThrow: boolean; expectedErrorType?: unknown }> = [
      { input: undefined, shouldThrow: false },
      { input: 1, shouldThrow: false },
      { input: 25, shouldThrow: false },
      { input: 100, shouldThrow: false },
      { input: 500, shouldThrow: false },
      { input: 0, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: -1, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: 1.5, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: NaN, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: Infinity, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: -Infinity, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: null, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: "100", shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: true, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: {}, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
      { input: 501, shouldThrow: true, expectedErrorType: InvalidSessionLookupBudgetError },
    ];

    for (const tc of testCases) {
      const store = new MockFirestoreStore();
      const mockDb = createMockFirestore(store);
      const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
      const inMemoryRepo = new InMemoryVoiceSessionRepository();

      const session = createVoiceBookingSession("+919876543210");
      await firestoreRepo.save(session);
      await inMemoryRepo.save(session);

      let fsError: unknown = null;
      try {
        await firestoreRepo.getByPhoneNumber("+919876543210", { maxScanBudget: tc.input as number });
      } catch (err) {
        fsError = err;
      }

      let memError: unknown = null;
      try {
        await inMemoryRepo.getByPhoneNumber("+919876543210", { maxScanBudget: tc.input as number });
      } catch (err) {
        memError = err;
      }

      if (tc.shouldThrow) {
        assert(fsError instanceof InvalidSessionLookupBudgetError, `Firestore should throw for input ${tc.input}`);
        assert(memError instanceof InvalidSessionLookupBudgetError, `InMemory should throw for input ${tc.input}`);
        assert.strictEqual(
          (fsError as InvalidSessionLookupBudgetError).name,
          (memError as InvalidSessionLookupBudgetError).name
        );
      } else {
        assert.strictEqual(fsError, null, `Firestore should not throw for input ${tc.input}`);
        assert.strictEqual(memError, null, `InMemory should not throw for input ${tc.input}`);
      }
    }

    recordPass("100% Contract parity across InMemory and Firestore implementations");
  }

  // --------------------------------------------------------------------------
  // Test 15: Valid budget detects truncation and throws IncompleteSessionLookupError with generalized message
  // --------------------------------------------------------------------------
  {
    const store = new MockFirestoreStore();
    const mockDb = createMockFirestore(store);
    const firestoreRepo = new FirestoreVoiceSessionRepository(mockDb);
    const inMemoryRepo = new InMemoryVoiceSessionRepository();

    const phone = "+919876543210";
    // Create 3 sessions for this phone
    for (let i = 1; i <= 3; i++) {
      const s = createVoiceBookingSession(phone);
      s.id = `vbs_trunc_${i}`;
      s.createdAt = `2026-11-01T10:0${i}:00.000Z`;
      s.updatedAt = `2026-11-01T10:0${i}:00.000Z`;
      await firestoreRepo.save(s);
      await inMemoryRepo.save(s);
    }

    // Set maxScanBudget = 2
    let fsError: unknown = null;
    try {
      await firestoreRepo.getByPhoneNumber(phone, { maxScanBudget: 2 });
    } catch (err) {
      fsError = err;
    }

    let memError: unknown = null;
    try {
      await inMemoryRepo.getByPhoneNumber(phone, { maxScanBudget: 2 });
    } catch (err) {
      memError = err;
    }

    assert(fsError instanceof IncompleteSessionLookupError);
    assert(memError instanceof IncompleteSessionLookupError);
    assert.strictEqual(
      (fsError as IncompleteSessionLookupError).message,
      `Session lookup for phone '${phone}' was truncated after scanning 2 sessions. Additional records exist beyond the scan budget.`
    );
    assert.strictEqual(
      (memError as IncompleteSessionLookupError).message,
      `Session lookup for phone '${phone}' was truncated after scanning 2 sessions. Additional records exist beyond the scan budget.`
    );
    assert.strictEqual((fsError as IncompleteSessionLookupError).scannedCount, 2);
    assert.strictEqual((memError as IncompleteSessionLookupError).scannedCount, 2);

    recordPass("Valid budget detects truncation and throws IncompleteSessionLookupError with generalized message");
  }

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.1.6 Verification Complete: ${passed}/${total} Tests Passed`);
  console.log("===============================================================================\n");
}

runTests().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
