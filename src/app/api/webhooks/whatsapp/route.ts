/**
 * BREW Coffee Platform — Phase 6.4 / 6.4.1 Meta WhatsApp Webhook Endpoint
 * 
 * Handles official Meta WhatsApp Cloud API webhooks:
 * 1. GET: Webhook verification challenge (hub.mode, hub.verify_token, hub.challenge)
 *    - Strictly requires configured META_WHATSAPP_VERIFY_TOKEN (fails closed with 500 if missing).
 * 2. POST: Message status update events (sent, delivered, read, failed)
 *    - Verifies Meta's X-Hub-Signature-256 header using HMAC-SHA256 and META_WHATSAPP_APP_SECRET.
 *    - Uses constant-time comparison against exact raw request body.
 *    - Validates payload structure and rejects malformed requests with 400.
 *    - Updates delivery status in Firestore. Never silently falls back to in-memory storage on deployed routes.
 *    - Returns 503 if Firestore database is uninitialized, or 500 if database update fails.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAdminFirestore } from "../../../../lib/firebaseAdmin";
import {
  FirestoreCommunicationOutboxRepository,
  CommunicationOutboxRepository,
} from "../../../../lib/communication/outbox/outboxRepository";
import { WhatsAppMessageStatus } from "../../../../lib/communication/types";

import {
  getWebhookOutboxRepoOverride,
  getWebhookDbProviderOverride,
} from "../../../../lib/communication/testingHooks";

export const dynamic = "force-dynamic";

/**
 * Resolves the active CommunicationOutboxRepository for webhook processing.
 * On deployed routes, strictly requires Firestore and returns 503 if unavailable.
 */
function resolveWebhookRepo(): { repo?: CommunicationOutboxRepository; errorResponse?: NextResponse } {
  const testOutboxRepo = getWebhookOutboxRepoOverride();
  const testDbProvider = getWebhookDbProviderOverride();
  if (testOutboxRepo) {
    return { repo: testOutboxRepo };
  }

  const db = testDbProvider ? testDbProvider() : getAdminFirestore();
  if (!db) {
    console.error("WhatsApp webhook: Firestore unavailable in deployed environment.");
    return {
      errorResponse: NextResponse.json(
        { error: "Service unavailable: Firestore database not configured" },
        { status: 503 }
      ),
    };
  }

  return { repo: new FirestoreCommunicationOutboxRepository() };
}

/**
 * GET /api/webhooks/whatsapp
 * Meta Webhook Verification Endpoint
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");

    // Standardized environment variables; fail closed if not configured
    const expectedToken =
      process.env.META_WHATSAPP_VERIFY_TOKEN ||
      process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
      process.env.WHATSAPP_VERIFY_TOKEN;

    if (!expectedToken || !expectedToken.trim()) {
      console.error("WhatsApp webhook verification failed: META_WHATSAPP_VERIFY_TOKEN is not configured.");
      return NextResponse.json(
        { error: "Configuration error: Meta WhatsApp verify token not configured" },
        { status: 500 }
      );
    }

    if (mode === "subscribe" && token === expectedToken) {
      return new Response(challenge || "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    return NextResponse.json({ error: "Forbidden: verification token mismatch" }, { status: 403 });
  } catch (error) {
    console.error("WhatsApp webhook verification error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/webhooks/whatsapp
 * Meta Webhook Status Event Receiver
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Validate Meta App Secret configuration
    const appSecret =
      process.env.META_WHATSAPP_APP_SECRET ||
      process.env.META_APP_SECRET ||
      process.env.WHATSAPP_APP_SECRET;

    if (!appSecret || !appSecret.trim()) {
      console.error("WhatsApp webhook error: META_WHATSAPP_APP_SECRET is not configured.");
      return NextResponse.json(
        { error: "Configuration error: Meta App Secret not configured" },
        { status: 500 }
      );
    }

    // 2. Validate X-Hub-Signature-256 header
    const signatureHeader =
      req.headers.get("x-hub-signature-256") ||
      req.headers.get("X-Hub-Signature-256");

    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
      return NextResponse.json(
        { error: "Unauthorized: missing or invalid signature header" },
        { status: 401 }
      );
    }

    const providedSignature = signatureHeader.slice("sha256=".length).trim();

    // 3. Read exact raw request body for constant-time HMAC-SHA256 comparison
    const rawBody = await req.text();

    const expectedSignature = crypto
      .createHmac("sha256", appSecret.trim())
      .update(rawBody, "utf8")
      .digest("hex");

    const providedBuffer = Buffer.from(providedSignature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return NextResponse.json(
        { error: "Forbidden: signature verification failed" },
        { status: 403 }
      );
    }

    // 4. Parse and validate JSON payload structure
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "Bad Request: malformed JSON payload" },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Bad Request: invalid webhook payload structure" },
        { status: 400 }
      );
    }

    const payload = body as Record<string, unknown>;
    if (!Array.isArray(payload.entry)) {
      return NextResponse.json(
        { error: "Bad Request: invalid webhook payload: missing entry array" },
        { status: 400 }
      );
    }

    // 5. Resolve durable repository (no silent in-memory fallback on deployed route)
    const { repo, errorResponse } = resolveWebhookRepo();
    if (errorResponse || !repo) {
      return (
        errorResponse ||
        NextResponse.json(
          { error: "Service unavailable: Firestore database not configured" },
          { status: 503 }
        )
      );
    }

    let processedCount = 0;
    const nowIso = new Date().toISOString();

    for (const entry of payload.entry) {
      if (!entry || typeof entry !== "object") continue;
      const entryObj = entry as Record<string, unknown>;
      const changes = Array.isArray(entryObj.changes) ? entryObj.changes : [];

      for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const changeObj = change as Record<string, unknown>;

        if (changeObj.field === "messages") {
          const changeVal = changeObj.value as Record<string, unknown> | undefined;
          const statuses = Array.isArray(changeVal?.statuses) ? changeVal.statuses : [];

          for (const statusObj of statuses) {
            if (!statusObj || typeof statusObj !== "object") continue;
            const messageId = (statusObj as Record<string, unknown>).id;
            const status = (statusObj as Record<string, unknown>).status as WhatsAppMessageStatus;

            if (typeof messageId === "string" && messageId && typeof status === "string" && status) {
              if (typeof repo.updateDeliveryStatusByProviderMessageId === "function") {
                const deliveryStatus = status === "failed" ? "failed" : "dispatched";
                try {
                  await repo.updateDeliveryStatusByProviderMessageId(
                    messageId,
                    deliveryStatus,
                    status,
                    nowIso
                  );
                  processedCount++;
                } catch (dbError) {
                  console.error("WhatsApp webhook: database update failed:", dbError);
                  return NextResponse.json(
                    { error: "Database error processing delivery status update" },
                    { status: 500 }
                  );
                }
              }
            }
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      processed: processedCount,
    });
  } catch (error) {
    console.error("WhatsApp webhook processing error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
