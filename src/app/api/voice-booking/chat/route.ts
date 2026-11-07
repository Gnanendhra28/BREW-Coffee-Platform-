import { NextRequest, NextResponse } from "next/server";
import { readBoundedJson } from "../../../../lib/boundedBody";
import {
  getVoiceSessionRepository,
  processConversationTurn,
} from "../../../../lib/voiceBooking";
import { toSafeCustomerVoiceSessionView } from "../../../../lib/communication/visibility";
import { ensureDemoSessions } from "../../../../lib/voiceBooking/demoData";
import { isVoicePrototypeMode } from "../../../../lib/voiceBooking/prototypeConfig";

export const dynamic = "force-dynamic";

/**
 * POST /api/voice-booking/chat
 *
 * Customer Interaction Endpoint:
 * Processes simulated customer text turns against the voice conversation engine.
 *
 * Security & Integrity Guarantees:
 * - Session progress is persisted with the corresponding turn.
 * - Turn deduplication protects against repeated requests.
 * - Customer can confirm or decline quotations, but CANNOT invoke staff approval.
 * - Returns only a safe, sanitized customer view (no raw phones, tokens, or secrets).
 */
export async function POST(req: NextRequest) {
  try {
    const bodyResult = await readBoundedJson<{
      sessionId?: string;
      message?: string;
      turnIndex?: number;
      turnId?: string;
      clientTurnId?: string;
      language?: string;
    }>(req);

    if (!bodyResult.ok || bodyResult.response) {
      return (
        bodyResult.response ||
        NextResponse.json({ error: "Invalid request payload." }, { status: 400 })
      );
    }

    const { sessionId, message, turnIndex, turnId, clientTurnId, language } = bodyResult.data || {};
    const effectiveTurnId = turnId || clientTurnId;

    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return NextResponse.json(
        { error: "Bad Request: missing required sessionId string." },
        { status: 400 }
      );
    }

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { error: "Bad Request: missing required message string." },
        { status: 400 }
      );
    }

    const repository = getVoiceSessionRepository();
    const id = sessionId.trim();
    const isProd = process.env.NODE_ENV === "production";
    const effectiveId =
      !isProd && (id === "demo" || id === "demo-pending" || id === "vbs_demo_awaiting_approval")
        ? "vbs_demo_pending_review"
        : !isProd && id === "demo-approved"
        ? "vbs_demo_approved_booking"
        : !isProd && (id === "demo-rejected" || id === "demo-declined")
        ? "vbs_demo_declined_booking"
        : id;

    let session = await repository.getById(effectiveId);

    if (
      !session &&
      !isProd &&
      (effectiveId.startsWith("vbs_demo_") || effectiveId.includes("demo")) &&
      isVoicePrototypeMode()
    ) {
      await ensureDemoSessions(repository);
      session = await repository.getById(effectiveId);
    }

    if (!session) {
      return NextResponse.json(
        { error: `Voice booking session '${sessionId}' not found.` },
        { status: 404 }
      );
    }

    // Terminal session check: confirmed bookings cannot be mutated via chat
    if (session.state === "booking_confirmed") {
      return NextResponse.json(
        {
          error: "Booking is already reviewed and confirmed by staff. No further modifications allowed.",
          session: toSafeCustomerVoiceSessionView(session),
        },
        { status: 409 }
      );
    }

    // Align session language if customer explicitly selected a supported language
    if (language === "en" || language === "hi" || language === "te") {
      session.language = language;
    }

    const turnResult = await processConversationTurn(session, message.trim(), {
      sessionRepository: repository,
      turnIndex: typeof turnIndex === "number" ? turnIndex : undefined,
      turnId: effectiveTurnId,
    });

    const safeView = toSafeCustomerVoiceSessionView(turnResult.session);

    return NextResponse.json({
      success: true,
      assistantResponse: turnResult.assistantResponse,
      session: safeView,
    });
  } catch (error) {
    console.error("Voice booking chat turn failed:", error);
    return NextResponse.json(
      { error: "Internal server error processing conversation turn." },
      { status: 500 }
    );
  }
}
