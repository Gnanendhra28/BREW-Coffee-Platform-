/**
 * BREW Coffee Platform — Phase 6.5.3 Verification Suite
 * Final Queue Fairness & Accurate Metrics Fidelity:
 * 1. True Rotating Queue Fairness (Batch sizes 1, 2, and 3 across sustained backlogs)
 * 2. Starvation Freedom for Batch Sizes 1 & 2
 * 3. Preservation of Atomic Claims & Claim Fencing
 * 4. Accurate Metrics Fidelity (Exact Aggregate Counts + Sampled Bounded Projections)
 * 5. Overall Metrics Fidelity Cannot Overstate Accuracy
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import {
  TestInMemoryCommunicationOutboxRepository,
  seedOutboxDeliveryForTest,
} from "../src/lib/communication/outbox/testFixture";
import {
  FirestoreCommunicationOutboxRepository,
  computeOutboxMetricsFromRecords,
  CommunicationDeliveryRecord,
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

function createValidDeliveryRecord(overrides: Partial<CommunicationDeliveryRecord> = {}): CommunicationDeliveryRecord {
  const id = overrides.id || `del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    eventId: `evt_${id}`,
    sessionId: "sess_p653_default",
    officialBookingId: "enq_p653_default",
    eventType: "booking_confirmed",
    channel: "whatsapp",
    purpose: "transactional_update",
    status: "pending",
    phoneNumberMasked: "+91 ••••• •••10",
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.5.3 Verification Suite");
  console.log("   True Rotating Queue Fairness & Accurate Metrics Fidelity");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // 1. True Rotating Queue Fairness (Batch Size 1)
  // ---------------------------------------------------------------------------
  console.log("\n--- 1. TRUE ROTATING QUEUE FAIRNESS: BATCH SIZE 1 ---");

  await test("1.1 Batch size 1 rotates starting candidate group across successive batches (no permanent starvation)", async () => {
    const repo = new TestInMemoryCommunicationOutboxRepository();
    const now = new Date();
    const nowMs = now.getTime();

    // Seed sustained backlog: 5 expired leases, 5 due retries, 5 pending
    for (let i = 1; i <= 5; i++) {
      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b1_expired_${i}`,
          status: "processing",
          attemptCount: 1,
          claimOwner: "previous_worker",
          claimToken: `stale_token_${i}`,
          claimedAt: new Date(nowMs - 120000).toISOString(),
          leaseExpiresAt: new Date(nowMs - 60000).toISOString(),
        })
      );

      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b1_retry_${i}`,
          status: "failed",
          attemptCount: 1,
          nextRetryAt: new Date(nowMs - 10000).toISOString(),
          lastError: {
            code: "NETWORK_ERROR",
            message: "Temporary glitch",
            isRetryable: true,
            occurredAt: new Date(nowMs - 10000).toISOString(),
            attempt: 1,
          },
        })
      );

      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b1_pending_${i}`,
          status: "pending",
          attemptCount: 0,
        })
      );
    }

    // Successive claims with batch size 1 must rotate:
    // Batch 1 (start 0): expired lease
    // Batch 2 (start 1): due retry
    // Batch 3 (start 2): pending delivery
    // Batch 4 (start 0): expired lease
    // Batch 5 (start 1): due retry
    // Batch 6 (start 2): pending delivery

    const batch1 = await repo.claimEligibleDeliveries("worker_b1", 60000, 1, now);
    assert.strictEqual(batch1.length, 1);
    assert.ok(batch1[0].id.startsWith("del_b1_expired_"), `Batch 1 expected expired lease, got: ${batch1[0].id}`);

    const batch2 = await repo.claimEligibleDeliveries("worker_b1", 60000, 1, now);
    assert.strictEqual(batch2.length, 1);
    assert.ok(batch2[0].id.startsWith("del_b1_retry_"), `Batch 2 expected due retry, got: ${batch2[0].id}`);

    const batch3 = await repo.claimEligibleDeliveries("worker_b1", 60000, 1, now);
    assert.strictEqual(batch3.length, 1);
    assert.ok(batch3[0].id.startsWith("del_b1_pending_"), `Batch 3 expected pending, got: ${batch3[0].id}`);

    const batch4 = await repo.claimEligibleDeliveries("worker_b1", 60000, 1, now);
    assert.strictEqual(batch4.length, 1);
    assert.ok(batch4[0].id.startsWith("del_b1_expired_"), `Batch 4 expected expired lease, got: ${batch4[0].id}`);

    const batch5 = await repo.claimEligibleDeliveries("worker_b1", 60000, 1, now);
    assert.strictEqual(batch5.length, 1);
    assert.ok(batch5[0].id.startsWith("del_b1_retry_"), `Batch 5 expected due retry, got: ${batch5[0].id}`);

    const batch6 = await repo.claimEligibleDeliveries("worker_b1", 60000, 1, now);
    assert.strictEqual(batch6.length, 1);
    assert.ok(batch6[0].id.startsWith("del_b1_pending_"), `Batch 6 expected pending, got: ${batch6[0].id}`);
  });

  // ---------------------------------------------------------------------------
  // 2. True Rotating Queue Fairness (Batch Size 2)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. TRUE ROTATING QUEUE FAIRNESS: BATCH SIZE 2 ---");

  await test("2.1 Batch size 2 rotates starting candidate group across successive batches (no group starved)", async () => {
    const repo = new TestInMemoryCommunicationOutboxRepository();
    const now = new Date();
    const nowMs = now.getTime();

    // Seed 5 items in each candidate group
    for (let i = 1; i <= 5; i++) {
      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b2_expired_${i}`,
          status: "processing",
          attemptCount: 1,
          claimOwner: "previous_worker",
          claimToken: `stale_token_${i}`,
          claimedAt: new Date(nowMs - 120000).toISOString(),
          leaseExpiresAt: new Date(nowMs - 60000).toISOString(),
        })
      );

      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b2_retry_${i}`,
          status: "failed",
          attemptCount: 1,
          nextRetryAt: new Date(nowMs - 10000).toISOString(),
          lastError: {
            code: "NETWORK_ERROR",
            message: "Temporary glitch",
            isRetryable: true,
            occurredAt: new Date(nowMs - 10000).toISOString(),
            attempt: 1,
          },
        })
      );

      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b2_pending_${i}`,
          status: "pending",
          attemptCount: 0,
        })
      );
    }

    // Successive claims with batch size 2:
    // Batch 1 (start 0): [expired, retry]
    // Batch 2 (start 1): [retry, pending]
    // Batch 3 (start 2): [pending, expired]

    const batch1 = await repo.claimEligibleDeliveries("worker_b2", 60000, 2, now);
    assert.strictEqual(batch1.length, 2);
    assert.ok(batch1[0].id.startsWith("del_b2_expired_"), `Batch 1 item 1 expected expired: ${batch1[0].id}`);
    assert.ok(batch1[1].id.startsWith("del_b2_retry_"), `Batch 1 item 2 expected retry: ${batch1[1].id}`);

    const batch2 = await repo.claimEligibleDeliveries("worker_b2", 60000, 2, now);
    assert.strictEqual(batch2.length, 2);
    assert.ok(batch2[0].id.startsWith("del_b2_retry_"), `Batch 2 item 1 expected retry: ${batch2[0].id}`);
    assert.ok(batch2[1].id.startsWith("del_b2_pending_"), `Batch 2 item 2 expected pending: ${batch2[1].id}`);

    const batch3 = await repo.claimEligibleDeliveries("worker_b2", 60000, 2, now);
    assert.strictEqual(batch3.length, 2);
    assert.ok(batch3[0].id.startsWith("del_b2_pending_"), `Batch 3 item 1 expected pending: ${batch3[0].id}`);
    assert.ok(batch3[1].id.startsWith("del_b2_expired_"), `Batch 3 item 2 expected expired: ${batch3[1].id}`);

    // Over the 3 batches (6 items total claimed):
    // Expired: 2 items claimed
    // Due retries: 2 items claimed
    // Pending: 2 items claimed
    const allClaimedIds = [...batch1, ...batch2, ...batch3].map((d) => d.id);
    const expiredClaimed = allClaimedIds.filter((id) => id.startsWith("del_b2_expired_")).length;
    const retryClaimed = allClaimedIds.filter((id) => id.startsWith("del_b2_retry_")).length;
    const pendingClaimed = allClaimedIds.filter((id) => id.startsWith("del_b2_pending_")).length;

    assert.strictEqual(expiredClaimed, 2, "Expired group received exactly 2 claims in 3 cycles");
    assert.strictEqual(retryClaimed, 2, "Retry group received exactly 2 claims in 3 cycles");
    assert.strictEqual(pendingClaimed, 2, "Pending group received exactly 2 claims in 3 cycles");
  });

  // ---------------------------------------------------------------------------
  // 3. True Rotating Queue Fairness (Batch Size 3)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. TRUE ROTATING QUEUE FAIRNESS: BATCH SIZE 3 ---");

  await test("3.1 Batch size 3 balances all candidate groups with rotating starting group", async () => {
    const repo = new TestInMemoryCommunicationOutboxRepository();
    const now = new Date();
    const nowMs = now.getTime();

    for (let i = 1; i <= 5; i++) {
      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b3_expired_${i}`,
          status: "processing",
          attemptCount: 1,
          claimOwner: "worker_b3_prev",
          claimToken: `stale_b3_token_${i}`,
          claimedAt: new Date(nowMs - 120000).toISOString(),
          leaseExpiresAt: new Date(nowMs - 60000).toISOString(),
        })
      );
      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b3_retry_${i}`,
          status: "failed",
          attemptCount: 1,
          nextRetryAt: new Date(nowMs - 10000).toISOString(),
          lastError: { code: "ERR", message: "glitch", isRetryable: true, occurredAt: new Date().toISOString() },
        })
      );
      await seedOutboxDeliveryForTest(
        repo,
        createValidDeliveryRecord({
          id: `del_b3_pending_${i}`,
          status: "pending",
          attemptCount: 0,
        })
      );
    }

    // Batch 1 (start 0): [expired, retry, pending]
    const batch1 = await repo.claimEligibleDeliveries("worker_b3", 60000, 3, now);
    assert.strictEqual(batch1.length, 3);
    assert.ok(batch1[0].id.startsWith("del_b3_expired_"));
    assert.ok(batch1[1].id.startsWith("del_b3_retry_"));
    assert.ok(batch1[2].id.startsWith("del_b3_pending_"));

    // Batch 2 (start 1): [retry, pending, expired]
    const batch2 = await repo.claimEligibleDeliveries("worker_b3", 60000, 3, now);
    assert.strictEqual(batch2.length, 3);
    assert.ok(batch2[0].id.startsWith("del_b3_retry_"));
    assert.ok(batch2[1].id.startsWith("del_b3_pending_"));
    assert.ok(batch2[2].id.startsWith("del_b3_expired_"));

    // Batch 3 (start 2): [pending, expired, retry]
    const batch3 = await repo.claimEligibleDeliveries("worker_b3", 60000, 3, now);
    assert.strictEqual(batch3.length, 3);
    assert.ok(batch3[0].id.startsWith("del_b3_pending_"));
    assert.ok(batch3[1].id.startsWith("del_b3_expired_"));
    assert.ok(batch3[2].id.startsWith("del_b3_retry_"));
  });

  // ---------------------------------------------------------------------------
  // 4. Firestore Rotating Queue Fairness & Atomic Claim Fencing
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. FIRESTORE ROTATING FAIRNESS & ATOMIC FENCING ---");

  await test("4.1 FirestoreCommunicationOutboxRepository rotates starting group and preserves claim token fencing", async () => {
    const now = new Date();
    const nowMs = now.getTime();

    const expiredDocs = Array.from({ length: 4 }, (_, i) => ({
      id: `fs_rot_exp_${i + 1}`,
      ref: { id: `fs_rot_exp_${i + 1}` },
      data: () => ({
        id: `fs_rot_exp_${i + 1}`,
        status: "processing",
        leaseExpiresAt: new Date(nowMs - 30000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }),
    }));

    const retryDocs = Array.from({ length: 4 }, (_, i) => ({
      id: `fs_rot_ret_${i + 1}`,
      ref: { id: `fs_rot_ret_${i + 1}` },
      data: () => ({
        id: `fs_rot_ret_${i + 1}`,
        status: "failed",
        nextRetryAt: new Date(nowMs - 5000).toISOString(),
        attemptCount: 1,
        maxAttempts: 3,
      }),
    }));

    const pendingDocs = Array.from({ length: 4 }, (_, i) => ({
      id: `fs_rot_pen_${i + 1}`,
      ref: { id: `fs_rot_pen_${i + 1}` },
      data: () => ({
        id: `fs_rot_pen_${i + 1}`,
        status: "pending",
        attemptCount: 0,
        maxAttempts: 3,
      }),
    }));

    const allMockDocs = [...expiredDocs, ...retryDocs, ...pendingDocs];
    let sharedCursor = 0;

    const mockDb = {
      collection: () => ({
        doc: (id: string) => ({
          id,
          get: async () => ({
            exists: true,
            data: () => ({ cursor: sharedCursor }),
          }),
          set: async (data: { cursor?: number }) => {
            if (typeof data?.cursor === "number") sharedCursor = data.cursor;
          },
        }),
        where: (field1: string, _op1: string, val1: unknown) => ({
          where: (field2: string) => ({
            limit: (lim: number) => ({
              get: async () => {
                if (field1 === "status" && val1 === "processing" && field2 === "leaseExpiresAt") {
                  return { docs: expiredDocs.slice(0, lim) };
                }
                if (field1 === "status" && val1 === "failed" && field2 === "nextRetryAt") {
                  return { docs: retryDocs.slice(0, lim) };
                }
                return { docs: [] };
              },
            }),
          }),
          limit: (lim: number) => ({
            get: async () => {
              if (field1 === "status" && val1 === "pending") {
                return { docs: pendingDocs.slice(0, lim) };
              }
              return { docs: [] };
            },
          }),
        }),
      }),
      runTransaction: async (updateFn: (t: unknown) => Promise<unknown>) => {
        const mockTransaction = {
          get: async (ref: { id: string }) => {
            if (ref.id === "_rotation_cursor") {
              return {
                exists: true,
                data: () => ({ cursor: sharedCursor }),
              };
            }
            const found = allMockDocs.find((d) => d.id === ref.id);
            return {
              exists: Boolean(found),
              data: () => found?.data(),
            };
          },
          set: (ref: { id: string }, data: { cursor?: number }) => {
            if (ref.id === "_rotation_cursor" && typeof data?.cursor === "number") {
              sharedCursor = data.cursor;
            }
          },
        };
        return await updateFn(mockTransaction);
      },
    };

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => mockDb as unknown as import("firebase-admin").firestore.Firestore)
    );

    // Call 1 with batch size 1 (start 0): claims expired
    const claim1 = await repo.claimEligibleDeliveries("fs_rot_worker", 60000, 1, now);
    assert.strictEqual(claim1.length, 1);
    assert.strictEqual(claim1[0].id, "fs_rot_exp_1");
    assert.strictEqual(claim1[0].status, "processing");
    assert.strictEqual(claim1[0].claimOwner, "fs_rot_worker");
    assert.ok(claim1[0].claimToken, "Claim token must be assigned");

    // Call 2 with batch size 1 (start 1): claims due retry
    const claim2 = await repo.claimEligibleDeliveries("fs_rot_worker", 60000, 1, now);
    assert.strictEqual(claim2.length, 1);
    assert.strictEqual(claim2[0].id, "fs_rot_ret_1");
    assert.strictEqual(claim2[0].status, "processing");
    assert.ok(claim2[0].claimToken, "Claim token must be assigned");

    // Call 3 with batch size 1 (start 2): claims pending
    const claim3 = await repo.claimEligibleDeliveries("fs_rot_worker", 60000, 1, now);
    assert.strictEqual(claim3.length, 1);
    assert.strictEqual(claim3[0].id, "fs_rot_pen_1");
    assert.strictEqual(claim3[0].status, "processing");
    assert.ok(claim3[0].claimToken, "Claim token must be assigned");
  });

  // ---------------------------------------------------------------------------
  // 5. Accurate Metrics Fidelity
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. ACCURATE METRICS FIDELITY ---");

  await test("5.1 Firestore getMetrics preserves exact count aggregations while marking bounded components as sampled", async () => {
    const mockAggDb = {
      collection: () => ({
        where: (field: string, _op: string, val: unknown) => ({
          count: () => ({
            get: async () => ({
              data: () => ({
                count: val === "pending" ? 15 : val === "dispatched" ? 85 : val === "whatsapp" ? 90 : 10,
              }),
            }),
          }),
          select: () => ({
            limit: () => ({
              get: async () => ({ docs: [] }),
            }),
          }),
        }),
      }),
    };

    const repo = new FirestoreCommunicationOutboxRepository(
      undefined,
      (() => mockAggDb as unknown as import("firebase-admin").firestore.Firestore)
    );

    const metrics = await repo.getMetrics(new Date());

    // 1. Exact Aggregate Counts preserved
    assert.strictEqual(metrics.counts.pending, 15);
    assert.strictEqual(metrics.counts.dispatched, 85);
    assert.strictEqual(metrics.components?.counts.fidelity, "exact");
    assert.strictEqual(metrics.components?.counts.isExact, true);
    assert.strictEqual(metrics.components?.channelBreakdown.fidelity, "exact");
    assert.strictEqual(metrics.components?.channelBreakdown.isExact, true);

    // 2. Bounded Projections marked as sampled
    assert.strictEqual(metrics.components?.staleLeases.fidelity, "sampled");
    assert.strictEqual(metrics.components?.staleLeases.isExact, false);
    assert.strictEqual(metrics.components?.staleLeases.sampleLimit, 250);

    assert.strictEqual(metrics.components?.oldestPendingAge.fidelity, "sampled");
    assert.strictEqual(metrics.components?.oldestPendingAge.isExact, false);
    assert.strictEqual(metrics.components?.oldestPendingAge.sampleLimit, 50);

    assert.strictEqual(metrics.components?.failureReasons.fidelity, "sampled");
    assert.strictEqual(metrics.components?.failureReasons.isExact, false);
    assert.strictEqual(metrics.components?.failureReasons.sampleLimit, 100);

    // 3. Complete Response NEVER overstates accuracy
    assert.strictEqual(
      metrics.fidelity,
      "sampled",
      "Overall metrics fidelity MUST be 'sampled' when any component is sampled"
    );
    assert.strictEqual(
      metrics.isExact,
      false,
      "Overall isExact MUST be false when any component is sampled"
    );
    assert.ok(metrics.sampleDetails?.sampledComponents?.includes("staleLeases"));
    assert.ok(metrics.sampleDetails?.sampledComponents?.includes("oldestPendingAge"));
    assert.ok(metrics.sampleDetails?.sampledComponents?.includes("failureReasons"));
  });

  await test("5.2 computeOutboxMetricsFromRecords enforces fidelity invariants (never overstates accuracy)", () => {
    const record = createValidDeliveryRecord({ id: "rec_exact_01", status: "pending" });

    // When all components are exact (e.g. in-memory full store evaluation)
    const exactMetrics = computeOutboxMetricsFromRecords([record]);
    assert.strictEqual(exactMetrics.fidelity, "exact");
    assert.strictEqual(exactMetrics.isExact, true);
    assert.strictEqual(exactMetrics.components?.counts.isExact, true);

    // When one component is marked sampled, overall fidelity MUST drop to sampled
    const partiallySampledMetrics = computeOutboxMetricsFromRecords([record], new Date(), {
      components: {
        counts: { fidelity: "exact", isExact: true },
        channelBreakdown: { fidelity: "exact", isExact: true },
        staleLeases: { fidelity: "sampled", isExact: false, sampleLimit: 250 },
        oldestPendingAge: { fidelity: "exact", isExact: true },
        failureReasons: { fidelity: "exact", isExact: true },
      },
    });

    assert.strictEqual(
      partiallySampledMetrics.fidelity,
      "sampled",
      "Overall fidelity must be 'sampled' if even one component is sampled"
    );
    assert.strictEqual(
      partiallySampledMetrics.isExact,
      false,
      "Overall isExact must be false if even one component is sampled"
    );
    assert.ok(partiallySampledMetrics.sampleDetails?.sampledComponents?.includes("staleLeases"));
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.5.3 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Fatal failure in Phase 6.5.3 verification suite:", err);
  process.exit(1);
});
