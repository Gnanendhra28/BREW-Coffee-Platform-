"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Calendar,
  MapPin,
  Users,
  Coffee,
  Check,
  X,
  ShieldCheck,
  ShieldAlert,
  FileText,
  MessageSquare,
  Sparkles,
} from "lucide-react";

export interface VoiceSessionItem {
  id: string;
  sessionId: string;
  requestId?: string | null;
  state: string;
  status: string;
  language: string;
  createdAt?: string;
  updatedAt?: string;
  officialBookingId?: string | null;
  maskedPhone?: string | null;
  requirements?: {
    eventType?: string | null;
    guestCount?: number | null;
    eventDate?: string | null;
    startTime?: string | null;
    durationHours?: number | null;
    venueAddress?: string | null;
    selectedTier?: string | null;
    customerConfirmed?: boolean;
    missingFields?: string[];
  };
  quotation?: {
    eventType?: string;
    guestCount?: number;
    estimatedGuests?: number;
    recommendedTier?: string | null;
    tiers?: Array<{
      tierId: string;
      name: string;
      pricePerGuest: number;
      totalAmount: number;
      perks: string[];
      isRecommended: boolean;
      tagline?: string;
      staffAssigned?: number;
      equipmentSummary?: string;
    }>;
  } | null;
  quotationIntegrity?: {
    valid: boolean;
    reason?: string;
  };
  staffApprovalAudit?: {
    approvedAt: string;
    staffRole: string;
  } | null;
  staffRejectionAudit?: {
    rejectedAt: string;
    staffRole: string;
    reason: string;
    customerFacingReason?: string;
  } | null;
  conversationHistory?: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    language: string;
    timestamp: string;
  }>;
}

export function VoiceBookingsManager({
  title = "AI Voice Booking Requests",
  subtitle = "Review customer-confirmed voice bookings, verify quotation integrity, and authorize or decline requests.",
}: {
  title?: string;
  subtitle?: string;
}) {
  const [sessions, setSessions] = useState<VoiceSessionItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected">("pending");
  const [selectedSession, setSelectedSession] = useState<VoiceSessionItem | null>(null);

  // Approval state
  const [approvingSessionId, setApprovingSessionId] = useState<string | null>(null);

  // Rejection modal state
  const [rejectionTargetId, setRejectionTargetId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [customerFacingReason, setCustomerFacingReason] = useState("");
  const [isSubmittingRejection, setIsSubmittingRejection] = useState(false);

  // Feedback notifications
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/voice-booking/sessions");
      if (res.ok) {
        const data = await res.json();
        const loaded: VoiceSessionItem[] = data.sessions || [];
        setSessions(loaded);

        // Keep selectedSession updated if open
        if (selectedSession) {
          const updated = loaded.find((s) => s.id === selectedSession.id);
          if (updated) setSelectedSession(updated);
        }
      } else {
        const data = await res.json();
        setErrorMessage(data.error || "Failed to load voice booking sessions");
      }
    } catch {
      setErrorMessage("Network error fetching voice booking sessions");
    } finally {
      setIsLoading(false);
    }
  }, [selectedSession]);

  useEffect(() => {
    queueMicrotask(() => {
      fetchSessions();
    });
  }, [fetchSessions]);

  // Execute staff approval
  const handleApprove = async (sessionId: string) => {
    setApprovingSessionId(sessionId);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch("/api/voice-booking/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Staff approval failed");
      } else {
        setSuccessMessage(`Session ${sessionId} successfully approved & booking confirmed!`);
        await fetchSessions();
      }
    } catch {
      setErrorMessage("Network error during staff approval");
    } finally {
      setApprovingSessionId(null);
    }
  };

  // Open rejection modal
  const openRejectionModal = (sessionId: string) => {
    setRejectionTargetId(sessionId);
    setRejectionReason("");
    setCustomerFacingReason("Our catering team is unable to fulfill this booking request with the specified logistics.");
    setErrorMessage(null);
  };

  // Execute staff rejection
  const handleReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectionTargetId) return;

    if (!rejectionReason.trim() || rejectionReason.trim().length < 3) {
      setErrorMessage("A detailed staff rejection reason of at least 3 characters is mandatory for audit records.");
      return;
    }

    setIsSubmittingRejection(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await fetch("/api/voice-booking/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: rejectionTargetId,
          reason: rejectionReason.trim(),
          customerFacingReason: customerFacingReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Rejection action failed");
      } else {
        setSuccessMessage(`Session ${rejectionTargetId} declined and status updated.`);
        setRejectionTargetId(null);
        setRejectionReason("");
        setCustomerFacingReason("");
        await fetchSessions();
      }
    } catch {
      setErrorMessage("Network error during rejection action");
    } finally {
      setIsSubmittingRejection(false);
    }
  };

  // Filtered session list
  const filteredSessions = sessions.filter((s) => {
    if (filter === "pending") return s.state === "awaiting_staff_approval";
    if (filter === "approved") return s.state === "booking_confirmed";
    if (filter === "rejected") return s.state === "customer_declined" || s.state === "cancelled";
    return true;
  });

  const pendingCount = sessions.filter((s) => s.state === "awaiting_staff_approval").length;
  const approvedCount = sessions.filter((s) => s.state === "booking_confirmed").length;
  const rejectedCount = sessions.filter((s) => s.state === "customer_declined" || s.state === "cancelled").length;

  return (
    <div className="space-y-5">
      {/* Top Header Card */}
      <div className="p-5 rounded-2xl bg-[#1C130D] border border-white/10 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="p-2 rounded-xl bg-amber-500/10 text-[#DFAB6C] border border-[#DFAB6C]/30">
              <Coffee className="w-5 h-5" />
            </span>
            <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
              {title}
            </h2>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-[#DFAB6C] border border-[#DFAB6C]/30">
              Zero-Cost Prototype
            </span>
          </div>
          <p className="text-xs text-[#8C7C70]">{subtitle}</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchSessions()}
            disabled={isLoading}
            className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-[#DFAB6C] border border-white/10 transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1.5 text-xs font-mono"
            title="Refresh list"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Alerts */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-3">
        <button
          type="button"
          onClick={() => setFilter("pending")}
          className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
            filter === "pending"
              ? "bg-amber-500 text-black shadow-md"
              : "bg-white/5 text-[#C4B4A8] hover:bg-white/10"
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>Pending Review</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-black/30">
            {pendingCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setFilter("approved")}
          className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
            filter === "approved"
              ? "bg-emerald-500 text-black shadow-md"
              : "bg-white/5 text-[#C4B4A8] hover:bg-white/10"
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Approved</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-black/30">
            {approvedCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setFilter("rejected")}
          className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
            filter === "rejected"
              ? "bg-red-500 text-white shadow-md"
              : "bg-white/5 text-[#C4B4A8] hover:bg-white/10"
          }`}
        >
          <XCircle className="w-3.5 h-3.5" />
          <span>Rejected / Declined</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-black/30">
            {rejectedCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
            filter === "all"
              ? "bg-white/20 text-white shadow-md"
              : "bg-white/5 text-[#8C7C70] hover:bg-white/10"
          }`}
        >
          <span>All Inquiries</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-black/30">
            {sessions.length}
          </span>
        </button>
      </div>

      {/* Booking Requests List */}
      {filteredSessions.length === 0 ? (
        <div className="p-8 rounded-2xl bg-black/30 border border-white/5 text-center space-y-2">
          <Coffee className="w-8 h-8 text-[#8C7C70] mx-auto opacity-40" />
          <p className="text-xs text-[#8C7C70]">
            No voice booking requests found in this filter category.
          </p>
          <p className="text-[11px] text-[#A8988B]">
            Simulate a new booking inquiry at <Link href="/location" className="text-[#DFAB6C] underline">/location</Link> or open <Link href="/voice-booking/demo" className="text-[#DFAB6C] underline">/voice-booking/demo</Link>.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5">
          {filteredSessions.map((session) => {
            const isAwaiting = session.state === "awaiting_staff_approval";
            const isConfirmed = session.state === "booking_confirmed";
            const isDeclined = session.state === "customer_declined" || session.state === "cancelled";
            const req = session.requirements || {};
            const quote = session.quotation;
            const chosenTier =
              quote?.tiers?.find((t) => t.tierId === req.selectedTier) ||
              quote?.tiers?.find((t) => t.isRecommended) ||
              quote?.tiers?.[0];

            return (
              <div
                key={session.id}
                className={`p-4 rounded-2xl border transition-all ${
                  isAwaiting
                    ? "bg-[#1E1610] border-amber-500/50 shadow-lg ring-1 ring-amber-500/30"
                    : isConfirmed
                    ? "bg-[#121B15] border-emerald-500/40"
                    : isDeclined
                    ? "bg-[#1C1212] border-red-500/30 text-[#A8988B]"
                    : "bg-black/40 border-white/5 text-[#C4B4A8]"
                }`}
              >
                {/* Header row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-white">
                      {session.id}
                    </span>
                    {session.officialBookingId && (
                      <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        Official ID: {session.officialBookingId}
                      </span>
                    )}
                    {session.maskedPhone && (
                      <span className="px-2 py-0.5 rounded text-[9px] font-mono bg-white/5 border border-white/10 text-[#C4B4A8]">
                        📞 {session.maskedPhone}
                      </span>
                    )}
                    <span className="px-2 py-0.5 rounded text-[9px] font-mono uppercase bg-white/5 border border-white/10 text-[#DFAB6C]">
                      🌐 {session.language || "en"}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Status badge */}
                    {isAwaiting && (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                        ⚠️ Awaiting Staff Approval
                      </span>
                    )}
                    {isConfirmed && (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        ✓ Confirmed
                      </span>
                    )}
                    {isDeclined && (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-red-500/20 text-red-300 border border-red-500/40">
                        ✗ Declined / Cancelled
                      </span>
                    )}

                    {/* Quotation integrity badge */}
                    {session.quotationIntegrity?.valid ? (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3 text-emerald-400" />
                        <span>Signature Verified</span>
                      </span>
                    ) : session.quotation ? (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/20 flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3 text-red-400" />
                        <span>Integrity Failed</span>
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Requirements Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 my-3 text-xs font-mono">
                  <div className="p-2 rounded-xl bg-black/30 border border-white/5">
                    <span className="text-[9px] text-[#8C7C70] block flex items-center gap-1">
                      <Calendar className="w-2.5 h-2.5" /> Date &amp; Time
                    </span>
                    <span className="font-bold text-white truncate block">
                      {req.eventDate || "Pending"} {req.startTime ? `@ ${req.startTime}` : ""}
                    </span>
                  </div>

                  <div className="p-2 rounded-xl bg-black/30 border border-white/5">
                    <span className="text-[9px] text-[#8C7C70] block flex items-center gap-1">
                      <Users className="w-2.5 h-2.5" /> Guests &amp; Duration
                    </span>
                    <span className="font-bold text-white truncate block">
                      {req.guestCount ? `${req.guestCount} guests` : "Pending"} · {req.durationHours ? `${req.durationHours} hrs` : "Pending"}
                    </span>
                  </div>

                  <div className="p-2 rounded-xl bg-black/30 border border-white/5">
                    <span className="text-[9px] text-[#8C7C70] block flex items-center gap-1">
                      <MapPin className="w-2.5 h-2.5" /> Venue Address
                    </span>
                    <span className="font-bold text-white truncate block">
                      {req.venueAddress || "Pending"}
                    </span>
                  </div>

                  <div className="p-2 rounded-xl bg-black/30 border border-white/5">
                    <span className="text-[9px] text-[#8C7C70] block flex items-center gap-1">
                      <Coffee className="w-2.5 h-2.5" /> Package &amp; Total
                    </span>
                    <span className="font-bold text-emerald-400 truncate block">
                      {chosenTier ? `${chosenTier.name} (₹${chosenTier.totalAmount.toLocaleString("en-IN")})` : "Unquoted"}
                    </span>
                  </div>
                </div>

                {/* Audit details if available */}
                {isConfirmed && session.staffApprovalAudit && (
                  <div className="mb-2 p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-300 font-mono flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>
                      Approved by <strong>{session.staffApprovalAudit.staffRole.toUpperCase()}</strong> at {new Date(session.staffApprovalAudit.approvedAt).toLocaleTimeString()}
                    </span>
                  </div>
                )}

                {isDeclined && session.staffRejectionAudit && (
                  <div className="mb-2 p-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] text-red-300 font-mono space-y-1">
                    <div className="flex items-center gap-2">
                      <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      <span>
                        Declined by <strong>{session.staffRejectionAudit.staffRole.toUpperCase()}</strong> at {new Date(session.staffRejectionAudit.rejectedAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div>
                      <span className="opacity-70">Staff Note:</span> {session.staffRejectionAudit.reason}
                    </div>
                  </div>
                )}

                {/* Action Footer */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-white/5">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedSession(session)}
                      className="text-xs text-[#DFAB6C] hover:text-white font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>Review Full Details</span>
                    </button>

                    <Link
                      href={`/voice-booking/${session.id}`}
                      target="_blank"
                      className="text-xs text-[#C4B4A8] hover:text-[#DFAB6C] flex items-center gap-1 transition-colors"
                    >
                      <span>Customer Page</span>
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                  </div>

                  <div className="flex items-center gap-2">
                    {isAwaiting && (
                      <>
                        <button
                          type="button"
                          onClick={() => openRejectionModal(session.id)}
                          className="px-3 py-1.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-300 font-bold text-xs border border-red-500/30 transition-all flex items-center gap-1 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Reject</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleApprove(session.id)}
                          disabled={
                            approvingSessionId === session.id ||
                            (session.quotationIntegrity && !session.quotationIntegrity.valid)
                          }
                          className="px-4 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-bold text-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-md"
                          title={
                            session.quotationIntegrity && !session.quotationIntegrity.valid
                              ? "Approval blocked: Quotation integrity verification failed"
                              : "Approve and confirm booking"
                          }
                        >
                          {approvingSessionId === session.id ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Approving...</span>
                            </>
                          ) : (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>Approve Booking</span>
                            </>
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* DETAIL REVIEW MODAL */}
      {selectedSession && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[90vh] bg-[#18110B] border border-[#DFAB6C]/40 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 bg-[#20150E] border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Coffee className="w-5 h-5 text-[#DFAB6C]" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Booking Detail Review: <span className="font-mono text-[#DFAB6C]">{selectedSession.id}</span>
                  </h3>
                  <div className="flex items-center gap-2 text-[10px] text-[#8C7C70] font-mono">
                    <span>Lang: {selectedSession.language.toUpperCase()}</span>
                    <span>•</span>
                    <span>Phone: {selectedSession.maskedPhone || "N/A"}</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedSession(null)}
                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1 text-xs">
              {/* Quotation Integrity Warning Banner if invalid */}
              {selectedSession.quotationIntegrity && !selectedSession.quotationIntegrity.valid && (
                <div className="p-3.5 rounded-xl bg-red-500/15 border border-red-500/40 text-red-200 space-y-1">
                  <div className="flex items-center gap-2 font-bold text-red-300">
                    <ShieldAlert className="w-4 h-4" />
                    <span>QUOTATION INTEGRITY CHECK FAILED — APPROVAL BLOCKED</span>
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    Reason: {selectedSession.quotationIntegrity.reason}. The quotation parameters do not match the cryptographic signature recorded when the customer reviewed the quote.
                  </p>
                </div>
              )}

              {/* Requirements & Missing Fields */}
              <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <h4 className="font-bold text-white text-xs uppercase tracking-wider font-mono">
                    Event Requirements
                  </h4>
                  {selectedSession.requirements?.missingFields && selectedSession.requirements.missingFields.length > 0 ? (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono">
                      Missing: {selectedSession.requirements.missingFields.join(", ")}
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                      All Mandatory Fields Extracted
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 font-mono text-[11px]">
                  <div>
                    <span className="text-[#8C7C70] block">Date:</span>
                    <span className="text-white font-bold">{selectedSession.requirements?.eventDate || "Not Provided"}</span>
                  </div>
                  <div>
                    <span className="text-[#8C7C70] block">Start Time:</span>
                    <span className="text-white font-bold">{selectedSession.requirements?.startTime || "Not Provided"}</span>
                  </div>
                  <div>
                    <span className="text-[#8C7C70] block">Duration:</span>
                    <span className="text-white font-bold">{selectedSession.requirements?.durationHours ? `${selectedSession.requirements.durationHours} hours` : "Not Provided"}</span>
                  </div>
                  <div>
                    <span className="text-[#8C7C70] block">Guests:</span>
                    <span className="text-white font-bold">{selectedSession.requirements?.guestCount ? `${selectedSession.requirements.guestCount} guests` : "Not Provided"}</span>
                  </div>
                  <div>
                    <span className="text-[#8C7C70] block">Venue Address:</span>
                    <span className="text-white font-bold">{selectedSession.requirements?.venueAddress || "Not Provided"}</span>
                  </div>
                  <div>
                    <span className="text-[#8C7C70] block">Customer Confirmed:</span>
                    <span className={selectedSession.requirements?.customerConfirmed ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>
                      {selectedSession.requirements?.customerConfirmed ? "Yes (Explicit)" : "Pending"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Quotation Breakdown Card */}
              {selectedSession.quotation && (
                <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
                  <div className="flex items-center justify-between border-b border-white/5 pb-2">
                    <h4 className="font-bold text-white text-xs uppercase tracking-wider font-mono flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#DFAB6C]" />
                      Authoritative Quotation &amp; Logistics Breakdown
                    </h4>
                    {selectedSession.quotationIntegrity?.valid && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3 text-emerald-400" />
                        Signature Valid
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {selectedSession.quotation.tiers?.map((tier) => {
                      const isSelected =
                        selectedSession.requirements?.selectedTier === tier.tierId ||
                        (!selectedSession.requirements?.selectedTier && tier.isRecommended);

                      return (
                        <div
                          key={tier.tierId}
                          className={`p-3 rounded-xl border text-left flex flex-col justify-between ${
                            isSelected
                              ? "bg-[#DFAB6C]/10 border-[#DFAB6C] shadow-md ring-1 ring-[#DFAB6C]/40"
                              : "bg-black/20 border-white/5"
                          }`}
                        >
                          <div>
                            <div className="flex justify-between items-start">
                              <span className="font-bold text-white text-xs">{tier.name}</span>
                              {isSelected && (
                                <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#DFAB6C] text-black font-bold">
                                  Selected
                                </span>
                              )}
                            </div>
                            <div className="mt-2 text-sm font-bold text-[#DFAB6C] font-mono">
                              ₹{tier.totalAmount.toLocaleString("en-IN")}
                            </div>
                            <div className="text-[10px] text-[#8C7C70] font-mono">
                              ₹{tier.pricePerGuest}/guest
                            </div>

                            <div className="mt-2 text-[10px] text-amber-200/80 bg-black/30 p-1.5 rounded space-y-0.5 font-mono">
                              <div>☕ {tier.staffAssigned} Baristas</div>
                              <div className="truncate">⚙️ {tier.equipmentSummary}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Conversation History Transcript */}
              <div className="p-4 rounded-xl bg-black/30 border border-white/10 space-y-3">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <h4 className="font-bold text-white text-xs uppercase tracking-wider font-mono flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5 text-[#DFAB6C]" />
                    Customer Conversation Transcript ({selectedSession.conversationHistory?.length || 0} Turns)
                  </h4>
                </div>

                <div className="max-h-56 overflow-y-auto space-y-2.5 p-2 rounded-lg bg-black/40">
                  {!selectedSession.conversationHistory || selectedSession.conversationHistory.length === 0 ? (
                    <span className="text-[11px] text-[#8C7C70] italic">No conversation turns recorded.</span>
                  ) : (
                    selectedSession.conversationHistory.map((turn) => (
                      <div
                        key={turn.id}
                        className={`p-2.5 rounded-xl text-[11px] leading-relaxed ${
                          turn.role === "assistant"
                            ? "bg-[#251A13] text-[#EDE4DA] border border-white/5"
                            : turn.role === "user"
                            ? "bg-[#DFAB6C]/20 text-[#DFAB6C] border border-[#DFAB6C]/30 ml-4"
                            : "bg-white/5 text-[#8C7C70]"
                        }`}
                      >
                        <div className="flex justify-between items-center text-[9px] opacity-70 mb-1">
                          <span className="font-bold uppercase font-mono">{turn.role} ({turn.language})</span>
                          <span>{new Date(turn.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <p className="whitespace-pre-wrap">{turn.content}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Modal Actions Footer */}
            <div className="p-4 bg-[#20150E] border-t border-white/10 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setSelectedSession(null)}
                className="px-4 py-2 rounded-xl bg-white/10 text-white font-bold text-xs hover:bg-white/20"
              >
                Close
              </button>

              <div className="flex items-center gap-2">
                {selectedSession.state === "awaiting_staff_approval" && (
                  <>
                    <button
                      type="button"
                      onClick={() => openRejectionModal(selectedSession.id)}
                      className="px-4 py-2 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-300 font-bold text-xs border border-red-500/30 cursor-pointer"
                    >
                      Reject Request
                    </button>

                    <button
                      type="button"
                      onClick={() => handleApprove(selectedSession.id)}
                      disabled={
                        approvingSessionId === selectedSession.id ||
                        (selectedSession.quotationIntegrity && !selectedSession.quotationIntegrity.valid)
                      }
                      className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-bold text-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-md"
                    >
                      {approvingSessionId === selectedSession.id ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Authorizing...</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Approve &amp; Confirm Booking</span>
                        </>
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* REJECTION REASON MODAL */}
      {rejectionTargetId && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleReject}
            className="w-full max-w-lg bg-[#1C1210] border border-red-500/40 rounded-2xl shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <XCircle className="w-5 h-5 text-red-400" />
                <h3 className="text-sm font-bold text-white">
                  Decline Booking: <span className="font-mono text-red-300">{rejectionTargetId}</span>
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setRejectionTargetId(null)}
                className="text-white/50 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-white mb-1">
                  Internal Audit Rejection Reason <span className="text-red-400">* (Min 3 characters)</span>
                </label>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g. Schedule conflict with high-volume wedding catering in Jubilee Hills"
                  rows={2}
                  required
                  minLength={3}
                  className="w-full p-2.5 rounded-xl bg-black/40 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-red-400"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#C4B4A8] mb-1">
                  Customer-Facing Reason (Displayed politely on status page)
                </label>
                <textarea
                  value={customerFacingReason}
                  onChange={(e) => setCustomerFacingReason(e.target.value)}
                  placeholder="e.g. Our barista van is fully committed for the selected time slot."
                  rows={2}
                  className="w-full p-2.5 rounded-xl bg-black/40 border border-white/10 text-white placeholder-white/30 text-xs focus:outline-none focus:border-red-400"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
              <button
                type="button"
                onClick={() => setRejectionTargetId(null)}
                className="px-4 py-2 rounded-xl bg-white/10 text-white font-bold text-xs hover:bg-white/20"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingRejection || rejectionReason.trim().length < 3}
                className="px-5 py-2 rounded-xl bg-red-500 hover:bg-red-400 text-white font-bold text-xs transition-all disabled:opacity-50 cursor-pointer shadow-md"
              >
                {isSubmittingRejection ? "Declining..." : "Confirm Rejection"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
