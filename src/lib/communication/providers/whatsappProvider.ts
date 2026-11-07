/**
 * BREW Coffee Platform — Phase 6.1.1 / Phase 6.3.3.1 WhatsApp Provider Interface & Deterministic Mock
 * 
 * SIMULATION ONLY:
 * MockWhatsAppProvider enables deterministic unit/integration testing of WhatsApp transactional
 * message flows without calling the Meta Cloud API or dispatching messages to real phone numbers.
 * 
 * Simulated statuses (e.g. 'simulated_accepted', 'simulated_delivered') are explicitly labeled
 * to prevent false claims of real Meta Cloud API dispatch or delivery.
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
 * 5. Production Integration Requirement: Real WhatsApp provider integrations (e.g. Meta Graph Cloud API)
 *    must separately establish and configure provider-side idempotency keys and TTL deduplication
 *    before production activation.
 */

import { createHash } from "crypto";
import {
  WhatsAppMessageStatus,
  WhatsAppMessageStatusResult,
  WhatsAppProvider,
  WhatsAppSendResult,
  WhatsAppTemplateParams,
} from "../types";
import { WhatsAppTemplateParamsSchema } from "../schemas";
import { ProviderIdempotencyConflictError } from "../errors";

interface CachedWhatsAppResult {
  fingerprint: string;
  result: WhatsAppSendResult;
  recordedAt: string;
}

/**
 * Computes canonical SHA-256 fingerprint of WhatsApp delivery payload.
 * Material fields: to, templateName, language, components.
 * Excluded non-delivery metadata: enquiryId, metadata, idempotencyKey.
 */
export function computeWhatsAppDeliveryFingerprint(params: WhatsAppTemplateParams): string {
  const canonical = {
    to: params.to,
    templateName: params.templateName,
    language: params.language,
    components: params.components,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

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
  private idempotencyCache: Map<string, CachedWhatsAppResult> = new Map();

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

    // 1. Failure simulation must occur before cache insertion
    if (this.simulateFailure) {
      throw new Error(this.failureErrorMessage);
    }

    const fingerprint = computeWhatsAppDeliveryFingerprint(validated);

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

    const result: WhatsAppSendResult = {
      messageId,
      status: "simulated_accepted",
      dispatchedAt,
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
    this.idempotencyCache.clear();
  }
}
