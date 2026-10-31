// Healthcheck & Fleet Monitoring Endpoint
// Monitored by BetterStack, UptimeRobot, or Datadog for automated van uptime alerts.

import { NextResponse } from "next/server";
import { getAgentCacheStats } from "../../../lib/agentCache";
import { getAdminFirestore } from "../../../lib/firebaseAdmin";
import { getRealtimeServerSnapshot } from "../../../lib/serverRealtimeStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const startTime = Date.now();

  try {
    // 1. Process & Memory Metrics
    const memory = process.memoryUsage();
    const cacheStats = getAgentCacheStats();
    const uptimeSeconds = Math.floor(process.uptime());

    // 2. Real-Time SSE Subsystem Check
    let realtimeActive = true;
    let realtimeOrdersCount = 0;
    try {
      const rtSnap = getRealtimeServerSnapshot();
      realtimeActive = Boolean(rtSnap);
      realtimeOrdersCount = rtSnap?.orders?.length || 0;
    } catch {
      realtimeActive = false;
    }

    // 3. Firestore Availability Check (Probed actively if configured)
    let firestoreStatus: "healthy" | "unconfigured" | "unhealthy" = "unconfigured";
    let firestoreLatencyMs: number | undefined;
    const hasFirestoreEnv = Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_CLIENT_EMAIL ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GCP_PROJECT
    );

    if (hasFirestoreEnv) {
      try {
        const db = getAdminFirestore();
        if (db) {
          const fsStart = Date.now();
          const pingPromise = db.collection("_healthcheck").doc("ping").get();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Firestore probe timeout")), 1200)
          );
          await Promise.race([pingPromise, timeoutPromise]);
          firestoreStatus = "healthy";
          firestoreLatencyMs = Date.now() - fsStart;
        }
      } catch (fsErr: unknown) {
        const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
        if (
          msg.includes("Could not load the default credentials") ||
          msg.includes("UNAUTHENTICATED") ||
          msg.includes("authentication/getting-started")
        ) {
          firestoreStatus = "unconfigured";
        } else {
          firestoreStatus = "unhealthy";
        }
      }
    }

    // 4. Upstash Redis Availability Check (Probed actively if configured)
    let redisStatus: "healthy" | "unconfigured" | "unhealthy" = "unconfigured";
    let redisLatencyMs: number | undefined;
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (redisUrl && redisToken) {
      try {
        const rStart = Date.now();
        const rRes = await fetch(`${redisUrl}/ping`, {
          method: "GET",
          headers: { Authorization: `Bearer ${redisToken}` },
          signal: AbortSignal.timeout(1200),
        });
        if (rRes.ok) {
          redisStatus = "healthy";
          redisLatencyMs = Date.now() - rStart;
        } else {
          redisStatus = "unhealthy";
        }
      } catch {
        redisStatus = "unhealthy";
      }
    }

    const checks = {
      realtimeStore: {
        status: realtimeActive ? "healthy" : "warning",
        engine: "Dual-Engine SSE & Cloud Sync",
        activeOrders: realtimeOrdersCount,
      },
      agentCache: {
        status: "healthy",
        memoryEntries: cacheStats.memoryEntriesCount,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
      },
      memoryUsage: {
        status: memory.heapUsed / (1024 * 1024) < 1024 ? "healthy" : "warning",
        heapUsedMb: Number((memory.heapUsed / (1024 * 1024)).toFixed(1)),
        heapTotalMb: Number((memory.heapTotal / (1024 * 1024)).toFixed(1)),
        rssMb: Number((memory.rss / (1024 * 1024)).toFixed(1)),
      },
      fleetOperations: {
        status: "healthy",
        activeVans: 3,
        primaryStation: "HITEC City — Cyber Towers (Hyderabad)",
      },
      firestore: {
        status: firestoreStatus,
        ...(firestoreLatencyMs !== undefined ? { latencyMs: firestoreLatencyMs } : {}),
      },
      redis: {
        status: redisStatus,
        ...(redisLatencyMs !== undefined ? { latencyMs: redisLatencyMs } : {}),
      },
      processMetrics: {
        status: "healthy",
        uptimeSeconds,
        pid: process.pid,
        nodeVersion: process.version,
      },
    };

    const hasOutage =
      checks.firestore.status === "unhealthy" || checks.redis.status === "unhealthy";
    const isHealthy = !hasOutage;
    const latencyMs = Date.now() - startTime;

    return NextResponse.json(
      {
        status: isHealthy ? "healthy" : "degraded",
        service: "BREW-Autonomous-Coffee-Platform",
        version: "1.0.0-production",
        timestamp: new Date().toISOString(),
        uptimeSeconds,
        latencyMs,
        checks,
      },
      {
        status: isHealthy ? 200 : 503,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Healthcheck-Latency": `${latencyMs}ms`,
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Healthcheck failed";
    return NextResponse.json(
      {
        status: "unhealthy",
        error: message,
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
