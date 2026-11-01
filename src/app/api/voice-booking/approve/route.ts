import { NextRequest, NextResponse } from "next/server";
import {
  getStaffSessionFromRequest,
  deriveTrustedStaffAuthorizationContext,
} from "../../../../lib/auth/adminAuth";
import { approveBookingByStaff, defaultSessionRepository } from "../../../../lib/voiceBooking";
import { readBoundedJson } from "../../../../lib/boundedBody";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate Request via Server-Side Staff Session Cookie
    const staffSession = await getStaffSessionFromRequest(req);
    if (!staffSession) {
      const token = req.cookies.get("brew_session")?.value;
      if (!token) {
        return NextResponse.json(
          { error: "Authentication required: missing brew_session cookie." },
          { status: 401 }
        );
      }
      return NextResponse.json(
        { error: "Authentication failed: invalid, expired, revoked, or non-staff session." },
        { status: 401 }
      );
    }

    // Role check: Only authorized staff roles (barista, fleet_admin, admin) can approve
    if (
      staffSession.role !== "barista" &&
      staffSession.role !== "fleet_admin" &&
      (staffSession.role as string) !== "admin"
    ) {
      return NextResponse.json(
        { error: "Forbidden: Staff credentials required to approve catering bookings." },
        { status: 403 }
      );
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

    const { sessionId, staffApprovalId } = bodyResult.data || {};
    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return NextResponse.json(
        { error: "Bad Request: missing required sessionId." },
        { status: 400 }
      );
    }

    // 3. Derive trusted StaffAuthorizationContext strictly from server-side session
    // Client-supplied staffRole or staffIdentity in request body are NEVER used!
    const authContext = await deriveTrustedStaffAuthorizationContext({
      tokenOrRequest: req,
      staffApprovalId: typeof staffApprovalId === "string" ? staffApprovalId : undefined,
    });

    // 4. Execute domain-level booking approval
    const approvedSession = await approveBookingByStaff(
      sessionId,
      authContext,
      defaultSessionRepository
    );

    return NextResponse.json({
      success: true,
      session: approvedSession,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error approving booking.";
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (
      message.includes("Cannot approve booking") ||
      message.includes("expected 'awaiting_staff_approval'")
    ) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
