// Production Rate Limiter with Upstash Redis HTTP REST support & Sliding Window Fallback
// Protects AI Agent endpoints (/api/barista-chat, /api/barista-ops-chat) from DDoS and API abuse.

import { NextRequest } from "next/server";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp in seconds
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
  windowSeconds: number = 60
): Promise<RateLimitResult> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `ratelimit:${prefix}:${identifier}`;
  const nowMs = Date.now();
  const resetTimestamp = Math.ceil((nowMs + windowSeconds * 1000) / 1000);

  // 1. If Upstash Redis is configured, execute atomic INCR via Upstash REST API
  if (redisUrl && redisToken) {
    try {
      // Pipeline: INCR + EXPIRE (if new)
      const res = await fetch(`${redisUrl}/pipeline`, {
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

      if (res.ok) {
        const data = await res.json();
        const currentCount = Number(data?.[0]?.result || 1);
        const ttl = Number(data?.[2]?.result || windowSeconds);
        const remaining = Math.max(0, limit - currentCount);

        return {
          success: currentCount <= limit,
          limit,
          remaining,
          reset: Math.floor(nowMs / 1000) + Math.max(1, ttl),
        };
      }
    } catch (err) {
      console.warn("[RateLimit] Upstash Redis check failed, falling back to sliding memory window:", err);
    }
  }

  // 2. Local Sliding-Window fallback store
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
  };
}
