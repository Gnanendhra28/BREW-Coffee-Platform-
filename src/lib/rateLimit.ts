// Production Rate Limiter with Upstash Redis HTTP REST support & Sliding Window Fallback
// Protects AI Agent endpoints (/api/barista-chat, /api/barista-ops-chat) from DDoS and API abuse.

import { NextRequest } from "next/server";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp in seconds
  degraded?: boolean; // True if operating in local memory fallback mode
  error?: "RATE_LIMITER_UNAVAILABLE" | string;
}

export interface RateLimitOptions {
  /**
   * Designates this endpoint as security-sensitive (e.g. auth-session, payments).
   * In production (NODE_ENV === "production" && ALLOW_LOCAL_FALLBACK !== "true"),
   * sensitive endpoints will NOT silently degrade to process-local stores.
   */
  sensitive?: boolean;
  /**
   * Outage policy when Upstash Redis is unreachable or unconfigured in production:
   * - "fail-closed": Denies request with RATE_LIMITER_UNAVAILABLE (default for sensitive endpoints).
   * - "degraded-log": Degrades to local memory with critical alert log.
   */
  outagePolicy?: "fail-closed" | "degraded-log";
}

interface WindowRecord {
  count: number;
  expiresAt: number;
}

// Global in-memory sliding window store for high-speed sub-millisecond rate tracking
const rateLimitStoreKey = Symbol.for("brew.ratelimit.store");
interface GlobalWithRateLimitStore {
  [rateLimitStoreKey]?: Map<string, WindowRecord>;
}

const g = globalThis as unknown as GlobalWithRateLimitStore;
if (!g[rateLimitStoreKey]) {
  g[rateLimitStoreKey] = new Map<string, WindowRecord>();
}
const localMemoryStore = g[rateLimitStoreKey]!;

/**
 * Extracts client IP identifier from headers or socket.
 */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "127.0.0.1";
}

/**
 * Executes rate limit check against Upstash Redis or Local Sliding Window.
 * Default: 10 requests per 60 seconds.
 */
export async function checkRateLimit(
  identifier: string,
  prefix: string = "barista-chat",
  limit: number = 10,
  windowSeconds: number = 60,
  options?: RateLimitOptions
): Promise<RateLimitResult> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `ratelimit:${prefix}:${identifier}`;
  const nowMs = Date.now();
  const resetTimestamp = Math.ceil((nowMs + windowSeconds * 1000) / 1000);

  // In true production, sensitive endpoints strictly enforce Upstash Redis and fail-closed security.
  // ALLOW_LOCAL_FALLBACK cannot bypass production controls.
  const isLocalTest =
    process.env.PLAYWRIGHT_TEST === "true" ||
    process.env.BREW_TEST_SUITE === "true";
  const isProduction =
    process.env.NODE_ENV === "production" && !isLocalTest;
  const isSensitive = options?.sensitive === true;
  const outagePolicy =
    options?.outagePolicy || (isSensitive ? "fail-closed" : "degraded-log");

  let redisError: unknown = null;

  // 1. If Upstash Redis is configured, execute ATOMIC Lua script via Upstash REST API
  // Lua script guarantees atomic INCR + conditional EXPIRE + TTL in a single Redis engine execution
  if (redisUrl && redisToken) {
    try {
      const atomicScript = `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        local ttl = redis.call('TTL', KEYS[1])
        return {current, ttl}
      `;

      let currentCount: number | null = null;
      let ttl: number | null = null;

      // Attempt atomic /eval first
      const evalRes = await fetch(`${redisUrl}/eval`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          script: atomicScript,
          keys: [key],
          args: [String(windowSeconds)],
        }),
        signal: AbortSignal.timeout(1500),
      });

      if (evalRes.ok) {
        const evalData = await evalRes.json();
        const resArray = Array.isArray(evalData?.result) ? evalData.result : [];
        currentCount = Number(resArray[0] || 1);
        ttl = Number(resArray[1] || windowSeconds);
      } else {
        // Fallback to /pipeline if /eval is unsupported by mock server
        const pipeRes = await fetch(`${redisUrl}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${redisToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            ["INCR", key],
            ["EXPIRE", key, windowSeconds, "NX"],
            ["TTL", key],
          ]),
          signal: AbortSignal.timeout(1500),
        });

        if (pipeRes.ok) {
          const pipeData = await pipeRes.json();
          currentCount = Number(pipeData?.[0]?.result || 1);
          ttl = Number(pipeData?.[2]?.result || windowSeconds);
        } else {
          redisError = new Error(`Redis HTTP ${pipeRes.status}: ${pipeRes.statusText}`);
        }
      }

      if (currentCount !== null && ttl !== null) {
        const remaining = Math.max(0, limit - currentCount);
        return {
          success: currentCount <= limit,
          limit,
          remaining,
          reset: Math.floor(nowMs / 1000) + Math.max(1, ttl),
          degraded: false,
        };
      }
    } catch (err) {
      redisError = err;
    }
  } else {
    redisError = new Error("Upstash Redis credentials not configured");
  }

  // 2. Explicit Behavior on Redis Outage / Unavailability in Production
  // Production sensitive endpoints MUST NOT silently degrade to process-local stores.
  // Unavailability or missing Redis configuration strictly fails closed.
  if (isProduction && isSensitive) {
    if (outagePolicy === "fail-closed") {
      console.error(
        `[SECURITY CRITICAL] [RATE_LIMIT_OUTAGE] Upstash Redis unavailable for sensitive endpoint "${prefix}". Failing closed. Cause: ${
          redisError instanceof Error ? redisError.message : String(redisError)
        }`
      );
      return {
        success: false,
        limit,
        remaining: 0,
        reset: resetTimestamp,
        degraded: true,
        error: "RATE_LIMITER_UNAVAILABLE",
      };
    } else {
      console.error(
        `[SECURITY ALERT] [RATE_LIMIT_DEGRADED] Upstash Redis unavailable for sensitive endpoint "${prefix}". Operating in degraded process-local mode.`
      );
    }
  } else if (redisError && redisUrl) {
    console.warn(
      `[RateLimit] Upstash Redis check failed for "${prefix}", falling back to sliding memory window:`,
      redisError
    );
  }

  // 3. Local Sliding-Window fallback store
  const record = localMemoryStore.get(key);

  if (!record || nowMs > record.expiresAt) {
    // New window
    localMemoryStore.set(key, {
      count: 1,
      expiresAt: nowMs + windowSeconds * 1000,
    });

    return {
      success: true,
      limit,
      remaining: limit - 1,
      reset: resetTimestamp,
      degraded: true,
    };
  }

  // Existing window
  record.count += 1;
  const isAllowed = record.count <= limit;
  const remaining = Math.max(0, limit - record.count);
  const reset = Math.ceil(record.expiresAt / 1000);

  return {
    success: isAllowed,
    limit,
    remaining,
    reset,
    degraded: true,
  };
}
