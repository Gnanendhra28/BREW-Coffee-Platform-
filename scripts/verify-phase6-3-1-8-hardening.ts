/**
 * BREW Coffee Platform — Phase 6.3.1.8 Verification Suite
 * Phone-Indexed In-Memory Lookup & Contract Hardening
 * 
 * Tests:
 * 1. Many unrelated customer sessions do not consume the requested phone's budget.
 * 2. Two matching sessions among more than 100 unrelated sessions return the correct latest session.
 * 3. Matching sessions beyond the budget cause IncompleteSessionLookupError.
 * 4. Exactly budget matching sessions do not cause truncation.
 * 5. Phone-number changes remove the old index entry and add the new one.
 * 6. Deletion removes the index entry.
 * 7. Clear removes all index entries.
 * 8. Updating a session without changing its phone number does not duplicate its index entry.
 * 9. Malformed matching sessions still fail closed.
 * 10. Malformed unrelated sessions do not break a lookup for another phone number.
 * 11. activeOnly still returns the latest eligible session.
 * 12. Invalid budgets still cause zero candidate inspections.
 * 13. Index consistency is thoroughly verified after create, update, phone change, delete, and clear.
 * 14. InMemory and Firestore lookup contract parity is maintained.
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
console.log("   BREW Coffee — Phase 6.3.1.8: Phone-Indexed In-Memory Lookup Verification");
console.log("   Test Mode: Deterministic High-Fidelity Simulator & InMemory Phone Index");
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

async function runPhase6318Tests() {
  let passed = 0;
  let total = 0;

  function recordPass(name: string) {
    passed++;
    total++;
    console.log(`  ✓ Test ${total}: ${name}`);
  }

  const targetPhone = "+919876543210";
  const unrelatedPhone = "+919111222333";

  // ---------------------------------------------------------------------------
  // Test 1: Many unrelated customer sessions do not consume requested phone's budget
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();

    // Insert 150 unrelated customer sessions
    for (let i = 1; i <= 150; i++) {
      const s = createVoiceBookingSession(unrelatedPhone, "en");
      s.id = `vbs_unrelated_${String(i).padStart(3, "0")}`;
      await repo.save(s);
    }

    // Insert 3 target customer sessions
    for (let i = 1; i <= 3; i++) {
      const s = createVoiceBookingSession(targetPhone, "en");
      s.id = `vbs_target_${i}`;
      s.createdAt = `2026-11-01T10:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    // Query targetPhone with maxScanBudget = 10
    // Even though the repository contains 153 total sessions, the budget is NOT consumed by unrelated sessions!
    const result = await repo.getByPhoneNumber(targetPhone, { maxScanBudget: 10 });
    assert(result !== null);
    assert.strictEqual(result.id, "vbs_target_3");
    // Candidate inspection count must be exactly 3 (target phone's candidate size), NOT 153 or 11
    assert.strictEqual(repo.lastScanInspectedCount, 3);

    recordPass("Many unrelated customer sessions do not consume requested phone's budget");
  }

  // ---------------------------------------------------------------------------
  // Test 2: Two matching sessions among more than 100 unrelated sessions return correct latest
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();

    // Insert 120 unrelated sessions
    for (let i = 1; i <= 120; i++) {
      const s = createVoiceBookingSession(unrelatedPhone, "en");
      s.id = `vbs_unrel_${String(i).padStart(3, "0")}`;
      await repo.save(s);
    }

    // Insert 2 target sessions
    const s1 = createVoiceBookingSession(targetPhone, "en");
    s1.id = "vbs_two_1";
    s1.createdAt = "2026-11-01T09:00:00.000Z";
    s1.updatedAt = s1.createdAt;
    await repo.save(s1);

    const s2 = createVoiceBookingSession(targetPhone, "en");
    s2.id = "vbs_two_2";
    s2.createdAt = "2026-11-01T09:30:00.000Z";
    s2.updatedAt = s2.createdAt;
    await repo.save(s2);

    const result = await repo.getByPhoneNumber(targetPhone);
    assert.strictEqual(result?.id, "vbs_two_2");
    assert.strictEqual(repo.lastScanInspectedCount, 2);

    recordPass("Two matching sessions among >100 unrelated sessions return correct latest session");
  }

  // ---------------------------------------------------------------------------
  // Test 3: Matching sessions beyond the budget cause IncompleteSessionLookupError
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();

    // Insert 6 sessions for target phone
    for (let i = 1; i <= 6; i++) {
      const s = createVoiceBookingSession(targetPhone, "en");
      s.id = `vbs_over_${i}`;
      s.createdAt = `2026-11-01T11:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    await assert.rejects(
      async () => repo.getByPhoneNumber(targetPhone, { maxScanBudget: 5 }),
      (err: unknown) => {
        return (
          err instanceof IncompleteSessionLookupError &&
          err.phoneNumber === targetPhone &&
          err.scannedCount === 5
        );
      }
    );
    assert.strictEqual(repo.lastScanInspectedCount, 6, "Inspected 5 budget + 1 probe candidate");

    recordPass("Matching sessions beyond the budget cause IncompleteSessionLookupError");
  }

  // ---------------------------------------------------------------------------
  // Test 4: Exactly budget matching sessions do not cause truncation
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();

    // Insert exactly 5 sessions for target phone
    for (let i = 1; i <= 5; i++) {
      const s = createVoiceBookingSession(targetPhone, "en");
      s.id = `vbs_exact_${i}`;
      s.createdAt = `2026-11-01T12:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await repo.save(s);
    }

    // Lookup with maxScanBudget = 5
    const result = await repo.getByPhoneNumber(targetPhone, { maxScanBudget: 5 });
    assert(result !== null);
    assert.strictEqual(result.id, "vbs_exact_5");
    assert.strictEqual(repo.lastScanInspectedCount, 5);

    recordPass("Exactly budget matching sessions do not cause truncation");
  }

  // ---------------------------------------------------------------------------
  // Test 5: Phone-number changes remove the old index entry and add the new one
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const phoneOld = "+919999900001";
    const phoneNew = "+919999900002";

    const s = createVoiceBookingSession(phoneOld, "en");
    s.id = "vbs_phone_change_test";
    await repo.save(s);

    assert.strictEqual(repo.getIndexedSessionCount(phoneOld), 1);
    assert.strictEqual(repo.getIndexedSessionCount(phoneNew), 0);

    // Update session with new phone number
    s.phoneNumber = phoneNew;
    await repo.save(s, 1);

    assert.strictEqual(repo.getIndexedSessionCount(phoneOld), 0);
    assert.strictEqual(repo.getIndexedSessionCount(phoneNew), 1);

    const oldResult = await repo.getByPhoneNumber(phoneOld);
    const newResult = await repo.getByPhoneNumber(phoneNew);

    assert.strictEqual(oldResult, null, "Old phone index must return null");
    assert.strictEqual(newResult?.id, "vbs_phone_change_test");

    recordPass("Phone-number changes remove old index entry and add new one");
  }

  // ---------------------------------------------------------------------------
  // Test 6: Deletion removes the index entry
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const phoneDel = "+919888800001";

    const s = createVoiceBookingSession(phoneDel, "en");
    s.id = "vbs_delete_test";
    await repo.save(s);

    assert.strictEqual(repo.getIndexedSessionCount(phoneDel), 1);

    const deleted = repo.deleteSession("vbs_delete_test");
    assert.strictEqual(deleted, true);

    assert.strictEqual(repo.getIndexedSessionCount(phoneDel), 0);
    assert.strictEqual(await repo.getByPhoneNumber(phoneDel), null);

    recordPass("Deletion removes index entry and clears empty phone set");
  }

  // ---------------------------------------------------------------------------
  // Test 7: Clear removes all index entries
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();

    const s1 = createVoiceBookingSession("+919000011111", "en");
    const s2 = createVoiceBookingSession("+919000022222", "en");
    await repo.save(s1);
    await repo.save(s2);

    assert.strictEqual(repo.getIndexedPhoneCount(), 2);

    repo.clear();

    assert.strictEqual(repo.getIndexedPhoneCount(), 0);
    assert.strictEqual(await repo.getByPhoneNumber("+919000011111"), null);
    assert.strictEqual(await repo.getByPhoneNumber("+919000022222"), null);

    recordPass("Clear removes all sessions and index entries");
  }

  // ---------------------------------------------------------------------------
  // Test 8: Updating session without changing phone number does not duplicate index entry
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const phoneNoDup = "+919777700001";

    const s = createVoiceBookingSession(phoneNoDup, "en");
    s.id = "vbs_no_dup_test";
    await repo.save(s);

    assert.strictEqual(repo.getIndexedSessionCount(phoneNoDup), 1);

    // Save update at revision 1
    s.state = "collecting_requirements";
    await repo.save(s, 1);
    assert.strictEqual(repo.getIndexedSessionCount(phoneNoDup), 1);

    // Save update at revision 2
    s.state = "details_collected";
    await repo.save(s, 2);
    assert.strictEqual(repo.getIndexedSessionCount(phoneNoDup), 1);

    recordPass("Updating session without changing phone does not duplicate index entry");
  }

  // ---------------------------------------------------------------------------
  // Test 9: Malformed matching sessions still fail closed
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const phoneCorrupt = "+919666600001";

    const s = {
      ...createVoiceBookingSession(phoneCorrupt, "en"),
      id: "vbs_malformed_match",
      createdAt: "INVALID_UTC_STAMP",
    };
    (repo as unknown as { sessions: Map<string, unknown> }).sessions.set(s.id, s);

    await assert.rejects(
      async () => repo.getByPhoneNumber(phoneCorrupt),
      (err: unknown) => {
        return (
          err instanceof VoiceSessionLookupIntegrityError &&
          err.documentId === "vbs_malformed_match" &&
          err.reason.includes("createdAt")
        );
      }
    );

    recordPass("Malformed matching sessions trigger fail-closed VoiceSessionLookupIntegrityError");
  }

  // ---------------------------------------------------------------------------
  // Test 10: Malformed unrelated sessions do not break lookup for another phone number
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const phoneClean = "+919555500001";
    const phoneBad = "+919555500002";

    // 1. Add valid session for phoneClean
    const cleanSession = createVoiceBookingSession(phoneClean, "en");
    cleanSession.id = "vbs_clean_session";
    cleanSession.createdAt = "2026-11-01T15:00:00.000Z";
    cleanSession.updatedAt = cleanSession.createdAt;
    await repo.save(cleanSession);

    // 2. Add malformed session for phoneBad
    const badSession = {
      ...createVoiceBookingSession(phoneBad, "en"),
      id: "vbs_bad_session",
      createdAt: "CORRUPTED_NON_UTC",
    };
    (repo as unknown as { sessions: Map<string, unknown> }).sessions.set(badSession.id, badSession);

    // Query for phoneClean must SUCCEED, completely unperturbed by phoneBad's corruption!
    const cleanResult = await repo.getByPhoneNumber(phoneClean);
    assert(cleanResult !== null);
    assert.strictEqual(cleanResult.id, "vbs_clean_session");

    // But query for phoneBad must FAIL CLOSED
    await assert.rejects(
      async () => repo.getByPhoneNumber(phoneBad),
      VoiceSessionLookupIntegrityError
    );

    recordPass("Malformed unrelated sessions do not break lookup for another phone number");
  }

  // ---------------------------------------------------------------------------
  // Test 11: activeOnly still returns latest eligible session
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const phoneActive = "+919444400001";

    const activeS = createVoiceBookingSession(phoneActive, "en");
    activeS.id = "vbs_act_older";
    activeS.state = "collecting_requirements";
    activeS.createdAt = "2026-11-01T16:00:00.000Z";
    activeS.updatedAt = activeS.createdAt;
    await repo.save(activeS);

    const termS = createVoiceBookingSession(phoneActive, "en");
    termS.id = "vbs_act_newer_term";
    termS.state = "booking_confirmed";
    termS.createdAt = "2026-11-01T16:30:00.000Z";
    termS.updatedAt = termS.createdAt;
    termS.staffApprovalAudit = {
      approvedAt: "2026-11-01T16:30:00.000Z",
      staffIdentity: "staff_barista_1",
      staffRole: "barista",
      staffApprovalId: "appr_4444",
      sessionId: "vbs_act_newer_term",
    };
    await repo.save(termS);

    const activeResult = await repo.getByPhoneNumber(phoneActive, { activeOnly: true });
    assert(activeResult !== null);
    assert.strictEqual(activeResult.id, "vbs_act_older");

    recordPass("activeOnly still returns latest eligible session");
  }

  // ---------------------------------------------------------------------------
  // Test 12: Invalid budgets still cause zero candidate inspections
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const s = createVoiceBookingSession(targetPhone, "en");
    await repo.save(s);

    const invalidBudgets = [NaN, Infinity, -Infinity, 0, -5, 12.5, null, "50", 501];
    for (const inv of invalidBudgets) {
      repo.lastScanInspectedCount = 0;
      await assert.rejects(
        async () => repo.getByPhoneNumber(targetPhone, { maxScanBudget: inv as number }),
        InvalidSessionLookupBudgetError
      );
      assert.strictEqual(repo.lastScanInspectedCount, 0);
    }

    recordPass("Invalid budgets cause zero candidate inspections");
  }

  // ---------------------------------------------------------------------------
  // Test 13: Index consistency verified after create, update, phone change, delete, and clear
  // ---------------------------------------------------------------------------
  {
    const repo = new InMemoryVoiceSessionRepository();
    const p1 = "+919333300001";
    const p2 = "+919333300002";

    // Create
    const s1 = createVoiceBookingSession(p1, "en");
    s1.id = "vbs_consist_1";
    await repo.save(s1);
    assert.strictEqual(repo.getIndexedSessionCount(p1), 1);

    // Update non-phone
    s1.state = "details_collected";
    await repo.save(s1, 1);
    assert.strictEqual(repo.getIndexedSessionCount(p1), 1);

    // Phone change
    s1.phoneNumber = p2;
    await repo.save(s1, 2);
    assert.strictEqual(repo.getIndexedSessionCount(p1), 0);
    assert.strictEqual(repo.getIndexedSessionCount(p2), 1);

    // Delete
    repo.deleteSession("vbs_consist_1");
    assert.strictEqual(repo.getIndexedSessionCount(p2), 0);
    assert.strictEqual(repo.getIndexedPhoneCount(), 0);

    // Multiple adds then Clear
    await repo.save(createVoiceBookingSession(p1, "en"));
    await repo.save(createVoiceBookingSession(p2, "en"));
    assert.strictEqual(repo.getIndexedPhoneCount(), 2);
    repo.clear();
    assert.strictEqual(repo.getIndexedPhoneCount(), 0);

    recordPass("Index consistency verified through create, update, phone change, delete, and clear");
  }

  // ---------------------------------------------------------------------------
  // Test 14: InMemory and Firestore lookup contract parity
  // ---------------------------------------------------------------------------
  {
    const store = new MockFirestoreStore();
    const fsRepo = new FirestoreVoiceSessionRepository(createMockFirestore(store));
    const memRepo = new InMemoryVoiceSessionRepository();

    const pParity = "+919222200001";
    for (let i = 1; i <= 3; i++) {
      const s = createVoiceBookingSession(pParity, "en");
      s.id = `parity_p8_${i}`;
      s.createdAt = `2026-11-01T18:0${i}:00.000Z`;
      s.updatedAt = s.createdAt;
      await fsRepo.save(s);
      await memRepo.save(s);
    }

    // Parity lookup
    const fsRes = await fsRepo.getByPhoneNumber(pParity, { maxScanBudget: 10 });
    const memRes = await memRepo.getByPhoneNumber(pParity, { maxScanBudget: 10 });
    assert.strictEqual(fsRes?.id, memRes?.id);
    assert.strictEqual(fsRes?.createdAt, memRes?.createdAt);

    // Truncation parity
    let fsTrunc: unknown = null;
    let memTrunc: unknown = null;
    try {
      await fsRepo.getByPhoneNumber(pParity, { maxScanBudget: 2 });
    } catch (e) {
      fsTrunc = e;
    }
    try {
      await memRepo.getByPhoneNumber(pParity, { maxScanBudget: 2 });
    } catch (e) {
      memTrunc = e;
    }
    assert(fsTrunc instanceof IncompleteSessionLookupError);
    assert(memTrunc instanceof IncompleteSessionLookupError);
    assert.strictEqual((fsTrunc as IncompleteSessionLookupError).scannedCount, 2);
    assert.strictEqual((memTrunc as IncompleteSessionLookupError).scannedCount, 2);

    recordPass("100% Contract parity maintained between InMemory and Firestore repositories");
  }

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.1.8 Verification Complete: ${passed}/${total} Tests Passed`);
  console.log("===============================================================================\n");
}

runPhase6318Tests().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
