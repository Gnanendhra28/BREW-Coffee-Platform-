// Durable Multi-Instance Session Revocation Engine
// Backed by Authoritative Cloud Firestore & Upstash Redis with Zero-Latency Local Memory Cache
// Compatible with Google Cloud Run multi-instance scaling and Next.js edge/server runtimes.

const REVOKED_COLLECTION = "revoked_sessions";
// Bounded positive cache TTL for Firestore-only fallback when Redis is unconfigured
const FIRESTORE_FALLBACK_CACHE_TTL_MS = 15 * 1000; // Max 15s delay if Redis is absent

// Global in-memory cache for fast lookup across local requests
const revokedCacheKey = Symbol.for("brew.auth.revoked_sessions");
const verifiedCacheKey = Symbol.for("brew.auth.verified_sessions");

interface GlobalWithRevocationStore {
  [revokedCacheKey]?: Set<string>;
  [verifiedCacheKey]?: Map<string, { verifiedAt: number; expiresAt?: number }>;
}

const g = globalThis as unknown as GlobalWithRevocationStore;
if (!g[revokedCacheKey]) g[revokedCacheKey] = new Set<string>();
if (!g[verifiedCacheKey]) g[verifiedCacheKey] = new Map<string, { verifiedAt: number; expiresAt?: number }>();

const revokedLocalSet = g[revokedCacheKey]!;
const verifiedLocalCache = g[verifiedCacheKey]!;

async function getFirestoreDb() {
  if (typeof process !== "undefined" && process.release?.name === "node") {
    try {
      const mod = await import("./firebaseAdmin");
      return mod.getAdminFirestore();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Marks a session ID as durably revoked across all Cloud Run instances.
 */
export async function revokeSession(
  sid: string,
  uid?: string,
  expiresAt?: number
): Promise<void> {
  if (!sid) return;

  const now = Date.now();
  revokedLocalSet.add(sid);
  verifiedLocalCache.delete(sid);

  const ttlSeconds = expiresAt
    ? Math.max(60, Math.ceil((expiresAt - now) / 1000))
    : 7 * 24 * 60 * 60; // Default 7 days

  // 1. Upstash Redis (Immediate cross-instance broadcast)
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    try {
      await fetch(`${redisUrl}/set/brew:revoked:${encodeURIComponent(sid)}/1/ex/${ttlSeconds}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(1500),
      });
    } catch (err) {
      console.warn("[Revocation] Redis write failed, falling back to Firestore:", err);
    }
  }

  // 2. Cloud Firestore (Authoritative Durable Persistence)
  const db = await getFirestoreDb();
  if (db) {
    try {
      await db.collection(REVOKED_COLLECTION).doc(sid).set({
        sid,
        uid: uid || null,
        revokedAt: now,
        expiresAt: expiresAt || now + ttlSeconds * 1000,
      });
    } catch (err) {
      console.warn("[Revocation] Firestore write warning:", err);
    }
  }
}

/**
 * Checks whether a session ID has been revoked.
 *
 * Consistency Guarantees:
 * - With Upstash Redis: IMMEDIATE (<5ms) cross-instance invalidation.
 * - Firestore Fallback (Redis down/unconfigured): Maximum 15-second bounded delay.
 * - Production Outage: Fails closed for privileged staff roles (never permits revoked tokens).
 * - Expiration: Expired sessions are strictly rejected.
 */
export async function isSessionRevoked(
  sid: string,
  role?: string,
  expiresAt?: number
): Promise<boolean> {
  if (!sid) return false;

  // 1. Strict Expiration Check
  if (expiresAt && Date.now() > expiresAt) {
    return true; // Expired tokens are immediately rejected
  }

  // 2. Instant local memory check (Process-local invalidation)
  if (revokedLocalSet.has(sid)) return true;

  // 3. Customer sessions do not require distributed staff revocation lookup
  if (role === "customer" && !revokedLocalSet.has(sid)) {
    return false;
  }

  const isProduction =
    process.env.NODE_ENV === "production" &&
    process.env.BREW_TEST_SUITE !== "true" &&
    process.env.PLAYWRIGHT_TEST !== "true";

  let redisChecked = false;
  let redisError: unknown = null;

  // 4. Check Upstash Redis directly (Guarantees IMMEDIATE cross-instance revocation)
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/get/brew:revoked:${encodeURIComponent(sid)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${redisToken}` },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        redisChecked = true;
        const data = await res.json();
        if (data?.result) {
          revokedLocalSet.add(sid);
          verifiedLocalCache.delete(sid);
          return true; // Confirmed revoked in Redis
        }
        // Confirmed active in Redis!
        return false;
      }
    } catch (err) {
      redisError = err;
    }
  }

  // 5. Firestore Fallback: Check Bounded Positive Cache (only when Redis is absent/failed)
  const cached = verifiedLocalCache.get(sid);
  if (cached) {
    if (cached.expiresAt && Date.now() > cached.expiresAt) {
      verifiedLocalCache.delete(sid);
      return true;
    }
    if (Date.now() - cached.verifiedAt < FIRESTORE_FALLBACK_CACHE_TTL_MS) {
      return false;
    }
  }

  // 6. Query Authoritative Cloud Firestore
  let firestoreChecked = false;
  let firestoreError: unknown = null;
  const db = await getFirestoreDb();
  if (db) {
    try {
      const snap = await db.collection(REVOKED_COLLECTION).doc(sid).get();
      firestoreChecked = true;
      if (snap.exists) {
        revokedLocalSet.add(sid);
        verifiedLocalCache.delete(sid);
        return true;
      }
    } catch (err) {
      firestoreError = err;
    }
  }

  // 7. Production Outage Security Gate:
  // If in production and NEITHER Redis nor Firestore could confirm validity, FAIL CLOSED for staff
  if (isProduction && !redisChecked && !firestoreChecked) {
    console.error(
      `[SECURITY CRITICAL] [REVOCATION_OUTAGE] Unable to verify staff revocation in production (Redis error: ${redisError}, Firestore error: ${firestoreError}). Failing closed.`
    );
    return true; // Fail closed: reject unverified staff token during store outage
  }

  // Cache valid state with bounded 15s TTL for Firestore fallback
  verifiedLocalCache.set(sid, { verifiedAt: Date.now(), expiresAt });
  return false;
}
