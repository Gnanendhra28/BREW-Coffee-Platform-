/**
 * BREW Coffee Platform — Phase 6.1 Voice Provider Interface & Deterministic Mock
 * 
 * SIMULATION ONLY:
 * MockVoiceProvider enables deterministic unit/integration testing of voice booking workflows
 * without initiating outbound PSTN calls, purchasing telephony credits, or contacting external APIs.
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
  private simulateFailure = false;
  private failureErrorMessage = "Simulated telephony connection failure";
  private currentStatus: VoiceCallStatus = "in_progress";
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

  async startSession(params: VoiceSessionParams): Promise<VoiceSessionResult> {
    // Validate parameters at runtime
    const validated = VoiceSessionParamsSchema.parse(params);

    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const startedAt = new Date().toISOString();
    const providerCallId = `mock_call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    this.activeSessions.set(validated.sessionId, {
      params: validated,
      startedAt,
    });

    return {
      sessionId: validated.sessionId,
      providerCallId,
      status: "initiated",
      startedAt,
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
    };
  }

  async endSession(sessionId: string): Promise<VoiceSessionEndResult> {
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    this.activeSessions.delete(sessionId);

    return {
      sessionId,
      status: "ended",
      endedAt: new Date().toISOString(),
    };
  }

  /**
   * Test inspection helper: returns count of currently tracked mock sessions.
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Clears in-memory mock state.
   */
  reset(): void {
    this.simulateFailure = false;
    this.currentStatus = "in_progress";
    this.activeSessions.clear();
  }
}
