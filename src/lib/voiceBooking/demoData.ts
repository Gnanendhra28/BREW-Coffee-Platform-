/**
 * BREW Coffee Platform — Phase P8 Demo Data Factory
 * Generates safe, reproducible demo bookings for presentation scenarios:
 * 1. Awaiting Staff Approval (English, Hitec City, 85 guests)
 * 2. Confirmed / Approved Booking (Hindi, Jubilee Hills, 120 guests)
 * 3. Declined / Rejected Booking (Telugu, Gachibowli, 200 guests)
 *
 * SAFETY INVARIANTS:
 * - Only available in prototype mode (`isVoicePrototypeMode()`).
 * - Clearly marked with `isDemo: true` in metadata.
 * - Does not overwrite real customer sessions.
 * - All quotations and HMAC signatures are computed authoritatively.
 */

import { VoiceBookingSession, VoiceSessionRepository } from "./types";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "./quotationAdapter";
import { computeOfficialVanRequestId } from "./vanRequestBridge";
import { isVoicePrototypeMode } from "./prototypeConfig";

export function createDemoVoiceBookingSessions(): VoiceBookingSession[] {
  // 1. Pending Review Demo Booking (English)
  const pendingId = "vbs_demo_pending_review";
  const pendingVanId = computeOfficialVanRequestId(pendingId);
  const pendingReqs = {
    eventType: "corporate" as const,
    guestCount: 85,
    eventDate: "2026-12-18",
    startTime: "14:00",
    durationHours: 4,
    venueAddress: "Hitec City, Hyderabad",
    selectedTier: "STANDARD" as const,
    beveragePreferences: ["cold brew", "pour over", "oat milk cappuccino"],
    customerConfirmed: true,
    handoffRequested: false,
    confidenceScore: 0.98,
    missingFields: [],
    unresolvedQuestions: [],
    corrections: [
      {
        field: "guestCount",
        previousValue: 60,
        newValue: 85,
        action: "update" as const,
        source: "customer_voice",
        timestamp: "2026-11-07T08:05:00.000Z",
      },
    ],
  };
  const pendingQuotation = generateVoiceBookingQuotation(pendingReqs);
  const pendingSnapshot = createQuotationSnapshot(pendingReqs, "2026-11-07T08:06:00.000Z");

  const sessionPending: VoiceBookingSession = {
    id: pendingId,
    phoneNumber: "+919876543210",
    language: "en",
    state: "awaiting_staff_approval",
    staffApprovalId: null,
    requirements: pendingReqs,
    quotation: pendingQuotation,
    quotationSnapshot: pendingSnapshot,
    officialBookingId: pendingVanId,
    metadata: {
      isDemo: true,
      demoScenario: "pending_staff_approval",
      officialBookingId: pendingVanId,
      enquiryRequestId: pendingVanId,
      bookingSource: "voice_booking",
    },
    conversationHistory: [
      {
        id: `msg_a_${pendingId}_1`,
        role: "assistant",
        content: "Welcome to BREW Coffee Voice Concierge! I'd love to help you arrange mobile espresso bar catering. What date and location are you planning?",
        language: "en",
        timestamp: "2026-11-07T08:00:00.000Z",
      },
      {
        id: `msg_u_${pendingId}_1`,
        role: "user",
        content: "Hi! We're planning our annual Tech Summit in Hitec City on 2026-12-18 starting at 2 PM for 60 guests.",
        language: "en",
        timestamp: "2026-11-07T08:01:00.000Z",
      },
      {
        id: `msg_a_${pendingId}_2`,
        role: "assistant",
        content: "Got it! And how many hours of beverage service will you need?",
        language: "en",
        timestamp: "2026-11-07T08:02:00.000Z",
      },
      {
        id: `msg_u_${pendingId}_2`,
        role: "user",
        content: "We need 4 hours of service, but actually 85 guests will be attending now.",
        language: "en",
        timestamp: "2026-11-07T08:04:00.000Z",
      },
      {
        id: `msg_a_${pendingId}_3`,
        role: "assistant",
        content: "Updated to 85 guests for 4 hours. We recommend our Artisanal Signature package with unlimited specialty brews and 2 dedicated baristas.",
        language: "en",
        timestamp: "2026-11-07T08:05:00.000Z",
      },
      {
        id: `msg_u_${pendingId}_3`,
        role: "user",
        content: "That sounds perfect. I confirm this quotation and want to submit for barista review.",
        language: "en",
        timestamp: "2026-11-07T08:06:00.000Z",
      },
    ],
    createdAt: "2026-11-07T08:00:00.000Z",
    updatedAt: "2026-11-07T08:06:00.000Z",
    revision: 6,
  };

  // 2. Confirmed Demo Booking (Hindi)
  const approvedId = "vbs_demo_approved_booking";
  const approvedVanId = computeOfficialVanRequestId(approvedId);
  const approvedReqs = {
    eventType: "wedding" as const,
    guestCount: 120,
    eventDate: "2026-12-20",
    startTime: "18:00",
    durationHours: 5,
    venueAddress: "Jubilee Hills, Hyderabad",
    selectedTier: "PREMIUM" as const,
    beveragePreferences: ["filter coffee", "cold brew", "espresso tonic"],
    customerConfirmed: true,
    handoffRequested: false,
    confidenceScore: 0.99,
    missingFields: [],
    unresolvedQuestions: [],
    corrections: [],
  };
  const approvedQuotation = generateVoiceBookingQuotation(approvedReqs);
  const approvedSnapshot = createQuotationSnapshot(approvedReqs, "2026-11-07T09:10:00.000Z");

  const sessionApproved: VoiceBookingSession = {
    id: approvedId,
    phoneNumber: "+919876543211",
    language: "hi",
    state: "booking_confirmed",
    staffApprovalId: "appr_demo_001",
    requirements: approvedReqs,
    quotation: approvedQuotation,
    quotationSnapshot: approvedSnapshot,
    officialBookingId: approvedVanId,
    staffApprovalAudit: {
      staffIdentity: "staff-barista-arjun",
      staffRole: "barista",
      staffApprovalId: "appr_demo_001",
      approvedAt: "2026-11-07T09:15:00.000Z",
      sessionId: approvedId,
    },
    metadata: {
      isDemo: true,
      demoScenario: "confirmed_booking",
      officialBookingId: approvedVanId,
      enquiryRequestId: approvedVanId,
      bookingSource: "voice_booking",
    },
    conversationHistory: [
      {
        id: `msg_a_${approvedId}_1`,
        role: "assistant",
        content: "नमस्ते! ब्रू कॉफ़ी वॉयस कंसीयर्ज में आपका स्वागत है। आप किस तारीख और स्थान पर कॉफ़ी कैटरिंग की योजना बना रहे हैं?",
        language: "hi",
        timestamp: "2026-11-07T09:00:00.000Z",
      },
      {
        id: `msg_u_${approvedId}_1`,
        role: "user",
        content: "नमस्ते, हमें 2026-12-20 को शाम 6 बजे जुबली हिल्स में 120 मेहमानों के लिए 5 घंटे का वीआईपी कॉफ़ी बार चाहिए।",
        language: "hi",
        timestamp: "2026-11-07T09:05:00.000Z",
      },
      {
        id: `msg_u_${approvedId}_2`,
        role: "user",
        content: "हाँ, यह पैकेज कन्फ़र्म कर दीजिए।",
        language: "hi",
        timestamp: "2026-11-07T09:10:00.000Z",
      },
    ],
    createdAt: "2026-11-07T09:00:00.000Z",
    updatedAt: "2026-11-07T09:15:00.000Z",
    revision: 4,
  };

  // 3. Declined Demo Booking (Telugu)
  const declinedId = "vbs_demo_declined_booking";
  const declinedVanId = computeOfficialVanRequestId(declinedId);
  const declinedReqs = {
    eventType: "corporate" as const,
    guestCount: 200,
    eventDate: "2026-12-15",
    startTime: "09:00",
    durationHours: 3,
    venueAddress: "Gachibowli, Hyderabad",
    selectedTier: "BASIC" as const,
    beveragePreferences: [],
    customerConfirmed: true,
    handoffRequested: false,
    confidenceScore: 0.95,
    missingFields: [],
    unresolvedQuestions: [],
    corrections: [],
  };
  const declinedQuotation = generateVoiceBookingQuotation(declinedReqs);
  const declinedSnapshot = createQuotationSnapshot(declinedReqs, "2026-11-07T09:40:00.000Z");

  const sessionDeclined: VoiceBookingSession = {
    id: declinedId,
    phoneNumber: "+919876543212",
    language: "te",
    state: "customer_declined",
    staffApprovalId: null,
    requirements: declinedReqs,
    quotation: declinedQuotation,
    quotationSnapshot: declinedSnapshot,
    officialBookingId: declinedVanId,
    staffRejectionAudit: {
      staffIdentity: "staff-barista-arjun",
      staffRole: "barista",
      staffRejectionId: "rej_demo_001",
      sessionId: declinedId,
      rejectedAt: "2026-11-07T09:45:00.000Z",
      reason: "CONFIDENTIAL INTERNAL NOTE: Mobile Van #2 generator scheduled for mandatory annual overhaul. Vehicle unavailable.",
      customerFacingReason: "All mobile vans are reserved during this slot due to scheduled maintenance.",
    },
    metadata: {
      isDemo: true,
      demoScenario: "declined_booking",
      officialBookingId: declinedVanId,
      enquiryRequestId: declinedVanId,
      bookingSource: "voice_booking",
    },
    conversationHistory: [
      {
        id: `msg_a_${declinedId}_1`,
        role: "assistant",
        content: "నమస్కారం! బ్రూ కాఫీ వాయిస్ ద్వారపాలకుడికి స్వాగతం. మీ ఈవెంట్ వివరాలు చెప్పండి.",
        language: "te",
        timestamp: "2026-11-07T09:30:00.000Z",
      },
      {
        id: `msg_u_${declinedId}_1`,
        role: "user",
        content: "నాకు 2026-12-15 న ఉదయం 9 గంటలకు 200 మంది కోసం 3 గంటలు గచ్చిబౌలిలో కాఫీ క్యాటరింగ్ కావాలి.",
        language: "te",
        timestamp: "2026-11-07T09:35:00.000Z",
      },
      {
        id: `msg_u_${declinedId}_2`,
        role: "user",
        content: "అవును, ఈ ప్యాకేజీని కన్ఫర్మ్ చేయండి.",
        language: "te",
        timestamp: "2026-11-07T09:40:00.000Z",
      },
    ],
    createdAt: "2026-11-07T09:30:00.000Z",
    updatedAt: "2026-11-07T09:45:00.000Z",
    revision: 4,
  };

  return [sessionPending, sessionApproved, sessionDeclined];
}

/**
 * Ensures demo sessions exist in the repository if currently empty.
 * Strictly active in local development/prototype mode.
 * PROHIBITED IN PRODUCTION: Will never seed demo data when NODE_ENV is production.
 */
export async function ensureDemoSessions(repository: VoiceSessionRepository): Promise<VoiceBookingSession[]> {
  if (process.env.NODE_ENV === "production" || !isVoicePrototypeMode()) {
    return [];
  }

  const demoSessions = createDemoVoiceBookingSessions();
  for (const session of demoSessions) {
    const existing = await repository.getById(session.id);
    if (!existing) {
      await repository.save(session);
    }
  }

  return demoSessions;
}
