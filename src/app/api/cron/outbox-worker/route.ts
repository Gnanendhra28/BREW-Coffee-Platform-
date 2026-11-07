/**
 * BREW Coffee Platform — Phase 6.5 Scheduled Outbox Worker Endpoint
 * 
 * Scheduled / HTTP-Triggered Background Worker:
 * Periodically processes pending, retryable, and expired-lease outbox deliveries.
 * 
 * Invariants:
 * 1. Secured via verifyWorkerAuth (Authorization: Bearer <CRON_SECRET> or x-cron-secret header).
 * 2. Constant-time secret comparison; fails closed if secret is not configured.
 * 3. Enforces bounded batches (batchSize <= 50) and timeout-safe cycles (maxCycles <= 5).
 * 4. Cooperative deadline enforcement: checks remaining budget before each cycle and delivery,
 *    releasing unstarted deliveries if headroom is exceeded. Individual provider operations
 *    must have bounded internal timeouts since asynchronous operations cannot be forcibly pre-empted.
 * 5. Fails closed (503) if Firestore is unavailable in deployed environments.
 * 6. Returns structured execution metrics. Never leaks secrets or customer PII.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerAuth } from "../../../../lib/communication/outbox/workerAuth";
import {
  createStandardOutboxWorker,
  runOutboxWorkerCycles,
  OutboxRunOptions,
} from "../../../../lib/communication/outbox/outboxService";
import { OutboxWorker } from "../../../../lib/communication/outbox/outboxWorker";
import { getAdminFirestore } from "../../../../lib/firebaseAdmin";
import {
  getCronWorkerOverride,
  getCronDbProviderOverride,
} from "../../../../lib/communication/testingHooks";

export const dynamic = "force-dynamic";

function parseAndValidateOptions(
  url: URL,
  body: Record<string, unknown> | null
): {
  batchSize: number;
  leaseDurationMs: number;
  maxCycles: number;
  maxDurationMs: number;
  workerId?: string;
} {
  const queryBatch = url.searchParams.get("batchSize");
  const queryLease = url.searchParams.get("leaseDurationMs");
  const queryMaxCycles = url.searchParams.get("maxCycles");
  const queryMaxDuration = url.searchParams.get("maxDurationMs");
  const queryWorkerId = url.searchParams.get("workerId");

  const rawBatch = queryBatch ?? body?.batchSize;
  const rawLease = queryLease ?? body?.leaseDurationMs;
  const rawCycles = queryMaxCycles ?? body?.maxCycles;
  const rawDuration = queryMaxDuration ?? body?.maxDurationMs;
  const rawWorkerId = queryWorkerId ?? body?.workerId;

  const parsedBatch = typeof rawBatch === "number" ? rawBatch : parseInt(String(rawBatch || "10"), 10);
  const parsedLease = typeof rawLease === "number" ? rawLease : parseInt(String(rawLease || "60000"), 10);
  const parsedCycles = typeof rawCycles === "number" ? rawCycles : parseInt(String(rawCycles || "1"), 10);
  const parsedDuration = typeof rawDuration === "number" ? rawDuration : parseInt(String(rawDuration || "25000"), 10);

  // Clamping rules:
  // batchSize: [1, 50], default 10
  const batchSize = Math.min(Math.max(1, Number.isFinite(parsedBatch) ? parsedBatch : 10), 50);

  // leaseDurationMs: [5000, 300000], default 60000
  const leaseDurationMs = Math.min(Math.max(5000, Number.isFinite(parsedLease) ? parsedLease : 60000), 300000);

  // maxCycles: [1, 5], default 1
  const maxCycles = Math.min(Math.max(1, Number.isFinite(parsedCycles) ? parsedCycles : 1), 5);

  // maxDurationMs: [1000, 25000], default 25000
  const maxDurationMs = Math.min(Math.max(1000, Number.isFinite(parsedDuration) ? parsedDuration : 25000), 25000);

  const workerId = typeof rawWorkerId === "string" && rawWorkerId.trim() ? rawWorkerId.trim() : undefined;

  return { batchSize, leaseDurationMs, maxCycles, maxDurationMs, workerId };
}

async function handleWorkerRequest(req: NextRequest) {
  try {
    // 1. Authorize caller
    const authResult = verifyWorkerAuth(req);
    if (!authResult.ok) {
      return NextResponse.json(
        { error: authResult.error, code: authResult.code },
        { status: authResult.status }
      );
    }

    // 2. Parse and validate options BEFORE creating the worker
    const url = new URL(req.url);
    let bodyOptions: Record<string, unknown> | null = null;
    try {
      const json = await req.json();
      if (json && typeof json === "object") {
        bodyOptions = json;
      }
    } catch {
      // Body is optional; query params or defaults take precedence
    }

    const validated = parseAndValidateOptions(url, bodyOptions);

    // 3. Resolve database / worker (configured with validated options)
    let worker: OutboxWorker;
    const testWorkerOverride = getCronWorkerOverride();
    const testDbProvider = getCronDbProviderOverride();
    if (testWorkerOverride) {
      worker = testWorkerOverride;
    } else {
      const db = testDbProvider ? testDbProvider() : getAdminFirestore();
      if (!db) {
        console.error("[CRON_OUTBOX_WORKER] Firestore unavailable in deployed environment.");
        return NextResponse.json(
          { error: "Service unavailable: Firestore database not configured" },
          { status: 503 }
        );
      }
      worker = createStandardOutboxWorker({
        batchSize: validated.batchSize,
        leaseDurationMs: validated.leaseDurationMs,
        workerId: validated.workerId,
      });
    }

    // 4. Run worker cycles with enforced limits
    const runOptions: OutboxRunOptions = {
      batchSize: validated.batchSize,
      leaseDurationMs: validated.leaseDurationMs,
      maxCycles: validated.maxCycles,
      maxDurationMs: validated.maxDurationMs,
      workerId: validated.workerId,
    };

    const result = await runOutboxWorkerCycles(worker, runOptions);

    return NextResponse.json({
      success: true,
      cyclesCompleted: result.cyclesCompleted,
      durationMs: result.durationMs,
      result: result.aggregateResult,
      timestamp: result.timestamp,
    });
  } catch (error) {
    console.error("[CRON_OUTBOX_WORKER] Fatal error during outbox cycle execution:", error);
    return NextResponse.json(
      { error: "Internal server error executing outbox worker cycle" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return handleWorkerRequest(req);
}

/**
 * GET is strictly rejected with 405 Method Not Allowed.
 * In accordance with Phase 6.5.1 specifications, outbox processing mutations
 * must never be triggered via safe/idempotent HTTP GET requests.
 */
export async function GET() {
  return NextResponse.json(
    { error: "Method Not Allowed. Use POST to execute outbox worker cycles." },
    {
      status: 405,
      headers: { Allow: "POST" },
    }
  );
}

export async function PUT() {
  return NextResponse.json(
    { error: "Method Not Allowed. Use POST to execute outbox worker cycles." },
    {
      status: 405,
      headers: { Allow: "POST" },
    }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: "Method Not Allowed. Use POST to execute outbox worker cycles." },
    {
      status: 405,
      headers: { Allow: "POST" },
    }
  );
}
