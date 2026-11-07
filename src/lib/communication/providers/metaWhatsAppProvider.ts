/**
 * BREW Coffee Platform — Phase 6.4 / 6.4.1 Meta WhatsApp Cloud API Provider
 * 
 * Official server-side integration for Meta WhatsApp Graph Cloud API.
 * Strictly server-side execution. Credentials and bearer tokens are never exposed
 * to browser contexts, diagnostic responses, or application logs.
 * 
 * AT-LEAST-ONCE DISPATCH & IDEMPOTENCY BOUNDARIES:
 * 1. At-Least-Once Dispatch: The transactional outbox queue guarantees at-least-once dispatch.
 * 2. In-Memory Cache Optimization: This provider maintains an in-memory Map of dispatched
 *    results keyed by idempotencyKey. This is an ephemeral in-process optimization to handle
 *    immediate in-flight retries or duplicate executions within the same Node.js runtime.
 * 3. Process Lifetime & Restarts: This in-memory cache is NOT durable or crash-safe.
 *    Across worker restarts, serverless cold starts, or multi-instance scaling, the in-memory
 *    cache does not persist. Retrying an unacknowledged delivery after a crash may re-issue
 *    the HTTP request to Meta Graph API.
 * 4. Downstream Provider Uncertainty: Meta's Graph API /messages endpoint does not support an
 *    external Idempotency-Key header. If a network partition occurs after Meta accepts the message
 *    but before the HTTP response reaches the caller, a subsequent retry will send another message.
 *    Therefore, the system MUST NOT be described as guaranteeing distributed exactly-once delivery.
 * 5. Deterministic Outbox Identities: Deterministic attempt keys (e.g. del_..._call1) track
 *    per-attempt outbox dispatch state, while status tracking is updated via webhooks.
 * 6. Test-Recipient Protection: All Cloud API dispatches require an explicit, non-empty
 *    allowed-recipient list (META_WHATSAPP_ALLOWED_RECIPIENTS or allowedRecipients config).
 *    If the list is missing or empty, dispatch fails closed with error 131030. Unrestricted
 *    production messaging is strictly prevented.
 */

if (typeof window !== "undefined") {
  throw new Error("Security violation: MetaWhatsAppCloudProvider cannot run in browser context.");
}

import {
  WhatsAppMessageStatusResult,
  WhatsAppProvider,
  WhatsAppSendResult,
  WhatsAppTemplateComponent,
  WhatsAppTemplateParams,
} from "../types";
import { WhatsAppTemplateParamsSchema } from "../schemas";
import { ProviderIdempotencyConflictError, WhatsAppCloudApiError } from "../errors";
import { normalizePhoneNumber } from "../consent";
import { computeWhatsAppDeliveryFingerprint } from "./whatsappProvider";

export interface MetaWhatsAppCloudConfig {
  phoneNumberId?: string;
  accessToken?: string;
  businessAccountId?: string;
  apiVersion?: string;
  webhookVerifyToken?: string;
  allowedRecipients?: string[];
  fetchFn?: typeof fetch;
  isSimulated?: boolean;
  requestTimeoutMs?: number; // default: 10,000 ms (bounded provider operation timeout)
}

interface CachedMetaWhatsAppResult {
  fingerprint: string;
  result: WhatsAppSendResult;
  recordedAt: string;
}

export class MetaWhatsAppCloudProvider implements WhatsAppProvider {
  public readonly providerName = "meta-whatsapp-cloud-api";
  public readonly isSimulated: boolean;
  public readonly providerMode: "mock" | "simulated" | "production";

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly businessAccountId: string;
  private readonly apiVersion: string;
  private readonly allowedRecipients: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  private idempotencyCache: Map<string, CachedMetaWhatsAppResult> = new Map();
  private recordedMessageStatuses: Map<string, WhatsAppMessageStatusResult> = new Map();

  constructor(config: MetaWhatsAppCloudConfig = {}) {
    this.phoneNumberId =
      config.phoneNumberId ||
      process.env.META_WHATSAPP_PHONE_NUMBER_ID ||
      process.env.WHATSAPP_PHONE_NUMBER_ID ||
      "";

    this.accessToken =
      config.accessToken ||
      process.env.META_WHATSAPP_ACCESS_TOKEN ||
      process.env.WHATSAPP_ACCESS_TOKEN ||
      "";

    this.businessAccountId =
      config.businessAccountId ||
      process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ||
      process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ||
      "";

    this.apiVersion =
      config.apiVersion ||
      process.env.META_WHATSAPP_API_VERSION ||
      process.env.WHATSAPP_API_VERSION ||
      "v21.0";

    const rawTimeout = config.requestTimeoutMs ?? 10_000;
    this.requestTimeoutMs = Math.min(
      Math.max(50, Number.isFinite(rawTimeout) ? Math.floor(rawTimeout) : 10_000),
      30_000
    );

    const envAllowed = (
      process.env.META_WHATSAPP_ALLOWED_RECIPIENTS ||
      process.env.WHATSAPP_ALLOWED_RECIPIENTS ||
      ""
    )
      .split(",")
      .map((s) => s.trim().replace(/^\+/, ""))
      .filter((s) => s.length > 0);

    const explicitAllowed = (config.allowedRecipients || []).map((s) =>
      s.trim().replace(/^\+/, "")
    );

    this.allowedRecipients = new Set([...envAllowed, ...explicitAllowed]);
    this.fetchFn = config.fetchFn || globalThis.fetch;
    this.isSimulated = Boolean(config.isSimulated);
    this.providerMode = this.isSimulated ? "simulated" : "production";
  }

  /**
   * Dispatches a pre-approved template message via Meta WhatsApp Cloud API.
   */
  async sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    const normalizedTo = normalizePhoneNumber(params.to) || params.to;
    const validated = WhatsAppTemplateParamsSchema.parse({ ...params, to: normalizedTo });
    const fingerprint = computeWhatsAppDeliveryFingerprint(validated);

    // 1. Provider-side Idempotency Verification
    if (validated.idempotencyKey) {
      const cached = this.idempotencyCache.get(validated.idempotencyKey);
      if (cached) {
        if (cached.fingerprint === fingerprint) {
          // Identical replay: return previous authoritative response
          return cached.result;
        }
        // Conflicting payload with identical key: fail closed
        throw new ProviderIdempotencyConflictError(
          `Provider idempotency conflict: key '${validated.idempotencyKey}' already used with conflicting payload.`
        );
      }
    }

    // 2. Validate Server Credentials
    if (!this.accessToken || !this.phoneNumberId) {
      throw new WhatsAppCloudApiError(
        "Meta WhatsApp Cloud API credentials missing: META_WHATSAPP_PHONE_NUMBER_ID and META_WHATSAPP_ACCESS_TOKEN must be configured.",
        {
          statusCode: 500,
          code: 100,
          isRetryable: false,
        }
      );
    }

    // 3. Normalize Recipient Phone Number
    const normalizedE164 = normalizePhoneNumber(validated.to);
    if (!normalizedE164) {
      throw new WhatsAppCloudApiError(
        `Invalid recipient phone number format: cannot normalize '${validated.to}' to E.164.`,
        {
          statusCode: 400,
          code: 100,
          isRetryable: false,
        }
      );
    }

    // Meta Graph API expects digits without the leading '+'
    const recipientDigits = normalizedE164.replace(/^\+/, "");

    // 4. Test Recipient Protection Safeguard (Fail Closed)
    // Cloud API dispatch must fail closed if the allowed-recipient list is missing or empty.
    if (this.allowedRecipients.size === 0) {
      throw new WhatsAppCloudApiError(
        "Meta WhatsApp Cloud API safeguard: allowed-recipient list is missing or empty. All outbound Cloud API dispatches fail closed.",
        {
          statusCode: 403,
          code: 131030,
          isRetryable: false,
        }
      );
    }

    // Reject every recipient not explicitly listed.
    if (!this.allowedRecipients.has(recipientDigits)) {
      throw new WhatsAppCloudApiError(
        `Meta Test Recipient Safeguard: Recipient number is not registered in the allowed test recipients list.`,
        {
          statusCode: 403,
          code: 131030,
          isRetryable: false,
        }
      );
    }

    // 5. Construct Meta Graph API Payload
    const metaPayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientDigits,
      type: "template",
      template: {
        name: validated.templateName,
        language: {
          code: this.formatLanguageCode(validated.language),
        },
        components: this.formatComponents(validated.components),
      },
    };

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

    let response: Response;
    let responseText = "";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(metaPayload),
        signal: controller.signal,
      });

      // Phase 6.5.2: Keep the request timeout active until the response body has been consumed.
      // In Node.js / fetch, await fetchFn resolves headers, but the body streams asynchronously.
      // Consuming the body inside this try block ensures stalled or hanging body streams abort
      // and remain retryable.
      responseText = await response.text();
    } catch (networkErr: unknown) {
      const isAbort =
        (networkErr as { name?: string })?.name === "AbortError" ||
        controller.signal.aborted;
      const msg = isAbort
        ? `Request timed out after ${this.requestTimeoutMs}ms contacting Meta Cloud API`
        : networkErr instanceof Error
        ? networkErr.message
        : "Network error contacting Meta Cloud API";

      throw new WhatsAppCloudApiError(`Meta Cloud API transport error: ${msg}`, {
        statusCode: isAbort ? 504 : 503,
        isRetryable: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // 6. Handle Error Responses
    if (!response.ok) {
      let errorBody: Record<string, unknown> = {};
      try {
        errorBody = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : {};
      } catch {
        // Fallback for non-JSON response
      }

      const metaError = (errorBody.error as Record<string, unknown>) || {};
      const errorCode = typeof metaError.code === "number" ? metaError.code : response.status;
      const errorSubcode = typeof metaError.error_subcode === "number" ? metaError.error_subcode : undefined;
      const errorType = typeof metaError.type === "string" ? metaError.type : undefined;
      const fbtraceId = typeof metaError.fbtrace_id === "string" ? metaError.fbtrace_id : undefined;

      const rawMsg =
        typeof metaError.message === "string"
          ? metaError.message
          : `HTTP ${response.status} ${response.statusText}`;

      // Strictly sanitize raw message: never permit auth tokens in thrown errors
      const sanitizedMsg = rawMsg
        .replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, "Bearer [REDACTED]")
        .replace(/EAAG[A-Za-z0-9]+/gi, "[REDACTED_TOKEN]");

      // Categorize retryability:
      // - 130429: Rate limit exceeded (retryable)
      // - 5xx: Server errors / network glitches (retryable)
      // - 131030: Recipient not in allowed list (non-retryable)
      // - 190: Access token expired / invalid (non-retryable)
      // - 100: Invalid parameter / template not found (non-retryable)
      const isRetryable = errorCode === 130429 || response.status >= 500;

      throw new WhatsAppCloudApiError(
        `Meta WhatsApp Cloud API error: [${errorCode}] ${sanitizedMsg}`,
        {
          statusCode: response.status,
          code: errorCode,
          subcode: errorSubcode,
          type: errorType,
          fbtraceId,
          isRetryable,
        }
      );
    }

    // 7. Parse Successful Meta Response
    let responseData: { messages?: Array<{ id: string }> } = {};
    try {
      responseData = responseText
        ? (JSON.parse(responseText) as { messages?: Array<{ id: string }> })
        : {};
    } catch {
      // Handled below
    }

    const messageId =
      responseData.messages?.[0]?.id ||
      `wamid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const dispatchedAt = new Date().toISOString();

    const result: WhatsAppSendResult = {
      messageId,
      status: "accepted",
      dispatchedAt,
      isSimulated: this.isSimulated,
      providerMode: this.providerMode,
    };

    // 8. Cache for Idempotency
    if (validated.idempotencyKey) {
      this.idempotencyCache.set(validated.idempotencyKey, {
        fingerprint,
        result,
        recordedAt: dispatchedAt,
      });
    }

    // Record initial status
    this.recordedMessageStatuses.set(messageId, {
      messageId,
      status: "accepted",
      timestamp: dispatchedAt,
      isSimulated: this.isSimulated,
      providerMode: this.providerMode,
    });

    return result;
  }

  /**
   * Retrieves message delivery status.
   */
  async getMessageStatus(messageId: string): Promise<WhatsAppMessageStatusResult> {
    const existing = this.recordedMessageStatuses.get(messageId);
    if (existing) {
      return existing;
    }

    return {
      messageId,
      status: "sent",
      timestamp: new Date().toISOString(),
      isSimulated: this.isSimulated,
      providerMode: this.providerMode,
    };
  }

  /**
   * Ingests delivery status updates (e.g. from incoming Meta webhooks).
   */
  recordWebhookStatus(messageId: string, status: WhatsAppMessageStatusResult["status"]): void {
    this.recordedMessageStatuses.set(messageId, {
      messageId,
      status,
      timestamp: new Date().toISOString(),
      isSimulated: this.isSimulated,
      providerMode: this.providerMode,
    });
  }

  /**
   * Formats components into Meta's required JSON structure.
   */
  private formatComponents(components: WhatsAppTemplateComponent[]) {
    return components.map((comp) => {
      const formattedParams = comp.parameters.map((param) => {
        if (param.type === "currency") {
          return { type: "currency", currency: param.text || "INR" };
        }
        if (param.type === "date_time") {
          return { type: "date_time", date_time: { fallback_value: param.text || "" } };
        }
        if (param.type === "document" && param.document) {
          return {
            type: "document",
            document: {
              link: param.document.link,
              filename: param.document.filename,
            },
          };
        }
        return {
          type: "text",
          text: String(param.text ?? ""),
        };
      });

      return {
        type: comp.type,
        ...(comp.subType ? { sub_type: comp.subType } : {}),
        ...(typeof comp.index === "number" ? { index: comp.index } : {}),
        parameters: formattedParams,
      };
    });
  }

  /**
   * Normalizes BCP-47 or ISO language code for Meta template lookup.
   */
  private formatLanguageCode(code: string): string {
    const normalized = (code || "en").trim().toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en_US";
    if (normalized === "hi" || normalized.startsWith("hi-")) return "hi";
    if (normalized === "te" || normalized.startsWith("te-")) return "te";
    return normalized.replace("-", "_");
  }

  /**
   * Diagnostic helper to inspect active credentials without leaking secrets.
   */
  getDiagnosticInfo(): Record<string, unknown> {
    return {
      providerName: this.providerName,
      phoneNumberIdConfigured: Boolean(this.phoneNumberId),
      accessTokenConfigured: Boolean(this.accessToken),
      businessAccountIdConfigured: Boolean(this.businessAccountId),
      apiVersion: this.apiVersion,
      allowedRecipientsCount: this.allowedRecipients.size,
      providerMode: this.providerMode,
      isSimulated: this.isSimulated,
    };
  }
}
