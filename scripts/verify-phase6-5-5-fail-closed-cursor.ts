/**
 * BREW Coffee Platform — Phase 6.5.5 Verification Suite
 * Fail-Closed Distributed Cursor & Mock Fallback Controls
 *
 * Verifies:
 * 1. Production fail-closed behavior: transient Firestore transaction errors on _rotation_cursor
 *    propagate directly instead of silently falling back to instance-local rotation.
 * 2. Unsupported test mocks: missing doc() or runTransaction() reject in production,
 *    and succeed only when explicitly configured with { allowLocalFallback: true }.
 * 3. Successful multi-instance rotation in full production configuration (allowLocalFallback: false).
 */

process.env.CRON_SECRET = "test_cron_secret_655_auth_token_48chars_secure!";
process.env.APP_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.BUSINESS_PHONE = "+919876543210";
process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import {
  FirestoreCommunicationOutboxRepository,
  OutboxWorker,
  CommunicationDeliveryRecord,
  MockVoiceProvider,
  MockWhatsAppProvider,
} from "../src/lib/communication";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { InMemoryConsentRepository } from "../src/lib/communication/repositories/consentRepository";
import { InMemoryDndRepository } from "../src/lib/communication/repositories/dndRepository";

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
    process.exitCode = 1;
  }
}

function createDeliveryFixture(
  id: string,
  status: "pending" | "processing" | "failed",
  options: {
    leaseExpiresAt?: string | null;
    nextRetryAt?: string | null;
    attemptCount?: number;
    claimOwner?: string | null;
    claimToken?: string | null;
    claimedAt?: string | null;
  } = {}
): CommunicationDeliveryRecord {
  return {
    id,
    eventId: `evt_${id}`,
    sessionId: `session_${id}`,
    channel: "whatsapp",
    purpose: "transactional_update",
    eventType: "booking_confirmed",
    phoneNumberMasked: "+91 98*** ***10",
    status,
    attemptCount: options.attemptCount ?? (status === "failed" ? 1 : status === "processing" ? 1 : 0),
    maxAttempts: 3,
    claimOwner: options.claimOwner !== undefined ? options.claimOwner : status === "processing" ? "owner_prior" : null,
    claimToken: options.claimToken !== undefined ? options.claimToken : status === "processing" ? "tok_prior" : null,
    claimedAt: options.claimedAt !== undefined ? options.claimedAt : status === "processing" ? new Date().toISOString() : null,
    leaseExpiresAt: options.leaseExpiresAt !== undefined ? options.leaseExpiresAt : null,
    nextRetryAt: options.nextRetryAt !== undefined ? options.nextRetryAt : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createSharedMockFirestore(initialRecords: CommunicationDeliveryRecord[] = []) {
  const docDataStore = new Map<string, CommunicationDeliveryRecord>();
  for (const r of initialRecords) {
    docDataStore.set(r.id, JSON.parse(JSON.stringify(r)));
  }

  let sharedCursorDoc: { cursor: number; updatedAt: string } | null = null;
  const claimedDeliveryIds = new Set<string>();
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
          const item = docDataStore.get(docId);
          return {
            exists: Boolean(item),
            data: () => (item ? { ...item } : undefined),
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
          docDataStore.set(docId, (options?.merge ? { ...prev, ...newData } : { ...newData }) as unknown as CommunicationDeliveryRecord);
        },
      }),
      where: (field1: string, _op1: string, val1: unknown) => ({
        where: (field2: string, _op2?: string, val2?: unknown) => ({
          limit: (lim: number) => ({
            get: async () => {
              const matches: Array<{ id: string; ref: { id: string }; data: () => Record<string, unknown> }> = [];
              for (const [id, rec] of docDataStore.entries()) {
                if (claimedDeliveryIds.has(id)) continue;
                if (field1 === "status" && rec.status === val1) {
                  if (field2 === "leaseExpiresAt" && rec.leaseExpiresAt && (!val2 || rec.leaseExpiresAt <= (val2 as string))) {
                    matches.push({ id, ref: { id }, data: () => ({ ...rec }) });
                  } else if (field2 === "nextRetryAt" && rec.nextRetryAt && (!val2 || rec.nextRetryAt <= (val2 as string))) {
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
      const executeTx = async (): Promise<T> => {
        const stageWrites = new Map<string, { data: unknown; merge?: boolean }>();

        const transaction = {
          get: async (docRef: { id: string }) => {
            if (docRef.id === "_rotation_cursor") {
              return {
                exists: sharedCursorDoc !== null,
                data: () => (sharedCursorDoc ? { ...sharedCursorDoc } : undefined),
              };
            }
            const item = docDataStore.get(docRef.id);
            return {
              exists: Boolean(item),
              data: () => (item ? { ...item } : undefined),
            };
          },
          set: (docRef: { id: string }, data: unknown, options?: { merge?: boolean }) => {
            stageWrites.set(docRef.id, { data, merge: options?.merge });
          },
        };

        const result = await updateFn(transaction);

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
            docDataStore.set(docId, (merge ? { ...prev, ...payload } : { ...payload }) as unknown as CommunicationDeliveryRecord);
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
    db: db as unknown as FirebaseFirestore.Firestore,
    getStore: () => docDataStore,
  };
}

function createIncompleteMockDb(docs: CommunicationDeliveryRecord[] = []) {
  return {
    collection: () => ({
      where: (field1: string, _op1: string, val1: unknown) => ({
        where: () => ({
          limit: (lim: number) => ({
            get: async () => ({
              docs: docs
                .filter((d) => d.status === val1)
                .slice(0, lim)
                .map((d) => ({
                  id: d.id,
                  ref: { id: d.id },
                  data: () => ({ ...d }),
                })),
            }),
          }),
        }),
        limit: (lim: number) => ({
          get: async () => ({
            docs: docs
              .filter((d) => d.status === val1)
              .slice(0, lim)
              .map((d) => ({
                id: d.id,
                ref: { id: d.id },
                data: () => ({ ...d }),
              })),
          }),
        }),
      }),
      // Intentionally omits doc() to simulate an unsupported mock for _rotation_cursor
    }),
    runTransaction: async <T>(updateFn: (transaction: unknown) => Promise<T>): Promise<T> => {
      const transaction = {
        get: async (ref: { id: string }) => {
          const found = docs.find((d) => d.id === ref.id);
          return {
            exists: Boolean(found),
            data: () => (found ? { ...found } : undefined),
          };
        },
        set: () => {},
      };
      return await updateFn(transaction);
    },
  };
}

async function runSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.5.5 Verification Suite");
  console.log("   Fail-Closed Distributed Cursor & Mock Fallback Controls");
  console.log("================================================================================\n");

  const now = new Date("2026-11-06T19:00:00.000Z");
  const pastIso = "2026-11-06T18:50:00.000Z";

  // ---------------------------------------------------------------------------
  // 1. TRANSIENT FIRESTORE TRANSACTION FAILURE (FAIL-CLOSED IN PRODUCTION)
  // ---------------------------------------------------------------------------
  console.log("--- 1. TRANSIENT FIRESTORE TRANSACTION FAILURE (FAIL-CLOSED) ---");

  await test("1.1 In production mode (default allowLocalFallback=false), transient transaction error rejects", async () => {
    const expired = createDeliveryFixture("del_fail_exp_1", "processing", { leaseExpiresAt: pastIso });
    const retry = createDeliveryFixture("del_fail_ret_1", "failed", { nextRetryAt: pastIso });
    const pending = createDeliveryFixture("del_fail_pend_1", "pending");

    const { db } = createSharedMockFirestore([expired, retry, pending]);

    // Override runTransaction to simulate transient Firestore contention / connection drop
    (db as unknown as { runTransaction: unknown }).runTransaction = async () => {
      throw new Error("10 ABORTED: Transaction lock contention / write conflict in Firestore");
    };

    const repo = new FirestoreCommunicationOutboxRepository(undefined, () => db);
    assert.strictEqual(repo.isLocalFallbackAllowed(), false, "Default allowLocalFallback must be false");

    // Must NOT silently swallow error and must NOT fall back to local rotation!
    await assert.rejects(
      async () => {
        await repo.claimEligibleDeliveries("failing_worker", 60000, 1, now);
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("[OUTBOX_ROTATION_TRANSACTION_FAILED]"),
          `Error must identify rotation transaction failure: ${err.message}`
        );
        assert.ok(
          err.message.includes("10 ABORTED"),
          `Error message must include underlying cause: ${err.message}`
        );
        return true;
      },
      "Must reject with OUTBOX_ROTATION_TRANSACTION_FAILED on transient transaction error"
    );
  });

  await test("1.2 Worker processCycle propagates rotation transaction failure instead of dispatching compromised deliveries", async () => {
    const expired = createDeliveryFixture("del_wfail_exp_1", "processing", { leaseExpiresAt: pastIso });
    const { db } = createSharedMockFirestore([expired]);

    (db as unknown as { runTransaction: unknown }).runTransaction = async () => {
      throw new Error("14 UNAVAILABLE: Firestore backend unavailable");
    };

    const repo = new FirestoreCommunicationOutboxRepository(undefined, () => db);
    const worker = new OutboxWorker(
      {
        outboxRepository: repo,
        sessionRepository: new InMemoryVoiceSessionRepository(),
        consentRepository: new InMemoryConsentRepository(),
        dndRepository: new InMemoryDndRepository(),
        voiceProvider: new MockVoiceProvider(),
        whatsappProvider: new MockWhatsAppProvider(),
      },
      { batchSize: 1 }
    );

    await assert.rejects(
      async () => {
        await worker.processCycle();
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("[OUTBOX_ROTATION_TRANSACTION_FAILED]"),
          "Worker must propagate rotation failure directly to caller"
        );
        return true;
      }
    );
  });

  await test("1.3 getSharedRotationCursor and setSharedRotationCursor reject in production when Firestore fails", async () => {
    const { db } = createSharedMockFirestore([]);
    (db as unknown as { collection: unknown }).collection = () => {
      throw new Error("5 NOT_FOUND: Database not found");
    };

    const repo = new FirestoreCommunicationOutboxRepository(undefined, () => db);
    assert.strictEqual(repo.isLocalFallbackAllowed(), false);

    await assert.rejects(async () => {
      await repo.getSharedRotationCursor();
    }, /OUTBOX_ROTATION_ERROR/);

    await assert.rejects(async () => {
      await repo.setSharedRotationCursor(1);
    }, /OUTBOX_ROTATION_ERROR/);
  });

  // ---------------------------------------------------------------------------
  // 2. UNSUPPORTED TEST MOCKS (EXPLICIT LOCAL FALLBACK)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. UNSUPPORTED TEST MOCKS (EXPLICIT LOCAL FALLBACK) ---");

  await test("2.1 Unsupported test mock without doc() or runTransaction() rejects when allowLocalFallback=false", async () => {
    const incompleteMockDb = createIncompleteMockDb([]);

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      () => incompleteMockDb as unknown as FirebaseFirestore.Firestore
    );

    await assert.rejects(
      async () => {
        await repo.claimEligibleDeliveries("mock_worker", 60000, 1, now);
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("[OUTBOX_ROTATION_UNSUPPORTED_MOCK]"),
          `Error must identify unsupported mock: ${err.message}`
        );
        return true;
      }
    );
  });

  await test("2.2 Unsupported test mock succeeds using local fallback when { allowLocalFallback: true } is configured", async () => {
    const pendingDoc = createDeliveryFixture("del_fallback_pend_1", "pending");
    const incompleteMockDb = createIncompleteMockDb([pendingDoc]);

    // Explicit test/mock configuration via constructor options
    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      () => incompleteMockDb as unknown as FirebaseFirestore.Firestore,
      { allowLocalFallback: true }
    );

    assert.strictEqual(repo.isLocalFallbackAllowed(), true);

    // Call 1: claims using local rotation without throwing
    const claim1 = await repo.claimEligibleDeliveries("fallback_worker", 60000, 1, now);
    assert.strictEqual(claim1.length, 1);
    assert.strictEqual(claim1[0].id, "del_fallback_pend_1");
  });

  await test("2.3 repo.setAllowLocalFallback(true) dynamically enables local fallback on existing instance", async () => {
    const incompleteMockDb = createIncompleteMockDb([]);

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      () => incompleteMockDb as unknown as FirebaseFirestore.Firestore
    );

    // Rejects initially
    await assert.rejects(async () => {
      await repo.claimEligibleDeliveries("dyn_worker", 60000, 1, now);
    }, /OUTBOX_ROTATION_UNSUPPORTED_MOCK/);

    // Enable fallback explicitly
    repo.setAllowLocalFallback(true);
    assert.strictEqual(repo.isLocalFallbackAllowed(), true);

    // Now succeeds
    const claim = await repo.claimEligibleDeliveries("dyn_worker", 60000, 1, now);
    assert.strictEqual(claim.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 3. SUCCESSFUL MULTI-INSTANCE ROTATION (PRODUCTION CONFIGURATION)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. SUCCESSFUL MULTI-INSTANCE ROTATION IN PRODUCTION CONFIG ---");

  await test("3.1 Two independent repositories with allowLocalFallback=false alternate candidate groups on batchSize=1", async () => {
    const expiredDocs = [
      createDeliveryFixture("del_p_exp_1", "processing", { leaseExpiresAt: pastIso }),
      createDeliveryFixture("del_p_exp_2", "processing", { leaseExpiresAt: pastIso }),
    ];
    const retryDocs = [
      createDeliveryFixture("del_p_ret_1", "failed", { nextRetryAt: pastIso }),
      createDeliveryFixture("del_p_ret_2", "failed", { nextRetryAt: pastIso }),
    ];
    const pendingDocs = [
      createDeliveryFixture("del_p_pend_1", "pending"),
      createDeliveryFixture("del_p_pend_2", "pending"),
    ];

    const { db } = createSharedMockFirestore([...expiredDocs, ...retryDocs, ...pendingDocs]);

    // Both instances configured strictly as production (allowLocalFallback: false)
    const repoA = new FirestoreCommunicationOutboxRepository(undefined, () => db);
    const repoB = new FirestoreCommunicationOutboxRepository(undefined, () => db);

    assert.strictEqual(repoA.isLocalFallbackAllowed(), false);
    assert.strictEqual(repoB.isLocalFallbackAllowed(), false);

    // Cycle 1: repoA claims Group 0 (expired)
    const c1 = await repoA.claimEligibleDeliveries("worker_A", 60000, 1, now);
    assert.strictEqual(c1.length, 1);
    assert.strictEqual(c1[0].id, "del_p_exp_1", "Cycle 1 must claim expired lease");

    // Cycle 2: repoB claims Group 1 (due retry)
    const c2 = await repoB.claimEligibleDeliveries("worker_B", 60000, 1, now);
    assert.strictEqual(c2.length, 1);
    assert.strictEqual(c2[0].id, "del_p_ret_1", "Cycle 2 must claim due retry");

    // Cycle 3: repoA claims Group 2 (pending)
    const c3 = await repoA.claimEligibleDeliveries("worker_A", 60000, 1, now);
    assert.strictEqual(c3.length, 1);
    assert.strictEqual(c3[0].id, "del_p_pend_1", "Cycle 3 must claim pending delivery");

    // Cycle 4: repoB wraps around to Group 0 (expired)
    const c4 = await repoB.claimEligibleDeliveries("worker_B", 60000, 1, now);
    assert.strictEqual(c4.length, 1);
    assert.strictEqual(c4[0].id, "del_p_exp_2", "Cycle 4 must wrap to expired lease");
  });

  await test("3.2 Concurrent workers advance shared cursor atomically without losing state", async () => {
    const expired = createDeliveryFixture("del_conc_exp_1", "processing", { leaseExpiresAt: pastIso });
    const retry = createDeliveryFixture("del_conc_ret_1", "failed", { nextRetryAt: pastIso });

    const { db } = createSharedMockFirestore([expired, retry]);

    const repo1 = new FirestoreCommunicationOutboxRepository(undefined, () => db);
    const repo2 = new FirestoreCommunicationOutboxRepository(undefined, () => db);

    // Execute concurrently
    const [claim1, claim2] = await Promise.all([
      repo1.claimEligibleDeliveries("worker_conc_1", 60000, 1, now),
      repo2.claimEligibleDeliveries("worker_conc_2", 60000, 1, now),
    ]);

    assert.strictEqual(claim1.length, 1);
    assert.strictEqual(claim2.length, 1);

    // Each must have claimed a distinct candidate group
    const claimedIds = new Set([claim1[0].id, claim2[0].id]);
    assert.ok(claimedIds.has("del_conc_exp_1"), "Must claim expired lease");
    assert.ok(claimedIds.has("del_conc_ret_1"), "Must claim due retry");

    // Shared cursor must be advanced twice (from 0 to 2)
    const finalCursor = await repo1.getSharedRotationCursor();
    assert.strictEqual(finalCursor, 2, "Shared cursor must advance twice under concurrent claims");
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.5.5 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exitCode = 1;
  }
}

runSuite().catch((err) => {
  console.error("Unhandled fatal verification error:", err);
  process.exitCode = 1;
});
