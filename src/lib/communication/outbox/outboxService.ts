/**
 * BREW Coffee Platform — Phase 6.5 Outbox Service & Background Execution Engine
 * 
 * Factory and lifecycle runner for background outbox workers.
 * Manages dependency wiring, batch boundaries, exponential backoff, and execution metrics.
 */

import { OutboxWorker, OutboxWorkerDependencies, OutboxWorkerOptions, OutboxCycleResult } from "./outboxWorker";
import {
  CommunicationOutboxRepository,
  FirestoreCommunicationOutboxRepository,
} from "./outboxRepository";
import { FirestoreVoiceSessionRepository } from "../../voiceBooking/repositories/firestoreSessionRepository";
import { FirestoreConsentRepository } from "../repositories/firestoreConsentRepository";
import { FirestoreDndRepository } from "../repositories/firestoreDndRepository";
import { getWhatsAppProvider } from "../providers/whatsappProviderSelector";
import { MockVoiceProvider } from "../providers/voiceProvider";
import { FirestoreVoiceCallAttemptRepository } from "../voice/callAttemptRepository";
import { getAdminFirestore } from "../../firebaseAdmin";

export interface OutboxRunResult {
  success: boolean;
  cyclesCompleted: number;
  durationMs: number;
  aggregateResult: OutboxCycleResult;
  timestamp: string;
}

export interface OutboxRunOptions {
  maxCycles?: number; // default: 1, max: 5
  batchSize?: number; // default: 10, max: 50
  leaseDurationMs?: number; // default: 60,000ms
  maxDurationMs?: number; // default: 25,000ms (clamped 1,000 - 25,000ms)
  workerId?: string;
  minCycleHeadroomMs?: number; // default: 3,000ms
  minDeliveryHeadroomMs?: number; // default: 2,000ms
}

/**
 * Creates a standard production-wired OutboxWorker instance using durable Firestore repositories.
 */
export function createStandardOutboxWorker(
  options: OutboxWorkerOptions = {},
  overrides: Partial<OutboxWorkerDependencies> = {}
): OutboxWorker {
  const db = getAdminFirestore();

  const outboxRepo: CommunicationOutboxRepository =
    overrides.outboxRepository ||
    (db
      ? new FirestoreCommunicationOutboxRepository()
      : (() => {
          throw new Error("Firestore Admin DB unavailable: cannot initialize standard outbox worker.");
        })());

  const sessionRepo =
    overrides.sessionRepository ||
    (db
      ? new FirestoreVoiceSessionRepository()
      : (() => {
          throw new Error("Firestore Admin DB unavailable: cannot initialize session repository.");
        })());

  const consentRepo =
    overrides.consentRepository ||
    (db
      ? new FirestoreConsentRepository()
      : (() => {
          throw new Error("Firestore Admin DB unavailable: cannot initialize consent repository.");
        })());

  const dndRepo =
    overrides.dndRepository ||
    (db
      ? new FirestoreDndRepository()
      : (() => {
          throw new Error("Firestore Admin DB unavailable: cannot initialize DND repository.");
        })());

  const whatsappProvider = overrides.whatsappProvider || getWhatsAppProvider();
  const voiceProvider = overrides.voiceProvider || new MockVoiceProvider();
  const callAttemptRepo =
    overrides.callAttemptRepository ||
    (db ? new FirestoreVoiceCallAttemptRepository() : undefined);

  const dependencies: OutboxWorkerDependencies = {
    outboxRepository: outboxRepo,
    sessionRepository: sessionRepo,
    consentRepository: consentRepo,
    dndRepository: dndRepo,
    whatsappProvider,
    voiceProvider,
    callAttemptRepository: callAttemptRepo,
    extractionProvider: overrides.extractionProvider,
    currentTimeProvider: overrides.currentTimeProvider,
    logger: overrides.logger || {
      info: (msg, meta) => console.log(`[OUTBOX_WORKER] ${msg}`, meta ? JSON.stringify(meta) : ""),
      warn: (msg, meta) => console.warn(`[OUTBOX_WORKER] ${msg}`, meta ? JSON.stringify(meta) : ""),
      error: (msg, meta) => console.error(`[OUTBOX_WORKER] ${msg}`, meta ? JSON.stringify(meta) : ""),
    },
  };

  return new OutboxWorker(dependencies, {
    workerId: options.workerId || `worker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    batchSize: Math.min(Math.max(1, options.batchSize || 10), 50),
    leaseDurationMs: options.leaseDurationMs || 60000,
    backoffBaseMs: options.backoffBaseMs || 5000,
  });
}

/**
 * Runs one or more worker cycles up to the configured limits or until queue is drained.
 * 
 * COOPERATIVE DEADLINE ENFORCEMENT & OPERATION BOUNDING:
 * In Node.js, asynchronous operations cannot be preemptively interrupted mid-flight.
 * Deadlines are enforced cooperatively at structured execution checkpoints:
 * 1. Cycle boundary: A new cycle is not started if remaining time < minCycleHeadroomMs.
 * 2. Delivery boundary: Inside a cycle, a new delivery is not started if remaining time < minDeliveryHeadroomMs.
 * 3. Batch release: Any claimed deliveries that cannot be safely started are released back to 'pending'.
 * 
 * Individual provider operations (such as Meta WhatsApp Cloud API network calls) MUST maintain
 * bounded timeouts internally (e.g. requestTimeoutMs) because the host runner cannot forcefully
 * abort an uncooperative, un-signaled external promise.
 */
export async function runOutboxWorkerCycles(
  worker: OutboxWorker,
  options: OutboxRunOptions = {}
): Promise<OutboxRunResult> {
  const startTime = Date.now();
  const maxCycles = Math.min(Math.max(1, options.maxCycles || 1), 5);
  const maxDurationMs = Math.min(Math.max(1000, options.maxDurationMs || 25000), 25000);
  const deadlineMs = startTime + maxDurationMs;
  const minCycleHeadroomMs = options.minCycleHeadroomMs ?? 3000;
  const minDeliveryHeadroomMs = options.minDeliveryHeadroomMs ?? 2000;

  const aggregate: OutboxCycleResult = {
    claimedCount: 0,
    dispatchedCount: 0,
    blockedCount: 0,
    failedCount: 0,
    permanentlyFailedCount: 0,
  };

  let cyclesCompleted = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // Check timeout headroom before starting next cycle
    const remainingTime = deadlineMs - Date.now();
    if (remainingTime < minCycleHeadroomMs) {
      break;
    }

    const cycleResult = await worker.processCycle({
      deadlineMs,
      minDeliveryHeadroomMs,
    });
    cyclesCompleted++;

    aggregate.claimedCount += cycleResult.claimedCount;
    aggregate.dispatchedCount += cycleResult.dispatchedCount;
    aggregate.blockedCount += cycleResult.blockedCount;
    aggregate.failedCount += cycleResult.failedCount;
    aggregate.permanentlyFailedCount += cycleResult.permanentlyFailedCount;

    // If no deliveries were eligible, stop early to avoid idle loops
    if (cycleResult.claimedCount === 0) {
      break;
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    success: true,
    cyclesCompleted,
    durationMs,
    aggregateResult: aggregate,
    timestamp: new Date().toISOString(),
  };
}
