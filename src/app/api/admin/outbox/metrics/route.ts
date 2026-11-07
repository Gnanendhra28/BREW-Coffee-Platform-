/**
 * BREW Coffee Platform — Phase 6.5 Outbox Metrics & Operational Monitoring Endpoint
 * 
 * Provides real-time operational visibility into the communication outbox:
 * - Pending, processing, dispatched, blocked, failed, and permanently failed delivery counts.
 * - Stale/expired lease detection.
 * - Oldest pending delivery age.
 * - Channel breakdowns (whatsapp, voice).
 * - Failure code distribution.
 * 
 * Security Invariants:
 * 1. Restricted to authenticated staff (via brew_session / inspectStaffSession) OR
 *    authorized workers (via CRON_SECRET / verifyWorkerAuth).
 * 2. Never exposes customer phone numbers, recipient identities, or PII.
 * 3. Fails closed (503) if Firestore is unavailable in deployed environments.
 */

import { NextRequest, NextResponse } from "next/server";
import { inspectStaffSession } from "../../../../../lib/auth/adminAuth";
import { verifyWorkerAuth } from "../../../../../lib/communication/outbox/workerAuth";
import {
  CommunicationOutboxRepository,
  FirestoreCommunicationOutboxRepository,
} from "../../../../../lib/communication/outbox/outboxRepository";
import { getAdminFirestore } from "../../../../../lib/firebaseAdmin";
import {
  getMetricsOutboxRepoOverride,
  getMetricsDbProviderOverride,
} from "../../../../../lib/communication/testingHooks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // 1. Dual Authentication: Worker Bearer Token OR Staff Admin Session
    const workerAuth = verifyWorkerAuth(req);
    let isAuthorized = workerAuth.ok;

    if (!isAuthorized) {
      const staffAuth = await inspectStaffSession(req);
      if (staffAuth.ok) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: "Unauthorized: valid staff session or worker authorization secret required." },
        { status: 401 }
      );
    }

    // 2. Resolve Repository
    let repo: CommunicationOutboxRepository;
    const testOutboxRepoOverride = getMetricsOutboxRepoOverride();
    const testDbProvider = getMetricsDbProviderOverride();
    if (testOutboxRepoOverride) {
      repo = testOutboxRepoOverride;
    } else {
      const db = testDbProvider ? testDbProvider() : getAdminFirestore();
      if (!db) {
        console.error("[OUTBOX_METRICS] Firestore unavailable in deployed environment.");
        return NextResponse.json(
          { error: "Service unavailable: Firestore database not configured" },
          { status: 503 }
        );
      }
      const activeDbProvider = testDbProvider;
      repo = new FirestoreCommunicationOutboxRepository(
        undefined,
        activeDbProvider ? (() => activeDbProvider() as FirebaseFirestore.Firestore) : undefined
      );
    }

    // 3. Compute Metrics
    if (typeof repo.getMetrics !== "function") {
      return NextResponse.json(
        { error: "Repository does not support metrics computation." },
        { status: 500 }
      );
    }

    const metrics = await repo.getMetrics(new Date());

    return NextResponse.json({
      success: true,
      metrics,
    });
  } catch (error) {
    console.error("[OUTBOX_METRICS] Failed to compute outbox metrics:", error);
    return NextResponse.json(
      { error: "Internal server error computing outbox metrics" },
      { status: 500 }
    );
  }
}
