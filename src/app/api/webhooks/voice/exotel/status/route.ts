/**
 * BREW Coffee Platform — Phase 6.6.2.1 Exotel Status Webhook Endpoint
 * 
 * Handles official Exotel status callback webhooks for outbound calls:
 * - Event types: ringing, answered / in-progress, completed, failed, busy, no-answer.
 * - Authenticates requests via HTTP Basic Auth in URL or per-call ephemeral HMAC query tokens.
 *   (Strictly avoids assuming custom request headers from Exotel telephony infrastructure).
 * - Validates consistency of CallSid, EventType, and Status fields, rejecting malformed callbacks.
 * - Enforces the 128-character CustomField limit and safe attempt/session correlation.
 * - Enforces monotonic status rank progression and records terminal-state conflicts.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAdminFirestore } from "../../../../../../lib/firebaseAdmin";
import {
  FirestoreVoiceCallAttemptRepository,
  generateExotelCallbackSignature,
  parseExotelCustomField,
  VoiceCallAttemptRepository,
  VoiceCallAttemptStatus,
} from "../../../../../../lib/communication";

import {
  getExotelWebhookCallAttemptRepoOverride,
  getExotelWebhookDbProviderOverride,
} from "../../../../../../lib/communication/testingHooks";

export const dynamic = "force-dynamic";

/**
 * Resolves the active VoiceCallAttemptRepository.
 * On deployed routes, strictly requires Firestore and returns 503 if uninitialized.
 */
function resolveCallAttemptRepo(): {
  repo?: VoiceCallAttemptRepository;
  errorResponse?: NextResponse;
} {
  const testCallAttemptRepo = getExotelWebhookCallAttemptRepoOverride();
  const testDbProvider = getExotelWebhookDbProviderOverride();
  if (testCallAttemptRepo) {
    return { repo: testCallAttemptRepo };
  }

  const db = testDbProvider ? testDbProvider() : getAdminFirestore();
  if (!db) {
    console.error("Exotel status webhook: Firestore unavailable in deployed environment.");
    return {
      errorResponse: NextResponse.json(
        { error: "Service unavailable: Firestore database not configured" },
        { status: 503 }
      ),
    };
  }

  return { repo: new FirestoreVoiceCallAttemptRepository(testDbProvider || undefined) };
}

/**
 * Maps raw Exotel status string to canonical internal VoiceCallAttemptStatus.
 */
function mapExotelStatusToInternal(rawStatus: string): VoiceCallAttemptStatus | null {
  const normalized = rawStatus.toLowerCase().trim().replace(/[\s_]/g, "-");
  switch (normalized) {
    case "queued":
      return "initiated";
    case "ringing":
      return "ringing";
    case "in-progress":
    case "answered":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "busy":
      return "busy";
    case "no-answer":
    case "no_answer":
      return "no_answer";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Validates semantic consistency between Exotel's EventType and Status fields.
 */
function validateEventConsistency(
  eventType: string | null,
  status: string
): { isValid: boolean; errorReason?: string } {
  if (!eventType) {
    return { isValid: true };
  }

  const normalizedEvent = eventType.toLowerCase().trim();
  const normalizedStatus = status.toLowerCase().trim().replace(/[\s_]/g, "-");

  if (normalizedEvent === "terminal") {
    const isTerminal = [
      "completed",
      "failed",
      "busy",
      "no-answer",
      "canceled",
      "cancelled",
    ].includes(normalizedStatus);
    if (!isTerminal) {
      return {
        isValid: false,
        errorReason: `EventType 'terminal' contradicts non-terminal Status '${status}'`,
      };
    }
  } else if (normalizedEvent === "answered") {
    const isAnswered = ["in-progress", "answered"].includes(normalizedStatus);
    if (!isAnswered) {
      return {
        isValid: false,
        errorReason: `EventType 'answered' contradicts Status '${status}'`,
      };
    }
  } else if (normalizedEvent === "ringing") {
    if (normalizedStatus !== "ringing") {
      return {
        isValid: false,
        errorReason: `EventType 'ringing' contradicts Status '${status}'`,
      };
    }
  }

  return { isValid: true };
}

/**
 * POST /api/webhooks/voice/exotel/status
 * Exotel Status Callback Webhook
 */
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    // 1. Parse Webhook Payload (supports urlencoded, form-data, and JSON)
    const contentType = req.headers.get("content-type") || "";
    const rawPayload: Record<string, unknown> = {};

    if (contentType.includes("application/json")) {
      try {
        const json = await req.json();
        Object.assign(rawPayload, json);
      } catch {
        return NextResponse.json({ error: "Bad Request: Malformed JSON payload" }, { status: 400 });
      }
    } else {
      try {
        const formData = await req.formData();
        for (const [key, value] of formData.entries()) {
          rawPayload[key] = value;
        }
      } catch {
        try {
          const text = await req.text();
          const params = new URLSearchParams(text);
          for (const [key, value] of params.entries()) {
            rawPayload[key] = value;
          }
        } catch {
          return NextResponse.json({ error: "Bad Request: Malformed form payload" }, { status: 400 });
        }
      }
    }

    // Extract CustomField and URL query parameters for correlation
    const customFieldRaw =
      (rawPayload.CustomField as string) || (rawPayload.custom_field as string) || null;

    if (customFieldRaw && customFieldRaw.length > 128) {
      return NextResponse.json(
        { error: "Bad Request: CustomField exceeds Exotel 128-character limit" },
        { status: 400 }
      );
    }

    const customParsed = parseExotelCustomField(customFieldRaw);
    const attemptId = customParsed.attemptId || searchParams.get("attemptId") || null;
    const sessionId = customParsed.sessionId || searchParams.get("sessionId") || null;

    // 2. Webhook Authentication
    // Standard Exotel Voice webhooks do NOT inject custom HTTP headers.
    // We authenticate via:
    // A) HTTP Basic Auth embedded in the URL (Authorization: Basic ...)
    // B) Ephemeral per-call HMAC signed query token (bound to attemptId + sessionId)
    // C) Direct token match against EXOTEL_WEBHOOK_SECRET
    const expectedSecret =
      process.env.EXOTEL_WEBHOOK_SECRET ||
      process.env.EXOTEL_STATUS_CALLBACK_TOKEN;

    const expectedUser = process.env.EXOTEL_WEBHOOK_USER;
    const expectedPass = process.env.EXOTEL_WEBHOOK_PASSWORD || expectedSecret;

    if (!expectedSecret && (!expectedUser || !expectedPass)) {
      console.error("Exotel status webhook failed: No webhook secret or Basic Auth configured.");
      return NextResponse.json(
        { error: "Configuration error: Exotel webhook authentication not configured" },
        { status: 500 }
      );
    }

    let isAuthenticated = false;

    // A) Check HTTP Basic Auth header
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Basic ") && expectedUser && expectedPass) {
      try {
        const credentials = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
        const [user, pass] = credentials.split(":");
        if (user && pass) {
          const userBuf = crypto.createHash("sha256").update(user).digest();
          const expUserBuf = crypto.createHash("sha256").update(expectedUser).digest();
          const passBuf = crypto.createHash("sha256").update(pass).digest();
          const expPassBuf = crypto.createHash("sha256").update(expectedPass).digest();

          if (
            crypto.timingSafeEqual(userBuf, expUserBuf) &&
            crypto.timingSafeEqual(passBuf, expPassBuf)
          ) {
            isAuthenticated = true;
          }
        }
      } catch {
        // Fall through
      }
    }

    // B) Check Ephemeral HMAC Signed Query Token or Static Query Token
    const incomingToken = searchParams.get("token") || searchParams.get("auth_token");
    if (!isAuthenticated && incomingToken && expectedSecret) {
      const incomingBuf = crypto.createHash("sha256").update(incomingToken.trim()).digest();

      // B.1 Check Ephemeral per-call HMAC signature (bound to attemptId + sessionId)
      if (attemptId && sessionId) {
        const expectedEphemeral = generateExotelCallbackSignature(
          expectedSecret,
          attemptId,
          sessionId
        );
        const expectedEphemeralBuf = crypto
          .createHash("sha256")
          .update(expectedEphemeral)
          .digest();
        if (crypto.timingSafeEqual(incomingBuf, expectedEphemeralBuf)) {
          isAuthenticated = true;
        }
      }

      // B.2 Check Direct Static Secret comparison
      if (!isAuthenticated) {
        const expectedDirectBuf = crypto
          .createHash("sha256")
          .update(expectedSecret.trim())
          .digest();
        if (crypto.timingSafeEqual(incomingBuf, expectedDirectBuf)) {
          isAuthenticated = true;
        }
      }
    }

    if (!isAuthenticated) {
      if (!authHeader && !incomingToken) {
        return NextResponse.json(
          { error: "Unauthorized: Missing webhook authentication credentials" },
          { status: 401 }
        );
      }
      return NextResponse.json(
        { error: "Forbidden: Webhook authentication verification failed" },
        { status: 403 }
      );
    }

    // 3. Extract and Validate Callback Fields
    const callSid = (
      (rawPayload.CallSid as string) ||
      (rawPayload.call_sid as string) ||
      (rawPayload.Sid as string)
    )?.trim();

    const rawStatus = (
      (rawPayload.Status as string) ||
      (rawPayload.status as string) ||
      (rawPayload.CallStatus as string)
    )?.trim();

    const eventType = (
      (rawPayload.EventType as string) ||
      (rawPayload.event_type as string) ||
      null
    )?.trim() || null;

    if (!callSid) {
      return NextResponse.json({ error: "Bad Request: Missing required CallSid" }, { status: 400 });
    }

    if (!rawStatus) {
      return NextResponse.json({ error: "Bad Request: Missing required Status" }, { status: 400 });
    }

    const internalStatus = mapExotelStatusToInternal(rawStatus);
    if (!internalStatus) {
      return NextResponse.json(
        { error: `Bad Request: Unrecognized Exotel status '${rawStatus}'` },
        { status: 400 }
      );
    }

    // Validate EventType consistency with Status
    const consistencyCheck = validateEventConsistency(eventType, rawStatus);
    if (!consistencyCheck.isValid) {
      return NextResponse.json(
        { error: `Bad Request: ${consistencyCheck.errorReason}` },
        { status: 400 }
      );
    }

    // Extract Duration and Timestamps
    const rawDuration =
      rawPayload.ConversationDuration ??
      rawPayload.Duration ??
      rawPayload.duration;

    let durationSeconds: number | null = null;
    if (rawDuration !== undefined && rawDuration !== null && String(rawDuration).trim() !== "") {
      const parsed = parseInt(String(rawDuration).trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        durationSeconds = parsed;
      }
    }

    const eventTime =
      (rawPayload.DateUpdated as string) ||
      (rawPayload.EndTime as string) ||
      new Date().toISOString();

    const errorCode = (
      (rawPayload.ErrorCode as string) ||
      (rawPayload.DialCallStatus as string) ||
      null
    )?.trim() || null;

    const errorMessage = (rawPayload.ErrorMessage as string)?.trim() || null;

    // 4. Resolve Repository
    const { repo, errorResponse } = resolveCallAttemptRepo();
    if (errorResponse || !repo) {
      return errorResponse || NextResponse.json({ error: "Repository unavailable" }, { status: 503 });
    }

    // 5. Update Call Attempt Lifecycle
    // Route A: Attempt already indexed by providerCallId
    const existing = await repo.getByProviderCallId(callSid);
    if (existing) {
      const updateResult = await repo.updateStatusByProviderCallId(callSid, {
        status: internalStatus,
        timestamp: eventTime,
        durationSeconds,
        errorCode,
        errorMessage,
        rawProviderMetadata: rawPayload,
      });

      return NextResponse.json(
        {
          status: "success",
          outcome: updateResult.outcome,
          attemptId: updateResult.attempt.id,
          reason: updateResult.reason,
        },
        { status: 200 }
      );
    }

    // Route B: Attempt not yet mapped to providerCallId, but internal attemptId is provided
    if (attemptId) {
      try {
        const correlateResult = await repo.correlateWebhookByAttemptId({
          attemptId,
          providerCallId: callSid,
          provider: "exotel",
          sessionId: sessionId || "",
          status: internalStatus,
          timestamp: eventTime,
          durationSeconds,
          errorCode,
          errorMessage,
          rawProviderMetadata: rawPayload,
        });

        return NextResponse.json(
          {
            status: "success",
            outcome: correlateResult.outcome,
            attemptId: correlateResult.attempt.id,
            reason: correlateResult.reason,
          },
          { status: 200 }
        );
      } catch (err: unknown) {
        if (err instanceof Error) {
          if (err.message.includes("mismatch") || err.message.includes("conflict")) {
            return NextResponse.json({ error: err.message }, { status: 409 });
          }
          if (err.message.includes("not found")) {
            return NextResponse.json({ error: err.message }, { status: 404 });
          }
        }
        throw err;
      }
    }

    // Route C: Neither providerCallId mapping nor attemptId exists
    return NextResponse.json(
      { error: `Call attempt for CallSid '${callSid}' not found and no correlation attemptId provided` },
      { status: 404 }
    );
  } catch (err: unknown) {
    console.error("Exotel status webhook unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error processing Exotel status webhook" },
      { status: 500 }
    );
  }
}
