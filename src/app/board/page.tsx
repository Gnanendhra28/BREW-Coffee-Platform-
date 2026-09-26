"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Coffee,
  Clock,
  Sparkles,
  Maximize2,
  Minimize2,
  MapPin,
  CheckCircle2,
  ArrowRight,
  Flame,
  Volume2,
  VolumeX,
  Copy,
  Check,
  ExternalLink,
  Settings2,
} from "lucide-react";
import { useVan } from "@/context/VanContext";
import { QRCodeDisplay } from "@/components/QRCodeDisplay";

export default function OutdoorBoardPage() {
  const {
    nowServingOrders,
    brewingOrders,
    vanLocation,
    estimatedWaitMinutes,
  } = useVan();

  const [currentTime, setCurrentTime] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [orderOrigin, setOrderOrigin] = useState("http://localhost:3000/menu");
  const [isCustomizingUrl, setIsCustomizingUrl] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState("");
  const [copied, setCopied] = useState(false);

  // Keep live time ticking
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      );
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  // Compute order URL for QR code
  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        setOrderOrigin(`${window.location.origin}/menu`);
      }
    });
  }, []);

  // Toggle Fullscreen
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      setIsFullscreen(false);
    }
  };

  const handleCopyLink = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(orderOrigin).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleApplyCustomUrl = (url: string) => {
    let clean = url.trim();
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = `http://${clean}`;
    }
    setOrderOrigin(clean);
    setIsCustomizingUrl(false);
  };

  // Sound chime when a new ready order appears
  const playPickupChime = () => {
    if (!soundEnabled || typeof window === "undefined") return;
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.85);
    } catch {}
  };

  return (
    <main className="relative w-full min-h-screen bg-[#0E0906] text-[#F4EFE6] flex flex-col justify-between select-none overflow-x-hidden p-4 sm:p-6 lg:p-8">
      {/* Background ambient lighting */}
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            "radial-gradient(circle at 50% 20%, #2B180E 0%, #150D08 55%, #0B0604 100%)",
        }}
      />

      {/* Top Header Bar */}
      <header className="flex items-center justify-between pb-6 border-b border-white/10">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 group cursor-pointer">
            <span className="text-3xl sm:text-4xl font-extrabold tracking-[0.25em] text-[#DFAB6C] font-sans">
              BREW
            </span>
          </Link>
          <div className="h-6 w-px bg-white/20 hidden sm:block" />
          <div className="flex items-center gap-2 bg-[#251810] border border-[#DFAB6C]/30 px-3 py-1 rounded-full">
            {vanLocation.status === "serving" && (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                <span className="text-xs uppercase tracking-wider font-bold text-emerald-400">
                  Still There & Serving
                </span>
              </>
            )}
            {vanLocation.status === "closed" && (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <span className="text-xs uppercase tracking-wider font-bold text-red-400">
                  Closed for the Day
                </span>
              </>
            )}
            {vanLocation.status === "moving" && (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
                <span className="text-xs uppercase tracking-wider font-bold text-amber-300">
                  In Transit / Relocating
                </span>
              </>
            )}
            {vanLocation.status === "break" && (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-blue-400" />
                <span className="text-xs uppercase tracking-wider font-bold text-blue-300">
                  Short Restock Break
                </span>
              </>
            )}
          </div>
        </div>

        {/* Location & Time Widget */}
        <div className="flex items-center gap-3 sm:gap-6">
          <div className="hidden md:flex items-center gap-2 text-xs text-[#C4B4A8]">
            <MapPin className="w-4 h-4 text-[#DFAB6C]" />
            <span className="font-medium text-white">{vanLocation.spotName}</span>
            <span className="text-[#8C7C70]">• {vanLocation.hours}</span>
          </div>

          <div className="bg-black/40 border border-white/10 px-3.5 py-1.5 rounded-xl font-mono text-base sm:text-lg font-bold text-[#DFAB6C] flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#DFAB6C]" />
            <span>{currentTime || "12:00:00"}</span>
          </div>

          {/* Audio Chime Toggle */}
          <button
            onClick={() => {
              setSoundEnabled(!soundEnabled);
              if (!soundEnabled) playPickupChime();
            }}
            title={soundEnabled ? "Mute pickup bell" : "Unmute pickup bell"}
            className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[#C4B4A8] hover:text-white transition-colors cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-[#DFAB6C]" /> : <VolumeX className="w-4 h-4" />}
          </button>

          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            title="Toggle Outdoor Kiosk Fullscreen"
            className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[#C4B4A8] hover:text-white transition-colors cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Board Content: 3-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 my-6 flex-1 items-stretch">
        {/* Column 1: "NOW SERVING" (Ready for pickup at counter window) */}
        <div className="lg:col-span-4 flex flex-col rounded-3xl bg-[#1C120B]/90 backdrop-blur-xl border border-emerald-500/30 p-6 shadow-[0_20px_50px_rgba(16,185,129,0.15)] relative overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between mb-5 pb-3 border-b border-emerald-500/20">
            <div className="flex items-center gap-2.5">
              <span className="w-3.5 h-3.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_12px_#34D399]" />
              <h2 className="text-xl sm:text-2xl font-serif font-bold text-white tracking-wide">
                Now Serving
              </h2>
            </div>
            <span className="text-xs uppercase tracking-widest font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
              Ready at Window
            </span>
          </div>

          {/* Now Serving List */}
          <div className="space-y-3 flex-1 overflow-y-auto">
            <AnimatePresence>
              {nowServingOrders.length === 0 ? (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center p-6 border border-dashed border-white/10 rounded-2xl">
                  <Coffee className="w-10 h-10 text-[#8C7C70] mb-2 opacity-50" />
                  <p className="text-sm text-[#8C7C70]">Next handcrafted brew ready shortly</p>
                </div>
              ) : (
                nowServingOrders.map((order) => (
                  <motion.div
                    key={order.id}
                    layout
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ type: "spring", damping: 20 }}
                    className="p-5 rounded-2xl bg-gradient-to-r from-emerald-950/60 to-emerald-900/30 border border-emerald-500/40 shadow-lg flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-emerald-400 uppercase tracking-widest font-mono">
                          Order
                        </span>
                        <span className="text-4xl sm:text-5xl font-extrabold text-white font-mono tracking-tight drop-shadow-[0_0_15px_rgba(52,211,153,0.5)]">
                          #{order.orderNumber}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-[#EDE4DA] mt-1">
                        {order.customerName}
                      </p>
                      {order.pickupType === "curbside" && (
                        <span className="inline-block mt-1 text-[10px] uppercase font-bold text-[#DFAB6C] bg-[#DFAB6C]/10 px-2 py-0.5 rounded">
                          🚗 Curbside • {order.vehicleInfo || "Vehicle"}
                        </span>
                      )}
                    </div>
                    <div className="w-12 h-12 rounded-full bg-emerald-500 text-black flex items-center justify-center font-bold text-xl animate-bounce">
                      <CheckCircle2 className="w-7 h-7 stroke-[2.5]" />
                    </div>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Column 2: "CURRENTLY BREWING" (In Progress) */}
        <div className="lg:col-span-4 flex flex-col rounded-3xl bg-[#1C120B]/90 backdrop-blur-xl border border-[#DFAB6C]/30 p-6 shadow-[0_20px_50px_rgba(223,171,108,0.1)] relative overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between mb-5 pb-3 border-b border-[#DFAB6C]/20">
            <div className="flex items-center gap-2.5">
              <Flame className="w-5 h-5 text-[#DFAB6C] animate-pulse" />
              <h2 className="text-xl sm:text-2xl font-serif font-bold text-white tracking-wide">
                Brewing Now
              </h2>
            </div>
            <span className="text-xs uppercase tracking-widest font-mono text-[#DFAB6C] bg-[#DFAB6C]/10 px-2.5 py-1 rounded-full border border-[#DFAB6C]/25">
              {brewingOrders.length} in queue
            </span>
          </div>

          {/* Brewing List */}
          <div className="space-y-3 flex-1 overflow-y-auto">
            <AnimatePresence>
              {brewingOrders.length === 0 ? (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center p-6 border border-dashed border-white/10 rounded-2xl">
                  <Sparkles className="w-10 h-10 text-[#DFAB6C] mb-2 opacity-60" />
                  <p className="text-sm text-white font-medium">Barista is ready for your order!</p>
                  <p className="text-xs text-[#8C7C70] mt-1">Scan the QR code to order instantly</p>
                </div>
              ) : (
                brewingOrders.map((order) => (
                  <motion.div
                    key={order.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="p-4 rounded-2xl bg-black/40 border border-white/10 flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-[#8C7C70] uppercase tracking-wider font-mono">
                          Order
                        </span>
                        <span className="text-3xl font-bold text-white font-mono">
                          #{order.orderNumber}
                        </span>
                      </div>
                      <p className="text-xs text-[#C4B4A8] mt-0.5">{order.customerName}</p>
                    </div>

                    <div className="text-right">
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#3D2619] text-[#DFAB6C] border border-[#DFAB6C]/30 uppercase tracking-wider text-[10px]">
                        {order.status === "brewing" ? "Grinding & Pulling" : "Received"}
                      </span>
                      <p className="text-[11px] text-[#8C7C70] mt-1">
                        {order.items.reduce((s, i) => s + i.quantity, 0)} items
                      </p>
                    </div>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Column 3: SCANNABLE QR CODE & VAN DETAILS */}
        <div className="lg:col-span-4 flex flex-col justify-between rounded-3xl bg-[#24170F]/95 backdrop-blur-xl border border-white/15 p-6 shadow-2xl relative overflow-hidden">
          {/* Ambient Corner Glow */}
          <div className="absolute top-0 right-0 w-44 h-44 bg-[#DFAB6C]/15 rounded-full blur-3xl pointer-events-none" />

          {/* Heading */}
          <div className="text-center mb-3">
            <span className="text-[10px] uppercase tracking-widest font-extrabold text-[#DFAB6C]">
              Zero-Contact Ordering
            </span>
            <h3 className="text-xl sm:text-2xl font-serif font-bold text-white mt-0.5">
              Order from Your Phone
            </h3>
            <p className="text-xs text-[#8C7C70] mt-1 font-sans">
              Scan with your phone camera to skip the line
            </p>
          </div>

          {/* High-Resolution Scannable QR Code (Compact & Balanced) */}
          <div className="flex flex-col items-center justify-center my-1">
            <QRCodeDisplay value={orderOrigin} size={135} />

            {/* URL Label & Action Row */}
            <div className="flex items-center gap-2 mt-2.5 max-w-full px-2">
              <span className="text-[11px] font-mono text-[#DFAB6C] truncate font-medium">
                {orderOrigin}
              </span>
              <button
                onClick={handleCopyLink}
                title="Copy order menu link"
                className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-[#DFAB6C] transition-all cursor-pointer flex-shrink-0"
              >
                {copied ? (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-sans font-semibold">
                    <Check className="w-3 h-3" /> Copied
                  </span>
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
              <a
                href={orderOrigin}
                target="_blank"
                rel="noreferrer"
                title="Open menu on this device"
                className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-[#DFAB6C] transition-all cursor-pointer flex-shrink-0"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
              <button
                onClick={() => {
                  setCustomUrlInput(orderOrigin);
                  setIsCustomizingUrl(!isCustomizingUrl);
                }}
                title="Configure URL for Phone Testing or Production"
                className={`p-1 rounded-md transition-all cursor-pointer flex-shrink-0 ${
                  isCustomizingUrl
                    ? "bg-[#DFAB6C] text-[#1A110B]"
                    : "bg-white/10 hover:bg-white/20 text-[#DFAB6C]"
                }`}
              >
                <Settings2 className="w-3 h-3" />
              </button>
            </div>

            {/* Quick Network Selector for Phone Scanning */}
            <div className="flex items-center justify-center gap-1.5 mt-2">
              <button
                type="button"
                onClick={() => setOrderOrigin("http://192.0.0.2:3000/menu")}
                className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition-all cursor-pointer ${
                  orderOrigin.includes("192.0.0.2")
                    ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                    : "bg-white/10 text-[#C4B4A8] hover:text-white hover:bg-white/15"
                }`}
                title="Scan with phone connected to personal hotspot"
              >
                📱 Phone Hotspot
              </button>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    setOrderOrigin(`${window.location.origin}/menu`);
                  }
                }}
                className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition-all cursor-pointer ${
                  orderOrigin.includes("localhost")
                    ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                    : "bg-white/10 text-[#C4B4A8] hover:text-white hover:bg-white/15"
                }`}
                title="Localhost on this computer"
              >
                💻 Localhost
              </button>
              <button
                type="button"
                onClick={() => setOrderOrigin("https://brew-coffee.cafe/menu")}
                className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition-all cursor-pointer ${
                  orderOrigin.includes("brew-coffee.cafe")
                    ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                    : "bg-white/10 text-[#C4B4A8] hover:text-white hover:bg-white/15"
                }`}
                title="Live production domain"
              >
                🌐 Live Web
              </button>
            </div>

            {/* Custom URL & Wi-Fi IP Panel */}
            <AnimatePresence>
              {isCustomizingUrl && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="w-full mt-3 p-3 rounded-2xl bg-black/60 border border-[#DFAB6C]/30 text-left overflow-hidden text-xs"
                >
                  <p className="font-bold text-white mb-1 flex items-center gap-1.5 text-[11px]">
                    <Settings2 className="w-3.5 h-3.5 text-[#DFAB6C]" />
                    Custom QR Target URL
                  </p>
                  <p className="text-[10px] text-[#8C7C70] mb-2 leading-relaxed">
                    Enter your computer&apos;s Wi-Fi / LAN IP so phones on the same network can reach it:
                  </p>

                  <div className="flex gap-1.5 mb-2">
                    <input
                      type="text"
                      value={customUrlInput}
                      onChange={(e) => setCustomUrlInput(e.target.value)}
                      placeholder="e.g. http://192.168.1.5:3000/menu"
                      className="flex-1 bg-white/5 border border-white/20 rounded-lg px-2.5 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                    <button
                      onClick={() => handleApplyCustomUrl(customUrlInput)}
                      className="px-3 py-1.5 rounded-lg bg-[#DFAB6C] hover:bg-white text-[#1A110B] text-[11px] font-bold cursor-pointer transition-all"
                    >
                      Apply
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 3 Quick Step Icons */}
          <div className="grid grid-cols-3 gap-2 my-4 text-center">
            <div className="p-2 rounded-xl bg-black/30 border border-white/5">
              <span className="text-base">📱</span>
              <p className="text-[10px] font-bold text-white mt-1">1. Scan</p>
              <p className="text-[9px] text-[#8C7C70]">Open menu</p>
            </div>
            <div className="p-2 rounded-xl bg-black/30 border border-white/5">
              <span className="text-base">☕</span>
              <p className="text-[10px] font-bold text-white mt-1">2. Choose</p>
              <p className="text-[9px] text-[#8C7C70]">Roast & milk</p>
            </div>
            <div className="p-2 rounded-xl bg-black/30 border border-white/5">
              <span className="text-base">🔔</span>
              <p className="text-[10px] font-bold text-white mt-1">3. Collect</p>
              <p className="text-[9px] text-[#8C7C70]">Watch board</p>
            </div>
          </div>

          {/* Live Wait Time Badge */}
          <div className="p-3.5 rounded-2xl bg-black/50 border border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Clock className="w-4 h-4 text-[#DFAB6C]" />
              <div>
                <p className="text-[10px] uppercase font-bold text-[#8C7C70]">
                  Est. Wait Time
                </p>
                <p className="text-sm font-bold text-white font-mono">
                  ~{estimatedWaitMinutes} Minutes
                </p>
              </div>
            </div>
            <Link
              href="/menu"
              className="px-3.5 py-1.5 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
            >
              <span>Order Now</span>
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>

      {/* Bottom Footer Info Strip */}
      <footer className="pt-4 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between text-xs text-[#8C7C70] gap-3">
        <div className="flex items-center gap-3">
          <span>☕ Mobile Outlet on Wheels</span>
          <span>•</span>
          <span className="text-[#EDE4DA]">Sanctuary Van #1</span>
          <span>•</span>
          <span className="text-emerald-400 font-medium">Accepting UPI, Google Pay, Cards & Cash</span>
        </div>

        <div className="flex items-center gap-4">
          <Link href="/barista" className="hover:text-[#DFAB6C] transition-colors underline">
            Barista KDS Login
          </Link>
          <span>•</span>
          <Link href="/location" className="hover:text-[#DFAB6C] transition-colors underline">
            Today&apos;s Route & Map
          </Link>
        </div>
      </footer>
    </main>
  );
}
