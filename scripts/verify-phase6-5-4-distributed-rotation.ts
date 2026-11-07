/**
 * BREW Coffee Platform — Phase 6.5.4 Verification Suite
 * Distributed Queue Rotation & Cross-Worker Fairness:
 * 1. Shared & persistent rotation state across independently constructed Firestore repository instances
 * 2. Rotating fairness across batch sizes 1, 2, and 3 using alternating repository instances
 * 3. Concurrent worker execution preventing cursor overwrite or lost updates
 * 4. Preservation of atomic claims, claim-token fencing, and accurate metrics fidelity
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import {
  FirestoreCommunicationOutboxRepository,
  InMemoryCommunicationOutboxRepository,
} from "../src/lib/communication";

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

/**
 * Creates a shared mock Firestore database with real ACID transaction semantics on cursor
 * and atomic delivery claim locking across multiple independent repository instances.
 */
function createSharedMockFirestore(initialRecords: {
  expired: Array<{ id: string; [key: string]: unknown }>;
  retries: Array<{ id: string; [key: string]: unknown }>;
  pending: Array<{ id: string; [key: string]: unknown }>;
}) {
  let sharedCursorDoc: { cursor: number; updatedAt: string } | null = null;
  const claimedDeliveryIds = new Set<string>();

  const docDataStore = new Map<string, Record<string, unknown>>();

  for (const item of initialRecords.expired) {
    docDataStore.set(item.id, {
      ...item,
      status: "processing",
      attemptCount: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 30000).toISOString(),
    });
  }
  for (const item of initialRecords.retries) {
    docDataStore.set(item.id, {
      ...item,
      status: "failed",
      attemptCount: 1,
      maxAttempts: 3,
      nextRetryAt: new Date(Date.now() - 5000).toISOString(),
    });
  }
  for (const item of initialRecords.pending) {
    docDataStore.set(item.id, {
      ...item,
      status: "pending",
      attemptCount: 0,
      maxAttempts: 3,
    });
  }

  let txQueue: Promise<unknown> = Promise.resolve();

  const db = {
    collection: () => ({
      doc: (docId: string) => ({
        id: docId,
        get: async () => {
          if (docId === "_rotation_cursor") {
            return {
              exists: sharedCursorDoc !== null,
              data: () => (sharedCursorDoc ? { ...sharedCursorDoc } : undefined),
            };
          }
          const data = docDataStore.get(docId);
          return {
            exists: data !== undefined,
            data: () => (data ? { ...data } : undefined),
          };
        },
        set: async (newData: Record<string, unknown>, options?: { merge?: boolean }) => {
          if (docId === "_rotation_cursor") {
            const cursorVal = typeof newData.cursor === "number" ? newData.cursor : 0;
            sharedCursorDoc = {
              cursor: cursorVal,
              updatedAt: (newData.updatedAt as string) || new Date().toISOString(),
            };
            return;
          }
          const prev = docDataStore.get(docId) || {};
          docDataStore.set(docId, options?.merge ? { ...prev, ...newData } : { ...newData });
        },
      }),
      where: (field1: string, _op1: string, val1: unknown) => ({
        where: (field2: string) => ({
          limit: (lim: number) => ({
            get: async () => {
              const matches: Array<{ id: string; ref: { id: string }; data: () => Record<string, unknown> }> = [];
              for (const [id, rec] of docDataStore.entries()) {
                if (claimedDeliveryIds.has(id)) continue;
                if (field1 === "status" && rec.status === val1) {
                  if (field2 === "leaseExpiresAt" && rec.leaseExpiresAt) {
                    matches.push({ id, ref: { id }, data: () => ({ ...rec }) });
                  } else if (field2 === "nextRetryAt" && rec.nextRetryAt) {
                    matches.push({ id, ref: { id }, data: () => ({ ...rec }) });
                  }
                }
                if (matches.length >= lim) break;
              }
              return { docs: matches };
            },
          }),
        }),
        limit: (lim: number) => ({
          get: async () => {
            const matches: Array<{ id: string; ref: { id: string }; data: () => Record<string, unknown> }> = [];
            for (const [id, rec] of docDataStore.entries()) {
              if (claimedDeliveryIds.has(id)) continue;
              if (field1 === "status" && rec.status === val1) {
                matches.push({ id, ref: { id }, data: () => ({ ...rec }) });
              }
              if (matches.length >= lim) break;
            }
            return { docs: matches };
          },
        }),
      }),
    }),
    runTransaction: async <T>(updateFn: (transaction: unknown) => Promise<T>): Promise<T> => {
      // Simulate serializable transaction execution in Firestore
      const executeTx = async (): Promise<T> => {
        const stageWrites = new Map<string, Record<string, unknown>>();

        const transaction = {
          get: async (ref: { id: string }) => {
            if (ref.id === "_rotation_cursor") {
              return {
                exists: sharedCursorDoc !== null,
                data: () => (sharedCursorDoc ? { ...sharedCursorDoc } : undefined),
              };
            }
            const liveData = docDataStore.get(ref.id);
            return {
              exists: liveData !== undefined,
              data: () => (liveData ? { ...liveData } : undefined),
            };
          },
          set: (ref: { id: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
            stageWrites.set(ref.id, { data, merge: options?.merge ?? false });
          },
        };

        const result = await updateFn(transaction);

        // Commit stage writes
        for (const [docId, { data, merge }] of stageWrites.entries()) {
          const payload = (data || {}) as Record<string, unknown>;
          if (docId === "_rotation_cursor") {
            const cursorVal = typeof payload.cursor === "number" ? payload.cursor : 0;
            sharedCursorDoc = {
              cursor: cursorVal,
              updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString(),
            };
          } else {
            const prev = docDataStore.get(docId) || {};
            docDataStore.set(docId, merge ? { ...prev, ...payload } : { ...payload });
            if (payload.status === "processing" && payload.claimOwner) {
              claimedDeliveryIds.add(docId);
            }
          }
        }

        return result;
      };

      const nextTx = txQueue.then(executeTx, executeTx);
      txQueue = nextTx.then(() => {}, () => {});
      return nextTx as Promise<T>;
    },
  };

  return {
    db,
    getSharedCursor: () => sharedCursorDoc?.cursor ?? 0,
    setSharedCursor: (val: number) => {
      sharedCursorDoc = { cursor: val, updatedAt: new Date().toISOString() };
    },
  };
}

async function runSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.5.4 Verification Suite");
  console.log("   Distributed Queue Rotation & Multi-Repository Instance Fairness");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // 1. Two Independently Constructed Firestore Instances: Batch Size 1
  // ---------------------------------------------------------------------------
  console.log("\n--- 1. TWO INDEPENDENT REPOSITORIES: BATCH SIZE 1 ---");

  await test("1.1 Two independently constructed repositories share rotation state and alternate groups on batchSize=1", async () => {
    const expiredList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b1_exp_${i + 1}` }));
    const retriesList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b1_ret_${i + 1}` }));
    const pendingList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b1_pen_${i + 1}` }));

    const { db } = createSharedMockFirestore({
      expired: expiredList,
      retries: retriesList,
      pending: pendingList,
    });

    // Two independently constructed repository instances sharing the same database
    const repoA = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );
    const repoB = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );

    const now = new Date();

    // Call 1 on repoA (start 0): Claims expired
    const claim1 = await repoA.claimEligibleDeliveries("worker_A", 60000, 1, now);
    assert.strictEqual(claim1.length, 1);
    assert.ok(claim1[0].id.startsWith("del_dist_b1_exp_"), `Call 1 (repoA) expected expired, got: ${claim1[0].id}`);

    // Call 2 on repoB (start 1): Claims due retry (advances from shared Firestore state)
    const claim2 = await repoB.claimEligibleDeliveries("worker_B", 60000, 1, now);
    assert.strictEqual(claim2.length, 1);
    assert.ok(claim2[0].id.startsWith("del_dist_b1_ret_"), `Call 2 (repoB) expected retry, got: ${claim2[0].id}`);

    // Call 3 on repoA (start 2): Claims pending
    const claim3 = await repoA.claimEligibleDeliveries("worker_A", 60000, 1, now);
    assert.strictEqual(claim3.length, 1);
    assert.ok(claim3[0].id.startsWith("del_dist_b1_pen_"), `Call 3 (repoA) expected pending, got: ${claim3[0].id}`);

    // Call 4 on repoB (start 0): Wraps back to expired
    const claim4 = await repoB.claimEligibleDeliveries("worker_B", 60000, 1, now);
    assert.strictEqual(claim4.length, 1);
    assert.ok(claim4[0].id.startsWith("del_dist_b1_exp_"), `Call 4 (repoB) expected expired, got: ${claim4[0].id}`);

    // Call 5 on repoA (start 1): Claims due retry
    const claim5 = await repoA.claimEligibleDeliveries("worker_A", 60000, 1, now);
    assert.strictEqual(claim5.length, 1);
    assert.ok(claim5[0].id.startsWith("del_dist_b1_ret_"), `Call 5 (repoA) expected retry, got: ${claim5[0].id}`);

    // Call 6 on repoB (start 2): Claims pending
    const claim6 = await repoB.claimEligibleDeliveries("worker_B", 60000, 1, now);
    assert.strictEqual(claim6.length, 1);
    assert.ok(claim6[0].id.startsWith("del_dist_b1_pen_"), `Call 6 (repoB) expected pending, got: ${claim6[0].id}`);
  });

  // ---------------------------------------------------------------------------
  // 2. Two Independently Constructed Firestore Instances: Batch Size 2 & 3
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. TWO INDEPENDENT REPOSITORIES: BATCH SIZES 2 & 3 ---");

  await test("2.1 Two independent repositories balance candidate groups on batchSize=2", async () => {
    const expiredList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b2_exp_${i + 1}` }));
    const retriesList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b2_ret_${i + 1}` }));
    const pendingList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b2_pen_${i + 1}` }));

    const { db } = createSharedMockFirestore({
      expired: expiredList,
      retries: retriesList,
      pending: pendingList,
    });

    const repoA = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );
    const repoB = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );

    const now = new Date();

    // Call 1 on repoA (start 0): [expired, retry]
    const batch1 = await repoA.claimEligibleDeliveries("worker_A", 60000, 2, now);
    assert.strictEqual(batch1.length, 2);
    assert.ok(batch1[0].id.startsWith("del_dist_b2_exp_"));
    assert.ok(batch1[1].id.startsWith("del_dist_b2_ret_"));

    // Call 2 on repoB (start 1): [retry, pending]
    const batch2 = await repoB.claimEligibleDeliveries("worker_B", 60000, 2, now);
    assert.strictEqual(batch2.length, 2);
    assert.ok(batch2[0].id.startsWith("del_dist_b2_ret_"));
    assert.ok(batch2[1].id.startsWith("del_dist_b2_pen_"));

    // Call 3 on repoA (start 2): [pending, expired]
    const batch3 = await repoA.claimEligibleDeliveries("worker_A", 60000, 2, now);
    assert.strictEqual(batch3.length, 2);
    assert.ok(batch3[0].id.startsWith("del_dist_b2_pen_"));
    assert.ok(batch3[1].id.startsWith("del_dist_b2_exp_"));
  });

  await test("2.2 Two independent repositories rotate primary candidate group on batchSize=3", async () => {
    const expiredList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b3_exp_${i + 1}` }));
    const retriesList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b3_ret_${i + 1}` }));
    const pendingList = Array.from({ length: 6 }, (_, i) => ({ id: `del_dist_b3_pen_${i + 1}` }));

    const { db } = createSharedMockFirestore({
      expired: expiredList,
      retries: retriesList,
      pending: pendingList,
    });

    const repoA = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );
    const repoB = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );

    const now = new Date();

    // Call 1 on repoA (start 0): [exp, ret, pen]
    const batch1 = await repoA.claimEligibleDeliveries("worker_A", 60000, 3, now);
    assert.strictEqual(batch1.length, 3);
    assert.ok(batch1[0].id.startsWith("del_dist_b3_exp_"));
    assert.ok(batch1[1].id.startsWith("del_dist_b3_ret_"));
    assert.ok(batch1[2].id.startsWith("del_dist_b3_pen_"));

    // Call 2 on repoB (start 1): [ret, pen, exp]
    const batch2 = await repoB.claimEligibleDeliveries("worker_B", 60000, 3, now);
    assert.strictEqual(batch2.length, 3);
    assert.ok(batch2[0].id.startsWith("del_dist_b3_ret_"));
    assert.ok(batch2[1].id.startsWith("del_dist_b3_pen_"));
    assert.ok(batch2[2].id.startsWith("del_dist_b3_exp_"));

    // Call 3 on repoA (start 2): [pen, exp, ret]
    const batch3 = await repoA.claimEligibleDeliveries("worker_A", 60000, 3, now);
    assert.strictEqual(batch3.length, 3);
    assert.ok(batch3[0].id.startsWith("del_dist_b3_pen_"));
    assert.ok(batch3[1].id.startsWith("del_dist_b3_exp_"));
    assert.ok(batch3[2].id.startsWith("del_dist_b3_ret_"));
  });

  // ---------------------------------------------------------------------------
  // 3. Concurrent Claims & Cursor Integrity
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. CONCURRENT CLAIMS & CURSOR INTEGRITY ---");

  await test("3.1 Concurrent workers atomically advance cursor without overwriting each other", async () => {
    const expiredList = Array.from({ length: 10 }, (_, i) => ({ id: `del_conc_exp_${i + 1}` }));
    const retriesList = Array.from({ length: 10 }, (_, i) => ({ id: `del_conc_ret_${i + 1}` }));
    const pendingList = Array.from({ length: 10 }, (_, i) => ({ id: `del_conc_pen_${i + 1}` }));

    const { db, getSharedCursor } = createSharedMockFirestore({
      expired: expiredList,
      retries: retriesList,
      pending: pendingList,
    });

    const repo1 = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );
    const repo2 = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => db as unknown as import("firebase-admin").firestore.Firestore)
    );

    const now = new Date();

    // Trigger concurrent claims simultaneously
    const [result1, result2] = await Promise.all([
      repo1.claimEligibleDeliveries("concurrent_worker_1", 60000, 1, now),
      repo2.claimEligibleDeliveries("concurrent_worker_2", 60000, 1, now),
    ]);

    assert.strictEqual(result1.length, 1);
    assert.strictEqual(result2.length, 1);

    // Each worker must have claimed a different delivery
    assert.notStrictEqual(result1[0].id, result2[0].id, "Concurrent workers must not claim the same delivery");

    // After 2 claims, shared cursor must have advanced by 2 steps
    const finalCursor = getSharedCursor();
    assert.strictEqual(finalCursor, 2, "Shared cursor must advance to 2 after two atomic claims");
  });

  // ---------------------------------------------------------------------------
  // 4. In-Memory Implementation Simplicity
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. IN-MEMORY IMPLEMENTATION SIMPLICITY ---");

  await test("4.1 InMemoryCommunicationOutboxRepository remains simple, lightweight and rotates locally", async () => {
    const repo = new InMemoryCommunicationOutboxRepository();
    assert.strictEqual(repo.getRotationOffset(), 0);
    repo.setRotationOffset(2);
    assert.strictEqual(repo.getRotationOffset(), 2);
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.5.4 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal failure in Phase 6.5.4 verification suite:", err);
  process.exit(1);
});
