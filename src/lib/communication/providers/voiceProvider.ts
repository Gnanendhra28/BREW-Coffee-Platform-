/**
 * BREW Coffee Platform — Phase 6.1.1 Voice Provider Interface & Deterministic Mock
 * 
 * SIMULATION ONLY:
 * MockVoiceProvider enables deterministic unit/integration testing of voice booking workflows
 * without initiating outbound PSTN calls, purchasing telephony credits, or contacting external APIs.
 * 
 * Simulated statuses (e.g. 'simulated_initiated') are explicitly labeled to prevent false claims
 * of real carrier connection or telephony dispatch.
 */

import {
  VoiceCallStatus,
  VoiceProvider,
  VoiceSessionEndResult,
  VoiceSessionParams,
  VoiceSessionResult,
  VoiceSessionStatusResult,
} from "../types";
import { VoiceSessionParamsSchema } from "../schemas";

export class MockVoiceProvider implements VoiceProvider {
  public readonly providerName = "mock-voice-provider";
  public readonly isSimulated = true;
  public readonly providerMode = "mock" as const;

  private simulateFailure = false;
  private failureErrorMessage = "Simulated telephony connection failure";
  private currentStatus: VoiceCallStatus = "simulated_in_progress";
  private injectedCallId: string | null = null;
  private injectedTimestamp: string | null = null;
  private activeSessions: Map<string, { params: VoiceSessionParams; startedAt: string }> = new Map();

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

    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const startedAt = this.injectedTimestamp || new Date().toISOString();
    const providerCallId =
      this.injectedCallId ||
      `mock_call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // Reset single-use injected overrides
    this.injectedCallId = null;
    this.injectedTimestamp = null;

    this.activeSessions.set(validated.sessionId, {
      params: validated,
      startedAt,
    });

    return {
      sessionId: validated.sessionId,
      providerCallId,
      status: "simulated_initiated",
      startedAt,
      isSimulated: true,
      providerMode: "mock",
    };
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
    this.currentStatus = "simulated_in_progress";
    this.injectedCallId = null;
    this.injectedTimestamp = null;
    this.activeSessions.clear();
  }
}
