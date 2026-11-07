import { NextRequest, NextResponse } from "next/server";
import { inspectStaffSession } from "../../../../lib/auth/adminAuth";
import { getVoiceSessionRepository, verifyQuotationIntegrity } from "../../../../lib/voiceBooking";
import { toSafeCustomerVoiceSessionView } from "../../../../lib/communication/visibility";
import { ensureDemoSessions } from "../../../../lib/voiceBooking/demoData";
import { isVoicePrototypeMode } from "../../../../lib/voiceBooking/prototypeConfig";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice-booking/sessions
 *
 * Protected Staff Endpoint:
 * Retrieves voice booking sessions for barista and admin dashboard review.
 * Strictly restricted to authenticated staff credentials.
 */
export async function GET(req: NextRequest) {
  try {
    const authResult = await inspectStaffSession(req);
    if (!authResult.ok) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }

    const repository = getVoiceSessionRepository();
    let sessions: unknown[] = [];

    if (typeof repository.getAllSessions === "function") {
      let all = await repository.getAllSessions();
      if (all.length === 0 && isVoicePrototypeMode() && process.env.NODE_ENV !== "production") {
        await ensureDemoSessions(repository);
        all = await repository.getAllSessions();
      }
      sessions = all.map((s) => {
        const safe = toSafeCustomerVoiceSessionView(s);
        const integrityResult = s.quotationSnapshot
          ? verifyQuotationIntegrity(s.quotationSnapshot, s.requirements, s.quotation)
          : { isMatch: false, reason: "No quotation snapshot recorded" };

        const integrity = {
          valid: integrityResult.isMatch,
          isMatch: integrityResult.isMatch,
          reason: integrityResult.reason,
        };

        return {
          ...safe,
          id: s.id,
          status: s.state,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          officialBookingId: s.officialBookingId || null,
          requestId: (s.metadata?.enquiryRequestId as string) || null,
          bookingRequirements: s.requirements,
          quotation: s.quotation || null,
          quotationSnapshot: s.quotationSnapshot || null,
          quotationIntegrity: integrity,
          staffApprovalAudit: s.staffApprovalAudit || null,
          staffRejectionAudit: s.staffRejectionAudit || null,
          conversationHistory: s.conversationHistory || [],
          // Staff view includes masked phone number for operational dispatch
          maskedPhone: s.phoneNumber ? `${s.phoneNumber.slice(0, 3)}****${s.phoneNumber.slice(-4)}` : null,
        };
      });
    }

    return NextResponse.json({
      success: true,
      sessions,
    });
  } catch (error) {
    console.error("Failed to retrieve voice booking sessions for staff:", error);
    return NextResponse.json(
      { error: "Internal server error retrieving voice sessions" },
      { status: 500 }
    );
  }
}
