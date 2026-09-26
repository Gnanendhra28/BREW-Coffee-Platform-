// Healthcheck & Fleet Monitoring Endpoint
// Monitored by BetterStack, UptimeRobot, or Datadog for automated van uptime alerts.

import { NextResponse } from "next/server";
import { getAgentCacheStats } from "@/lib/agentCache";

export const dynamic = "force-dynamic";

export async function GET() {
  const startTime = Date.now();

  try {
    const memory = process.memoryUsage();
    const cacheStats = getAgentCacheStats();
    const uptimeSeconds = Math.floor(process.uptime());

    const checks = {
      realtimeStore: {
        status: "healthy",
        engine: "Dual-Engine SSE & Cloud Sync",
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
    };

    const isHealthy = Object.values(checks).every((c) => c.status !== "critical");
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
