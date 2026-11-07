/**
 * BREW Coffee Platform — Phase 6.5 Outbox Worker Authentication
 * 
 * Server-authoritative authentication boundary for background outbox workers
 * and scheduled cron endpoints.
 * 
 * Security Invariants:
 * 1. Strictly server-only. Never bundled or leaked to client environments.
 * 2. Compares secrets in constant time using crypto.timingSafeEqual to prevent
 *    timing side-channel attacks.
 * 3. Fails closed (500) if no worker/cron secret is configured in environment.
 * 4. Fails closed (401) on missing, malformed, or mismatched credentials.
 * 5. Redacts secrets from all logs and error responses.
 */

if (typeof window !== "undefined") {
  throw new Error("Security violation: workerAuth cannot be executed in client context.");
}

import crypto from "crypto";
import { NextRequest } from "next/server";

export type WorkerAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string; code: string };

/**
 * Extracts and verifies worker authentication credentials from an incoming NextRequest.
 * Accepts:
 * - Authorization: Bearer <secret>
 * - x-cron-secret: <secret>
 */
export function verifyWorkerAuth(req: NextRequest): WorkerAuthResult {
  const configuredSecret =
    process.env.CRON_SECRET ||
    process.env.WORKER_SECRET ||
    process.env.OUTBOX_WORKER_SECRET;

  if (!configuredSecret || !configuredSecret.trim()) {
    console.error("[WORKER_AUTH] Configuration failure: CRON_SECRET or WORKER_SECRET is not configured.");
    return {
      ok: false,
      status: 500,
      error: "Configuration error: worker authorization secret is not configured.",
      code: "WORKER_SECRET_NOT_CONFIGURED",
    };
  }

  // 1. Extract Bearer token or x-cron-secret header
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const cronHeader = req.headers.get("x-cron-secret") || req.headers.get("X-Cron-Secret");

  let providedToken: string | null = null;

  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    providedToken = authHeader.substring(7).trim();
  } else if (cronHeader) {
    providedToken = cronHeader.trim();
  }

  if (!providedToken) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized: missing worker authorization credentials.",
      code: "MISSING_WORKER_CREDENTIALS",
    };
  }

  // 2. Constant-time comparison
  const expectedSecretTrimmed = configuredSecret.trim();
  const providedBuffer = Buffer.from(providedToken, "utf8");
  const expectedBuffer = Buffer.from(expectedSecretTrimmed, "utf8");

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized: invalid worker authorization credentials.",
      code: "INVALID_WORKER_CREDENTIALS",
    };
  }

  return { ok: true };
}
