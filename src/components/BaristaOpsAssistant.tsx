"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  MapPin,
  Calendar,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Truck,
  Sun,
  TrendingUp,
  ShieldCheck,
  Check,
} from "lucide-react";
import { useVan } from "@/context/VanContext";
import {
  VanParkingSpot,
  WeatherForecast,
  EmployeeImprovementPlan,
  processEmployeeOpsQuery,
} from "@/lib/employeeBaristaOpsEngine";

interface OpsChatMessage {
  id: string;
  sender: "employee" | "dispatcher";
  text: string;
  recommendedSpots?: (VanParkingSpot & {
    weather: WeatherForecast;
    deconfliction: { isSafe: boolean; closestVanDistanceKm: number | null; conflictNotes: string };
  })[];
  improvementPlan?: EmployeeImprovementPlan;
  quickReplies?: string[];
}

const DEFAULT_OPS_CHIPS = [
  "📍 Where should I park today?",
  "📅 Best spot for tomorrow based on weather",
  "🚚 Check fleet proximity & surrounding vans",
  "📈 Analyze customer reviews & staff improvement plan",
  "🌊 Recommend spot in Visakhapatnam",
  "🏛️ Recommend spot in Vijayawada",
];

export const BaristaOpsAssistant: React.FC = () => {
  const {
    vanLocation,
    updateVanLocation,
    futureStops,
    addFutureStop,
  } = useVan();

  const [inputMessage, setInputMessage] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [appliedSpotId, setAppliedSpotId] = useState<string | null>(null);
  const [scheduledSpotId, setScheduledSpotId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idCounter = useRef(10);

  // Load reviews from localStorage
  const [storedReviews, setStoredReviews] = useState<
    { location: string; rating: number; comment: string; item: string }[]
  >([]);

  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        try {
          const stored = localStorage.getItem("brew_customer_reviews_v2");
          if (stored) {
            setStoredReviews(JSON.parse(stored));
          }
        } catch {}
      }
    });
  }, []);

  // Initial welcome message
  const [messages, setMessages] = useState<OpsChatMessage[]>(() => [
    {
      id: "msg-ops-init",
      sender: "dispatcher",
      text: "👋 Welcome to **BREW Fleet Operations & Dispatch Copilot**!\n\nI analyze real-time **weather forecasts**, **customer review trends**, and **active fleet locations** to help you determine:\n1. 📍 Where to park the van today or for upcoming dates.\n2. 🚚 Surrounding van proximity to avoid overlapping.\n3. 📈 Employee performance & action plans based on guest reviews.\n\nHow can I assist your shift today?",
      quickReplies: DEFAULT_OPS_CHIPS,
    },
  ]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isProcessing]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputMessage).trim();
    if (!text || isProcessing) return;

    const currentId = idCounter.current++;
    const userMsgId = `emp-${currentId}`;
    const newMessages: OpsChatMessage[] = [
      ...messages,
      {
        id: userMsgId,
        sender: "employee",
        text,
      },
    ];

    setMessages(newMessages);
    setInputMessage("");
    setIsProcessing(true);

    try {
      const res = await fetch("/api/barista-ops-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          activeVanLocation: vanLocation,
          futureStops,
          reviews: storedReviews,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to process dispatch query");
      }

      const data = await res.json();
      const dispatcherId = idCounter.current++;

      setMessages((prev) => [
        ...prev,
        {
          id: `dispatcher-${dispatcherId}`,
          sender: "dispatcher",
          text: data.replyText,
          recommendedSpots: data.recommendedSpots,
          improvementPlan: data.improvementPlan,
          quickReplies: data.quickReplies || DEFAULT_OPS_CHIPS,
        },
      ]);
    } catch (err) {
      console.error("Ops Chat Error:", err);
      // Fallback directly to local engine
      const localResult = processEmployeeOpsQuery(text, {
        activeVanLocation: vanLocation,
        futureStops,
        reviews: storedReviews,
      });

      const fallbackId = idCounter.current++;
      setMessages((prev) => [
        ...prev,
        {
          id: `dispatcher-${fallbackId}`,
          sender: "dispatcher",
          text: localResult.replyText,
          recommendedSpots: localResult.recommendedSpots,
          improvementPlan: localResult.improvementPlan,
          quickReplies: localResult.quickReplies,
        },
      ]);
    } finally {
      setIsProcessing(false);
    }
  };

  // 1-Click Action: Set Recommended Spot as Today's Live Station
  const handleApplyToLiveStation = (spot: VanParkingSpot) => {
    updateVanLocation({
      spotName: spot.spotName,
      city: `${spot.city}, ${spot.state}`,
      address: spot.address,
      hours: spot.recommendedHours,
      status: "serving",
      notes: `${spot.landmark}. ${spot.parkingDescription}`,
      coordinates: spot.coordinates,
    });

    setAppliedSpotId(spot.id);
    setTimeout(() => setAppliedSpotId(null), 3000);
  };

  // 1-Click Action: Add to Future Stops Schedule
  const handleScheduleFutureStop = (spot: VanParkingSpot) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split("T")[0];
    const dayOfWeek = tomorrow.toLocaleDateString("en-US", { weekday: "long" });

    addFutureStop({
      date: dateStr,
      dayOfWeek,
      state: spot.state,
      city: spot.city,
      spotName: spot.spotName,
      address: spot.address,
      hours: spot.recommendedHours,
      status: "confirmed",
      badge: "AI Optimal Hub",
      notes: `${spot.landmark} — ${spot.parkingDescription}`,
    });

    setScheduledSpotId(spot.id);
    setTimeout(() => setScheduledSpotId(null), 3000);
  };

  const handleResetChat = () => {
    const resetId = idCounter.current++;
    setMessages([
      {
        id: `msg-ops-reset-${resetId}`,
        sender: "dispatcher",
        text: "Operations history cleared. Where would you like to dispatch the van or what review insights do you need?",
        quickReplies: DEFAULT_OPS_CHIPS,
      },
    ]);
  };

  return (
    <div className="w-full bg-[#1A110B] border border-white/10 rounded-3xl overflow-hidden shadow-2xl flex flex-col h-[760px] max-h-[82vh]">
      {/* Header Bar */}
      <div className="px-6 py-4 bg-[#23150D] border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#DFAB6C]/20 border border-[#DFAB6C]/40 flex items-center justify-center text-[#DFAB6C]">
            <Truck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white font-sans">
                BREW Fleet AI Dispatcher & Ops Copilot
              </h2>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-mono font-bold">
                Live Fleet Sync
              </span>
            </div>
            <p className="text-xs text-[#8C7C70]">
              Weather-grounded routing, fleet deconfliction & customer review learning
            </p>
          </div>
        </div>

        <button
          onClick={handleResetChat}
          className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-[#8C7C70] hover:text-white transition-colors flex items-center gap-1.5 text-xs font-semibold"
          title="Reset Ops Conversation"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Reset</span>
        </button>
      </div>

      {/* Messages Thread */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5 text-sm">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.sender === "employee" ? "items-end" : "items-start"
            }`}
          >
            <span className="text-[11px] font-mono text-[#8C7C70] mb-1 px-1">
              {msg.sender === "employee" ? "Barista Team" : "AI Dispatcher"}
            </span>

            <div
              className={`max-w-[92%] rounded-2xl px-5 py-3.5 leading-relaxed ${
                msg.sender === "employee"
                  ? "bg-[#DFAB6C] text-[#140D08] font-semibold rounded-br-none shadow-md"
                  : "bg-[#25170F] border border-white/10 text-[#EDE4DA] rounded-bl-none shadow-lg"
              }`}
            >
              <p className="whitespace-pre-line">{msg.text}</p>
            </div>

            {/* Structured Recommended Parking Spots */}
            {msg.recommendedSpots && msg.recommendedSpots.length > 0 && (
              <div className="mt-3 w-full space-y-4">
                {msg.recommendedSpots.map((spot) => {
                  const isApplied = appliedSpotId === spot.id;
                  const isScheduled = scheduledSpotId === spot.id;

                  return (
                    <div
                      key={spot.id}
                      className="w-full bg-[#20130B] border border-[#DFAB6C]/30 rounded-2xl p-4 sm:p-5 shadow-xl hover:border-[#DFAB6C]/60 transition-all space-y-3"
                    >
                      {/* Top Badges & Title */}
                      <div className="flex flex-wrap items-start justify-between gap-2 pb-2.5 border-b border-white/10">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-base sm:text-lg font-bold text-white font-serif">
                              {spot.spotName}
                            </h4>
                            <span className="px-2 py-0.5 rounded bg-white/10 text-[#DFAB6C] text-xs font-bold">
                              {spot.city}
                            </span>
                          </div>
                          <p className="text-xs text-[#8C7C70] flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3.5 h-3.5 text-[#DFAB6C]" />
                            <span>{spot.landmark}</span>
                          </p>
                        </div>

                        {/* Rating & Demographic */}
                        <div className="text-right">
                          <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-400 font-mono text-xs font-bold border border-amber-500/30">
                            ★ {spot.averageRating}
                          </span>
                        </div>
                      </div>

                      {/* Parking Details & Bay Description */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                        <div className="p-2.5 rounded-xl bg-black/30 border border-white/5 space-y-1">
                          <span className="text-[#8C7C70] uppercase tracking-wider font-bold block text-[10px]">
                            Exact Parking Bay:
                          </span>
                          <p className="text-[#EDE4DA] leading-snug">
                            {spot.parkingDescription}
                          </p>
                        </div>

                        <div className="p-2.5 rounded-xl bg-black/30 border border-white/5 space-y-1">
                          <span className="text-[#8C7C70] uppercase tracking-wider font-bold block text-[10px]">
                            Recommended Timings:
                          </span>
                          <p className="text-white font-mono font-medium">
                            {spot.recommendedHours}
                          </p>
                          <p className="text-[11px] text-[#DFAB6C]">
                            Peak footfall: {spot.peakHours}
                          </p>
                        </div>
                      </div>

                      {/* Weather Impact & Fleet Deconfliction */}
                      <div className="space-y-2">
                        {/* Weather advice */}
                        <div className="p-2.5 rounded-xl bg-[#2A1D13] border border-[#DFAB6C]/20 flex items-start gap-2.5 text-xs text-[#EDE4DA]">
                          <Sun className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-bold text-white">
                              Weather Forecast: {spot.weather.condition} ({spot.weather.tempC}°C, {spot.weather.rainChancePercent}% Rain)
                            </span>
                            <p className="text-[#A09085] mt-0.5">
                              {spot.weather.baristaAdvisory}
                            </p>
                          </div>
                        </div>

                        {/* Fleet deconfliction alert */}
                        <div
                          className={`p-2.5 rounded-xl border flex items-center gap-2 text-xs font-medium ${
                            spot.deconfliction.isSafe
                              ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
                              : "bg-red-950/20 border-red-500/30 text-red-300"
                          }`}
                        >
                          {spot.deconfliction.isSafe ? (
                            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
                          )}
                          <span>{spot.deconfliction.conflictNotes}</span>
                        </div>

                        {/* Customer review takeaway */}
                        <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 text-xs text-[#8C7C70]">
                          <span className="text-[10px] uppercase font-bold text-[#DFAB6C] block">
                            Guest Review Insights:
                          </span>
                          <p className="text-[#C4B4A8] mt-0.5 italic">
                            &quot;{spot.customerReviewSummary}&quot;
                          </p>
                        </div>
                      </div>

                      {/* Action Bar */}
                      <div className="pt-2 flex flex-wrap items-center gap-2.5">
                        {/* Google Maps link */}
                        <a
                          href={spot.googleMapsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white font-semibold text-xs flex items-center gap-1.5 transition-all"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>View on Google Maps</span>
                        </a>

                        {/* Set as Live Station */}
                        <button
                          onClick={() => handleApplyToLiveStation(spot)}
                          className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow-md cursor-pointer ${
                            isApplied
                              ? "bg-emerald-500 text-black"
                              : "bg-[#DFAB6C] hover:bg-[#E5B57A] text-[#140D08]"
                          }`}
                        >
                          {isApplied ? (
                            <>
                              <Check className="w-4 h-4" />
                              <span>Live Station Broadcasted! ✓</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Set as Today&apos;s Live Station</span>
                            </>
                          )}
                        </button>

                        {/* Schedule Future Stop */}
                        <button
                          onClick={() => handleScheduleFutureStop(spot)}
                          className={`px-3 py-2 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                            isScheduled
                              ? "bg-blue-500/20 text-blue-300 border-blue-400"
                              : "border-white/15 text-[#DFAB6C] hover:bg-white/5"
                          }`}
                        >
                          <Calendar className="w-3.5 h-3.5" />
                          <span>
                            {isScheduled ? "Added to Schedule! ✓" : "Add to Upcoming Stops"}
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Structured Employee Improvement Plan */}
            {msg.improvementPlan && (
              <div className="mt-3 w-full bg-[#20130B] border border-white/10 rounded-2xl p-5 shadow-xl space-y-4">
                <div className="flex flex-wrap items-center justify-between pb-3 border-b border-white/10 gap-2">
                  <div>
                    <h3 className="text-base font-bold text-white font-serif flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-[#DFAB6C]" />
                      <span>{msg.improvementPlan.title}</span>
                    </h3>
                    <span className="text-[11px] text-[#8C7C70]">
                      Generated {msg.improvementPlan.generatedDate} • Based on {msg.improvementPlan.totalReviewsAnalyzed} customer reviews
                    </span>
                  </div>
                  <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-mono font-bold border border-emerald-500/30">
                    Overall: {msg.improvementPlan.overallRating}★
                  </span>
                </div>

                {/* Key Strengths */}
                <div>
                  <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block mb-1.5">
                    What Our Baristas Are Doing Right:
                  </span>
                  <ul className="space-y-1 text-xs text-[#EDE4DA]">
                    {msg.improvementPlan.keyStrengths.map((st, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-emerald-400 font-bold">✓</span>
                        <span>{st}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Actionable Improvement Items */}
                <div className="space-y-2.5 pt-2 border-t border-white/5">
                  <span className="text-[11px] font-bold text-[#DFAB6C] uppercase tracking-wider block">
                    Actionable Improvement Plan for Barista Team:
                  </span>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {msg.improvementPlan.actionableImprovements.map((act, i) => (
                      <div
                        key={i}
                        className="p-3 rounded-xl bg-black/40 border border-white/10 space-y-1.5 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-white">
                            {act.area}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                              act.priority === "High" || act.priority === "Urgent"
                                ? "bg-red-500/20 text-red-300 border border-red-500/30"
                                : "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                            }`}
                          >
                            {act.priority}
                          </span>
                        </div>

                        <p className="text-[11px] text-[#A09085]">
                          <strong className="text-[#C4B4A8]">Feedback:</strong> {act.issueIdentified}
                        </p>
                        <p className="text-[#DFAB6C] font-medium leading-snug">
                          <strong className="text-white">Action:</strong> {act.actionPlan}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Station specific advice */}
                <div className="p-3 rounded-xl bg-[#2A1C12] border border-[#DFAB6C]/20 text-xs">
                  <span className="font-bold text-[#DFAB6C] block mb-1">
                    Station Operational Tips:
                  </span>
                  <ul className="space-y-1 text-[#EDE4DA]">
                    {msg.improvementPlan.stationSpecificTips.map((tip, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-[#DFAB6C]">•</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Quick Replies */}
            {msg.quickReplies && msg.quickReplies.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {msg.quickReplies.map((chip) => (
                  <button
                    key={chip}
                    onClick={() => handleSendMessage(chip)}
                    className="text-[11px] px-3 py-1 rounded-full border border-[#DFAB6C]/30 bg-[#DFAB6C]/10 text-[#EDE4DA] hover:bg-[#DFAB6C]/20 hover:border-[#DFAB6C] transition-colors cursor-pointer"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Processing Indicator */}
        {isProcessing && (
          <div className="flex items-center gap-2 text-xs text-[#DFAB6C] font-mono p-2">
            <Truck className="w-4 h-4 animate-bounce" />
            <span>Analyzing fleet coordinates, weather forecast & customer reviews...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSendMessage();
        }}
        className="p-3.5 border-t border-white/10 bg-[#23150D] flex items-center gap-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder="Ask dispatch advisor (e.g., Where should I park today?)..."
          disabled={isProcessing}
          className="flex-1 bg-black/40 border border-white/10 rounded-2xl px-4 py-2.5 text-xs sm:text-sm text-white placeholder-[#8C7C70] focus:outline-none focus:border-[#DFAB6C] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!inputMessage.trim() || isProcessing}
          aria-label="Send ops query"
          className="px-4 py-2.5 rounded-2xl bg-[#DFAB6C] text-[#140D08] font-bold flex items-center gap-1.5 hover:bg-[#E5B57A] disabled:opacity-40 transition-all flex-shrink-0 cursor-pointer"
        >
          <Send className="w-4 h-4" />
          <span className="hidden sm:inline text-xs">Send</span>
        </button>
      </form>
    </div>
  );
};
