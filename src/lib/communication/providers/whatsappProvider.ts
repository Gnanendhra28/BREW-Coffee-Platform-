/**
 * BREW Coffee Platform — Phase 6.1 WhatsApp Provider Interface & Deterministic Mock
 * 
 * SIMULATION ONLY:
 * MockWhatsAppProvider enables deterministic unit/integration testing of WhatsApp transactional
 * message flows without calling the Meta Cloud API or dispatching messages to real phone numbers.
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
  private simulateFailure = false;
  private failureErrorMessage = "Simulated WhatsApp Meta Graph API error (500)";
  private defaultMessageStatus: WhatsAppMessageStatus = "delivered";
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

  async sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    // Validate template payload against Zod schema
    const validated = WhatsAppTemplateParamsSchema.parse(params);

    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const dispatchedAt = new Date().toISOString();
    const messageId = `mock_wa_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    this.dispatchedMessages.set(messageId, {
      params: validated,
      dispatchedAt,
      status: "accepted",
    });

    return {
      messageId,
      status: "accepted",
      dispatchedAt,
    };
  }

  async getMessageStatus(messageId: string): Promise<WhatsAppMessageStatusResult> {
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const record = this.dispatchedMessages.get(messageId);
    const status = record ? this.defaultMessageStatus : "failed";

    return {
      messageId,
      status,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Test inspection helper: returns count of dispatched mock messages.
   */
  getDispatchedMessageCount(): number {
    return this.dispatchedMessages.size;
  }

  /**
   * Test inspection helper: retrieves template name of last dispatched message without exposing PII.
   */
  getLastDispatchedTemplateName(): string | null {
    const entries = Array.from(this.dispatchedMessages.values());
    if (entries.length === 0) return null;
    return entries[entries.length - 1].params.templateName;
  }

  /**
   * Clears in-memory mock state.
   */
  reset(): void {
    this.simulateFailure = false;
    this.defaultMessageStatus = "delivered";
    this.dispatchedMessages.clear();
  }
}
