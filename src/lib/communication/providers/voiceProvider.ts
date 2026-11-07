/**
 * BREW Coffee Platform — Phase 6.1.1 / Phase 6.3.3.1 Voice Provider Interface & Deterministic Mock
 * 
 * SIMULATION ONLY:
 * MockVoiceProvider enables deterministic unit/integration testing of voice booking workflows
 * without initiating outbound PSTN calls, purchasing telephony credits, or contacting external APIs.
 * 
 * Simulated statuses (e.g. 'simulated_initiated') are explicitly labeled to prevent false claims
 * of real carrier connection or telephony dispatch.
 * 
 * IDEMPOTENCY ARCHITECTURE & RUNTIME LIMITATIONS:
 * 1. Single-Instance Deduplication: Same-instance repeated calls with identical idempotencyKey
 *    and matching canonical payload are deduplicated in-memory and return the cached result.
 * 2. Process Lifetime Limitation: The internal idempotency cache is backed by an ephemeral in-memory Map.
 *    Replacing, recycling, or restarting a provider instance or Node process completely loses its cache.
 * 3. Mock Boundary: This implementation is a deterministic testing mock, NOT a distributed, durable
 *    external provider idempotency guarantee.
 * 4. At-Least-Once Delivery: The Outbox pattern guarantees at-least-once delivery; downstream receivers
 *    and external carrier providers may observe duplicate attempts across worker or node restarts.
 * 5. Production Integration Requirement: Real telephony provider integrations (e.g. Twilio, Exotel)
 *    must separately establish and configure provider-side idempotency keys and TTL deduplication
 *    before production activation.
 */

import { createHash } from "crypto";
import {
  MockVoiceCallOutcome,
  VoiceCallStatus,
  VoiceProvider,
  VoiceSessionEndResult,
  VoiceSessionParams,
  VoiceSessionResult,
  VoiceSessionStatusResult,
} from "../types";
import { VoiceSessionParamsSchema } from "../schemas";
import { ProviderIdempotencyConflictError } from "../errors";
import { maskPhoneNumber } from "../config";

interface CachedVoiceResult {
  fingerprint: string;
  result: VoiceSessionResult;
  recordedAt: string;
}

/**
 * Computes canonical SHA-256 fingerprint of voice delivery payload.
 * Material fields: sessionId, phoneNumber, language.
 * Excluded non-delivery metadata: enquiryId, metadata, idempotencyKey.
 */
export function computeVoiceDeliveryFingerprint(params: VoiceSessionParams): string {
  const canonical = {
    sessionId: params.sessionId,
    phoneNumber: params.phoneNumber,
    language: params.language,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class MockVoiceProvider implements VoiceProvider {
  public readonly providerName = "mock-voice-provider";
  public readonly isSimulated = true;
  public readonly providerMode = "mock" as const;

  private simulateFailure = false;
  private failureErrorMessage = "Simulated telephony connection failure";
  private currentStatus: VoiceCallStatus = "simulated_in_progress";
  private nextOutcome: MockVoiceCallOutcome | null = null;
  private defaultOutcome: MockVoiceCallOutcome = "answered";
  private injectedCallId: string | null = null;
  private injectedTimestamp: string | null = null;
  private activeSessions: Map<string, { params: VoiceSessionParams; startedAt: string }> = new Map();
  private idempotencyCache: Map<string, CachedVoiceResult> = new Map();
  private customerTurnsMap: Map<string, string[]> = new Map();
  private harnessDefaultCustomerTurns: string[] = [];

  /**
   * Configures global fallback simulated customer utterances strictly for isolated test harnesses.
   * Normal worker execution does not use this fallback unless explicitly opted in.
   */
  setSimulatedCustomerTurns(turns: string[]): void {
    this.harnessDefaultCustomerTurns = [...turns];
  }

  /**
   * Explicit test harness API for configuring global fallback customer utterances.
   */
  setTestHarnessFallbackCustomerTurns(turns: string[]): void {
    this.harnessDefaultCustomerTurns = [...turns];
  }

  /**
   * Configures simulated customer utterances for a specific session ID.
   * Prevents using phone numbers or PII as session IDs.
   */
  setSessionCustomerTurns(sessionId: string, turns: string[]): void {
    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new Error("setSessionCustomerTurns requires a valid non-empty sessionId string.");
    }
    const trimmed = sessionId.trim();
    if (trimmed.startsWith("+") || /^\d{10,15}$/.test(trimmed)) {
      throw new Error("Security violation: Raw phone number cannot be used as sessionId for customer turns.");
    }
    this.customerTurnsMap.set(trimmed, [...turns]);
  }

  /**
   * Returns configured simulated customer utterances for a session.
   * By default, returns ONLY utterances explicitly registered for the given sessionId.
   * If sessionId is not found or not provided, returns empty array [], avoiding accidental inheritance.
   * Global fallback is only returned if explicitly opted in via options.allowGlobalFallback: true.
   */
  getSimulatedCustomerTurns(
    sessionId?: string,
    options?: { allowGlobalFallback?: boolean }
  ): string[] {
    if (sessionId && this.customerTurnsMap.has(sessionId)) {
      return [...(this.customerTurnsMap.get(sessionId) || [])];
    }
    if (options?.allowGlobalFallback === true) {
      return [...this.harnessDefaultCustomerTurns];
    }
    return [];
  }

  /**
   * Clears simulated customer turn scripts for a specific session.
   */
  clearSessionCustomerTurns(sessionId: string): void {
    this.customerTurnsMap.delete(sessionId);
  }

  /**
   * Clears all configured simulated customer turn scripts and harness fallbacks.
   */
  clearCustomerTurns(): void {
    this.customerTurnsMap.clear();
    this.harnessDefaultCustomerTurns = [];
  }

  /**
   * Configures whether subsequent operations should simulate network or provider failures.
   */
  setSimulateFailure(shouldFail: boolean, message?: string): void {
    this.simulateFailure = shouldFail;
    if (message) this.failureErrorMessage = message;
  }

  /**
   * Sets the deterministic call status returned by getStatus().
   */
  setSimulatedStatus(status: VoiceCallStatus): void {
    this.currentStatus = status;
  }

  /**
   * Configures the deterministic call outcome for the next startSession() call.
   * Single-use: resets to defaultOutcome after startSession() execution.
   */
  setNextOutcome(outcome: MockVoiceCallOutcome): void {
    this.nextOutcome = outcome;
  }

  /**
   * Sets the persistent default mock call outcome when nextOutcome is not set.
   */
  setDefaultOutcome(outcome: MockVoiceCallOutcome): void {
    this.defaultOutcome = outcome;
  }

  /**
   * Allows tests to inject a predictable providerCallId for assertion.
   */
  setNextCallId(id: string): void {
    this.injectedCallId = id;
  }

  /**
   * Allows tests to inject a predictable timestamp for deterministic verification.
   */
  setNextTimestamp(isoTimestamp: string): void {
    this.injectedTimestamp = isoTimestamp;
  }

  async startSession(params: VoiceSessionParams): Promise<VoiceSessionResult> {
    const validated = VoiceSessionParamsSchema.parse(params);

    // 1. Failure simulation must occur before cache insertion
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const fingerprint = computeVoiceDeliveryFingerprint(validated);

    // 2. Check provider-side idempotency cache if key provided
    if (validated.idempotencyKey) {
      const cached = this.idempotencyCache.get(validated.idempotencyKey);
      if (cached) {
        if (cached.fingerprint === fingerprint) {
          // Identical replay: return original result without duplicate simulation
          return cached.result;
        }
        // Conflicting payload with identical key: fail closed
        throw new ProviderIdempotencyConflictError(
          `Provider idempotency conflict: key '${validated.idempotencyKey}' already used with conflicting payload.`
        );
      }
    }

    const startedAt = this.injectedTimestamp || new Date().toISOString();
    const providerCallId =
      this.injectedCallId ||
      `mock_call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // Reset single-use injected overrides
    this.injectedCallId = null;
    this.injectedTimestamp = null;

    // Resolve deterministic mock call outcome
    const callOutcome: MockVoiceCallOutcome = this.nextOutcome ?? this.defaultOutcome;
    this.nextOutcome = null;

    // Update internal simulated status based on outcome
    this.currentStatus =
      callOutcome === "answered"
        ? "simulated_answered"
        : callOutcome === "busy"
        ? "simulated_busy"
        : callOutcome === "no_answer"
        ? "simulated_no_answer"
        : "simulated_failed";

    // Privacy safeguard: store only masked phone number in internal mock state
    this.activeSessions.set(validated.sessionId, {
      params: {
        ...validated,
        phoneNumber: maskPhoneNumber(validated.phoneNumber),
      },
      startedAt,
    });

    const result: VoiceSessionResult = {
      sessionId: validated.sessionId,
      providerCallId,
      status: callOutcome === "failed" ? "simulated_failed" : "simulated_initiated",
      callOutcome,
      startedAt,
      isSimulated: true,
      providerMode: "mock",
    };

    // 3. Cache successful delivery result
    if (validated.idempotencyKey) {
      this.idempotencyCache.set(validated.idempotencyKey, {
        fingerprint,
        result,
        recordedAt: new Date().toISOString(),
      });
    }

    return result;
  }

  async getStatus(sessionId: string): Promise<VoiceSessionStatusResult> {
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const session = this.activeSessions.get(sessionId);
    const providerCallId = session ? `mock_call_${sessionId}` : "mock_call_unknown";

    return {
      sessionId,
      providerCallId,
      status: this.currentStatus,
      durationSeconds: session ? 45 : 0,
      isSimulated: true,
      providerMode: "mock",
    };
  }

  async endSession(sessionId: string): Promise<VoiceSessionEndResult> {
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    this.activeSessions.delete(sessionId);

    return {
      sessionId,
      status: "simulated_ended",
      endedAt: new Date().toISOString(),
      isSimulated: true,
      providerMode: "mock",
    };
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  reset(): void {
    this.simulateFailure = false;
    this.failureErrorMessage = "Simulated telephony connection failure";
    this.currentStatus = "simulated_in_progress";
    this.nextOutcome = null;
    this.defaultOutcome = "answered";
    this.injectedCallId = null;
    this.injectedTimestamp = null;
    this.activeSessions.clear();
    this.idempotencyCache.clear();
  }
}
