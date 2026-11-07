import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  inspectStaffSession,
  deriveTrustedStaffRejectionContext,
} from "../../../../lib/auth/adminAuth";
import {
  rejectBookingByStaff,
  getVoiceSessionRepository,
} from "../../../../lib/voiceBooking";
import { readBoundedJson } from "../../../../lib/boundedBody";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate Request via Server-Side Staff Session Cookie
    const authResult = await inspectStaffSession(req);
    if (!authResult.ok) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }

    // 2. Read stream-bounded body (enforces 100KB payload limit)
    const bodyResult = await readBoundedJson<{
      sessionId?: string;
      reason?: string;
      customerFacingReason?: string;
      staffRole?: unknown; // Any client-supplied role is ignored
      staffIdentity?: unknown; // Any client-supplied identity is ignored
    }>(req);

    if (!bodyResult.ok || bodyResult.response) {
      return (
        bodyResult.response ||
        NextResponse.json({ error: "Invalid request payload." }, { status: 400 })
      );
    }

    const { sessionId, reason, customerFacingReason } = bodyResult.data || {};
    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return NextResponse.json(
        { error: "Bad Request: missing required sessionId." },
        { status: 400 }
      );
    }

    if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
      return NextResponse.json(
        { error: "Bad Request: a valid rejection reason (minimum 3 characters) is required." },
        { status: 400 }
      );
    }

    // 3. Derive trusted StaffRejectionAuthorizationContext strictly from verified server-side session
    const serverRejectionId = `rej_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
    const authContext = await deriveTrustedStaffRejectionContext({
      verifiedSession: authResult.session,
      staffRejectionId: serverRejectionId,
      reason: reason.trim(),
      customerFacingReason: customerFacingReason?.trim(),
    });

    // 4. Booking Existence and State Pre-checks
    const repository = getVoiceSessionRepository();
    const existingSession = await repository.getById(sessionId.trim());
    if (!existingSession) {
      return NextResponse.json(
        { error: `Booking session '${sessionId}' not found.` },
        { status: 404 }
      );
    }

    if (existingSession.state === "booking_confirmed" || existingSession.staffApprovalAudit) {
      return NextResponse.json(
        { error: `Booking session '${sessionId}' has already been approved and confirmed. Conflict rejected.` },
        { status: 409 }
      );
    }

    if (existingSession.state === "customer_declined" || existingSession.staffRejectionAudit) {
      return NextResponse.json(
        { error: `Booking session '${sessionId}' has already been rejected. Duplicate rejection rejected.` },
        { status: 409 }
      );
    }

    if (existingSession.state !== "awaiting_staff_approval") {
      return NextResponse.json(
        {
          error: `Cannot reject booking: session is in state '${existingSession.state}', expected 'awaiting_staff_approval'.`,
        },
        { status: 409 }
      );
    }

    // 5. Execute domain-level booking rejection
    const rejectedSession = await rejectBookingByStaff(
      sessionId.trim(),
      authContext,
      repository
    );

    return NextResponse.json({
      success: true,
      session: rejectedSession,
      state: rejectedSession.state,
      staffRejectionAudit: rejectedSession.staffRejectionAudit,
      officialBookingId: rejectedSession.officialBookingId || `enq_voice_${rejectedSession.id}`,
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "status" in err &&
      typeof (err as { status: number }).status === "number"
    ) {
      const status = (err as { status: number }).status as 401 | 403;
      const message = err instanceof Error ? err.message : "Authentication error";
      return NextResponse.json({ error: message }, { status });
    }

    const message = err instanceof Error ? err.message : "";
    if (message.includes("not found")) {
      return NextResponse.json({ error: "Booking session not found." }, { status: 404 });
    }
    if (
      message.includes("Cannot reject booking") ||
      message.includes("already been approved") ||
      message.includes("already been rejected") ||
      message.includes("expected 'awaiting_staff_approval'")
    ) {
      return NextResponse.json({ error: message }, { status: 409 });
    }

    return NextResponse.json({ error: "An unexpected server error occurred." }, { status: 500 });
  }
}
