"use client";

import React, { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  MapPin,
  Clock,
  Navigation,
  Coffee,
  CheckCircle2,
  ArrowRight,
  Truck,
  Building2,
  Mail,
  Send,
  X,
  ExternalLink,
  Calendar,
  Users,
  AlertCircle,
  Sparkles,
  Check,
  Copy,
} from "lucide-react";
import { Header } from "@/components/Header";
import { useVan } from "@/context/VanContext";
import { generateEventQuotation, type EventQuotation } from "@/lib/smartAgentsEngine";

export default function VanLocationPage() {
  const { vanLocation, futureStops } = useVan();
  const BUSINESS_EMAIL = "mattag@iitbhilai.ac.in";

  const [notifyContact, setNotifyContact] = useState("");
  const [activeFilter, setActiveFilter] = useState<
    "all" | "Telangana" | "Andhra Pradesh"
  >("all");

  // Van Request Modal / Drawer State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [requestOrg, setRequestOrg] = useState("");
  const [requestLocation, setRequestLocation] = useState("");
  const [requestDate, setRequestDate] = useState("");
  const [requestCrowd, setRequestCrowd] = useState("100–300 People");
  const [requestNotes, setRequestNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState<{
    contact: string;
    organization: string;
    location: string;
  } | null>(null);
  const [mailtoBackup, setMailtoBackup] = useState("");
  const [gmailUrl, setGmailUrl] = useState("");
  const [quotation, setQuotation] = useState<EventQuotation | null>(null);
  const [selectedTier, setSelectedTier] = useState<string>("Artisanal Signature");
  const [copiedQuote, setCopiedQuote] = useState(false);

  const filteredFutureStops = futureStops.filter(
    (item) => activeFilter === "all" || item.state === activeFilter,
  );

  const handleOpenRequest = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsModalOpen(true);
  };

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notifyContact.trim()) return;

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/request-van", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact: notifyContact.trim(),
          organization: requestOrg.trim() || "College / Office Campus",
          location: requestLocation.trim() || "Telangana / AP",
          eventDate: requestDate.trim() || "Flexible",
          crowdSize: requestCrowd,
          notes: requestNotes.trim(),
        }),
      });

      const data = await res.json();

      setLastSubmitted({
        contact: notifyContact.trim(),
        organization: requestOrg.trim() || "Campus",
        location: requestLocation.trim() || "Local Hub",
      });

      if (data.quotation) {
        setQuotation(data.quotation);
      }
      if (data.mailtoUrl) {
        setMailtoBackup(data.mailtoUrl);
      }
      if (data.gmailUrl) {
        setGmailUrl(data.gmailUrl);
      }

      setSubmitSuccess(true);
    } catch (err) {
      console.error("Failed to send van request:", err);
      const fallbackQuote = generateEventQuotation({
        organization: requestOrg.trim() || "Campus / Office",
        location: requestLocation.trim() || "Local Hub",
        crowdSizeStr: requestCrowd,
        eventDate: requestDate.trim() || "Upcoming",
      });
      setQuotation(fallbackQuote);

      // Fallback mailto & Gmail URLs directly to mattag@iitbhilai.ac.in
      const subj = `Van Request: ${requestOrg || "Campus"} (${requestLocation || "Location"})`;
      const body = `Contact: ${notifyContact}\nOrg: ${requestOrg}\nLocation: ${requestLocation}\nCrowd: ${requestCrowd}\nNotes: ${requestNotes}`;

      const fallbackUrl = `mailto:${BUSINESS_EMAIL}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
      const fallbackGmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(BUSINESS_EMAIL)}&su=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;

      setMailtoBackup(fallbackUrl);
      setGmailUrl(fallbackGmail);
      setSubmitSuccess(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative w-full min-h-screen bg-[#140D08] text-[#F4EFE6] flex flex-col justify-start select-none font-sans">
      {/* Deep Espresso Radial Gradient */}
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 50% 25%, #301A10 0%, #170E08 55%, #0B0604 100%)",
        }}
      />
      <div className="fixed top-1/4 right-1/4 w-[600px] h-[600px] bg-[#D48F47]/10 rounded-full blur-[160px] pointer-events-none -z-10" />

      <Header />

      <div className="relative w-full max-w-[1400px] mx-auto pt-28 sm:pt-36 pb-20 px-6 sm:px-10 lg:px-16 flex-1">
        {/* Header Title */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 bg-[#2E1B10] border border-[#DFAB6C]/30 px-3.5 py-1 rounded-full mb-3">
            <Truck className="w-4 h-4 text-[#DFAB6C]" />
            <span className="text-xs uppercase tracking-wider font-bold text-white">
              Outlet on Wheels • AP & Telangana
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-serif font-bold text-white tracking-tight">
            Where Is Our Van Today?
          </h1>
          <p className="text-sm text-[#8C7C70] mt-2 font-sans leading-relaxed">
            Our luxury artisanal coffee truck travels across{" "}
            <strong>Telangana & Andhra Pradesh</strong> — from Hyderabad&apos;s
            bustling IT tech parks to the coastal waters of Visakhapatnam and
            Vijayawada. Catch us fresh and hot on wheels!
          </p>
        </div>

        {/* TODAY'S LIVE STATION CARD */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-6 sm:p-10 rounded-3xl bg-[#20150F]/90 backdrop-blur-xl border border-[#DFAB6C]/30 shadow-[0_20px_60px_rgba(0,0,0,0.8)] mb-14 relative overflow-hidden"
        >
          <div className="absolute top-0 right-0 w-80 h-80 bg-[#DFAB6C]/10 rounded-full blur-3xl pointer-events-none" />

          {/* Vehicle Status Badge */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              {vanLocation.status === "serving" && (
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                  </span>
                  <span className="text-xs uppercase font-bold tracking-widest">
                    Vehicle Status: Still There & Serving Now
                  </span>
                </div>
              )}
              {vanLocation.status === "closed" && (
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/20 border border-red-500/40 text-red-400">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                  </span>
                  <span className="text-xs uppercase font-bold tracking-widest">
                    Vehicle Status: Closed for the Day
                  </span>
                </div>
              )}
              {vanLocation.status === "moving" && (
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
                  </span>
                  <span className="text-xs uppercase font-bold tracking-widest">
                    Vehicle Status: In Transit / Relocating Soon
                  </span>
                </div>
              )}
              {vanLocation.status === "break" && (
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-400" />
                  </span>
                  <span className="text-xs uppercase font-bold tracking-widest">
                    Vehicle Status: Short Restock Break
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs text-[#8C7C70] font-mono">
              <span className="px-2.5 py-1 rounded-full bg-black/40 border border-white/10 text-white font-medium">
                {vanLocation.city}
              </span>
            </div>
          </div>

          {vanLocation.status === "closed" && (
            <div className="mb-5 p-4 rounded-2xl bg-red-950/40 border border-red-500/30 text-xs text-red-200 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
              <div>
                <strong className="text-white block text-sm">
                  Today&apos;s Outlet Service Has Concluded
                </strong>
                <span className="text-[#EDE4DA]/80">
                  Our mobile van has closed for today. Check upcoming scheduled
                  dates below to catch our next stop, or request our van at your
                  college/office!
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <div className="lg:col-span-7">
              <h2 className="text-3xl sm:text-4xl font-serif font-bold text-white mb-3">
                {vanLocation.spotName}
              </h2>

              <div className="flex flex-col gap-2 text-sm text-[#8C7C70] mb-5">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-[#DFAB6C] shrink-0" />
                  <span>
                    {vanLocation.address}, {vanLocation.city}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#DFAB6C] shrink-0" />
                  <span className="font-mono text-white">
                    {vanLocation.hours}
                  </span>
                </div>
              </div>

              {vanLocation.notes && (
                <div className="p-3.5 rounded-2xl bg-black/30 border border-white/5 text-xs text-[#C4B4A8] mb-6 flex items-start gap-2.5">
                  <span className="text-base">📍</span>
                  <p className="leading-relaxed">
                    <strong className="text-white">Note:</strong>{" "}
                    {vanLocation.notes}
                  </p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/menu"
                  className="px-6 py-3.5 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 shadow-lg cursor-pointer"
                >
                  <Coffee className="w-4 h-4" />
                  <span>Order Ahead at This Van</span>
                </Link>

                <Link
                  href="/board"
                  className="px-5 py-3.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/10 text-white font-semibold text-xs tracking-wider transition-all flex items-center gap-2 cursor-pointer"
                >
                  <span>View Outdoor Queue Board</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>

                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(
                    `${vanLocation.spotName} ${vanLocation.address} ${vanLocation.city}`,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-3.5 rounded-xl bg-black/40 hover:bg-black/60 border border-white/10 text-[#C4B4A8] hover:text-white text-xs font-mono transition-all flex items-center gap-2"
                >
                  <Navigation className="w-4 h-4 text-[#DFAB6C]" />
                  <span>Get Driving Directions</span>
                </a>
              </div>
            </div>

            {/* Van Capabilities Box */}
            <div className="lg:col-span-5 p-5 rounded-2xl bg-black/40 border border-white/10">
              <span className="text-xs uppercase font-bold text-[#DFAB6C] tracking-wider block mb-3">
                Mobile Van Specs & Features
              </span>
              <div className="space-y-2.5 text-xs text-[#C4B4A8]">
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Dual-Group Custom Italian Espresso Machine</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Zero-Emission Silent Battery Inverter System</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Dedicated Curbside Delivery for Parked Vehicles</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Nitro Infused Cold Brew On Tap</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Accepting UPI, Google Pay, Cards & Cash</span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* UPCOMING SCHEDULED VAN STOPS (LIVE UPDATES FROM BARISTA DISPATCH) */}
        <div className="mb-16">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-3 border-b border-white/10">
            <div>
              <div className="inline-flex items-center gap-2 bg-[#DFAB6C]/10 border border-[#DFAB6C]/30 px-3 py-1 rounded-full mb-2">
                <Calendar className="w-3.5 h-3.5 text-[#DFAB6C]" />
                <span className="text-[11px] uppercase font-bold text-[#DFAB6C] tracking-wider">
                  Live Dispatch Schedule
                </span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-serif font-bold text-white">
                Upcoming Scheduled Stops
              </h2>
              <p className="text-xs text-[#8C7C70] mt-0.5">
                Confirmed future locations and dates updated live by our van
                dispatch team.
              </p>
            </div>

            {/* Region Filter Buttons */}
            <div className="flex items-center gap-1.5 p-1 rounded-xl bg-black/40 border border-white/10 text-xs">
              <button
                onClick={() => setActiveFilter("all")}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                  activeFilter === "all"
                    ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                    : "text-[#8C7C70] hover:text-white"
                }`}
              >
                All Stops ({futureStops.length})
              </button>
              <button
                onClick={() => setActiveFilter("Telangana")}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                  activeFilter === "Telangana"
                    ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                    : "text-[#8C7C70] hover:text-white"
                }`}
              >
                Telangana
              </button>
              <button
                onClick={() => setActiveFilter("Andhra Pradesh")}
                className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                  activeFilter === "Andhra Pradesh"
                    ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                    : "text-[#8C7C70] hover:text-white"
                }`}
              >
                Andhra Pradesh
              </button>
            </div>
          </div>

          {filteredFutureStops.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredFutureStops.map((stop) => (
                <div
                  key={stop.id}
                  className="p-5 rounded-3xl bg-[#22160F]/90 backdrop-blur-md border border-[#DFAB6C]/25 hover:border-[#DFAB6C]/70 shadow-lg hover:shadow-2xl transition-all flex flex-col justify-between group"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="px-3 py-1 rounded-full bg-[#DFAB6C] text-[#1A110B] text-xs font-bold font-mono shadow-sm">
                        {stop.date}
                      </span>
                      <span className="text-[10px] uppercase font-bold text-[#DFAB6C] bg-[#DFAB6C]/10 border border-[#DFAB6C]/30 px-2.5 py-0.5 rounded-full">
                        {stop.state}
                      </span>
                    </div>

                    <h3 className="font-serif font-bold text-lg text-white mb-1 group-hover:text-[#DFAB6C] transition-colors">
                      {stop.spotName}
                    </h3>

                    <div className="flex items-center gap-2 text-xs text-[#C4B4A8] mb-2">
                      <MapPin className="w-3.5 h-3.5 text-[#DFAB6C] shrink-0" />
                      <span>
                        {stop.address}, {stop.city}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-white font-mono mb-3">
                      <Clock className="w-3.5 h-3.5 text-[#DFAB6C] shrink-0" />
                      <span>{stop.hours}</span>
                    </div>

                    {stop.notes && (
                      <p className="text-xs text-[#EDE4DA]/85 leading-relaxed bg-black/40 p-2.5 rounded-xl border border-white/5">
                        {stop.notes}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-[11px]">
                    <span className="text-emerald-400 font-medium flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {stop.badge || "Confirmed Station"}
                    </span>
                    <span className="text-[#8C7C70] font-mono text-[10px]">
                      {stop.dayOfWeek}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 sm:p-12 rounded-3xl bg-[#20150F]/70 backdrop-blur-md border border-white/10 text-center flex flex-col items-center justify-center max-w-2xl mx-auto">
              <div className="w-14 h-14 rounded-2xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/30 flex items-center justify-center text-[#DFAB6C] mb-4">
                <Calendar className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-serif font-bold text-white mb-2">
                No Upcoming Stops Scheduled Yet
              </h3>
              <p className="text-xs text-[#8C7C70] max-w-md mx-auto leading-relaxed mb-6">
                Our van dispatch team updates upcoming dates and pop-up
                locations as new campus and tech park visits are confirmed. Want
                us to visit your area?
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={handleOpenRequest}
                  className="px-5 py-3 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg"
                >
                  Request Van At Your Location
                </button>
              </div>
            </div>
          )}
        </div>

        {/* NOTIFY ME / VAN LOCATION REQUEST BANNER */}
        <div className="p-8 sm:p-10 rounded-3xl bg-[#24170F]/90 backdrop-blur-xl border border-white/10 flex flex-col md:flex-row items-center justify-between gap-6 shadow-2xl">
          <div className="max-w-lg">
            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-[#DFAB6C] font-bold mb-2">
              <Truck className="w-3.5 h-3.5" />
              <span>Host the Outlet on Wheels</span>
            </div>
            <h3 className="font-serif text-2xl sm:text-3xl font-bold text-white mb-2">
              Want Our Van at Your Office or College?
            </h3>
            <p className="text-xs text-[#8C7C70] leading-relaxed">
              We cater tech conferences, college fests, corporate tech campuses,
              and private events across Hyderabad, Visakhapatnam, Vijayawada,
              and campus hubs.
            </p>
            <p className="text-[11px] text-[#DFAB6C]/80 mt-2 flex items-center gap-1.5 font-mono">
              <Mail className="w-3 h-3 text-[#DFAB6C]" />
              <span>
                Direct Business Inquiries: <strong>{BUSINESS_EMAIL}</strong>
              </span>
            </p>
          </div>

          <form
            onSubmit={handleOpenRequest}
            className="flex flex-col sm:flex-row items-center gap-2.5 w-full md:w-auto"
          >
            <input
              type="text"
              required
              value={notifyContact}
              onChange={(e) => setNotifyContact(e.target.value)}
              placeholder="Enter your phone or email..."
              className="px-4 py-3 rounded-xl bg-black/40 border border-white/15 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C] w-full md:w-64"
            />
            <button
              type="submit"
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold text-xs uppercase tracking-wider transition-all whitespace-nowrap cursor-pointer shadow-lg flex items-center justify-center gap-1.5"
            >
              <span>Request Van</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>

        {/* ========================================================================= */}
        {/* INTERACTIVE VAN LOCATION REQUEST MODAL                                    */}
        {/* ========================================================================= */}
        <AnimatePresence>
          {isModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md overflow-y-auto">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative w-full max-w-2xl rounded-3xl bg-[#22160F] border-2 border-[#DFAB6C]/40 shadow-2xl p-6 sm:p-8 my-8 text-left max-h-[90vh] overflow-y-auto"
              >
                {/* Close Button */}
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="absolute top-5 right-5 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-[#DFAB6C] flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>

                {submitSuccess && quotation ? (
                  /* Interactive 3-Tier Quotation Screen (Agent #4) */
                  <div className="py-2 space-y-5">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
                      <div>
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono font-bold uppercase tracking-wider mb-1.5">
                          <Sparkles className="w-3 h-3" />
                          <span>AI Event Concierge · Quoted in &lt;100ms</span>
                        </div>
                        <h3 className="text-xl sm:text-2xl font-serif font-bold text-white">
                          Catering Quotation for {lastSubmitted?.organization}
                        </h3>
                        <p className="text-xs text-[#8C7C70] mt-0.5">
                          📍 {lastSubmitted?.location} • 👥 {quotation.estimatedCrowd} Guests • 📞 {lastSubmitted?.contact}
                        </p>
                      </div>
                    </div>

                    {/* Operational Logistics & Ingredient Allocations */}
                    <div className="p-4 rounded-2xl bg-black/40 border border-white/5 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] uppercase tracking-wider font-bold text-[#DFAB6C]">
                          📦 Certified Ingredient Allocation &amp; Crew Specs
                        </span>
                        <span className="text-[10px] font-mono text-[#8C7C70]">
                          Zero Stockout Guarantee
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                        <div className="p-2.5 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-[10px] text-[#8C7C70] uppercase block">Barista Crew</span>
                          <span className="font-bold text-white">{quotation.baristasAssigned} Certified Baristas</span>
                          <span className="text-[9px] text-[#A8988B] block mt-0.5">45s service speed</span>
                        </div>
                        <div className="p-2.5 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-[10px] text-[#8C7C70] uppercase block">Single-Origin Beans</span>
                          <span className="font-bold text-amber-300 font-mono">{quotation.ingredientAllocation.coffeeBeansKg} kg</span>
                          <span className="text-[9px] text-[#A8988B] block mt-0.5">18g dose + 30% buffer</span>
                        </div>
                        <div className="p-2.5 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-[10px] text-[#8C7C70] uppercase block">Farm Fresh Milk</span>
                          <span className="font-bold text-white font-mono">{quotation.ingredientAllocation.milkLiters} Liters</span>
                          <span className="text-[9px] text-[#A8988B] block mt-0.5">Dairy &amp; Oat included</span>
                        </div>
                        <div className="p-2.5 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-[10px] text-[#8C7C70] uppercase block">Artisanal Paper Cups</span>
                          <span className="font-bold text-white font-mono">{quotation.ingredientAllocation.cupsCount} Cups</span>
                          <span className="text-[9px] text-[#A8988B] block mt-0.5">Includes 40% refills</span>
                        </div>
                        <div className="p-2.5 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-[10px] text-[#8C7C70] uppercase block">Bakery Pastries</span>
                          <span className="font-bold text-white font-mono">{quotation.ingredientAllocation.pastriesCount} Pieces</span>
                          <span className="text-[9px] text-[#A8988B] block mt-0.5">Fresh 1-day bake</span>
                        </div>
                        <div className="p-2.5 rounded-xl bg-white/5 border border-white/5">
                          <span className="text-[10px] text-[#8C7C70] uppercase block">Power Requirement</span>
                          <span className="font-bold text-emerald-400 text-[11px] truncate block">{quotation.powerRequirement}</span>
                          <span className="text-[9px] text-[#A8988B] block mt-0.5">Silent inverter backup</span>
                        </div>
                      </div>
                    </div>

                    {/* Interactive 3-Tier Quotation Cards */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] uppercase tracking-wider font-bold text-[#DFAB6C]">
                          🏷️ Select Your Service Tier:
                        </span>
                        <span className="text-[10px] text-[#8C7C70]">
                          Includes ₹{quotation.travelDistanceFee} distance &amp; van setup fee
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {quotation.tiers.map((tier) => {
                          const isSelected = selectedTier === tier.name;
                          return (
                            <button
                              key={tier.name}
                              type="button"
                              onClick={() => setSelectedTier(tier.name)}
                              className={`p-3.5 rounded-2xl border text-left transition-all cursor-pointer relative flex flex-col justify-between ${
                                isSelected
                                  ? "bg-gradient-to-b from-[#2E1D13] to-[#1E120B] border-[#DFAB6C] ring-2 ring-[#DFAB6C]/40 shadow-xl"
                                  : "bg-black/30 border-white/10 hover:border-white/20 text-[#A8988B]"
                              }`}
                            >
                              {tier.isRecommended && (
                                <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full bg-emerald-500 text-stone-950 font-bold text-[9px] uppercase tracking-wider shadow">
                                  Recommended
                                </span>
                              )}

                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <h4 className="text-xs font-bold text-white">
                                    {tier.name}
                                  </h4>
                                  {isSelected && (
                                    <Check className="w-4 h-4 text-[#DFAB6C]" />
                                  )}
                                </div>
                                <div className="my-1.5">
                                  <span className="text-lg font-extrabold text-[#DFAB6C] font-mono">
                                    ₹{tier.totalAmount.toLocaleString("en-IN")}
                                  </span>
                                  <span className="text-[10px] text-[#8C7C70] block font-mono">
                                    ₹{tier.pricePerGuest}/guest
                                  </span>
                                </div>
                              </div>

                              <ul className="mt-2 space-y-1 text-[10px] text-[#C4B4A8] border-t border-white/5 pt-2">
                                {tier.perks.map((perk, pIdx) => (
                                  <li key={pIdx} className="line-clamp-2 leading-tight flex items-start gap-1">
                                    <span className="text-[#DFAB6C] shrink-0">•</span>
                                    <span>{perk}</span>
                                  </li>
                                ))}
                              </ul>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 1-Click Booking & Dispatch Actions */}
                    <div className="pt-2 flex flex-col sm:flex-row gap-2.5">
                      {gmailUrl && (
                        <a
                          href={gmailUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-3 px-4 rounded-xl bg-[#EA4335] hover:bg-[#d93025] text-white text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-[#EA4335]/25"
                        >
                          <Mail className="w-4 h-4" />
                          <span>Confirm {selectedTier} via Gmail</span>
                        </a>
                      )}

                      {mailtoBackup && (
                        <a
                          href={mailtoBackup}
                          className="py-3 px-4 rounded-xl bg-white/10 hover:bg-white/20 border border-white/10 text-white text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-[#DFAB6C]" />
                          <span>Mail App</span>
                        </a>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          const quoteSummary = `BREW Mobile Coffee Van Quotation for ${lastSubmitted?.organization}\nLocation: ${lastSubmitted?.location}\nCrowd: ${quotation.estimatedCrowd} Guests\nSelected Tier: ${selectedTier}\nTotal: ₹${quotation.tiers.find(t => t.name === selectedTier)?.totalAmount.toLocaleString("en-IN")}\nCrew: ${quotation.baristasAssigned} Baristas\nBeans: ${quotation.ingredientAllocation.coffeeBeansKg}kg\nMilk: ${quotation.ingredientAllocation.milkLiters}L\nCups: ${quotation.ingredientAllocation.cupsCount}\nOfficial Desk: ${BUSINESS_EMAIL}`;
                          navigator.clipboard.writeText(quoteSummary);
                          setCopiedQuote(true);
                          setTimeout(() => setCopiedQuote(false), 2500);
                        }}
                        className="py-3 px-4 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-white text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        {copiedQuote ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Copied to Clipboard!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-[#DFAB6C]" />
                            <span>Copy Quote</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setIsModalOpen(false);
                          setSubmitSuccess(false);
                          setNotifyContact("");
                          setRequestOrg("");
                          setRequestLocation("");
                        }}
                        className="py-3 px-4 rounded-xl bg-[#DFAB6C] hover:bg-white text-stone-950 text-xs font-bold transition-all cursor-pointer"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : submitSuccess ? (
                  /* Simple Success Fallback */
                  <div className="py-6 text-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-emerald-500/20 border-2 border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto text-3xl">
                      ✓
                    </div>
                    <h3 className="text-xl font-serif font-bold text-white">
                      Van Request Dispatched!
                    </h3>
                    <p className="text-xs text-[#C4B4A8] leading-relaxed max-w-sm mx-auto">
                      Your request for{" "}
                      <strong className="text-white">
                        {lastSubmitted?.organization}
                      </strong>{" "}
                      in{" "}
                      <strong className="text-white">
                        {lastSubmitted?.location}
                      </strong>{" "}
                      has been transmitted directly to our business operations
                      desk at{" "}
                      <span className="text-[#DFAB6C] font-mono font-semibold">
                        {BUSINESS_EMAIL}
                      </span>
                      .
                    </p>
                    <div className="pt-3 flex justify-center">
                      <button
                        onClick={() => {
                          setIsModalOpen(false);
                          setSubmitSuccess(false);
                        }}
                        className="py-2.5 px-6 rounded-xl bg-[#DFAB6C] text-stone-950 text-xs font-bold cursor-pointer"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Request Form */
                  <div>
                    <div className="flex items-center gap-2.5 mb-1">
                      <div className="w-8 h-8 rounded-xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/30 flex items-center justify-center text-[#DFAB6C]">
                        <Truck className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-lg sm:text-xl font-serif font-bold text-white">
                          Request Van At Your Location
                        </h3>
                        <p className="text-[11px] text-[#8C7C70]">
                          Host our artisanal outlet on wheels for your college,
                          office, or event
                        </p>
                      </div>
                    </div>

                    <div className="p-2.5 rounded-xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/20 text-[11px] text-[#DFAB6C] flex items-center gap-2 my-4">
                      <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>
                        Notifications route directly to operations manager:{" "}
                        <strong>{BUSINESS_EMAIL}</strong>
                      </span>
                    </div>

                    <form onSubmit={handleSendRequest} className="space-y-3.5">
                      {/* Contact */}
                      <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-[#C4B4A8] mb-1">
                          Your Email *
                        </label>
                        <input
                          type="text"
                          required
                          value={notifyContact}
                          onChange={(e) => setNotifyContact(e.target.value)}
                          placeholder="e.g. @gmail.com"
                          className="w-full bg-white/5 border border-white/15 rounded-xl px-3.5 py-2 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C]"
                        />
                      </div>

                      {/* Organization & Location Grid */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-[#C4B4A8] mb-1">
                            Name *
                          </label>
                          <div className="relative">
                            <Building2 className="w-3.5 h-3.5 text-[#8C7C70] absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              required
                              value={requestOrg}
                              onChange={(e) => setRequestOrg(e.target.value)}
                              className="w-full bg-white/5 border border-white/15 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C]"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-[#C4B4A8] mb-1">
                            Location *
                          </label>
                          <div className="relative">
                            <MapPin className="w-3.5 h-3.5 text-[#8C7C70] absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              required
                              value={requestLocation}
                              onChange={(e) =>
                                setRequestLocation(e.target.value)
                              }
                              className="w-full bg-white/5 border border-white/15 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C]"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Date & Crowd */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-[#C4B4A8] mb-1">
                            Date and Time *
                          </label>
                          <div className="relative">
                            <Calendar className="w-3.5 h-3.5 text-[#8C7C70] absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              value={requestDate}
                              onChange={(e) => setRequestDate(e.target.value)}
                              className="w-full bg-white/5 border border-white/15 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C]"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wider text-[#C4B4A8] mb-1">
                            Crowd Size
                          </label>
                          <div className="relative">
                            <Users className="w-3.5 h-3.5 text-[#8C7C70] absolute left-3 top-1/2 -translate-y-1/2" />
                            <select
                              value={requestCrowd}
                              onChange={(e) => setRequestCrowd(e.target.value)}
                              className="w-full bg-[#1A110B] border border-white/15 rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-[#DFAB6C] cursor-pointer"
                            >
                              <option value="50–150 People">
                                50–150 People
                              </option>
                              <option value="150–300 People">
                                150–300 People
                              </option>
                              <option value="300–600 People">
                                300–600 People
                              </option>
                              <option value="600+ Mega Fest / Conference">
                                600+ Mega Fest
                              </option>
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-[#C4B4A8] mb-1">
                          Special Requests / Parking Details
                        </label>
                        <textarea
                          rows={2}
                          value={requestNotes}
                          onChange={(e) => setRequestNotes(e.target.value)}
                          placeholder="e.g. Parking available near seminar hall, power socket available..."
                          className="w-full bg-white/5 border border-white/15 rounded-xl p-3 text-xs text-white placeholder-[#7A6A5E] focus:outline-none focus:border-[#DFAB6C]"
                        />
                      </div>

                      {/* Submit */}
                      <div className="pt-2 flex items-center justify-end gap-2.5">
                        <button
                          type="button"
                          onClick={() => setIsModalOpen(false)}
                          className="px-4 py-2 rounded-xl text-xs font-medium text-[#8C7C70] hover:text-white transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={
                            isSubmitting ||
                            !notifyContact.trim() ||
                            !requestOrg.trim() ||
                            !requestLocation.trim()
                          }
                          className="px-6 py-2.5 rounded-xl bg-[#DFAB6C] disabled:opacity-40 hover:bg-white text-[#1A110B] text-xs font-bold transition-all shadow-lg flex items-center gap-2 cursor-pointer"
                        >
                          {isSubmitting ? (
                            <>
                              <span className="w-3.5 h-3.5 border-2 border-[#1A110B] border-t-transparent rounded-full animate-spin" />
                              <span>Dispatching Mail...</span>
                            </>
                          ) : (
                            <>
                              <Send className="w-3.5 h-3.5" />
                              <span>Send Request to Operations</span>
                            </>
                          )}
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
