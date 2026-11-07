"use client";

import React, { useEffect, useState, useRef, use, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Phone,
  Sparkles,
  Send,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowLeft,
  ShieldCheck,
  RefreshCw,
  XCircle,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Square,
  Pause,
  Play,
  RotateCcw,
  Calendar,
  MapPin,
  Users,
  Coffee,
  Edit3,
  Check,
  ArrowRight,
} from "lucide-react";
import { Header } from "../../../components/Header";
import { SafeCustomerVoiceSessionView } from "../../../lib/communication/visibility";
import {
  detectBrowserSpeechCapabilities,
  createBrowserSpeechRecognizer,
  createBrowserSpeechSynthesizer,
  BrowserSpeechCapabilities,
  BrowserSpeechRecognizer,
  BrowserSpeechSynthesizer,
  BROWSER_SPEECH_LANGUAGES,
} from "../../../lib/voiceBooking/browserSpeechAdapter";
import { SupportedLanguage } from "../../../lib/voiceBooking/types";

export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "error";
export type ConversationMode = "auto" | "push_to_talk";

function isTerminalState(state?: string): boolean {
  if (!state) return false;
  return (
    state === "booking_confirmed" ||
    state === "customer_declined" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "awaiting_staff_approval"
  );
}

export default function VoiceBookingConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const sessionId = resolvedParams.id;

  const [session, setSession] = useState<SafeCustomerVoiceSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputMessage, setInputMessage] = useState("");
  const [isSending, setIsSending] = useState(false);

  // Browser voice interface states
  const [capabilities, setCapabilities] = useState<BrowserSpeechCapabilities | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<SupportedLanguage>("en");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceErrorMessage, setVoiceErrorMessage] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Phase P3: Conversation loop and reliability states
  const [conversationMode, setConversationMode] = useState<ConversationMode>("auto");
  const [isVoicePaused, setIsVoicePaused] = useState<boolean>(false);
  const [lastFailedTurn, setLastFailedTurn] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognizerRef = useRef<BrowserSpeechRecognizer | null>(null);
  const synthesizerRef = useRef<BrowserSpeechSynthesizer | null>(null);
  const lastSubmittedTranscriptRef = useRef<string>("");
  const lastSubmittedTimeRef = useRef<number>(0);
  const isMutedRef = useRef<boolean>(false);
  const conversationModeRef = useRef<ConversationMode>("auto");
  const isVoicePausedRef = useRef<boolean>(false);
  const sessionRef = useRef<SafeCustomerVoiceSessionView | null>(null);

  // Keep sessionRef in sync with state
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Toggle mute helper
  const handleToggleMute = () => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      if (next) {
        synthesizerRef.current?.cancel();
        setVoiceState((s) => (s === "speaking" ? "idle" : s));
      }
      return next;
    });
  };

  // Toggle conversation mode (Hands-Free Auto vs Push-to-Talk)
  const handleToggleConversationMode = () => {
    setConversationMode((prev) => {
      const next = prev === "auto" ? "push_to_talk" : "auto";
      conversationModeRef.current = next;
      return next;
    });
  };

  // Detect browser speech capabilities on mount
  useEffect(() => {
    queueMicrotask(() => {
      setCapabilities(detectBrowserSpeechCapabilities());
    });
  }, []);

  // Initialize Speech Synthesizer
  useEffect(() => {
    synthesizerRef.current = createBrowserSpeechSynthesizer({
      language: selectedLanguage,
      onStart: () => setVoiceState("speaking"),
      onEnd: () => {
        setVoiceState((prev) => (prev === "speaking" ? "idle" : prev));
        // Phase P3: In auto/hands-free continuous conversation mode, automatically re-arm listening once assistant finishes speaking
        if (
          conversationModeRef.current === "auto" &&
          !isVoicePausedRef.current &&
          sessionRef.current &&
          !isTerminalState(sessionRef.current.state)
        ) {
          setTimeout(() => {
            if (
              conversationModeRef.current === "auto" &&
              !isVoicePausedRef.current &&
              sessionRef.current &&
              !isTerminalState(sessionRef.current.state)
            ) {
              setVoiceState("listening");
              recognizerRef.current?.start();
            }
          }, 450); // Natural conversational pause
        }
      },
      onError: () => {
        setVoiceState((prev) => (prev === "speaking" ? "idle" : prev));
        // Continue hands-free loop even if voice synthesis fails
        if (
          conversationModeRef.current === "auto" &&
          !isVoicePausedRef.current &&
          sessionRef.current &&
          !isTerminalState(sessionRef.current.state)
        ) {
          setTimeout(() => {
            if (
              conversationModeRef.current === "auto" &&
              !isVoicePausedRef.current &&
              sessionRef.current &&
              !isTerminalState(sessionRef.current.state)
            ) {
              setVoiceState("listening");
              recognizerRef.current?.start();
            }
          }, 600);
        }
      },
    });

    return () => {
      synthesizerRef.current?.cancel();
    };
  }, [selectedLanguage]);

  // Phase P3: Core Conversational Turn Submission with Idempotency & Language Context
  const handleVoiceTurnSubmission = useCallback(
    async (textToSend: string) => {
      if (!textToSend || !session || isSending) return;

      // Duplicate submission prevention (debounce 2500ms for exact duplicate recognized chunks)
      const now = Date.now();
      if (
        textToSend === lastSubmittedTranscriptRef.current &&
        now - lastSubmittedTimeRef.current < 2500
      ) {
        return;
      }
      lastSubmittedTranscriptRef.current = textToSend;
      lastSubmittedTimeRef.current = now;

      // Barge-in: interrupt assistant speech
      synthesizerRef.current?.cancel();

      setVoiceState("processing");
      setLiveTranscript("");
      setIsSending(true);

      // Phase P3: Construct unique clientTurnId and sequential turnIndex
      const userTurnCount = session.conversationHistory?.filter((m) => m.role === "user").length || 0;
      const turnIndex = userTurnCount + 1;
      const clientTurnId = `${session.sessionId}_turn_${turnIndex}_${now}`;

      try {
        const res = await fetch("/api/voice-booking/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.sessionId,
            message: textToSend,
            turnIndex,
            clientTurnId,
            language: selectedLanguage,
          }),
        });

        const data = await res.json();
        if (res.ok && data.session) {
          setSession(data.session);
          setLastFailedTurn(null);

          // Update UI language if detected differently by engine (code-switching)
          if (
            data.session.language &&
            (data.session.language === "en" ||
              data.session.language === "hi" ||
              data.session.language === "te") &&
            data.session.language !== selectedLanguage
          ) {
            setSelectedLanguage(data.session.language);
          }

          // Speak assistant response out loud if not muted
          if (
            !isMutedRef.current &&
            data.assistantResponse &&
            typeof data.assistantResponse === "string"
          ) {
            setVoiceState("speaking");
            synthesizerRef.current?.speak(data.assistantResponse);
          } else {
            setVoiceState("idle");
            // If muted but in auto mode, resume listening after brief interval
            if (
              conversationModeRef.current === "auto" &&
              !isVoicePausedRef.current &&
              !isTerminalState(data.session.state)
            ) {
              setTimeout(() => {
                if (
                  conversationModeRef.current === "auto" &&
                  !isVoicePausedRef.current &&
                  !isTerminalState(sessionRef.current?.state)
                ) {
                  setVoiceState("listening");
                  recognizerRef.current?.start();
                }
              }, 1200);
            }
          }
        } else {
          setVoiceState("error");
          setVoiceErrorMessage(data.error || "Failed to process voice turn.");
          setLastFailedTurn(textToSend);
          setTimeout(() => {
            setVoiceState((prev) => (prev === "error" ? "idle" : prev));
          }, 4000);
        }
      } catch {
        setVoiceState("error");
        setVoiceErrorMessage("Network connection error. You can retry your last response.");
        setLastFailedTurn(textToSend);
        setTimeout(() => {
          setVoiceState((prev) => (prev === "error" ? "idle" : prev));
        }, 4000);
      } finally {
        setIsSending(false);
      }
    },
    [session, isSending, selectedLanguage]
  );

  // Initialize Speech Recognizer
  useEffect(() => {
    recognizerRef.current = createBrowserSpeechRecognizer({
      language: selectedLanguage,
      interimResults: true,
      continuous: false,
      onStatusChange: (status) => {
        if (status === "listening") {
          setVoiceState("listening");
        } else if (status === "idle") {
          setVoiceState((prev) => (prev === "listening" ? "idle" : prev));
        }
      },
      onTranscript: (transcript, isFinal) => {
        setLiveTranscript(transcript);
        if (isFinal && transcript.trim()) {
          handleVoiceTurnSubmission(transcript.trim());
        }
      },
      onError: (errMsg) => {
        setVoiceErrorMessage(errMsg);
        setVoiceState("error");
        setTimeout(() => {
          setVoiceState((prev) => (prev === "error" ? "idle" : prev));
        }, 4000);
      },
      onEnd: () => {
        setVoiceState((prev) => (prev === "listening" ? "idle" : prev));
      },
    });

    return () => {
      recognizerRef.current?.stop();
    };
  }, [selectedLanguage, handleVoiceTurnSubmission]);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/voice-booking/session?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError(`Voice booking session '${sessionId}' was not found.`);
        } else {
          setError("Failed to load session details.");
        }
        return;
      }
      const data = await res.json();
      if (data.session) {
        setSession(data.session);
        if (
          data.session.language &&
          (data.session.language === "en" ||
            data.session.language === "hi" ||
            data.session.language === "te")
        ) {
          setSelectedLanguage(data.session.language);
        }
        setError(null);
        try {
          localStorage.setItem("brew_last_voice_session_id", sessionId);
        } catch {
          // Ignore localStorage access failures
        }
      }
    } catch {
      setError("Network error loading session.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    queueMicrotask(() => {
      fetchSession();
    });
  }, [fetchSession]);

  // Phase P6: Clean teardown on unmount
  useEffect(() => {
    return () => {
      recognizerRef.current?.stop();
      synthesizerRef.current?.cancel();
    };
  }, []);

  // Phase P5: Poll session state every 4 seconds when waiting for staff review
  useEffect(() => {
    if (session?.state === "awaiting_staff_approval") {
      const timer = setInterval(() => {
        fetchSession();
      }, 4000);
      return () => clearInterval(timer);
    }
  }, [session?.state, fetchSession]);

  // Auto-scroll messages to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.conversationHistory]);

  // Phase P3: Pause voice conversation
  const handlePauseVoice = () => {
    setIsVoicePaused(true);
    isVoicePausedRef.current = true;
    recognizerRef.current?.stop();
    synthesizerRef.current?.cancel();
    setVoiceState("idle");
  };

  // Phase P3: Resume voice conversation
  const handleResumeVoice = () => {
    setIsVoicePaused(false);
    isVoicePausedRef.current = false;
    setVoiceErrorMessage(null);
    setLiveTranscript("");
    synthesizerRef.current?.cancel();
    setVoiceState("listening");
    recognizerRef.current?.start();
  };

  // Phase P3: End voice conversation cleanly
  const handleEndVoiceConversation = () => {
    setIsVoicePaused(true);
    isVoicePausedRef.current = true;
    recognizerRef.current?.stop();
    synthesizerRef.current?.cancel();
    setVoiceState("idle");
    setLiveTranscript("");
  };

  // Push-to-talk toggle
  const handleToggleListening = () => {
    if (voiceState === "listening") {
      recognizerRef.current?.stop();
      setVoiceState("idle");
    } else {
      // Barge-in: interrupt any assistant speech immediately
      synthesizerRef.current?.cancel();
      setIsVoicePaused(false);
      isVoicePausedRef.current = false;
      setVoiceErrorMessage(null);
      setLiveTranscript("");
      setVoiceState("listening");
      recognizerRef.current?.start();
    }
  };

  const handleStopSpeaking = () => {
    synthesizerRef.current?.cancel();
    setVoiceState("idle");
  };

  const handleLanguageChange = (lang: SupportedLanguage) => {
    setSelectedLanguage(lang);
    recognizerRef.current?.setLanguage(lang);
    synthesizerRef.current?.setLanguage(lang);
  };

  const handleSpeakMessage = (text: string) => {
    if (synthesizerRef.current) {
      synthesizerRef.current.cancel();
      setVoiceState("speaking");
      synthesizerRef.current.speak(text);
    }
  };

  const handleEditField = (promptPrefix: string) => {
    setInputMessage(promptPrefix);
  };

  const handleSendMessage = async (e?: React.FormEvent, explicitText?: string) => {
    if (e) e.preventDefault();
    const textToSend = explicitText !== undefined ? explicitText : inputMessage.trim();
    if (!textToSend || isSending || !session) return;

    // Interrupt assistant speech on new message
    synthesizerRef.current?.cancel();

    setIsSending(true);
    setInputMessage("");
    setVoiceState("processing");

    const userTurnCount = session.conversationHistory?.filter((m) => m.role === "user").length || 0;
    const turnIndex = userTurnCount + 1;
    // eslint-disable-next-line react-hooks/purity
    const timestamp = Date.now();
    const clientTurnId = `${session.sessionId}_turn_${turnIndex}_${timestamp}`;

    try {
      const res = await fetch("/api/voice-booking/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          message: textToSend,
          turnIndex,
          clientTurnId,
          language: selectedLanguage,
        }),
      });

      const data = await res.json();
      if (res.ok && data.session) {
        setSession(data.session);
        setLastFailedTurn(null);

        // Speak assistant response out loud if not muted
        if (
          !isMutedRef.current &&
          data.assistantResponse &&
          typeof data.assistantResponse === "string"
        ) {
          setVoiceState("speaking");
          synthesizerRef.current?.speak(data.assistantResponse);
        } else {
          setVoiceState("idle");
        }
      } else {
        alert(data.error || "Failed to process message.");
        setLastFailedTurn(textToSend);
        setVoiceState("idle");
      }
    } catch {
      alert("Network error sending message.");
      setLastFailedTurn(textToSend);
      setVoiceState("idle");
    } finally {
      setIsSending(false);
    }
  };

  const handleSelectPackage = (tierId: string, tierName: string) => {
    handleSendMessage(undefined, `Select ${tierName} package`);
  };

  // Helper to identify the current missing field for visual highlighting
  const currentMissingField = session?.requirements?.missingFields?.[0] || null;

  const activeConfirmedTier =
    session?.quotation?.tiers.find((t) => t.tierId === session?.requirements?.selectedTier) ||
    session?.quotation?.tiers.find((t) => t.isRecommended) ||
    session?.quotation?.tiers[1] ||
    session?.quotation?.tiers[0];
  const activeTierName = activeConfirmedTier ? activeConfirmedTier.name : "Artisanal Signature";
  const activeTierTotal = activeConfirmedTier
    ? ` (₹${activeConfirmedTier.totalAmount.toLocaleString("en-IN")})`
    : "";

  return (
    <main className="relative w-full min-h-screen bg-[#140D08] text-[#F4EFE6] flex flex-col justify-start select-none font-sans">
      {/* Background Gradient */}
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 50% 25%, #301A10 0%, #170E08 55%, #0B0604 100%)",
        }}
      />
      <div className="fixed top-1/4 right-1/4 w-[500px] h-[500px] bg-[#D48F47]/10 rounded-full blur-[140px] pointer-events-none -z-10" />

      <Header />

      <div className="relative w-full max-w-4xl mx-auto pt-28 sm:pt-36 pb-20 px-4 sm:px-8 flex-1 flex flex-col">
        {/* Navigation back & Quick Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-3 text-xs">
            <Link
              href="/voice-booking"
              className="inline-flex items-center gap-1.5 text-[#8C7C70] hover:text-[#DFAB6C] transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Voice Portal</span>
            </Link>
            <span className="text-white/20">•</span>
            <Link
              href="/location"
              className="inline-flex items-center gap-1.5 text-[#8C7C70] hover:text-[#DFAB6C] transition-colors"
            >
              <span>Van Locations</span>
            </Link>
            <span className="text-white/20">•</span>
            <Link
              href="/voice-booking"
              className="inline-flex items-center gap-1 text-[#DFAB6C] hover:underline"
            >
              <span>+ New Booking</span>
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleEndVoiceConversation}
              className="inline-flex items-center gap-1 text-xs text-red-300 hover:text-white transition-colors bg-red-500/10 border border-red-500/20 px-2.5 py-1.5 rounded-lg cursor-pointer"
              title="Stop listening & speech"
            >
              <Square className="w-3 h-3 text-red-400" />
              <span>Stop Voice</span>
            </button>
            <button
              type="button"
              onClick={fetchSession}
              className="inline-flex items-center gap-1.5 text-xs text-[#DFAB6C] hover:text-white transition-colors bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* PROTOTYPE NOTICE BANNER */}
        <div className="mb-6 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3 text-left">
          <Sparkles className="w-4 h-4 text-[#DFAB6C] shrink-0 mt-0.5" />
          <div className="text-xs">
            <strong className="text-white font-medium block">
              BREW Natural Voice Concierge (Phase P3 Browser AI)
            </strong>
            <p className="text-[#C4B4A8] text-[11px] leading-relaxed">
              Experience hands-free, multilingual AI coffee catering booking powered by Web Speech APIs. Speak naturally in English, Hindi, or Telugu to provide event details, receive real-time quotations, and submit booking requests for staff approval at zero additional cost.
            </p>
          </div>
        </div>

        {loading && !session && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-[#8C7C70] space-y-3">
            <div className="w-6 h-6 border-2 border-[#DFAB6C] border-t-transparent rounded-full animate-spin" />
            <span className="text-xs">Connecting to voice concierge...</span>
          </div>
        )}

        {error && (
          <div className="p-6 rounded-2xl bg-red-500/10 border border-red-500/30 text-center space-y-3">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
            <h3 className="text-sm font-bold text-white">{error}</h3>
            <Link
              href="/location"
              className="inline-block px-4 py-2 rounded-xl bg-white/10 text-xs font-bold text-white hover:bg-white/20"
            >
              Return to Booking Form
            </Link>
          </div>
        )}

        {session && (
          <div className="flex-1 flex flex-col space-y-4">
            {/* SESSION STATUS HEADER CARD */}
            <div className="p-5 rounded-2xl bg-[#1F150F] border border-white/10 shadow-xl space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-[#DFAB6C]/10 text-[#DFAB6C]">
                    <Phone className="w-4 h-4" />
                  </span>
                  <div>
                    <span className="text-[10px] text-[#8C7C70] uppercase tracking-wider block font-bold">
                      Session Reference
                    </span>
                    <span className="text-xs font-mono font-bold text-white">
                      {session.sessionId}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Language Pill */}
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-bold font-mono uppercase bg-white/5 border border-white/10 text-[#DFAB6C]">
                    🌐 {selectedLanguage.toUpperCase()}
                  </span>

                  {/* Mode Pill */}
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-white/5 border border-white/10 text-[#C4B4A8]">
                    {conversationMode === "auto" ? "⚡ Hands-Free Auto" : "🎙️ Push-to-Talk"}
                  </span>

                  {/* State Machine Status */}
                  <span
                    className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      session.state === "booking_confirmed"
                        ? "bg-emerald-500 text-black"
                        : session.state === "awaiting_staff_approval"
                        ? "bg-amber-400 text-black"
                        : session.state === "customer_declined" || session.state === "cancelled"
                        ? "bg-red-500 text-white"
                        : "bg-white/10 text-white"
                    }`}
                  >
                    {session.state.replace(/_/g, " ")}
                  </span>
                </div>
              </div>

              {/* Phase P5 & P6: Authoritative Staff Decision & Booking Status Banners */}
              {session.state === "booking_confirmed" && (
                <div className="p-4 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                      <h4 className="text-sm font-bold text-white">
                        Catering Booking Confirmed &amp; Approved!
                      </h4>
                    </div>
                    <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono font-bold border border-emerald-500/30">
                      Active Reservation
                    </span>
                  </div>
                  <p className="text-xs text-emerald-100/90 leading-relaxed">
                    Our barista operations team has verified your event parameters and confirmed catering slot reservation. Our dedicated mobile van and baristas will arrive at your venue prior to start time.
                  </p>
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] font-mono text-emerald-300 border-t border-emerald-500/20">
                    <span><strong>Inquiry / Booking ID:</strong> {session.officialBookingId || session.sessionId}</span>
                    {session.staffApprovalAudit?.approvedAt && (
                      <span><strong>Approved At:</strong> {new Date(session.staffApprovalAudit.approvedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    )}
                    {session.staffApprovalAudit?.staffRole && (
                      <span><strong>Verified By:</strong> {session.staffApprovalAudit.staffRole.toUpperCase()}</span>
                    )}
                  </div>
                </div>
              )}

              {session.state === "awaiting_staff_approval" && (
                <div className="p-4 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-200 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Clock className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />
                      <h4 className="text-sm font-bold text-white">
                        Booking Submitted — Awaiting Barista Review
                      </h4>
                    </div>
                    <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono font-bold border border-amber-500/30">
                      Live Polling (4s)
                    </span>
                  </div>
                  <p className="text-xs text-amber-100/90 leading-relaxed">
                    Your event requirements and chosen quotation tier have been submitted. Our mobile barista operations team is reviewing route feasibility and slot reservation. This page will update automatically once verified.
                  </p>
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] font-mono text-amber-300 border-t border-amber-500/20">
                    <span><strong>Inquiry ID:</strong> {session.officialBookingId || session.sessionId}</span>
                    <span><strong>Language:</strong> {selectedLanguage.toUpperCase()}</span>
                    <span><strong>Status:</strong> Pending Staff Approval</span>
                  </div>
                </div>
              )}

              {(session.state === "customer_declined" || session.state === "cancelled") && (
                <div className="p-4 rounded-xl bg-red-500/15 border border-red-500/30 text-red-200 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                      <h4 className="text-sm font-bold text-white">
                        Booking Request Declined
                      </h4>
                    </div>
                    <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-red-500/20 text-red-300 font-mono font-bold border border-red-500/30">
                      Declined / Cancelled
                    </span>
                  </div>
                  <p className="text-xs text-red-100/90 leading-relaxed">
                    {session.customerFacingRejectionReason ||
                      "We are unable to accommodate your booking request with the specified details at this time. Please adjust your requirements or reach out to our team."}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-red-500/20">
                    <Link
                      href="/voice-booking"
                      className="px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-xs transition-all inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Start a New Booking</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => handleEditField("Change date to ")}
                      className="px-3.5 py-1.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/30 font-bold text-xs transition-all inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Adjust Requirements</span>
                    </button>
                  </div>
                </div>
              )}

              {/* BOOKING DETAILS CHECKLIST */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-[#8C7C70] uppercase font-bold tracking-wider font-mono">
                    Booking Requirements Progress
                  </span>
                  <span className="text-[10px] text-[#DFAB6C] font-mono">
                    {5 - (session.requirements.missingFields?.length || 0)} / 5 Mandatory Fields Collected
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs font-mono">
                  {/* Event Date */}
                  <div
                    className={`p-2.5 rounded-xl border transition-all ${
                      session.requirements.eventDate
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                        : currentMissingField === "eventDate"
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-300 animate-pulse"
                        : "bg-black/30 border-white/5 text-[#8C7C70]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] flex items-center gap-1 font-bold">
                        <Calendar className="w-3 h-3" /> Date
                      </span>
                      {session.requirements.eventDate && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleEditField("Change date to ")}
                            className="text-[9px] text-[#DFAB6C] hover:underline cursor-pointer flex items-center gap-0.5"
                            title="Edit date"
                          >
                            <Edit3 className="w-2.5 h-2.5" />
                          </button>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        </div>
                      )}
                    </div>
                    <span className="font-bold truncate block text-[11px] text-white">
                      {session.requirements.eventDate || (currentMissingField === "eventDate" ? "Asking..." : "Pending")}
                    </span>
                  </div>

                  {/* Start Time */}
                  <div
                    className={`p-2.5 rounded-xl border transition-all ${
                      session.requirements.startTime
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                        : currentMissingField === "startTime"
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-300 animate-pulse"
                        : "bg-black/30 border-white/5 text-[#8C7C70]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] flex items-center gap-1 font-bold">
                        <Clock className="w-3 h-3" /> Time
                      </span>
                      {session.requirements.startTime && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleEditField("Change time to ")}
                            className="text-[9px] text-[#DFAB6C] hover:underline cursor-pointer flex items-center gap-0.5"
                            title="Edit time"
                          >
                            <Edit3 className="w-2.5 h-2.5" />
                          </button>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        </div>
                      )}
                    </div>
                    <span className="font-bold truncate block text-[11px] text-white">
                      {session.requirements.startTime || (currentMissingField === "startTime" ? "Asking..." : "Pending")}
                    </span>
                  </div>

                  {/* Duration */}
                  <div
                    className={`p-2.5 rounded-xl border transition-all ${
                      session.requirements.durationHours
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                        : currentMissingField === "durationHours"
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-300 animate-pulse"
                        : "bg-black/30 border-white/5 text-[#8C7C70]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] flex items-center gap-1 font-bold">
                        <Clock className="w-3 h-3" /> Duration
                      </span>
                      {session.requirements.durationHours && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleEditField("Change duration to ")}
                            className="text-[9px] text-[#DFAB6C] hover:underline cursor-pointer flex items-center gap-0.5"
                            title="Edit duration"
                          >
                            <Edit3 className="w-2.5 h-2.5" />
                          </button>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        </div>
                      )}
                    </div>
                    <span className="font-bold truncate block text-[11px] text-white">
                      {session.requirements.durationHours
                        ? `${session.requirements.durationHours} hrs`
                        : currentMissingField === "durationHours"
                        ? "Asking..."
                        : "Pending"}
                    </span>
                  </div>

                  {/* Guests */}
                  <div
                    className={`p-2.5 rounded-xl border transition-all ${
                      session.requirements.guestCount
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                        : currentMissingField === "guestCount"
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-300 animate-pulse"
                        : "bg-black/30 border-white/5 text-[#8C7C70]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] flex items-center gap-1 font-bold">
                        <Users className="w-3 h-3" /> Guests
                      </span>
                      {session.requirements.guestCount && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleEditField("Change guests to ")}
                            className="text-[9px] text-[#DFAB6C] hover:underline cursor-pointer flex items-center gap-0.5"
                            title="Edit guests"
                          >
                            <Edit3 className="w-2.5 h-2.5" />
                          </button>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        </div>
                      )}
                    </div>
                    <span className="font-bold truncate block text-[11px] text-[#DFAB6C]">
                      {session.requirements.guestCount
                        ? `${session.requirements.guestCount} guests`
                        : currentMissingField === "guestCount"
                        ? "Asking..."
                        : "Pending"}
                    </span>
                  </div>

                  {/* Venue */}
                  <div
                    className={`p-2.5 rounded-xl border transition-all ${
                      session.requirements.venueAddress
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                        : currentMissingField === "venueAddress"
                        ? "bg-amber-500/10 border-amber-500/40 text-amber-300 animate-pulse"
                        : "bg-black/30 border-white/5 text-[#8C7C70]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] flex items-center gap-1 font-bold">
                        <MapPin className="w-3 h-3" /> Venue
                      </span>
                      {session.requirements.venueAddress && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleEditField("Change venue to ")}
                            className="text-[9px] text-[#DFAB6C] hover:underline cursor-pointer flex items-center gap-0.5"
                            title="Edit venue"
                          >
                            <Edit3 className="w-2.5 h-2.5" />
                          </button>
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        </div>
                      )}
                    </div>
                    <span className="font-bold truncate block text-[11px] text-white">
                      {session.requirements.venueAddress || (currentMissingField === "venueAddress" ? "Asking..." : "Pending")}
                    </span>
                  </div>

                  {/* Package Tier */}
                  <div
                    className={`p-2.5 rounded-xl border transition-all ${
                      session.requirements.selectedTier
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                        : "bg-black/30 border-white/5 text-[#8C7C70]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] flex items-center gap-1 font-bold">
                        <Coffee className="w-3 h-3" /> Package
                      </span>
                      {session.requirements.selectedTier && (
                        <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                      )}
                    </div>
                    <span className="font-bold truncate block text-[11px] text-white">
                      {session.requirements.selectedTier || "Optional"}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* QUOTATION PRESENTATION CARD (WHEN GENERATED) */}
            {session.quotation && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-5 rounded-2xl bg-[#261A12] border border-[#DFAB6C]/30 shadow-xl space-y-4"
              >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-[#DFAB6C]" />
                      <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                        Authoritative Instant Quotation ({session.quotation.guestCount || session.quotation.estimatedGuests} Guests)
                      </h3>
                    </div>
                    {session.requirements.customerConfirmed ? (
                      <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30">
                        ✓ Confirmed by Customer
                      </span>
                    ) : (
                      <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                        Awaiting Customer Confirmation
                      </span>
                    )}
                  </div>

                  {/* Complete Event Summary Bar */}
                  <div className="p-3 rounded-xl bg-black/30 border border-white/5 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-4 text-[11px] text-[#C4B4A8]">
                      <span><strong className="text-white">Date:</strong> {session.requirements.eventDate}</span>
                      <span><strong className="text-white">Time:</strong> {session.requirements.startTime} ({session.requirements.durationHours} hrs)</span>
                      <span><strong className="text-white">Location:</strong> {session.requirements.venueAddress}, Hyderabad</span>
                      <span><strong className="text-white">Expected:</strong> {session.requirements.guestCount} Guests</span>
                    </div>
                    <span className="text-[10px] text-[#DFAB6C] font-mono font-bold">
                      Verified Pricing • No Hidden Charges
                    </span>
                  </div>

                  {/* 3 Package Comparisons Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {session.quotation.tiers.map((tier) => {
                      const isSelected =
                        session.requirements.selectedTier === tier.tierId ||
                        (!session.requirements.selectedTier && tier.isRecommended);

                      return (
                        <div
                          key={tier.tierId}
                          className={`p-3.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
                            isSelected
                              ? "bg-[#DFAB6C]/10 border-[#DFAB6C] shadow-lg ring-1 ring-[#DFAB6C]/50"
                              : "bg-black/30 border-white/10 hover:border-white/20"
                          }`}
                        >
                          <div>
                            <div className="flex justify-between items-start">
                              <span className="text-xs font-bold text-white block">
                                {tier.name}
                              </span>
                              {tier.isRecommended && (
                                <span className="text-[9px] px-1.5 py-0.2 bg-emerald-500/20 text-emerald-300 font-bold rounded">
                                  Recommended
                                </span>
                              )}
                            </div>
                            {tier.tagline && (
                              <span className="text-[10px] text-[#8C7C70] block line-clamp-1 mt-0.5">
                                {tier.tagline}
                              </span>
                            )}
                            <div className="mt-2">
                              <span className="text-base font-extrabold text-[#DFAB6C] font-mono">
                                ₹{tier.totalAmount.toLocaleString("en-IN")}
                              </span>
                              <span className="text-[10px] text-[#8C7C70] block font-mono">
                                ₹{tier.pricePerGuest}/guest • {session.quotation?.guestCount || session.quotation?.estimatedGuests} guests
                              </span>
                            </div>

                            {/* Staff & Equipment Allocation */}
                            <div className="mt-2 text-[10px] text-amber-200/80 bg-black/20 p-1.5 rounded border border-white/5 space-y-0.5 font-mono">
                              <div>☕ {tier.staffAssigned} Dedicated Baristas</div>
                              <div className="truncate">⚙️ {tier.equipmentSummary}</div>
                            </div>

                            <ul className="mt-2.5 space-y-1 text-[10px] text-[#C4B4A8] border-t border-white/5 pt-2">
                              {tier.perks.slice(0, 4).map((perk, i) => (
                                <li key={i} className="line-clamp-1 flex items-start gap-1">
                                  <span className="text-[#DFAB6C]">•</span>
                                  <span>{perk}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="mt-3 pt-2 border-t border-white/5">
                            {isSelected ? (
                              <button
                                type="button"
                                disabled
                                className="w-full py-1.5 rounded-lg bg-[#DFAB6C] text-black font-bold text-[10px] flex items-center justify-center gap-1 cursor-default shadow-sm"
                              >
                                <Check className="w-3 h-3" />
                                <span>Selected Package</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSelectPackage(tier.tierId, tier.name)}
                                className="w-full py-1.5 rounded-lg bg-white/10 hover:bg-[#DFAB6C] hover:text-black text-white text-[10px] font-bold transition-all cursor-pointer"
                              >
                                Select Package
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Phase P6: Explicit Customer Confirmation & Submission Action */}
                  {!session.requirements.customerConfirmed && (
                    <div className="pt-3 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-3 bg-black/30 p-4 rounded-xl border border-white/5">
                      <div className="space-y-0.5 text-left">
                        <span className="text-xs font-bold text-white block">
                          Ready to Lock In Your Event Date?
                        </span>
                        <p className="text-[11px] text-[#A8988B]">
                          Selected package: <strong className="text-[#DFAB6C]">{activeTierName}</strong>{activeTierTotal}. Submitting sends your request directly to our barista team for immediate reservation verification.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          handleSendMessage(
                            undefined,
                            `I confirm the ${activeTierName} package quotation and want to submit this booking request for staff approval.`
                          )
                        }
                        disabled={isSending}
                        className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-400 hover:from-emerald-400 hover:to-emerald-300 text-stone-950 font-extrabold text-xs transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 cursor-pointer disabled:opacity-50 shrink-0"
                      >
                        <CheckCircle2 className="w-4 h-4 text-stone-950" />
                        <span>Confirm &amp; Submit Booking Request</span>
                        <ArrowRight className="w-3.5 h-3.5 text-stone-950" />
                      </button>
                    </div>
                  )}

                  {session.requirements.customerConfirmed && (
                    <div className="pt-2 text-center text-[11px] text-emerald-300 font-mono flex items-center justify-center gap-1.5 bg-black/20 p-2.5 rounded-xl border border-emerald-500/20">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Quotation Confirmed by Customer • Dispatched to Barista Dispatch Queue</span>
                    </div>
                  )}
                </motion.div>
            )}

            {/* CONVERSATION TRANSCRIPT FEED */}
            <div className="flex-1 min-h-[320px] max-h-[460px] overflow-y-auto p-4 rounded-2xl bg-[#1A110B]/80 border border-white/10 space-y-3.5">
              {session.conversationHistory.map((msg) => {
                const isAssistant = msg.role === "assistant";
                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-2.5 ${
                      isAssistant ? "justify-start" : "justify-end"
                    }`}
                  >
                    {isAssistant && (
                      <div className="w-7 h-7 rounded-full bg-[#DFAB6C] text-[#140D08] flex items-center justify-center font-bold text-[11px] shrink-0 shadow-md">
                        ☕
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] rounded-2xl p-3.5 text-xs leading-relaxed ${
                        isAssistant
                          ? "bg-[#2A1D15] text-[#EDE4DA] border border-white/10 rounded-tl-none"
                          : "bg-[#DFAB6C] text-[#1A110B] font-medium rounded-tr-none shadow-md"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-1 text-[10px] opacity-70">
                        <span>{isAssistant ? "BREW Concierge" : "You"}</span>
                        <div className="flex items-center gap-2">
                          <span>{msg.language.toUpperCase()}</span>
                          {isAssistant && (
                            <button
                              type="button"
                              onClick={() => handleSpeakMessage(msg.content)}
                              className="text-[#DFAB6C] hover:text-white transition-colors cursor-pointer"
                              title="Listen to this message"
                            >
                              <Volume2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* RETRY FAILED TURN BANNER (RELIABILITY) */}
            {lastFailedTurn && (
              <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-xs flex items-center justify-between gap-2 text-red-200">
                <span className="flex items-center gap-1.5 truncate">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />
                  Turn submission encountered an issue. Would you like to retry?
                </span>
                <button
                  type="button"
                  onClick={() => handleVoiceTurnSubmission(lastFailedTurn)}
                  className="px-3 py-1 rounded-lg bg-red-500 text-white font-bold hover:bg-red-400 transition-colors flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Retry Turn</span>
                </button>
              </div>
            )}

            {/* INTERACTIVE VOICE CONTROLS & STATE BAR */}
            <div className="p-3.5 rounded-2xl bg-[#1C130D] border border-white/10 space-y-3">
              {/* Controls Header: Language Selection, Audio Mute & Mode Toggle */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2.5">
                {/* Language Picker */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-[#8C7C70] font-mono mr-1">Language:</span>
                  {(["en", "hi", "te"] as SupportedLanguage[]).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => handleLanguageChange(lang)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                        selectedLanguage === lang
                          ? "bg-[#DFAB6C] text-black font-bold shadow-sm"
                          : "bg-white/5 text-[#C4B4A8] hover:bg-white/10"
                      }`}
                    >
                      {BROWSER_SPEECH_LANGUAGES[lang].label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {/* Mode Toggle Button: Auto vs Push-to-Talk */}
                  <button
                    type="button"
                    onClick={handleToggleConversationMode}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-[#C4B4A8] cursor-pointer"
                    title={
                      conversationMode === "auto"
                        ? "Currently in Hands-free continuous loop. Click for Push-to-talk."
                        : "Currently in Push-to-talk. Click for Hands-free continuous loop."
                    }
                  >
                    {conversationMode === "auto" ? "Mode: Hands-Free 🔄" : "Mode: Push-to-Talk 🎙️"}
                  </button>

                  {/* Audio Output Mute / Unmute Button */}
                  <button
                    type="button"
                    onClick={handleToggleMute}
                    className={`px-3 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all cursor-pointer border ${
                      isMuted
                        ? "bg-red-500/10 text-red-300 border-red-500/30"
                        : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                    }`}
                    title={isMuted ? "Audio muted" : "Audio enabled"}
                  >
                    {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                    <span>{isMuted ? "Spoken: Off" : "Spoken: On"}</span>
                  </button>
                </div>
              </div>

              {/* Live Voice Status Indicator & Push-to-Talk Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                  {/* Push-to-Talk / Listening Toggle */}
                  <button
                    type="button"
                    disabled={isSending || (capabilities !== null && !capabilities.hasSpeechRecognition)}
                    onClick={handleToggleListening}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 transition-all cursor-pointer shadow-md disabled:opacity-40 ${
                      voiceState === "listening"
                        ? "bg-red-500 text-white animate-pulse"
                        : "bg-[#DFAB6C] text-black hover:bg-white"
                    }`}
                  >
                    {voiceState === "listening" ? (
                      <>
                        <MicOff className="w-4 h-4" />
                        <span>Stop Listening</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-4 h-4" />
                        <span>Start Speaking</span>
                      </>
                    )}
                  </button>

                  {/* Phase P3: Pause / Resume Control */}
                  {!isTerminalState(session.state) && (
                    <>
                      {isVoicePaused ? (
                        <button
                          type="button"
                          onClick={handleResumeVoice}
                          className="px-3 py-2 rounded-xl text-xs font-bold bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-black border border-emerald-500/30 transition-all flex items-center gap-1.5 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Resume Voice</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handlePauseVoice}
                          className="px-3 py-2 rounded-xl text-xs font-bold bg-white/5 hover:bg-white/10 text-[#C4B4A8] border border-white/10 transition-all flex items-center gap-1.5 cursor-pointer"
                        >
                          <Pause className="w-3.5 h-3.5" />
                          <span>Pause Voice</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleEndVoiceConversation}
                        className="px-3 py-2 rounded-xl text-xs font-bold bg-white/5 hover:bg-red-500/20 text-[#8C7C70] hover:text-red-300 border border-white/10 hover:border-red-500/30 transition-all flex items-center gap-1.5 cursor-pointer"
                      >
                        <Square className="w-3 h-3" />
                        <span>End Voice</span>
                      </button>
                    </>
                  )}

                  {/* Audio Status Pill */}
                  <div className="flex items-center gap-2 text-xs">
                    {voiceState === "listening" && (
                      <span className="flex items-center gap-1.5 text-red-400 font-bold font-mono text-[11px]">
                        <span className="w-2 h-2 rounded-full bg-red-400 animate-ping" />
                        Listening ({BROWSER_SPEECH_LANGUAGES[selectedLanguage].sttLocale})...
                      </span>
                    )}
                    {voiceState === "processing" && (
                      <span className="flex items-center gap-1.5 text-amber-300 font-bold font-mono text-[11px]">
                        <span className="w-3.5 h-3.5 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
                        Processing response...
                      </span>
                    )}
                    {voiceState === "speaking" && (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 text-emerald-300 font-bold font-mono text-[11px]">
                          <Volume2 className="w-3.5 h-3.5 animate-bounce" />
                          Speaking response...
                        </span>
                        <button
                          type="button"
                          onClick={handleStopSpeaking}
                          className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] text-white flex items-center gap-1 cursor-pointer"
                        >
                          <Square className="w-2.5 h-2.5 fill-current" />
                          <span>Stop</span>
                        </button>
                      </div>
                    )}
                    {voiceState === "error" && (
                      <span className="text-red-400 text-[11px] font-bold">
                        ⚠️ {voiceErrorMessage || "Microphone / Speech recognition error"}
                      </span>
                    )}
                    {voiceState === "idle" && (
                      <span className="text-[#8C7C70] text-[11px]">
                        {isVoicePaused
                          ? "Voice loop paused. Click Resume to continue speaking."
                          : `Ready to speak or type in ${BROWSER_SPEECH_LANGUAGES[selectedLanguage].label}`}
                      </span>
                    )}
                  </div>
                </div>

                {/* Browser Compatibility Notice */}
                {capabilities && !capabilities.hasSpeechRecognition && (
                  <span className="text-[10px] text-amber-300/80 bg-amber-500/10 px-2 py-1 rounded border border-amber-500/20">
                    Speech recognition unavailable in this browser; text chat active.
                  </span>
                )}
              </div>

              {/* Real-time live transcript bubble when listening */}
              {liveTranscript && (
                <div className="p-2.5 rounded-xl bg-black/40 border border-[#DFAB6C]/40 text-xs text-[#DFAB6C] flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold text-white/60 bg-white/10 px-1.5 py-0.5 rounded font-mono">
                    Live
                  </span>
                  <span className="italic">&ldquo;{liveTranscript}&rdquo;</span>
                </div>
              )}
            </div>

            {/* ACTION & INPUT AREA */}
            <div className="space-y-3">
              {/* Quick Action buttons for quotation confirmation */}
              {session.state === "awaiting_customer_confirmation" && (
                <div className="flex flex-wrap gap-2 justify-end">
                  <button
                    type="button"
                    disabled={isSending}
                    onClick={() =>
                      handleSendMessage(
                        undefined,
                        `Yes, I confirm the ${activeTierName} package.`
                      )
                    }
                    className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Confirm {activeTierName}{activeTierTotal}</span>
                  </button>

                  <button
                    type="button"
                    disabled={isSending}
                    onClick={() =>
                      handleSendMessage(
                        undefined,
                        "I decline this quotation. Please cancel."
                      )
                    }
                    className="px-4 py-2 rounded-xl bg-red-500/20 hover:bg-red-500 text-red-300 hover:text-white border border-red-500/30 text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    <span>Decline Quote</span>
                  </button>
                </div>
              )}

              {/* Staff status banners */}
              {session.state === "awaiting_staff_approval" && (
                <div className="p-3.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>
                      Booking request submitted and locked. Awaiting operational scheduling & confirmation by staff concierge team.
                    </span>
                  </div>
                  <span className="font-mono text-[10px] uppercase font-bold text-amber-300">
                    Awaiting Staff Review
                  </span>
                </div>
              )}

              {session.state === "booking_confirmed" && (
                <div className="p-3.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>
                      Booking officially confirmed and approved by staff ({session.staffApprovalAudit?.staffRole || "Barista"})!
                    </span>
                  </div>
                  <span className="font-mono text-[10px] uppercase font-bold text-emerald-300">
                    Officially Confirmed
                  </span>
                </div>
              )}

              {/* Text Input Form (Fallback & Parallel Input) */}
              {session.state !== "awaiting_staff_approval" &&
                session.state !== "booking_confirmed" &&
                session.state !== "customer_declined" &&
                session.state !== "cancelled" && (
                  <form onSubmit={handleSendMessage} className="flex gap-2">
                    <input
                      type="text"
                      value={inputMessage}
                      disabled={isSending}
                      onChange={(e) => setInputMessage(e.target.value)}
                      placeholder={`Type your response in ${BROWSER_SPEECH_LANGUAGES[selectedLanguage].label}... (e.g. '50 guests on 2026-12-25 at Hitec City')`}
                      className="flex-1 bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C]"
                    />
                    <button
                      type="submit"
                      disabled={isSending || !inputMessage.trim()}
                      className="px-6 py-3 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] text-xs font-bold transition-all shadow-lg flex items-center gap-2 cursor-pointer disabled:opacity-40"
                    >
                      {isSending ? (
                        <span className="w-3.5 h-3.5 border-2 border-[#1A110B] border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>Send</span>
                    </button>
                  </form>
                )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
