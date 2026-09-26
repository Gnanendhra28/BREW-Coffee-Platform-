// Autonomous AI Agent Cache Layer
// Reduces LLM API invocations by caching weather forecasts, parking recommendations, and responses.
// Backed by Upstash Redis with automatic in-memory fallback.

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const agentCacheStoreKey = Symbol.for("brew.agentcache.store");
const agentCacheStatsKey = Symbol.for("brew.agentcache.stats");

interface GlobalWithAgentCache {
  [agentCacheStoreKey]?: Map<string, CacheEntry<unknown>>;
  [agentCacheStatsKey]?: { hits: number; misses: number; sets: number };
}

const g = globalThis as unknown as GlobalWithAgentCache;
if (!g[agentCacheStoreKey]) {
  g[agentCacheStoreKey] = new Map<string, CacheEntry<unknown>>();
}
if (!g[agentCacheStatsKey]) {
  g[agentCacheStatsKey] = { hits: 0, misses: 0, sets: 0 };
}

const memoryCache = g[agentCacheStoreKey]!;
const cacheStats = g[agentCacheStatsKey]!;

/**
 * Retrieves cached response for a given key.
 */
export async function getCachedAgentData<T>(key: string): Promise<T | null> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prefixedKey = `agentcache:${key}`;

  // 1. Check Upstash Redis
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/get/${encodeURIComponent(prefixedKey)}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(1500),
      });

      if (res.ok) {
        const body = await res.json();
        if (body.result) {
          cacheStats.hits++;
          return JSON.parse(body.result) as T;
        }
      }
    } catch (err) {
      console.warn("[AgentCache] Upstash Redis GET failed, checking memory:", err);
    }
  }

  // 2. Check in-memory store
  const local = memoryCache.get(prefixedKey);
  const now = Date.now();

  if (local) {
    if (now < local.expiresAt) {
      cacheStats.hits++;
      return local.data as T;
    }
    // Expired
    memoryCache.delete(prefixedKey);
  }

  cacheStats.misses++;
  return null;
}

/**
 * Caches data with an expiration TTL (Default: 30 minutes / 1800 seconds).
 */
export async function setCachedAgentData<T>(
  key: string,
  data: T,
  ttlSeconds: number = 1800
): Promise<void> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prefixedKey = `agentcache:${key}`;
  const now = Date.now();
  cacheStats.sets++;

  // 1. Store in memory
  memoryCache.set(prefixedKey, {
    data,
    expiresAt: now + ttlSeconds * 1000,
  });

  // 2. Store in Upstash Redis if configured
  if (redisUrl && redisToken) {
    try {
      const serialized = JSON.stringify(data);
      await fetch(
        `${redisUrl}/set/${encodeURIComponent(prefixedKey)}?ex=${ttlSeconds}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${redisToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ value: serialized }),
          signal: AbortSignal.timeout(1500),
        }
      );
    } catch (err) {
      console.warn("[AgentCache] Upstash Redis SET failed:", err);
    }
  }
}

/**
 * Returns cache telemetry for health checking and ops monitoring.
 */
export function getAgentCacheStats() {
  return {
    memoryEntriesCount: memoryCache.size,
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    sets: cacheStats.sets,
  };
}
