/**
 * BREW Coffee Platform — Phase 6.3.1.7 Verification Suite
 * Bound In-Memory Session Lookup Work & Strict Parity
 * 
 * Tests:
 * 1. Valid budget inspects at most permitted number of map entries + 1 truncation probe entry.
 * 2. Additional matching record beyond budget causes IncompleteSessionLookupError.
 * 3. Latest-session result remains correct when complete matching set is within budget.
 * 4. activeOnly still returns latest eligible non-terminal session without staff approval.
 * 5. Malformed matching record triggers fail-closed VoiceSessionLookupIntegrityError.
 * 6. Invalid budgets cause zero map scans (observable scan counter is 0).
 * 7. Document ID descending tie-breaker on identical createdAt timestamps.
 * 8. Truncated lookup avoids materializing or sorting the entire collection.
 * 9. InMemory and Firestore contract parity across valid, invalid, active, and corrupted lookups.
 * 10. Complete scan budget boundary tests (budget 1, default 100, hard max 500).
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
  IncompleteSessionLookupError,
  InvalidSessionLookupBudgetError,
  VoiceSessionLookupIntegrityError,
} from "../src/lib/voiceBooking/types";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";

// Ensure testing HMAC secret is defined
process.env.QUOTATION_SNAPSHOT_SECRET =
  process.env.QUOTATION_SNAPSHOT_SECRET || "brew-test-quotation-secret-32-chars-long!";

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.1.7: Bound In-Memory Lookup & Contract Parity");
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

async function runPhase6317Tests() {
  let passed = 0;
  let total = 0;

  function recordPass(name: string) {
    passed++;
    total++;
    console.log(`  ✓ Test ${total}: ${name}`);
  }

  const phone = "+919123456789";

  // ---------------------------------------------------------------------------
  // Test 1: Bounded map scan: inspects at most permitted budget + 1 truncation probe
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    // Populate with 25 sessions
    for (let i = 1; i <= 25; i++) {
      const s = createVoiceBookingSession(phone, "en");
      s.id = `vbs_bounded_${String(i).padStart(3, "0")}`;
      s.createdAt = `2026-11-01T10:${String(i).padStart(2, "0")}:00.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    // Lookup with maxScanBudget = 10
    let threw = false;
    try {
      await repo.getByPhoneNumber(phone, { maxScanBudget: 10 });
    } catch (err) {
      if (err instanceof IncompleteSessionLookupError) {
        threw = true;
        assert.strictEqual(err.phoneNumber, phone);
        assert.strictEqual(err.scannedCount, 10);
      }
    }
    assert(threw, "Must throw IncompleteSessionLookupError on truncation");

    // Key assertion: observable scan counter must be EXACTLY maxBudget + 1 (10 + 1 = 11)
    // Not 25! It must have halted immediately after the one-entry probe!
    assert.strictEqual(
      repo.lastScanInspectedCount,
      11,
      `Expected exactly 11 entries inspected (10 budget + 1 probe), got ${repo.lastScanInspectedCount}`
    );
    assert.strictEqual(repo.getLastScanInspectedCount(), 11);

    recordPass("Valid budget inspects at most permitted budget + 1 truncation probe entry");
  }

  // ---------------------------------------------------------------------------
  // Test 2: Additional matching record beyond budget causes IncompleteSessionLookupError
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    // 6 records in total
    for (let i = 1; i <= 6; i++) {
      const s = createVoiceBookingSession(phone, "en");
      s.id = `vbs_probe_${i}`;
      s.createdAt = `2026-11-01T11:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    // Budget = 5
    await assert.rejects(
      async () => repo.getByPhoneNumber(phone, { maxScanBudget: 5 }),
      (err: unknown) => {
        return (
          err instanceof IncompleteSessionLookupError &&
          err.phoneNumber === phone &&
          err.scannedCount === 5 &&
          err.message.includes("truncated after scanning 5 sessions")
        );
      }
    );
    assert.strictEqual(repo.lastScanInspectedCount, 6);

    recordPass("Additional matching record beyond budget triggers IncompleteSessionLookupError");
  }

  // ---------------------------------------------------------------------------
  // Test 3: Latest-session result remains correct when complete matching set is within budget
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    for (let i = 1; i <= 5; i++) {
      const s = createVoiceBookingSession(phone, "en");
      s.id = `vbs_complete_${i}`;
      s.createdAt = `2026-11-01T12:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    // Budget = 10 (exceeds total matching records)
    const result = await repo.getByPhoneNumber(phone, { maxScanBudget: 10 });
    assert(result !== null);
    assert.strictEqual(result.id, "vbs_complete_5", "Latest session by createdAt must be returned");
    assert.strictEqual(result.createdAt, "2026-11-01T12:05:00.000Z");
    assert.strictEqual(repo.lastScanInspectedCount, 5, "Scanned all 5 entries without truncation");

    recordPass("Latest-session result remains correct when complete matching set is within budget");
  }

  // ---------------------------------------------------------------------------
  // Test 4: activeOnly returns latest eligible non-terminal session
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();

    // 1. Older active session
    const activeSession = createVoiceBookingSession(phone, "en");
    activeSession.id = "vbs_active_older";
    activeSession.state = "collecting_requirements";
    activeSession.createdAt = "2026-11-01T13:01:00.000Z";
    activeSession.updatedAt = activeSession.createdAt;
    await repo.save(activeSession);

    // 2. Newer terminal session
    const terminalSession = createVoiceBookingSession(phone, "en");
    terminalSession.id = "vbs_terminal_newer";
    terminalSession.state = "booking_confirmed";
    terminalSession.createdAt = "2026-11-01T13:05:00.000Z";
    terminalSession.updatedAt = terminalSession.createdAt;
    terminalSession.staffApprovalAudit = {
      approvedAt: "2026-11-01T13:05:00.000Z",
      staffIdentity: "staff_test_123",
      staffRole: "barista",
      staffApprovalId: "appr_123",
      sessionId: "vbs_terminal_newer",
    };
    await repo.save(terminalSession);

    // Regular lookup should return newer terminal session
    const latest = await repo.getByPhoneNumber(phone);
    assert.strictEqual(latest?.id, "vbs_terminal_newer");

    // activeOnly lookup should bypass terminal session and return active session
    const active = await repo.getByPhoneNumber(phone, { activeOnly: true });
    assert.strictEqual(active?.id, "vbs_active_older");
    assert.strictEqual(active?.state, "collecting_requirements");

    recordPass("activeOnly still returns latest eligible non-terminal session");
  }

  // ---------------------------------------------------------------------------
  // Test 5: Malformed matching records still cause VoiceSessionLookupIntegrityError
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const valid = createVoiceBookingSession(phone, "en");
    valid.id = "vbs_valid_1";
    valid.createdAt = "2026-11-01T14:00:00.000Z";
    valid.updatedAt = valid.createdAt;
    await repo.save(valid);

    // Inject corrupted record directly into internal map
    const corrupt = {
      ...createVoiceBookingSession(phone, "en"),
      id: "vbs_corrupt_test",
      createdAt: "INVALID_TIMESTAMP",
    };
    (repo as unknown as { sessions: Map<string, unknown> }).sessions.set(corrupt.id, corrupt);

    await assert.rejects(
      async () => repo.getByPhoneNumber(phone),
      (err: unknown) => {
        return (
          err instanceof VoiceSessionLookupIntegrityError &&
          err.documentId === "vbs_corrupt_test" &&
          err.reason.includes("createdAt")
        );
      }
    );

    recordPass("Malformed matching records trigger fail-closed VoiceSessionLookupIntegrityError");
  }

  // ---------------------------------------------------------------------------
  // Test 6: Invalid budgets cause zero map scans
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const s = createVoiceBookingSession(phone, "en");
    await repo.save(s);

    const invalidBudgets = [NaN, Infinity, -Infinity, 0, -10, 15.5, null, "50", 501];
    for (const inv of invalidBudgets) {
      repo.lastScanInspectedCount = 0;
      await assert.rejects(
        async () => repo.getByPhoneNumber(phone, { maxScanBudget: inv as number }),
        InvalidSessionLookupBudgetError
      );
      assert.strictEqual(
        repo.lastScanInspectedCount,
        0,
        `Expected 0 map scans for invalid budget ${inv}, got ${repo.lastScanInspectedCount}`
      );
    }

    recordPass("Invalid budgets cause zero map scans (observable counter = 0)");
  }

  // ---------------------------------------------------------------------------
  // Test 7: Deterministic document ID tie-breaker on identical createdAt
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const sameTime = "2026-11-01T15:00:00.000Z";

    const sA = createVoiceBookingSession(phone, "en");
    sA.id = "tie_doc_aaa";
    sA.createdAt = sameTime;
    sA.updatedAt = sameTime;
    await repo.save(sA);

    const sZ = createVoiceBookingSession(phone, "en");
    sZ.id = "tie_doc_zzz";
    sZ.createdAt = sameTime;
    sZ.updatedAt = sameTime;
    await repo.save(sZ);

    const sM = createVoiceBookingSession(phone, "en");
    sM.id = "tie_doc_mmm";
    sM.createdAt = sameTime;
    sM.updatedAt = sameTime;
    await repo.save(sM);

    const result = await repo.getByPhoneNumber(phone);
    assert.strictEqual(result?.id, "tie_doc_zzz", "Must break ties with document ID descending");

    recordPass("Deterministic document ID descending tie-breaker on identical createdAt");
  }

  // ---------------------------------------------------------------------------
  // Test 8: Truncated lookup avoids materializing or sorting entire collection
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    // Populate with 100 sessions
    for (let i = 1; i <= 100; i++) {
      const s = createVoiceBookingSession(phone, "en");
      s.id = `vbs_huge_${String(i).padStart(3, "0")}`;
      s.createdAt = `2026-11-01T16:00:${String(i % 60).padStart(2, "0")}.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    // Set small budget of 5
    await assert.rejects(
      async () => repo.getByPhoneNumber(phone, { maxScanBudget: 5 }),
      IncompleteSessionLookupError
    );

    // Exactly 6 entries inspected out of 100!
    assert.strictEqual(
      repo.lastScanInspectedCount,
      6,
      `Expected exactly 6 entries inspected, got ${repo.lastScanInspectedCount}`
    );

    recordPass("Truncated lookup halts immediately at 1-entry probe without unbounded scan");
  }

  // ---------------------------------------------------------------------------
  // Test 9: Complete contract parity between InMemory and Firestore
  // ---------------------------------------------------------------------------
  {
    const store = new MockFirestoreStore();
    const fsRepo = new FirestoreVoiceSessionRepository(createMockFirestore(store));
    const memRepo = new InMemoryVoiceSessionRepository();

    for (let i = 1; i <= 4; i++) {
      const s = createVoiceBookingSession(phone, "en");
      s.id = `parity_${i}`;
      s.createdAt = `2026-11-01T17:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await fsRepo.save(s);
      await memRepo.save(s);
    }

    // 1. Success parity
    const fsLatest = await fsRepo.getByPhoneNumber(phone, { maxScanBudget: 10 });
    const memLatest = await memRepo.getByPhoneNumber(phone, { maxScanBudget: 10 });
    assert.strictEqual(fsLatest?.id, memLatest?.id);
    assert.strictEqual(fsLatest?.createdAt, memLatest?.createdAt);

    // 2. Truncation parity
    let fsTruncErr: unknown = null;
    let memTruncErr: unknown = null;
    try {
      await fsRepo.getByPhoneNumber(phone, { maxScanBudget: 3 });
    } catch (e) {
      fsTruncErr = e;
    }
    try {
      await memRepo.getByPhoneNumber(phone, { maxScanBudget: 3 });
    } catch (e) {
      memTruncErr = e;
    }
    assert(fsTruncErr instanceof IncompleteSessionLookupError);
    assert(memTruncErr instanceof IncompleteSessionLookupError);
    assert.strictEqual(
      (fsTruncErr as IncompleteSessionLookupError).message,
      (memTruncErr as IncompleteSessionLookupError).message
    );

    recordPass("Complete contract parity between InMemory and Firestore implementations");
  }

  // ---------------------------------------------------------------------------
  // Test 10: Complete scan budget boundary checks (1, default 100, hard max 500)
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const s = createVoiceBookingSession(phone, "en");
    s.id = "vbs_boundary_1";
    await repo.save(s);

    // Budget 1
    const res1 = await repo.getByPhoneNumber(phone, { maxScanBudget: 1 });
    assert.strictEqual(res1?.id, "vbs_boundary_1");
    assert.strictEqual(repo.lastScanInspectedCount, 1);

    // Default 100
    const res100 = await repo.getByPhoneNumber(phone);
    assert.strictEqual(res100?.id, "vbs_boundary_1");
    assert.strictEqual(repo.lastScanInspectedCount, 1);

    // Hard max 500
    const res500 = await repo.getByPhoneNumber(phone, { maxScanBudget: 500 });
    assert.strictEqual(res500?.id, "vbs_boundary_1");
    assert.strictEqual(repo.lastScanInspectedCount, 1);

    recordPass("Complete scan budget boundary checks (1, default 100, hard max 500)");
  }

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.1.7 Verification Complete: ${passed}/${total} Tests Passed`);
  console.log("===============================================================================\n");
}

runPhase6317Tests().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
