import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  inspectStaffSession,
  deriveTrustedStaffAuthorizationContext,
} from "../../../../lib/auth/adminAuth";
import {
  approveBookingByStaff,
  getVoiceSessionRepository,
  verifyQuotationIntegrity,
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
      staffApprovalId?: string;
      staffRole?: unknown; // Any client-supplied role is ignored
      staffIdentity?: unknown; // Any client-supplied identity is ignored
    }>(req);

    if (!bodyResult.ok || bodyResult.response) {
      return (
        bodyResult.response ||
        NextResponse.json({ error: "Invalid request payload." }, { status: 400 })
      );
    }

    const { sessionId } = bodyResult.data || {};
    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return NextResponse.json(
        { error: "Bad Request: missing required sessionId." },
        { status: 400 }
      );
    }

    // 3. Derive trusted StaffAuthorizationContext strictly from verified server-side session
    // Client-supplied staffRole or staffIdentity in request body are NEVER used!
    // Passing verifiedSession eliminates redundant token verification and revocation queries.
    // Server generates authoritative approval audit ID; client staffApprovalId treated as correlation only
    const serverApprovalId = `appr_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
    const authContext = await deriveTrustedStaffAuthorizationContext({
      verifiedSession: authResult.session,
      staffApprovalId: serverApprovalId,
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

    const hasExistingAudit = Boolean(existingSession.staffApprovalAudit);
    if (existingSession.state === "booking_confirmed" || hasExistingAudit) {
      return NextResponse.json(
        { error: `Booking session '${sessionId}' has already been approved and confirmed.` },
        { status: 409 }
      );
    }

    if (existingSession.state !== "awaiting_staff_approval") {
      return NextResponse.json(
        {
          error: `Cannot approve booking: session is in state '${existingSession.state}', expected 'awaiting_staff_approval'.`,
        },
        { status: 409 }
      );
    }

    // 4b. Mandatory Quotation Integrity Verification Pre-check
    if (!existingSession.quotationSnapshot) {
      return NextResponse.json(
        { error: `Cannot approve booking: session is missing mandatory quotationSnapshot.` },
        { status: 409 }
      );
    }
    const integrity = verifyQuotationIntegrity(
      existingSession.quotationSnapshot,
      existingSession.requirements,
      existingSession.quotation
    );
    if (!integrity.isMatch) {
      return NextResponse.json(
        {
          error: `Cannot approve booking: quotation integrity verification failed (${
            integrity.reason || integrity.mismatchedFields.join(", ")
          }). Tampered or stale quotation detected.`,
        },
        { status: 409 }
      );
    }

    // 5. Execute domain-level booking approval
    const approvedSession = await approveBookingByStaff(
      sessionId.trim(),
      authContext,
      repository
    );

    return NextResponse.json({
      success: true,
      session: approvedSession,
      state: approvedSession.state,
      staffApprovalAudit: approvedSession.staffApprovalAudit,
      officialBookingId: approvedSession.officialBookingId || `enq_voice_${approvedSession.id}`,
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
      message.includes("Cannot approve booking") ||
      message.includes("already been approved") ||
      message.includes("Duplicate approval rejected") ||
      message.includes("expected 'awaiting_staff_approval'") ||
      message.includes("Resource collision") ||
      message.includes("already booked")
    ) {
      return NextResponse.json({ error: message }, { status: 409 });
    }

    return NextResponse.json({ error: "An unexpected server error occurred." }, { status: 500 });
  }
}
