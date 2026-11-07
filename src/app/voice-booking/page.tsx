"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Mic,
  Sparkles,
  Phone,
  ArrowRight,
  RotateCcw,
} from "lucide-react";
import { Header } from "../../components/Header";
import { SupportedLanguage } from "../../lib/voiceBooking/types";
import { BROWSER_SPEECH_LANGUAGES } from "../../lib/voiceBooking/browserSpeechAdapter";

export default function VoiceBookingLandingPage() {
  const router = useRouter();
  const [selectedLanguage, setSelectedLanguage] = useState<SupportedLanguage>("en");
  const [phoneNumber, setPhoneNumber] = useState("+91 98765 43210");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSessionId, setRecentSessionId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("brew_last_voice_session_id");
      if (saved && saved.startsWith("vbs_")) {
        queueMicrotask(() => {
          setRecentSessionId(saved);
        });
      }
    } catch {
      // Ignore localStorage access failures
    }
  }, []);

  const handleStartSession = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsStarting(true);
    setError(null);

    try {
      const cleanPhone = phoneNumber.replace(/[\s-]/g, "") || "+919876543210";
      const res = await fetch("/api/voice-booking/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          language: selectedLanguage,
        }),
      });

      const data = await res.json();
      if (res.ok && data.sessionId) {
        try {
          localStorage.setItem("brew_last_voice_session_id", data.sessionId);
        } catch {
          // Ignore
        }
        router.push(`/voice-booking/${data.sessionId}`);
      } else {
        setError(data.error || "Unable to start voice session. Please try again.");
        setIsStarting(false);
      }
    } catch {
      setError("Network error connecting to booking service. Please check your connection.");
      setIsStarting(false);
    }
  };

  const handleResumeRecent = () => {
    if (recentSessionId) {
      router.push(`/voice-booking/${recentSessionId}`);
    }
  };

  return (
    <main className="relative w-full min-h-screen bg-[#140D08] text-[#F4EFE6] flex flex-col justify-start select-none font-sans">
      {/* Background Gradient & Glows */}
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 50% 20%, #301A10 0%, #170E08 55%, #0B0604 100%)",
        }}
      />
      <div className="fixed top-1/4 right-1/4 w-[500px] h-[500px] bg-[#D48F47]/10 rounded-full blur-[140px] pointer-events-none -z-10" />

      <Header />

      <div className="relative w-full max-w-4xl mx-auto pt-28 sm:pt-36 pb-20 px-4 sm:px-8 flex-1 flex flex-col space-y-8">
        {/* Breadcrumb / Top Bar */}
        <div className="flex items-center justify-between text-xs text-[#8C7C70]">
          <Link href="/" className="hover:text-[#DFAB6C] transition-colors flex items-center gap-1">
            <span>← Home</span>
          </Link>
          <span className="font-mono text-[10px] uppercase tracking-wider text-[#DFAB6C]">
            Phase P6 · Complete Booking Experience
          </span>
        </div>

        {/* Hero Section */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[#DFAB6C] text-xs font-mono font-bold mb-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Multilingual AI Voice Concierge</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold font-serif text-white tracking-tight">
            Book Mobile Espresso Catering <br className="hidden sm:inline" />
            <span className="text-[#DFAB6C]">Using Natural Voice</span>
          </h1>
          <p className="text-xs sm:text-sm text-[#C4B4A8] max-w-2xl mx-auto leading-relaxed">
            Experience our conversational AI concierge. Speak or type in English, Hindi, or Telugu to outline your event requirements, compare packages, receive an instant cryptographic quote, and reserve your date with our mobile barista van.
          </p>
        </div>

        {/* Quick Resume Recent Session Banner if available */}
        {recentSessionId && (
          <div className="p-4 rounded-2xl bg-[#261A12] border border-[#DFAB6C]/40 shadow-xl flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="p-2 rounded-xl bg-amber-500/10 text-[#DFAB6C]">
                <RotateCcw className="w-4 h-4" />
              </span>
              <div>
                <span className="text-xs font-bold text-white block">
                  Ongoing Voice Booking Session Found
                </span>
                <span className="text-[10px] text-[#8C7C70] font-mono block">
                  Reference: {recentSessionId}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleResumeRecent}
              className="px-4 py-2 rounded-xl bg-[#DFAB6C] hover:bg-white text-stone-950 font-bold text-xs transition-all flex items-center gap-1.5 shadow-md cursor-pointer shrink-0"
            >
              <span>Resume Active Session</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Start Booking Session Card */}
        <div className="p-6 sm:p-8 rounded-3xl bg-[#1C130D] border border-white/10 shadow-2xl space-y-6">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <div className="flex items-center gap-2.5">
              <span className="p-2.5 rounded-2xl bg-amber-500/10 text-[#DFAB6C] border border-amber-500/20">
                <Mic className="w-5 h-5 text-[#DFAB6C]" />
              </span>
              <div>
                <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                  Start New Booking Concierge
                </h2>
                <p className="text-xs text-[#8C7C70]">
                  Zero cost, zero phone charges. Powered by Web Speech APIs.
                </p>
              </div>
            </div>
            <span className="px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              Free Prototype
            </span>
          </div>

          <form onSubmit={handleStartSession} className="space-y-5">
            {/* Language Selection */}
            <div>
              <label className="block text-xs font-bold text-white mb-2">
                1. Select Preferred Conversational Language
              </label>
              <div className="grid grid-cols-3 gap-2.5">
                {(["en", "hi", "te"] as SupportedLanguage[]).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setSelectedLanguage(lang)}
                    className={`p-3 rounded-2xl border text-center transition-all cursor-pointer ${
                      selectedLanguage === lang
                        ? "bg-[#DFAB6C] text-black border-[#DFAB6C] font-bold shadow-lg ring-2 ring-[#DFAB6C]/50"
                        : "bg-black/30 border-white/10 text-[#C4B4A8] hover:border-white/20"
                    }`}
                  >
                    <span className="block text-sm font-bold">
                      {lang === "en" ? "English" : lang === "hi" ? "हिंदी" : "తెలుగు"}
                    </span>
                    <span className="block text-[10px] opacity-75 font-mono">
                      {BROWSER_SPEECH_LANGUAGES[lang].label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Phone Number Input */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold text-white">
                  2. Contact Phone (For Staff Dispatch &amp; Reservation Confirmation)
                </label>
                <button
                  type="button"
                  onClick={() => setPhoneNumber("+91 98765 43210")}
                  className="text-[10px] text-[#DFAB6C] hover:underline cursor-pointer font-mono"
                >
                  Use Demo Number
                </button>
              </div>
              <div className="relative">
                <Phone className="w-4 h-4 text-[#8C7C70] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+91 98765 43210"
                  required
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-black/40 border border-white/10 text-white placeholder-white/30 text-xs font-mono focus:outline-none focus:border-[#DFAB6C]"
                />
              </div>
              <p className="text-[10px] text-[#8C7C70] mt-1 font-mono">
                🔒 In prototype mode, no actual phone calls or SMS messages are sent. Phone numbers are securely masked.
              </p>
            </div>

            {error && (
              <div className="p-3.5 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-200">
                {error}
              </div>
            )}

            {/* Launch Button */}
            <button
              type="submit"
              disabled={isStarting}
              className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-[#DFAB6C] to-[#E5BE8A] hover:opacity-95 text-stone-950 font-bold text-sm transition-all flex items-center justify-center gap-2 shadow-xl cursor-pointer disabled:opacity-50"
            >
              {isStarting ? (
                <>
                  <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  <span>Initializing Voice Session...</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  <span>Launch Voice Concierge &amp; Start Booking</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* 3 Catering Packages Comparison Overview */}
        <div className="space-y-4">
          <div className="text-center sm:text-left">
            <h3 className="text-base font-bold text-white uppercase tracking-wider font-mono">
              Available Catering Packages
            </h3>
            <p className="text-xs text-[#8C7C70]">
              All packages include certified baristas, commercial espresso equipment, fresh whole milk, oat milk, and premium artisanal beans.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            {/* Classic Brew */}
            <div className="p-4 rounded-2xl bg-black/30 border border-white/10 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-mono text-[#DFAB6C] block uppercase font-bold">Entry Tier</span>
                <h4 className="text-sm font-bold text-white mt-0.5">Classic Brew</h4>
                <div className="mt-2 text-base font-extrabold text-[#DFAB6C] font-mono">
                  ₹250 <span className="text-[10px] text-[#8C7C70] font-normal">/ guest</span>
                </div>
                <div className="mt-2 text-[10px] text-amber-200/80 bg-black/40 p-2 rounded-lg font-mono space-y-0.5">
                  <div>☕ 2 Dedicated Baristas</div>
                  <div>⚙️ Dual-Boiler Commercial Machine</div>
                </div>
                <ul className="mt-3 space-y-1 text-[11px] text-[#C4B4A8]">
                  <li>• Espresso, Americano, Cappuccino, Latte</li>
                  <li>• House Roasted Single Origin Arabica</li>
                  <li>• Dairy &amp; Oat Milk included</li>
                </ul>
              </div>
            </div>

            {/* Artisanal Signature */}
            <div className="p-4 rounded-2xl bg-[#DFAB6C]/10 border border-[#DFAB6C] shadow-lg ring-1 ring-[#DFAB6C]/40 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-[#DFAB6C] uppercase font-bold">Most Popular</span>
                  <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#DFAB6C] text-black font-bold font-mono">
                    Recommended
                  </span>
                </div>
                <h4 className="text-sm font-bold text-white mt-0.5">Artisanal Signature</h4>
                <div className="mt-2 text-base font-extrabold text-[#DFAB6C] font-mono">
                  ₹450 <span className="text-[10px] text-[#8C7C70] font-normal">/ guest</span>
                </div>
                <div className="mt-2 text-[10px] text-amber-200/80 bg-black/40 p-2 rounded-lg font-mono space-y-0.5">
                  <div>☕ 3 Dedicated Baristas</div>
                  <div>⚙️ Custom Brew Van + Manual Pour-Over Bar</div>
                </div>
                <ul className="mt-3 space-y-1 text-[11px] text-[#C4B4A8]">
                  <li>• Full Espresso Menu + Manual Pour-Overs</li>
                  <li>• Specialty Syrups (Vanilla Bean, Hazelnut)</li>
                  <li>• Iced Lattes &amp; Cascara Sparkling Tea</li>
                </ul>
              </div>
            </div>

            {/* VIP Unlimited Bar */}
            <div className="p-4 rounded-2xl bg-black/30 border border-white/10 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-mono text-[#DFAB6C] block uppercase font-bold">Luxury Tier</span>
                <h4 className="text-sm font-bold text-white mt-0.5">VIP Unlimited Bar</h4>
                <div className="mt-2 text-base font-extrabold text-[#DFAB6C] font-mono">
                  ₹750 <span className="text-[10px] text-[#8C7C70] font-normal">/ guest</span>
                </div>
                <div className="mt-2 text-[10px] text-amber-200/80 bg-black/40 p-2 rounded-lg font-mono space-y-0.5">
                  <div>☕ 4 Dedicated Baristas</div>
                  <div>⚙️ Multi-Group Espresso + Nitro Cold Brew</div>
                </div>
                <ul className="mt-3 space-y-1 text-[11px] text-[#C4B4A8]">
                  <li>• Nitro Cold Brew on Tap + Coffee Mocktails</li>
                  <li>• Custom Brand / Event Latte Art Printing</li>
                  <li>• Priority Multi-Van Service Available</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* 5-Step Booking Journey Roadmap */}
        <div className="p-6 rounded-2xl bg-black/20 border border-white/5 space-y-4">
          <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
            How The Voice Booking Concierge Works
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-white/5 space-y-1">
              <span className="text-[10px] font-mono text-[#DFAB6C] font-bold block">Step 1</span>
              <span className="font-bold text-white block">Speak Details</span>
              <p className="text-[10px] text-[#8C7C70]">Date, time, duration, guest count, and venue in Hyderabad.</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 space-y-1">
              <span className="text-[10px] font-mono text-[#DFAB6C] font-bold block">Step 2</span>
              <span className="font-bold text-white block">AI Extraction</span>
              <p className="text-[10px] text-[#8C7C70]">Natural follow-up questions clarify any missing parameters.</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 space-y-1">
              <span className="text-[10px] font-mono text-[#DFAB6C] font-bold block">Step 3</span>
              <span className="font-bold text-white block">Compare &amp; Select</span>
              <p className="text-[10px] text-[#8C7C70]">Pick between Classic Brew, Artisanal Signature, or VIP Bar.</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 space-y-1">
              <span className="text-[10px] font-mono text-[#DFAB6C] font-bold block">Step 4</span>
              <span className="font-bold text-white block">Confirm Quote</span>
              <p className="text-[10px] text-[#8C7C70]">Submit with cryptographic HMAC signature integrity.</p>
            </div>
            <div className="p-3 rounded-xl bg-white/5 space-y-1">
              <span className="text-[10px] font-mono text-[#DFAB6C] font-bold block">Step 5</span>
              <span className="font-bold text-white block">Barista Review</span>
              <p className="text-[10px] text-[#8C7C70]">Staff verifies logistics and reserves your date in real time.</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
