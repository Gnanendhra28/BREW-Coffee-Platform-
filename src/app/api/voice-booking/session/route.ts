import { NextRequest, NextResponse } from "next/server";
import {
  getVoiceSessionRepository,
  getInitialGreeting,
  createVoiceBookingSession,
  SupportedLanguage,
} from "../../../../lib/voiceBooking";
import { toSafeCustomerVoiceSessionView } from "../../../../lib/communication/visibility";
import { readBoundedJson } from "../../../../lib/boundedBody";
import { ensureDemoSessions } from "../../../../lib/voiceBooking/demoData";
import { isVoicePrototypeMode } from "../../../../lib/voiceBooking/prototypeConfig";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice-booking/session?sessionId=vbs_...
 *
 * Public Read-Only Endpoint for customer to inspect their voice booking session.
 * Exposes only safe, sanitized projection:
 * - Omits unmasked phone numbers, claim tokens, provider secrets, and internal outbox data.
 * - Auto-initializes initial greeting if session is fresh (state=created, empty conversation).
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("sessionId") || searchParams.get("id");

    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return NextResponse.json(
        { error: "Bad Request: missing required sessionId query parameter." },
        { status: 400 }
      );
    }

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

    const repository = getVoiceSessionRepository();
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

    // Auto-initialize greeting if session was created but no greeting appended yet
    if (session.state === "created" && session.conversationHistory.length === 0) {
      const greeting = getInitialGreeting(session.language);
      const nowIso = new Date().toISOString();
      session.conversationHistory.push({
        id: `msg_a_${session.id}_init`,
        role: "assistant",
        content: greeting,
        language: session.language,
        timestamp: nowIso,
      });
      // Do not record a real call attempt or mark the call as answered on page load.
      // Call attempt status, attempt count, and call answered timestamps are only
      // modified by genuine outbound delivery execution or worker processes.
      session.updatedAt = nowIso;
      try {
        await repository.save(session, session.revision);
      } catch {
        // Optimistic concurrency or concurrent greeting append; reload
        const reloaded = await repository.getById(effectiveId);
        if (reloaded) {
          return NextResponse.json({
            success: true,
            session: toSafeCustomerVoiceSessionView(reloaded),
          });
        }
      }
    }

    const safeView = toSafeCustomerVoiceSessionView(session);

    return NextResponse.json({
      success: true,
      session: safeView,
    });
  } catch (error) {
    console.error("Failed to retrieve voice booking session:", error);
    return NextResponse.json(
      { error: "Internal server error retrieving voice session" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/voice-booking/session
 *
 * Public Endpoint: Creates a new voice booking session for interactive customer booking.
 * Body: { phoneNumber?: string; language?: "en" | "hi" | "te" }
 */
export async function POST(req: NextRequest) {
  try {
    const bodyResult = await readBoundedJson<{
      phoneNumber?: string;
      language?: SupportedLanguage;
    }>(req);

    const body = bodyResult.ok && bodyResult.data ? bodyResult.data : {};
    const rawPhone = typeof body.phoneNumber === "string" ? body.phoneNumber.replace(/[\s-]/g, "").trim() : "";
    const phone = rawPhone || "+919876543210";
    const language: SupportedLanguage =
      body.language === "hi" || body.language === "te" || body.language === "en"
        ? body.language
        : "en";

    const session = createVoiceBookingSession(phone, language);
    const greeting = getInitialGreeting(language);
    const nowIso = new Date().toISOString();
    session.conversationHistory.push({
      id: `msg_a_${session.id}_init`,
      role: "assistant",
      content: greeting,
      language: session.language,
      timestamp: nowIso,
    });
    session.updatedAt = nowIso;

    const repository = getVoiceSessionRepository();
    await repository.save(session);

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      session: toSafeCustomerVoiceSessionView(session),
    });
  } catch (error) {
    console.error("Failed to create voice booking session:", error);
    return NextResponse.json(
      { error: "Internal server error creating voice session" },
      { status: 500 }
    );
  }
}
