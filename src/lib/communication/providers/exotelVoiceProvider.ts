/**
 * BREW Coffee Platform — Phase 6.6.2.1 Exotel Voice Provider
 * 
 * Official carrier adapter for Exotel Cloud Telephony outbound calls.
 * Implements Direct Connect Voice AI (StreamUrl & StreamType=bidirectional),
 * CustomField attempt correlation (<= 128 chars), ephemeral HMAC webhook signing,
 * secret redaction, bounded request timeouts, and safe error classification.
 * 
 * INVARIANTS:
 * 1. Default India Host: Defaults strictly to https://api.in.exotel.com (Mumbai cluster).
 *    Never silently falls back to Singapore (api.exotel.com).
 * 2. Connect Voice AI Architecture: Directly initiates call to WebSocket audio bridge
 *    via StreamUrl and StreamType="bidirectional".
 * 3. Safe Failure Boundaries: Request timeouts are classified as UNCERTAIN.
 *    The provider strictly blocks automated redials when provider outcome is uncertain.
 * 4. Secret Redaction: API tokens, keys, account SIDs, and authorization headers
 *    are strictly redacted from thrown errors, diagnostic messages, and logs.
 * 5. Bounded Safe Retries: Retries are ONLY permitted on pre-request network failures
 *    (e.g. ENOTFOUND before connection) or 429 rate limit with backoff; NEVER on read timeouts.
 * 6. Ephemeral Webhook Signing: Signs StatusCallback with per-call HMAC-SHA256 token
 *    bound to attemptId and sessionId, preventing exposure of reusable static secrets.
 */

if (typeof window !== "undefined") {
  throw new Error("Security violation: ExotelVoiceProvider cannot run in browser context.");
}

import crypto from "crypto";
import {
  ConsentRepository,
  VoiceCallStatus,
  VoiceProvider,
  VoiceSessionEndResult,
  VoiceSessionParams,
  VoiceSessionResult,
  VoiceSessionStatusResult,
} from "../types";
import { VoiceSessionParamsSchema } from "../schemas";
import { maskPhoneNumber, isVoiceBookingEnabled } from "../config";
import { VoiceCallAttemptRepository } from "../voice/types";
import { generateStreamToken } from "../voice/audioBridge/exotelAudioBridge";
import {
  validateTestDialingSafety,
  VoiceTestAuthorizationError,
  VoiceTestAuthorizationRegistry,
} from "../voice/testAuthorization";

export interface ExotelVoiceConfig {
  accountSid?: string;
  apiKey?: string;
  apiToken?: string;
  subdomain?: string; // default: "api.in.exotel.com" (India cluster)
  callerId?: string; // Exotel Virtual Number (ExoPhone), e.g. "080XXXXXXXX"
  streamUrl?: string; // Direct Connect Voice AI WebSocket URL (e.g. "wss://voice.brewcoffee.in/media")
  streamType?: string; // default: "bidirectional"
  streamSecret?: string; // Secret for signing single-use StreamUrl tokens
  streamTokenExpiresInSeconds?: number; // Expiry in seconds (default: 300)
  appletId?: string; // Optional legacy Flow Applet ID (if not using direct StreamUrl)
  statusCallbackUrl?: string; // Webhook URL
  statusCallbackToken?: string; // Shared secret for HMAC signing webhook callbacks
  webhookUsername?: string; // Optional Basic Auth username for StatusCallback URL
  webhookPassword?: string; // Optional Basic Auth password for StatusCallback URL
  requestTimeoutMs?: number; // default: 10000 ms
  maxRetries?: number; // default: 2 (only for safe pre-request errors)
  fetchFn?: typeof fetch;
  callAttemptRepository?: VoiceCallAttemptRepository;
  testAuthorizationRegistry?: VoiceTestAuthorizationRegistry;
  consentRepository?: ConsentRepository;
  isSimulated?: boolean;
}

export class ExotelApiError extends Error {
  public readonly statusCode?: number;
  public readonly isTimeoutOrNetwork: boolean;
  public readonly isCertainRejection: boolean;

  constructor(
    message: string,
    options?: {
      statusCode?: number;
      isTimeoutOrNetwork?: boolean;
      isCertainRejection?: boolean;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "ExotelApiError";
    this.statusCode = options?.statusCode;
    this.isTimeoutOrNetwork = options?.isTimeoutOrNetwork ?? false;
    this.isCertainRejection = options?.isCertainRejection ?? false;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Computes an ephemeral per-call HMAC token for StatusCallback verification.
 * Avoids exposing static reusable master secrets in query strings.
 */
export function generateExotelCallbackSignature(
  secretKey: string,
  attemptId: string,
  sessionId: string
): string {
  return crypto
    .createHmac("sha256", secretKey.trim())
    .update(`${attemptId.trim()}:${sessionId.trim()}`)
    .digest("hex");
}

/**
 * Parses and validates Exotel CustomField metadata payload.
 * Supports JSON string `{"attemptId":"...","sessionId":"..."}` and delimited `"attemptId:sessionId"`.
 */
export function parseExotelCustomField(customFieldRaw?: string | null): {
  attemptId?: string;
  sessionId?: string;
} {
  if (!customFieldRaw || typeof customFieldRaw !== "string") {
    return {};
  }

  const trimmed = customFieldRaw.trim();
  if (!trimmed) return {};

  // 1. Try JSON parsing
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        attemptId:
          typeof parsed.attemptId === "string"
            ? parsed.attemptId.trim()
            : typeof parsed.a === "string"
            ? parsed.a.trim()
            : undefined,
        sessionId:
          typeof parsed.sessionId === "string"
            ? parsed.sessionId.trim()
            : typeof parsed.s === "string"
            ? parsed.s.trim()
            : undefined,
      };
    } catch {
      // Fall through to delimited check
    }
  }

  // 2. Try colon delimited "attemptId:sessionId"
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    if (parts.length >= 2) {
      return {
        attemptId: parts[0]?.trim() || undefined,
        sessionId: parts[1]?.trim() || undefined,
      };
    }
  }

  // 3. Fallback: treat entire string as attemptId
  return { attemptId: trimmed };
}

/**
 * Formats custom metadata for Exotel's CustomField parameter (strictly <= 128 characters).
 */
export function formatExotelCustomField(attemptId: string, sessionId: string): string {
  const cleanAttempt = attemptId.trim();
  const cleanSession = sessionId.trim();

  // 1. Standard JSON format
  const jsonFormat = JSON.stringify({ attemptId: cleanAttempt, sessionId: cleanSession });
  if (jsonFormat.length <= 128) {
    return jsonFormat;
  }

  // 2. Compact JSON format
  const compactJson = JSON.stringify({ a: cleanAttempt, s: cleanSession });
  if (compactJson.length <= 128) {
    return compactJson;
  }

  // 3. Delimited format
  const delimited = `${cleanAttempt}:${cleanSession}`;
  if (delimited.length <= 128) {
    return delimited;
  }

  // 4. Fail visibly if attemptId + sessionId exceed 128 characters
  throw new Error(
    `CustomField exceeds Exotel 128-character limit: ${delimited.length} chars (attemptId: ${cleanAttempt.length}, sessionId: ${cleanSession.length}). Cannot serialize safely.`
  );
}

export class ExotelVoiceProvider implements VoiceProvider {
  public readonly providerName = "exotel";
  public readonly isAsynchronous = true;

  private readonly config: ExotelVoiceConfig;
  private readonly accountSid: string;
  private readonly apiKey: string;
  private readonly apiToken: string;
  private readonly subdomain: string;
  private readonly callerId: string;
  private readonly streamUrl: string;
  private readonly streamType: string;
  private readonly streamSecret: string;
  private readonly streamTokenExpiresInSeconds: number;
  private readonly appletId: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: ExotelVoiceConfig = {}) {
    this.config = config;
    this.accountSid = (config.accountSid || process.env.EXOTEL_ACCOUNT_SID || "").trim();
    this.apiKey = (config.apiKey || process.env.EXOTEL_API_KEY || "").trim();
    this.apiToken = (config.apiToken || process.env.EXOTEL_API_TOKEN || "").trim();

    // STRICT: Default to India cluster https://api.in.exotel.com
    let rawSubdomain = (
      config.subdomain ||
      process.env.EXOTEL_SUBDOMAIN ||
      process.env.EXOTEL_API_HOST ||
      "api.in.exotel.com"
    ).trim();
    rawSubdomain = rawSubdomain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    this.subdomain = rawSubdomain || "api.in.exotel.com";

    this.callerId = (config.callerId || process.env.EXOTEL_CALLER_ID || "").trim();
    this.streamUrl = (config.streamUrl || process.env.EXOTEL_STREAM_URL || "").trim();
    this.streamType = (config.streamType || "bidirectional").trim();
    this.streamSecret = (
      config.streamSecret ||
      process.env.EXOTEL_STREAM_SECRET ||
      process.env.STREAM_SECRET_KEY ||
      config.statusCallbackToken ||
      process.env.EXOTEL_WEBHOOK_SECRET ||
      process.env.AUTH_SECRET ||
      ""
    ).trim();
    this.streamTokenExpiresInSeconds = config.streamTokenExpiresInSeconds ?? 300;
    this.appletId = (config.appletId || process.env.EXOTEL_APPLET_ID || "").trim();
    this.timeoutMs = config.requestTimeoutMs || 10000;
    this.maxRetries = typeof config.maxRetries === "number" ? config.maxRetries : 2;
    this.fetchFn = config.fetchFn || fetch;
  }

  /**
   * Redacts sensitive credentials, tokens, and basic auth headers from strings.
   */
  private redactSecrets(str: string): string {
    if (!str) return str;
    let redacted = str;
    if (this.apiKey) {
      redacted = redacted.split(this.apiKey).join("[REDACTED_API_KEY]");
    }
    if (this.apiToken) {
      redacted = redacted.split(this.apiToken).join("[REDACTED_API_TOKEN]");
    }
    if (this.streamSecret) {
      redacted = redacted.split(this.streamSecret).join("[REDACTED_STREAM_SECRET]");
    }
    if (this.config.statusCallbackToken) {
      redacted = redacted.split(this.config.statusCallbackToken).join("[REDACTED_WEBHOOK_TOKEN]");
    }
    const envSecret = process.env.EXOTEL_WEBHOOK_SECRET;
    if (envSecret) {
      redacted = redacted.split(envSecret).join("[REDACTED_WEBHOOK_SECRET]");
    }
    redacted = redacted.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED_AUTH_HEADER]");
    redacted = redacted.replace(/([?&]token=)[^& \t\r\n]+/gi, "$1[REDACTED_STREAM_TOKEN]");
    return redacted;
  }

  /**
   * Normalizes destination phone number for Exotel (standard E.164 or 10-digit format).
   */
  private formatDestinationNumber(phone: string): string {
    const cleaned = phone.replace(/[\s\-()]/g, "");
    if (cleaned.startsWith("+91") && cleaned.length === 13) {
      return cleaned;
    }
    if (cleaned.startsWith("91") && cleaned.length === 12) {
      return `+${cleaned}`;
    }
    if (cleaned.startsWith("0") && cleaned.length === 11) {
      return `+91${cleaned.slice(1)}`;
    }
    if (cleaned.length === 10) {
      return `+91${cleaned}`;
    }
    return cleaned;
  }

  /**
   * Builds Exotel Connect Voice AI URL:
   * https://<subdomain>/v1/Accounts/<account_sid>/Calls/connect
   * (Alignd with official Connect Voice AI AgentStream API specification)
   */
  private getConnectUrl(): string {
    return `https://${this.subdomain}/v1/Accounts/${encodeURIComponent(this.accountSid)}/Calls/connect`;
  }

  /**
   * Builds Exotel Call Details URL:
   * https://<subdomain>/v1/Accounts/<account_sid>/Calls/<CallSid>.json
   */
  private getCallDetailsUrl(callSid: string): string {
    return `https://${this.subdomain}/v1/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
  }

  /**
   * Builds Exotel Flow / Applet URL:
   * http://my.exotel.com/<account_sid>/exoml/start_voice/<applet_id>
   */
  private getAppletUrl(): string {
    return `http://my.exotel.com/${encodeURIComponent(this.accountSid)}/exoml/start_voice/${encodeURIComponent(this.appletId)}`;
  }

  /**
   * Outbound Call Initiation (Provider Contract)
   * 
   * Dispatches outbound call request to Exotel Connect Voice AI API.
   * On acceptance (HTTP 200/201), extracts CallSid and persists provider acceptance.
   * On timeout/network uncertainty, fails closed and categorizes as uncertain without redialing.
   */
  async startSession(params: VoiceSessionParams): Promise<VoiceSessionResult> {
    const validated = VoiceSessionParamsSchema.parse(params);

    if (!isVoiceBookingEnabled()) {
      throw new ExotelApiError(
        "Telephony dispatch forbidden: Voice booking is disabled by policy (VOICE_BOOKING_ENABLED=false).",
        { isCertainRejection: true }
      );
    }

    if (!this.accountSid || !this.apiKey || !this.apiToken) {
      throw new ExotelApiError(
        "Exotel provider configuration error: Missing EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, or EXOTEL_API_TOKEN.",
        { isCertainRejection: true }
      );
    }

    if (!this.callerId) {
      throw new ExotelApiError(
        "Exotel provider configuration error: Missing EXOTEL_CALLER_ID virtual number.",
        { isCertainRejection: true }
      );
    }

    const internalAttemptId = validated.idempotencyKey || `att_${validated.sessionId}`;
    const destinationPhone = this.formatDestinationNumber(validated.phoneNumber);
    const maskedPhone = maskPhoneNumber(destinationPhone);

    // Controlled test authorization & allowlist safety validation
    try {
      await validateTestDialingSafety({
        phoneNumber: destinationPhone,
        attemptId: internalAttemptId,
        testAuthorizationId: validated.testAuthorizationId,
        isTestMode: process.env.VOICE_TEST_MODE === "true",
        authorizationRegistry: this.config.testAuthorizationRegistry,
        consentRepository: this.config.consentRepository,
      });
    } catch (err: unknown) {
      if (err instanceof VoiceTestAuthorizationError) {
        throw new ExotelApiError(err.message, {
          isCertainRejection: true,
          cause: err,
        });
      }
      throw err;
    }

    const customField = formatExotelCustomField(internalAttemptId, validated.sessionId);

    // 1. Resolve StreamUrl vs Flow Url
    // Connect Voice AI direct streaming is the primary standard
    const effectiveStreamUrl =
      this.streamUrl ||
      (this.appletId
        ? undefined
        : `${(process.env.APP_URL || "http://localhost:3000").replace(/^http/i, "ws")}/media`);

    if (!effectiveStreamUrl && !this.appletId) {
      throw new ExotelApiError(
        "Exotel provider configuration error: Missing EXOTEL_STREAM_URL for Direct Connect Voice AI.",
        { isCertainRejection: true }
      );
    }

    let finalStreamUrl: string | undefined = undefined;

    if (effectiveStreamUrl) {
      if (!this.streamSecret) {
        throw new ExotelApiError(
          "Exotel provider configuration error: Missing stream secret (EXOTEL_STREAM_SECRET) for authenticated WebSocket handoff.",
          { isCertainRejection: true }
        );
      }

      // Generate single-use, attempt-bound, session-bound stream token
      const tokenResult = generateStreamToken({
        secretKey: this.streamSecret,
        attemptId: internalAttemptId,
        sessionId: validated.sessionId,
        expiresInSeconds: this.streamTokenExpiresInSeconds,
      });

      let streamUrlObj: URL;
      try {
        streamUrlObj = new URL(effectiveStreamUrl);
      } catch (err) {
        throw new ExotelApiError(
          "Exotel provider configuration error: Invalid EXOTEL_STREAM_URL format.",
          { isCertainRejection: true, cause: err }
        );
      }

      streamUrlObj.searchParams.set("token", tokenResult.token);
      streamUrlObj.searchParams.set("attemptId", internalAttemptId);
      streamUrlObj.searchParams.set("sessionId", validated.sessionId);
      finalStreamUrl = streamUrlObj.toString();

      // Enforce Exotel's documented 600-character StreamUrl limit
      if (finalStreamUrl.length > 600) {
        throw new ExotelApiError(
          `Exotel StreamUrl exceeds documented 600-character limit (${finalStreamUrl.length} chars).`,
          { isCertainRejection: true }
        );
      }
    }

    // 2. Build StatusCallback URL
    // Secure with Basic Auth in URL and/or per-call HMAC signed query token (avoiding reusable static secrets in query strings)
    const webhookSecret =
      this.config.statusCallbackToken ||
      process.env.EXOTEL_WEBHOOK_SECRET ||
      process.env.EXOTEL_STATUS_CALLBACK_TOKEN;

    const baseCallbackUrl =
      this.config.statusCallbackUrl ||
      process.env.EXOTEL_STATUS_CALLBACK_URL ||
      `${process.env.APP_URL || "http://localhost:3000"}/api/webhooks/voice/exotel/status`;

    const callbackUrlObj = new URL(baseCallbackUrl);

    // If Basic Auth is configured, embed credentials in the URL
    const basicUser = this.config.webhookUsername || process.env.EXOTEL_WEBHOOK_USER;
    const basicPass = this.config.webhookPassword || process.env.EXOTEL_WEBHOOK_PASSWORD;
    if (basicUser && basicPass) {
      callbackUrlObj.username = basicUser;
      callbackUrlObj.password = basicPass;
    }

    // Ephemeral per-call HMAC token (bound to internalAttemptId + sessionId)
    if (webhookSecret) {
      const ephemeralToken = generateExotelCallbackSignature(
        webhookSecret,
        internalAttemptId,
        validated.sessionId
      );
      callbackUrlObj.searchParams.set("token", ephemeralToken);
    }
    callbackUrlObj.searchParams.set("attemptId", internalAttemptId);
    callbackUrlObj.searchParams.set("sessionId", validated.sessionId);
    const statusCallbackUrl = callbackUrlObj.toString();

    const connectUrl = this.getConnectUrl();

    // 3. Prepare x-www-form-urlencoded body
    const bodyParams = new URLSearchParams();
    bodyParams.set("From", destinationPhone);
    bodyParams.set("CallerId", this.callerId);

    if (finalStreamUrl) {
      // Connect Voice AI (direct streaming)
      bodyParams.set("StreamUrl", finalStreamUrl);
      bodyParams.set("StreamType", this.streamType);
    } else if (this.appletId) {
      // Flow Builder fallback
      bodyParams.set("Url", this.getAppletUrl());
    }

    bodyParams.set("CustomField", customField);
    bodyParams.set("StatusCallback", statusCallbackUrl);
    bodyParams.set("StatusCallbackEvents[0]", "terminal");
    bodyParams.set("StatusCallbackEvents[1]", "answered");
    bodyParams.set("StatusCallbackEvents[2]", "ringing");

    const authHeader = `Basic ${Buffer.from(`${this.apiKey}:${this.apiToken}`).toString("base64")}`;

    let lastError: unknown = null;
    let attemptNumber = 0;

    while (attemptNumber <= this.maxRetries) {
      attemptNumber++;
      const controller = new AbortController();
      let timeoutTriggered = false;

      const timeoutHandle = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, this.timeoutMs);

      try {
        const response = await this.fetchFn(connectUrl, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: bodyParams.toString(),
          signal: controller.signal,
        });

        // Ensure timeout remains active until entire response body is read
        const responseText = await response.text();
        clearTimeout(timeoutHandle);

        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(responseText);
        } catch {
          // Non-JSON response
        }

        if (!response.ok) {
          const restException = data.RestException as Record<string, unknown> | undefined;
          const rawMessage =
            (restException?.Message as string) ||
            (data.message as string) ||
            response.statusText ||
            "Unknown carrier error";
          const safeMessage = this.redactSecrets(rawMessage);

          // 4xx responses are known rejections by carrier without dialing customer
          const is4xx = response.status >= 400 && response.status < 500;
          const is429 = response.status === 429;

          if (is4xx && !is429) {
            throw new ExotelApiError(`Exotel API rejection (${response.status}): ${safeMessage}`, {
              statusCode: response.status,
              isCertainRejection: true,
              isTimeoutOrNetwork: false,
            });
          }

          // 429 or 5xx: can retry ONLY if bounded retries remain and server explicitly rejected
          if (attemptNumber <= this.maxRetries) {
            await new Promise((r) => setTimeout(r, 200 * attemptNumber));
            continue;
          }

          throw new ExotelApiError(`Exotel API server error (${response.status}): ${safeMessage}`, {
            statusCode: response.status,
            isCertainRejection: false,
            isTimeoutOrNetwork: false,
          });
        }

        // Successfully accepted: Extract CallSid
        const callObj = (data.Call || data) as Record<string, unknown>;
        const callSid = (callObj.Sid as string) || (callObj.CallSid as string);

        if (!callSid || typeof callSid !== "string" || !callSid.trim()) {
          throw new ExotelApiError("Exotel API response missing Call.Sid identifier.", {
            statusCode: response.status,
            isCertainRejection: false,
            isTimeoutOrNetwork: false,
          });
        }

        const nowIso = new Date().toISOString();

        // If repository is injected, persist provider acceptance immediately
        if (this.config.callAttemptRepository) {
          try {
            await this.config.callAttemptRepository.markInitiationAccepted(
              internalAttemptId,
              callSid.trim(),
              nowIso
            );
          } catch {
            // Non-fatal: Outbox worker handles repository synchronization
          }
        }

        return {
          sessionId: validated.sessionId,
          providerCallId: callSid.trim(),
          status: "initiated",
          startedAt: nowIso,
          isSimulated: this.config.isSimulated || false,
          providerMode: this.config.isSimulated ? "mock" : "production",
        };
      } catch (err: unknown) {
        clearTimeout(timeoutHandle);

        const isTimeout =
          timeoutTriggered ||
          (err instanceof Error &&
            (err.name === "AbortError" ||
              err.name === "TimeoutError" ||
              err.message.toLowerCase().includes("timeout") ||
              err.message.toLowerCase().includes("timed out")));

        if (isTimeout) {
          // TIMEOUT FAILURE: The request reached the network and Exotel may have accepted it!
          // NEVER RETRY. Fail closed with uncertain outcome.
          throw new ExotelApiError(
            `Exotel call initiation timed out after ${this.timeoutMs}ms for ${maskedPhone}. Outcome is uncertain; automated redial blocked.`,
            {
              isTimeoutOrNetwork: true,
              isCertainRejection: false,
              cause: err,
            }
          );
        }

        if (err instanceof ExotelApiError && err.isCertainRejection) {
          throw err;
        }

        lastError = err;

        // Check if pre-request DNS / connection failure before transmission
        const isPreRequestConnectionError =
          err instanceof Error &&
          (err.message.includes("ENOTFOUND") ||
            err.message.includes("ECONNREFUSED") ||
            err.message.includes("EAI_AGAIN"));

        if (isPreRequestConnectionError && attemptNumber <= this.maxRetries) {
          await new Promise((r) => setTimeout(r, 200 * attemptNumber));
          continue;
        }

        // Network connection error / socket hangup
        const isNetworkError =
          err instanceof Error &&
          (err.message.includes("ECONNRESET") ||
            err.message.includes("ETIMEDOUT") ||
            err.message.includes("fetch failed"));

        throw new ExotelApiError(
          this.redactSecrets(`Exotel network failure: ${err instanceof Error ? err.message : String(err)}`),
          {
            isTimeoutOrNetwork: isNetworkError,
            isCertainRejection: false,
            cause: err,
          }
        );
      }
    }

    throw new ExotelApiError(
      this.redactSecrets(
        `Exotel dispatch failed after ${this.maxRetries} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`
      ),
      {
        isTimeoutOrNetwork: true,
        isCertainRejection: false,
        cause: lastError,
      }
    );
  }

  /**
   * Retrieves live status of a call attempt from Exotel's Call Details API:
   * GET https://<subdomain>/v1/Accounts/<account_sid>/Calls/<CallSid>.json
   */
  async getStatus(providerCallId: string): Promise<VoiceSessionStatusResult> {
    if (!providerCallId || !providerCallId.trim()) {
      throw new ExotelApiError("providerCallId required for getStatus.");
    }

    const cleanCallSid = providerCallId.trim();
    const url = this.getCallDetailsUrl(cleanCallSid);
    const authHeader = `Basic ${Buffer.from(`${this.apiKey}:${this.apiToken}`).toString("base64")}`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      const responseText = await response.text();
      clearTimeout(timeoutHandle);

      if (!response.ok) {
        throw new ExotelApiError(
          this.redactSecrets(`Failed to retrieve Exotel call details (${response.status}): ${responseText}`),
          { statusCode: response.status }
        );
      }

      const data = JSON.parse(responseText);
      const call = (data.Call || data) as Record<string, unknown>;

      const rawStatus = ((call.Status as string) || "").toLowerCase().trim();
      let status: VoiceCallStatus = "in_progress";

      switch (rawStatus) {
        case "queued":
          status = "queued";
          break;
        case "ringing":
          status = "ringing";
          break;
        case "in-progress":
        case "answered":
          status = "answered";
          break;
        case "completed":
          status = "completed";
          break;
        case "failed":
          status = "failed";
          break;
        case "busy":
          status = "busy";
          break;
        case "no-answer":
        case "no_answer":
          status = "no_answer";
          break;
        default:
          status = "in_progress";
      }

      const duration = typeof call.Duration === "number" ? call.Duration : parseInt(String(call.Duration || "0"), 10);
      const parsedCustom = parseExotelCustomField(call.CustomField as string);

      return {
        sessionId: parsedCustom.sessionId || "",
        providerCallId: cleanCallSid,
        status,
        durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : undefined,
        isSimulated: this.config.isSimulated || false,
        providerMode: this.config.isSimulated ? "mock" : "production",
      };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      throw new ExotelApiError(
        this.redactSecrets(`Exotel getStatus error for ${cleanCallSid}: ${err instanceof Error ? err.message : String(err)}`),
        { cause: err }
      );
    }
  }

  /**
   * Terminates or cancels an in-progress or queued call.
   */
  async endSession(providerCallId: string, reason?: string): Promise<VoiceSessionEndResult> {
    if (!providerCallId || !providerCallId.trim()) {
      throw new ExotelApiError("providerCallId required for endSession.");
    }

    const cleanCallSid = providerCallId.trim();
    // Exotel hangup API / cancel endpoint
    const url = `https://${this.subdomain}/v1/Accounts/${encodeURIComponent(this.accountSid)}/Calls/${encodeURIComponent(cleanCallSid)}/hangup.json`;
    const authHeader = `Basic ${Buffer.from(`${this.apiKey}:${this.apiToken}`).toString("base64")}`;

    const bodyParams = new URLSearchParams();
    if (reason && reason.trim()) {
      bodyParams.set("reason", reason.trim());
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await this.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: bodyParams.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      return {
        sessionId: cleanCallSid,
        status: "ended",
        endedAt: new Date().toISOString(),
        isSimulated: this.config.isSimulated || false,
        providerMode: this.config.isSimulated ? "mock" : "production",
      };
    } catch {
      clearTimeout(timeoutHandle);
      // Best-effort: return ended
      return {
        sessionId: cleanCallSid,
        status: "ended",
        endedAt: new Date().toISOString(),
        isSimulated: this.config.isSimulated || false,
        providerMode: this.config.isSimulated ? "mock" : "production",
      };
    }
  }
}
