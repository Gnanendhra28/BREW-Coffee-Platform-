/**
 * BREW Coffee Platform — Phase 6.1.1 WhatsApp Provider Interface & Deterministic Mock
 * 
 * SIMULATION ONLY:
 * MockWhatsAppProvider enables deterministic unit/integration testing of WhatsApp transactional
 * message flows without calling the Meta Cloud API or dispatching messages to real phone numbers.
 * 
 * Simulated statuses (e.g. 'simulated_accepted', 'simulated_delivered') are explicitly labeled
 * to prevent false claims of real Meta Cloud API dispatch or delivery.
 */

import {
  WhatsAppMessageStatus,
  WhatsAppMessageStatusResult,
  WhatsAppProvider,
  WhatsAppSendResult,
  WhatsAppTemplateParams,
} from "../types";
import { WhatsAppTemplateParamsSchema } from "../schemas";

export class MockWhatsAppProvider implements WhatsAppProvider {
  public readonly providerName = "mock-whatsapp-provider";
  public readonly isSimulated = true;
  public readonly providerMode = "mock" as const;

  private simulateFailure = false;
  private failureErrorMessage = "Simulated WhatsApp Meta Graph API error (500)";
  private defaultMessageStatus: WhatsAppMessageStatus = "simulated_delivered";
  private injectedMessageId: string | null = null;
  private injectedTimestamp: string | null = null;
  private dispatchedMessages: Map<
    string,
    { params: WhatsAppTemplateParams; dispatchedAt: string; status: WhatsAppMessageStatus }
  > = new Map();

  /**
   * Configures whether subsequent operations should simulate network or provider failures.
   */
  setSimulateFailure(shouldFail: boolean, message?: string): void {
    this.simulateFailure = shouldFail;
    if (message) this.failureErrorMessage = message;
  }

  /**
   * Sets the deterministic message status returned by getMessageStatus().
   */
  setSimulatedStatus(status: WhatsAppMessageStatus): void {
    this.defaultMessageStatus = status;
  }

  /**
   * Allows tests to inject a predictable message ID for assertion.
   */
  setNextMessageId(id: string): void {
    this.injectedMessageId = id;
  }

  /**
   * Allows tests to inject a predictable timestamp for deterministic verification.
   */
  setNextTimestamp(isoTimestamp: string): void {
    this.injectedTimestamp = isoTimestamp;
  }

  async sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    const validated = WhatsAppTemplateParamsSchema.parse(params);

    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const dispatchedAt = this.injectedTimestamp || new Date().toISOString();
    const messageId =
      this.injectedMessageId ||
      `mock_wa_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Reset single-use injected overrides
    this.injectedMessageId = null;
    this.injectedTimestamp = null;

    this.dispatchedMessages.set(messageId, {
      params: validated,
      dispatchedAt,
      status: "simulated_accepted",
    });

    return {
      messageId,
      status: "simulated_accepted",
      dispatchedAt,
      isSimulated: true,
      providerMode: "mock",
    };
  }

  async getMessageStatus(messageId: string): Promise<WhatsAppMessageStatusResult> {
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const record = this.dispatchedMessages.get(messageId);
    const status = record ? this.defaultMessageStatus : "simulated_failed";

    return {
      messageId,
      status,
      timestamp: new Date().toISOString(),
      isSimulated: true,
      providerMode: "mock",
    };
  }

  getDispatchedMessageCount(): number {
    return this.dispatchedMessages.size;
  }

  getLastDispatchedTemplateName(): string | null {
    const entries = Array.from(this.dispatchedMessages.values());
    if (entries.length === 0) return null;
    return entries[entries.length - 1].params.templateName;
  }

  reset(): void {
    this.simulateFailure = false;
    this.defaultMessageStatus = "simulated_delivered";
    this.injectedMessageId = null;
    this.injectedTimestamp = null;
    this.dispatchedMessages.clear();
  }
}
