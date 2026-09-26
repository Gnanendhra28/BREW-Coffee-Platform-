"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import {
  Coffee,
  CheckCircle2,
  Clock,
  Volume2,
  VolumeX,
  Search,
  Play,
  ExternalLink,
  Car,
  MapPin,
  Calendar,
  Plus,
  Trash2,
  Sparkles,
  Truck,
  AlertTriangle,
  RefreshCw,
  Zap,
  Share2,
  Copy,
  Check,
  LogOut,
  Shield,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useVan, OrderStatus } from "@/context/VanContext";
import { MENU_ITEMS } from "@/data/menuData";
import { BaristaOpsAssistant } from "@/components/BaristaOpsAssistant";
import {
  analyzeStockDepletion,
  generateSocialBroadcast,
} from "@/lib/smartAgentsEngine";

export default function BaristaKDSPage() {
  const {
    orders,
    activeOrders,
    updateOrderStatus,
    soldOutItemIds,
    toggleSoldOut,
    vanLocation,
    updateVanLocation,
    futureStops,
    addFutureStop,
    deleteFutureStop,
    setStopAsLiveToday,
    inventory,
    restockInventory,
    flashDeal,
    toggleFlashDeal,
    curbsideArrivals,
  } = useVan();

  const router = useRouter();
  const { user, signOutUser } = useAuth();

  const [filterTab, setFilterTab] = useState<
    "active" | "all" | "inventory" | "settings" | "dispatch"
  >("active");
  const [isCopilotOpen, setIsCopilotOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [currentTime, setCurrentTime] = useState("");
  const [currentTimestamp, setCurrentTimestamp] = useState(0);
  const [inventorySearch, setInventorySearch] = useState("");

  // Location edit states
  const [spotName, setSpotName] = useState(vanLocation.spotName);
  const [spotCity, setSpotCity] = useState(vanLocation.city);
  const [spotAddress, setSpotAddress] = useState(vanLocation.address);
  const [spotHours, setSpotHours] = useState(vanLocation.hours);
  const [spotStatus, setSpotStatus] = useState<
    "serving" | "moving" | "closed" | "break"
  >(vanLocation.status);
  const [spotNotes, setSpotNotes] = useState(vanLocation.notes || "");
  const [locationSaved, setLocationSaved] = useState(false);
  const [restockedFeedback, setRestockedFeedback] = useState(false);
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null);

  // Future stops form states
  const [futDate, setFutDate] = useState("");
  const [futDayOfWeek, setFutDayOfWeek] = useState("Monday");
  const [futState, setFutState] = useState<"Telangana" | "Andhra Pradesh">(
    "Telangana",
  );
  const [futCity, setFutCity] = useState("Hyderabad");
  const [futSpotName, setFutSpotName] = useState("");
  const [futAddress, setFutAddress] = useState("");
  const [futHours, setFutHours] = useState("8:00 AM — 4:00 PM");
  const [futBadge, setFutBadge] = useState("Confirmed Hub");
  const [futNotes, setFutNotes] = useState("");
  const [futSuccessMsg, setFutSuccessMsg] = useState("");

  // Clock
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
      setCurrentTimestamp(now.getTime());
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  // Web Audio Synth Chime
  const playNewOrderDing = () => {
    if (!soundEnabled || typeof window === "undefined") return;
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.65);
    } catch {}
  };

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case "received":
        return (
          <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] uppercase tracking-wider font-bold">
            🟡 New Order
          </span>
        );
      case "brewing":
        return (
          <span className="px-2.5 py-1 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 text-[10px] uppercase tracking-wider font-bold animate-pulse">
            🔥 Brewing
          </span>
        );
      case "ready":
        return (
          <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] uppercase tracking-wider font-bold">
            ✓ Ready for Guest
          </span>
        );
      case "served":
        return (
          <span className="px-2.5 py-1 rounded-full bg-white/10 text-[#8C7C70] text-[10px] uppercase tracking-wider font-semibold">
            Served
          </span>
        );
      default:
        return null;
    }
  };

  const filteredInventory = MENU_ITEMS.filter((item) =>
    item.name.toLowerCase().includes(inventorySearch.toLowerCase().trim()),
  );

  const handleSaveLocation = (e: React.FormEvent) => {
    e.preventDefault();
    updateVanLocation({
      spotName,
      city: spotCity,
      address: spotAddress,
      hours: spotHours,
      status: spotStatus,
      notes: spotNotes,
    });
    setLocationSaved(true);
    setTimeout(() => setLocationSaved(false), 2500);
  };

  const handleCreateFutureStop = (e: React.FormEvent) => {
    e.preventDefault();
    if (!futSpotName.trim() || !futDate.trim()) return;

    addFutureStop({
      date: futDate.trim(),
      dayOfWeek: futDayOfWeek,
      state: futState,
      city: futCity.trim(),
      spotName: futSpotName.trim(),
      address: futAddress.trim() || `${futCity}, ${futState}`,
      hours: futHours.trim(),
      status: "confirmed",
      badge: futBadge.trim() || "Confirmed Stop",
      notes: futNotes.trim(),
    });

    setFutSuccessMsg("✓ New upcoming stop published! Now live on /location");
    setFutSpotName("");
    setFutDate("");
    setFutNotes("");
    setFutAddress("");
    setTimeout(() => setFutSuccessMsg(""), 3500);
  };

  return (
    <main className="relative w-full min-h-screen bg-[#140D08] text-[#F4EFE6] flex flex-col justify-start select-none font-sans">
      {/* Top Bar */}
      <header className="sticky top-0 z-40 bg-[#1E130D]/95 backdrop-blur-md border-b border-white/10 px-4 sm:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Left branding & Role */}
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl font-extrabold tracking-[0.2em] text-[#DFAB6C]">
              BREW
            </span>
          </Link>
          <div className="h-5 w-px bg-white/20" />
          <div className="flex items-center gap-2 bg-[#2E1B10] px-3 py-1 rounded-full border border-white/10">
            <Coffee className="w-3.5 h-3.5 text-[#DFAB6C]" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              Barista Van KDS
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center rounded-xl bg-black/40 p-1 border border-white/10 text-xs">
          <button
            onClick={() => setFilterTab("active")}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
              filterTab === "active"
                ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                : "text-[#8C7C70] hover:text-white"
            }`}
          >
            Live Tickets ({activeOrders.length})
          </button>
          <button
            onClick={() => setFilterTab("all")}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
              filterTab === "all"
                ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                : "text-[#8C7C70] hover:text-white"
            }`}
          >
            All History ({orders.length})
          </button>
          <button
            onClick={() => setFilterTab("inventory")}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
              filterTab === "inventory"
                ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                : "text-[#8C7C70] hover:text-white"
            }`}
          >
            <span>Stock Toggles</span>
            {analyzeStockDepletion(inventory).length > 0 ? (
              <span className="px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[10px] font-bold font-mono animate-pulse">
                {analyzeStockDepletion(inventory).length} alert
              </span>
            ) : (
              <span className="text-[11px] font-mono opacity-80">({soldOutItemIds.length})</span>
            )}
          </button>
          <button
            onClick={() => setFilterTab("settings")}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
              filterTab === "settings"
                ? "bg-[#DFAB6C] text-[#1A110B] shadow-sm"
                : "text-[#8C7C70] hover:text-white"
            }`}
          >
            Van Location
          </button>
          <button
            onClick={() => setFilterTab("dispatch")}
            className={`px-3 sm:px-4 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
              filterTab === "dispatch"
                ? "bg-gradient-to-r from-[#DFAB6C] to-[#E5B57A] text-[#1A110B] shadow-sm"
                : "text-[#DFAB6C] hover:text-white"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Ops & Dispatch</span>
          </button>
        </div>

        {/* Right Tools: Time, Sound, Outdoor Board link */}
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-sm font-bold text-[#DFAB6C] bg-black/30 px-3 py-1.5 rounded-lg border border-white/5">
            {currentTime}
          </span>

          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-[#DFAB6C] cursor-pointer"
            title={soundEnabled ? "Mute audio chimes" : "Enable audio chimes"}
          >
            {soundEnabled ? (
              <Volume2 className="w-4 h-4" />
            ) : (
              <VolumeX className="w-4 h-4" />
            )}
          </button>

          <Link
            href="/board"
            target="_blank"
            className="px-3 py-1.5 rounded-lg bg-[#3D2619] hover:bg-[#DFAB6C] hover:text-[#1A110B] text-xs font-bold text-[#F4EFE6] border border-white/10 transition-all flex items-center gap-1.5 cursor-pointer shadow-md"
            title="Launch outdoor customer display screen"
          >
            <span>Outdoor Board</span>
            <ExternalLink className="w-3 h-3" />
          </Link>

          {/* Staff Shift Identity & Lock KDS */}
          {user && (
            <div className="flex items-center gap-2 pl-2 border-l border-white/10">
              <div className="hidden sm:flex flex-col text-right">
                <span className="text-xs font-bold text-white flex items-center gap-1 justify-end">
                  <Shield className="w-3 h-3 text-[#DFAB6C]" />
                  <span>{user.displayName || "Active Shift"}</span>
                </span>
                <span className="text-[10px] text-[#DFAB6C] uppercase font-mono tracking-wider font-semibold">
                  {user.role}
                </span>
              </div>
              <button
                onClick={async () => {
                  await signOutUser();
                  router.push("/login?redirect=/barista");
                }}
                className="px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                title="Lock KDS & End Shift"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden md:inline text-[11px] font-semibold">Lock KDS</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1600px] w-full mx-auto">
        {/* VIEW 1: LIVE ACTIVE TICKETS */}
        {filterTab === "active" && (
          <div>
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-white/10">
              <div>
                <h1 className="text-2xl font-serif font-bold text-white">
                  Incoming Order Tickets
                </h1>
                <p className="text-xs text-[#8C7C70] mt-0.5">
                  Update tickets as you grind, brew, and serve at the mobile
                  window
                </p>
              </div>

              <div className="flex items-center gap-4 text-xs font-mono">
                <span className="text-amber-400">
                  Received:{" "}
                  {orders.filter((o) => o.status === "received").length}
                </span>
                <span className="text-blue-400">
                  Brewing: {orders.filter((o) => o.status === "brewing").length}
                </span>
                <span className="text-emerald-400">
                  Ready at Window:{" "}
                  {orders.filter((o) => o.status === "ready").length}
                </span>
              </div>
            </div>

            {activeOrders.length === 0 ? (
              <div className="py-20 text-center flex flex-col items-center justify-center bg-[#1E130D]/40 rounded-3xl border border-dashed border-white/10">
                <Coffee className="w-12 h-12 text-[#DFAB6C] mb-3 opacity-60" />
                <h3 className="text-lg font-bold text-white">
                  All orders are served!
                </h3>
                <p className="text-xs text-[#8C7C70] max-w-sm mt-1">
                  The order queue is empty. Waiting for guests outside to scan
                  the board and place orders.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                <AnimatePresence>
                  {activeOrders.map((order) => {
                    const elapsedMins =
                      currentTimestamp > 0
                        ? Math.max(
                            0,
                            Math.floor(
                              (currentTimestamp - order.createdAt) /
                                (1000 * 60),
                            ),
                          )
                        : 0;
                    return (
                      <motion.div
                        key={order.id}
                        layout
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className={`rounded-3xl border p-5 flex flex-col justify-between shadow-xl transition-all ${
                          order.status === "ready"
                            ? "bg-gradient-to-b from-[#17261C] to-[#121B14] border-emerald-500/40 shadow-emerald-950/40"
                            : order.status === "brewing"
                              ? "bg-gradient-to-b from-[#1C2029] to-[#141820] border-blue-500/40 shadow-blue-950/40"
                              : "bg-[#22160F] border-amber-500/40 shadow-black/60"
                        }`}
                      >
                        {/* Ticket Header */}
                        <div>
                          <div className="flex items-start justify-between mb-3 pb-3 border-b border-white/10">
                            <div>
                              <div className="flex items-baseline gap-2">
                                <span className="text-xs uppercase tracking-widest font-mono text-[#8C7C70]">
                                  Token
                                </span>
                                <span className="text-3xl font-extrabold text-white font-mono">
                                  #{order.orderNumber}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-sm font-semibold text-white">
                                  {order.customerName}
                                </span>
                                {order.pickupType === "curbside" && (
                                  <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] font-bold uppercase flex items-center gap-1">
                                    <Car className="w-3 h-3" />
                                    <span>Curbside</span>
                                  </span>
                                )}
                              </div>
                              {order.vehicleInfo && (
                                <p className="text-[11px] text-[#DFAB6C] font-mono mt-0.5">
                                  {order.vehicleInfo}
                                </p>
                              )}

                              {/* Curbside Drive-Thru Expediter Live Pulse (Agent #2) */}
                              {order.pickupType === "curbside" && curbsideArrivals[order.id] === "arrived" && (
                                <div className="mt-2 p-2 rounded-xl bg-emerald-500/20 border border-emerald-500/60 text-emerald-200 text-xs font-bold flex items-center gap-2 animate-pulse shadow-md">
                                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                                  </span>
                                  <div>
                                    <span className="text-[10px] text-emerald-300 uppercase tracking-wider block">🚨 Vehicle at Curb!</span>
                                    <span className="text-[11px] text-white">Deliver to vehicle window now</span>
                                  </div>
                                </div>
                              )}

                              {order.pickupType === "curbside" && curbsideArrivals[order.id] === "approaching" && (
                                <div className="mt-2 p-2 rounded-xl bg-amber-500/20 border border-amber-500/50 text-amber-200 text-xs font-semibold flex items-center gap-2 animate-pulse">
                                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                                  </span>
                                  <div>
                                    <span className="text-[10px] text-amber-300 uppercase tracking-wider block">⚡ Approaching (~2m ETA)</span>
                                    <span className="text-[11px] text-amber-100">Sync extraction for 60s handover</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="flex flex-col items-end gap-1.5">
                              {getStatusBadge(order.status)}
                              <span className="text-[11px] text-[#8C7C70] font-mono flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {elapsedMins === 0
                                  ? "Just now"
                                  : `${elapsedMins}m ago`}
                              </span>
                            </div>
                          </div>

                          {/* Items List */}
                          <div className="space-y-2 mb-4">
                            {order.items.map((item, idx) => (
                              <div
                                key={idx}
                                className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-black/25"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="w-5 h-5 rounded bg-[#DFAB6C]/20 text-[#DFAB6C] font-mono font-bold flex items-center justify-center text-[11px]">
                                    {item.quantity}x
                                  </span>
                                  <span className="font-medium text-white">
                                    {item.name}
                                  </span>
                                </div>
                                <span className="text-[#8C7C70] font-mono">
                                  ₹
                                  {(item.price * item.quantity).toLocaleString(
                                    "en-IN",
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>

                          {/* Special Barista Notes */}
                          {order.notes && (
                            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 mb-4 text-xs">
                              <span className="font-bold text-amber-400 block text-[10px] uppercase tracking-wider">
                                Note for Barista:
                              </span>
                              <p className="text-[#EDE4DA] mt-0.5">
                                {order.notes}
                              </p>
                            </div>
                          )}
                        </div>

                        {/* Action Buttons Pipeline */}
                        <div className="pt-3 border-t border-white/10 flex flex-col gap-2">
                          <div className="flex justify-between items-center text-xs mb-1">
                            <span className="text-[#8C7C70]">Total Paid</span>
                            <span className="font-mono font-bold text-white text-sm">
                              ₹{order.totalAmount.toLocaleString("en-IN")}
                            </span>
                          </div>

                          {order.status === "received" && (
                            <button
                              onClick={() =>
                                updateOrderStatus(order.id, "brewing")
                              }
                              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer shadow-md"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              <span>Start Brewing</span>
                            </button>
                          )}

                          {order.status === "brewing" && (
                            <button
                              onClick={() => {
                                updateOrderStatus(order.id, "ready");
                                playNewOrderDing();
                              }}
                              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer shadow-md"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Mark Ready at Window</span>
                            </button>
                          )}

                          {order.status === "ready" && (
                            <button
                              onClick={() =>
                                updateOrderStatus(order.id, "served")
                              }
                              className="w-full py-2.5 rounded-xl bg-[#F4EFE6] text-[#1A110B] hover:bg-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer shadow-md"
                            >
                              <span>Handed to Guest (Complete)</span>
                            </button>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>
        )}

        {/* VIEW 2: ALL ORDER HISTORY */}
        {filterTab === "all" && (
          <div>
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-white/10">
              <h1 className="text-2xl font-serif font-bold text-white">
                All Orders Today ({orders.length})
              </h1>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#1E130D]">
              <table className="w-full text-left text-xs">
                <thead className="bg-black/40 text-[#8C7C70] uppercase font-mono border-b border-white/10">
                  <tr>
                    <th className="p-3.5">Token</th>
                    <th className="p-3.5">Customer</th>
                    <th className="p-3.5">Items</th>
                    <th className="p-3.5">Total</th>
                    <th className="p-3.5">Type</th>
                    <th className="p-3.5">Status</th>
                    <th className="p-3.5">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      className="hover:bg-white/5 transition-colors"
                    >
                      <td className="p-3.5 font-mono font-bold text-[#DFAB6C]">
                        #{o.orderNumber}
                      </td>
                      <td className="p-3.5 text-white font-medium">
                        {o.customerName}
                      </td>
                      <td className="p-3.5 text-[#C4B4A8]">
                        {o.items
                          .map((i) => `${i.quantity}x ${i.name}`)
                          .join(", ")}
                      </td>
                      <td className="p-3.5 font-mono text-white">
                        ₹{o.totalAmount.toLocaleString("en-IN")}
                      </td>
                      <td className="p-3.5 capitalize">{o.pickupType}</td>
                      <td className="p-3.5">{getStatusBadge(o.status)}</td>
                      <td className="p-3.5">
                        {o.status !== "served" && (
                          <button
                            onClick={() => updateOrderStatus(o.id, "served")}
                            className="px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-[10px] font-semibold cursor-pointer"
                          >
                            Mark Served
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* VIEW 3: INVENTORY STOCK TOGGLES (86 LIST) */}
        {filterTab === "inventory" && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-2 border-b border-white/10">
              <div>
                <h1 className="text-2xl font-serif font-bold text-white">
                  Mobile Van Stock & &apos;86&apos; Sold Out Toggles
                </h1>
                <p className="text-xs text-[#8C7C70] mt-0.5">
                  Tap to instantly toggle availability. Sold-out items are
                  hidden or disabled on the customer ordering menu.
                </p>
              </div>

              <div className="relative w-full sm:w-64">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8C7C70]" />
                <input
                  type="text"
                  value={inventorySearch}
                  onChange={(e) => setInventorySearch(e.target.value)}
                  placeholder="Search item to 86..."
                  className="w-full pl-9 pr-3 py-2 bg-black/40 rounded-xl border border-white/10 text-xs text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C]"
                />
              </div>
            </div>

            {/* INVENTORY SENTINEL ENGINE (Agent #1) */}
            <div className="mb-8 p-6 rounded-3xl bg-[#22160F] border border-amber-500/30 shadow-xl space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-300">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                        Inventory Sentinel — Raw Stock &amp; Burn Rate
                      </h2>
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-bold">
                        Live Auto-Deduction
                      </span>
                    </div>
                    <p className="text-xs text-[#8C7C70]">
                      Ingredients automatically deduct per espresso shot, steamed milk, and bakery pastry sold.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    restockInventory();
                    setRestockedFeedback(true);
                    setTimeout(() => setRestockedFeedback(false), 2500);
                  }}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-md ${
                    restockedFeedback
                      ? "bg-emerald-500 text-stone-950"
                      : "bg-[#DFAB6C] hover:bg-white text-[#1A110B]"
                  }`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${restockedFeedback ? "animate-spin" : ""}`} />
                  <span>{restockedFeedback ? "Van Restocked!" : "Quick Restock (+ All Ingredients)"}</span>
                </button>
              </div>

              {/* 6 Ingredient Gauges */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {/* Coffee Beans */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#8C7C70] tracking-wider">
                    Coffee Beans
                  </span>
                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className="text-2xl font-black text-white font-mono">
                      {inventory.coffeeBeansKg}
                    </span>
                    <span className="text-xs font-mono text-[#8C7C70]">kg</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        inventory.coffeeBeansKg <= 2 ? "bg-red-500" : "bg-amber-400"
                      }`}
                      style={{ width: `${Math.min(100, (inventory.coffeeBeansKg / 10) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Whole Milk */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#8C7C70] tracking-wider">
                    Whole Milk
                  </span>
                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className="text-2xl font-black text-white font-mono">
                      {inventory.wholeMilkLiters}
                    </span>
                    <span className="text-xs font-mono text-[#8C7C70]">L</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        inventory.wholeMilkLiters <= 5 ? "bg-red-500" : "bg-emerald-400"
                      }`}
                      style={{ width: `${Math.min(100, (inventory.wholeMilkLiters / 20) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Oat Milk */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#8C7C70] tracking-wider">
                    Oat Milk (Vegan)
                  </span>
                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className="text-2xl font-black text-white font-mono">
                      {inventory.oatMilkLiters}
                    </span>
                    <span className="text-xs font-mono text-[#8C7C70]">L</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        inventory.oatMilkLiters <= 2 ? "bg-amber-500" : "bg-emerald-400"
                      }`}
                      style={{ width: `${Math.min(100, (inventory.oatMilkLiters / 10) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Paper Cups */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#8C7C70] tracking-wider">
                    Artisan Cups
                  </span>
                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className="text-2xl font-black text-white font-mono">
                      {inventory.paperCups}
                    </span>
                    <span className="text-xs font-mono text-[#8C7C70]">cups</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        inventory.paperCups <= 25 ? "bg-red-500" : "bg-blue-400"
                      }`}
                      style={{ width: `${Math.min(100, (inventory.paperCups / 150) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Bakery Pastries */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#8C7C70] tracking-wider">
                    Bakery Pastries
                  </span>
                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className="text-2xl font-black text-white font-mono">
                      {inventory.bakeryPastries}
                    </span>
                    <span className="text-xs font-mono text-[#8C7C70]">pcs</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        inventory.bakeryPastries <= 5 ? "bg-red-500" : "bg-amber-400"
                      }`}
                      style={{ width: `${Math.min(100, (inventory.bakeryPastries / 30) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Syrups */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-bold text-[#8C7C70] tracking-wider">
                    Flavor Syrups
                  </span>
                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className="text-2xl font-black text-white font-mono">
                      {inventory.syrupsLiters}
                    </span>
                    <span className="text-xs font-mono text-[#8C7C70]">L</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-purple-400 transition-all"
                      style={{ width: `${Math.min(100, (inventory.syrupsLiters / 5) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Depletion Alerts Section */}
              {analyzeStockDepletion(inventory).length > 0 && (
                <div className="pt-3 border-t border-white/5 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400 uppercase tracking-wider">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                    <span>Predictive Depletion Alerts &amp; AI Recommendations</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {analyzeStockDepletion(inventory).map((alert, idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-xl border text-xs flex items-start gap-2.5 ${
                          alert.severity === "critical"
                            ? "bg-red-950/30 border-red-500/40 text-red-200"
                            : "bg-amber-950/30 border-amber-500/40 text-amber-200"
                        }`}
                      >
                        <AlertTriangle
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            alert.severity === "critical" ? "text-red-400" : "text-amber-400"
                          }`}
                        />
                        <div className="flex-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-bold text-white">{alert.ingredient}</span>
                            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-black/40">
                              {alert.predictedDepletionTime}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#EDE4DA]/80 mt-1">
                            {alert.recommendation}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredInventory.map((item) => {
                const isSoldOut = soldOutItemIds.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className={`p-4 rounded-2xl border transition-all flex items-center justify-between ${
                      isSoldOut
                        ? "bg-red-950/30 border-red-500/40 opacity-75"
                        : "bg-[#22160F] border-white/10"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-black/40 relative overflow-hidden shrink-0">
                        <Image
                          src={item.image}
                          alt={item.name}
                          fill
                          className="object-contain p-1"
                        />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-white truncate max-w-[130px]">
                          {item.name}
                        </p>
                        <span className="text-[10px] text-[#8C7C70] uppercase tracking-wider block">
                          {item.categoryLabel}
                        </span>
                        <span className="text-xs text-[#DFAB6C] font-mono">
                          ₹{item.price}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => toggleSoldOut(item.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                        isSoldOut
                          ? "bg-red-500 text-white hover:bg-red-600 shadow-md"
                          : "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500 hover:text-black"
                      }`}
                    >
                      {isSoldOut ? "86'D (Out)" : "In Stock"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 4: VAN LOCATION & STATUS SETTINGS */}
        {filterTab === "settings" && (
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="pb-3 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-serif font-bold text-white flex items-center gap-2.5">
                  <Truck className="w-6 h-6 text-[#DFAB6C]" />
                  <span>Van Parking & Real-Time Vehicle Status</span>
                </h1>
                <p className="text-xs text-[#8C7C70] mt-0.5">
                  Control today&apos;s live vehicle status (Still There vs
                  Closed) and schedule future upcoming stops for the public
                  location tracker.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Link
                  href="/location"
                  target="_blank"
                  className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-[#DFAB6C] font-semibold flex items-center gap-1.5 transition-all"
                >
                  <span>Open Public /location</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
                <Link
                  href="/board"
                  target="_blank"
                  className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-white font-semibold flex items-center gap-1.5 transition-all"
                >
                  <span>Open Outdoor /board</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>

            {/* SECTION 1: TODAY'S LIVE VEHICLE STATUS & LOCATION */}
            <div className="p-6 rounded-3xl bg-[#22160F] border border-white/10 shadow-xl space-y-5">
              <div className="flex items-center justify-between pb-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#DFAB6C] animate-pulse" />
                  <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                    Today&apos;s Live Station & Vehicle Status
                  </h2>
                </div>
                <span className="text-[11px] font-mono text-[#8C7C70]">
                  Real-time broadcast to /location & /board
                </span>
              </div>

              <form onSubmit={handleSaveLocation} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Current Spot Name */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Current Parking Area *
                    </label>
                    <input
                      type="text"
                      required
                      value={spotName}
                      onChange={(e) => setSpotName(e.target.value)}
                      placeholder="e.g. HITEC City — Cyber Towers Gate 2"
                      className="w-full px-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* City & State */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      City & Region *
                    </label>
                    <input
                      type="text"
                      required
                      value={spotCity}
                      onChange={(e) => setSpotCity(e.target.value)}
                      placeholder="e.g. Hyderabad, Telangana or Visakhapatnam, AP"
                      className="w-full px-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Address */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Landmark Address
                    </label>
                    <input
                      type="text"
                      value={spotAddress}
                      onChange={(e) => setSpotAddress(e.target.value)}
                      placeholder="e.g. Phase 2, Cyber Gateway Promenade"
                      className="w-full px-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Operating Hours */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Today&apos;s Operating Hours *
                    </label>
                    <input
                      type="text"
                      required
                      value={spotHours}
                      onChange={(e) => setSpotHours(e.target.value)}
                      placeholder="e.g. 7:00 AM — 11:00 PM"
                      className="w-full px-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>
                </div>

                {/* VEHICLE STATUS SELECTOR */}
                <div className="pt-2">
                  <label className="block text-xs uppercase font-bold text-[#DFAB6C] mb-1.5 flex items-center justify-between">
                    <span>
                      Vehicle Operational Status (Live on Customer Pages) *
                    </span>
                    <span className="text-[10px] text-[#8C7C70] font-normal lowercase">
                      Select whether van is still there or closed
                    </span>
                  </label>
                  <select
                    value={spotStatus}
                    onChange={(e) =>
                      setSpotStatus(
                        e.target.value as
                          | "serving"
                          | "moving"
                          | "closed"
                          | "break",
                      )
                    }
                    className="w-full px-4 py-3 bg-black/60 rounded-xl border-2 border-[#DFAB6C]/40 text-sm text-white font-semibold focus:outline-none focus:border-[#DFAB6C]"
                  >
                    <option value="serving">🟢 Still There & Serving</option>
                    <option value="closed">🔴 Closed for the Day </option>
                    <option value="moving">🚚 In Transit / Relocating </option>
                    <option value="break">
                      ☕ Short Barista Break / Restocking{" "}
                    </option>
                  </select>
                </div>

                {/* LIVE STATUS PREVIEW BADGE */}
                <div className="p-3.5 rounded-2xl bg-black/40 border border-white/10 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs uppercase font-mono text-[#8C7C70]">
                      Customer View:
                    </span>
                    {spotStatus === "serving" && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-xs font-bold">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                        🟢 Still There & Serving Now
                      </span>
                    )}
                    {spotStatus === "closed" && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-bold">
                        🔴 Closed for the Day
                      </span>
                    )}
                    {spotStatus === "moving" && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold">
                        🚚 In Transit / Relocating Soon
                      </span>
                    )}
                    {spotStatus === "break" && (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 text-xs font-bold">
                        ☕ Short Restock Break
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-[#8C7C70] hidden sm:inline">
                    {spotStatus === "serving"
                      ? "Van is open for walkup & curbside"
                      : spotStatus === "closed"
                        ? "Informs guests on /location that van has closed"
                        : "Notifies guests that van is in transit"}
                  </span>
                </div>

                {/* Special Notes */}
                <div>
                  <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                    Special Parking
                  </label>
                  <input
                    type="text"
                    value={spotNotes}
                    onChange={(e) => setSpotNotes(e.target.value)}
                    placeholder="e.g. Dedicated curbside pickup lane open. Cash, UPI, and Card accepted."
                    className="w-full px-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white focus:outline-none focus:border-[#DFAB6C]"
                  />
                </div>

                {/* Submit Live Location */}
                <button
                  type="submit"
                  className="w-full py-3.5 bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg shadow-[#DFAB6C]/20 flex items-center justify-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {locationSaved
                      ? "✓ Live Vehicle Status & Location Updated!"
                      : "Update Live Vehicle Status & Location"}
                  </span>
                </button>
              </form>
            </div>

            {/* SECTION 2: CREATE FUTURE VAN LOCATION UPDATES */}
            <div className="p-6 rounded-3xl bg-[#22160F] border border-white/10 shadow-xl space-y-5">
              <div className="flex items-center justify-between pb-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/30 flex items-center justify-center text-[#DFAB6C]">
                    <Calendar className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                      Schedule Future Van Stop (Create Future Updates)
                    </h2>
                    <p className="text-xs text-[#8C7C70]">
                      Add upcoming locations so customers can view upcoming
                      stops in advance on the location page.
                    </p>
                  </div>
                </div>
              </div>

              {futSuccessMsg && (
                <div className="p-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{futSuccessMsg}</span>
                </div>
              )}

              <form onSubmit={handleCreateFutureStop} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                  {/* Date Label */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Date *
                    </label>
                    <input
                      type="text"
                      required
                      value={futDate}
                      onChange={(e) => setFutDate(e.target.value)}
                      placeholder="e.g. Tomorrow, Sep 21 or Sep 25"
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Day of Week */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Day of Week *
                    </label>
                    <select
                      value={futDayOfWeek}
                      onChange={(e) => setFutDayOfWeek(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    >
                      <option value="Monday">Monday</option>
                      <option value="Tuesday">Tuesday</option>
                      <option value="Wednesday">Wednesday</option>
                      <option value="Thursday">Thursday</option>
                      <option value="Friday">Friday</option>
                      <option value="Saturday">Saturday</option>
                      <option value="Sunday">Sunday</option>
                    </select>
                  </div>

                  {/* State */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      State *
                    </label>
                    <select
                      value={futState}
                      onChange={(e) =>
                        setFutState(
                          e.target.value as "Telangana" | "Andhra Pradesh",
                        )
                      }
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    >
                      <option value="Telangana">Telangana</option>
                      <option value="Andhra Pradesh">Andhra Pradesh</option>
                    </select>
                  </div>

                  {/* City */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      City *
                    </label>
                    <input
                      type="text"
                      required
                      value={futCity}
                      onChange={(e) => setFutCity(e.target.value)}
                      placeholder="e.g. Hyderabad, Visakhapatnam, Vijayawada"
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Spot Name */}
                  <div className="sm:col-span-2">
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Target Spot *
                    </label>
                    <input
                      type="text"
                      required
                      value={futSpotName}
                      onChange={(e) => setFutSpotName(e.target.value)}
                      placeholder="e.g. DLF Cybercity & Waverock or AU North Campus Hub"
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Detailed Address */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Landmark Address
                    </label>
                    <input
                      type="text"
                      value={futAddress}
                      onChange={(e) => setFutAddress(e.target.value)}
                      placeholder="e.g. Gachibowli Financial District"
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Hours */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Planned Operating Hours *
                    </label>
                    <input
                      type="text"
                      required
                      value={futHours}
                      onChange={(e) => setFutHours(e.target.value)}
                      placeholder="e.g. 7:30 AM — 4:00 PM"
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>

                  {/* Category / Badge */}
                  <div>
                    <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                      Badge / Tag
                    </label>
                    <input
                      type="text"
                      value={futBadge}
                      onChange={(e) => setFutBadge(e.target.value)}
                      placeholder="e.g. Tech Corridor, Sunrise Seaside, Fest"
                      className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-xs uppercase font-bold text-[#8C7C70] mb-1">
                    Special Menu Notes / Features
                  </label>
                  <input
                    type="text"
                    value={futNotes}
                    onChange={(e) => setFutNotes(e.target.value)}
                    placeholder="e.g. Special Nitro cold brew bar + fresh warm cinnamon rolls"
                    className="w-full px-3.5 py-2.5 bg-black/40 rounded-xl border border-white/10 text-xs text-white focus:outline-none focus:border-[#DFAB6C]"
                  />
                </div>

                {/* Submit button */}
                <button
                  type="submit"
                  className="py-3 px-6 bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-md flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>Publish Future Van Stop to Location Page</span>
                </button>
              </form>
            </div>

            {/* SECTION 3: UPCOMING SCHEDULED STOPS LIST */}
            <div className="p-6 rounded-3xl bg-[#22160F] border border-white/10 shadow-xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-white/5">
                <div>
                  <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                    Upcoming Scheduled Stops ({futureStops.length})
                  </h2>
                  <p className="text-xs text-[#8C7C70]">
                    These future updates are displayed live to customers
                    visiting /location.
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-mono">
                  Live on /location
                </span>
              </div>

              <div className="space-y-3">
                {futureStops.map((stop) => (
                  <div
                    key={stop.id}
                    className="p-4 rounded-2xl bg-black/40 border border-white/10 hover:border-[#DFAB6C]/40 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="space-y-1.5 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2.5 py-0.5 rounded-full bg-[#DFAB6C] text-[#1A110B] text-xs font-bold font-mono">
                          {stop.date}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-white/10 text-white text-[11px]">
                          {stop.dayOfWeek}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-[#DFAB6C]/10 border border-[#DFAB6C]/30 text-[#DFAB6C] text-[10px] font-semibold uppercase tracking-wider">
                          {stop.state}
                        </span>
                        {stop.badge && (
                          <span className="text-[11px] text-[#8C7C70]">
                            • {stop.badge}
                          </span>
                        )}
                      </div>

                      <h3 className="text-sm sm:text-base font-bold text-white font-serif">
                        {stop.spotName}
                      </h3>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-[#8C7C70]">
                        <span className="flex items-center gap-1 text-[#C4B4A8]">
                          <MapPin className="w-3.5 h-3.5 text-[#DFAB6C]" />
                          {stop.address}, {stop.city}
                        </span>
                        <span className="flex items-center gap-1 font-mono text-white">
                          <Clock className="w-3.5 h-3.5 text-[#DFAB6C]" />
                          {stop.hours}
                        </span>
                      </div>

                      {stop.notes && (
                        <p className="text-xs text-[#EDE4DA]/80 italic bg-white/5 px-2.5 py-1 rounded-lg inline-block">
                          Note: {stop.notes}
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => {
                          setStopAsLiveToday(stop.id);
                          setSpotName(stop.spotName);
                          setSpotCity(`${stop.city}, ${stop.state}`);
                          setSpotAddress(stop.address);
                          setSpotHours(stop.hours);
                          setSpotStatus("serving");
                          setSpotNotes(stop.notes || "");
                          setLocationSaved(true);
                          setTimeout(() => setLocationSaved(false), 2500);
                        }}
                        className="px-3.5 py-2 rounded-xl bg-emerald-600/30 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
                        title="Promote this upcoming stop to be today's active live van"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Set as Live Today</span>
                      </button>

                      <button
                        onClick={() => deleteFutureStop(stop.id)}
                        className="p-2 rounded-xl bg-red-950/40 hover:bg-red-600/30 text-red-400 hover:text-red-200 border border-red-500/30 transition-all cursor-pointer"
                        title="Delete stop"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* VIEW 5: AI DISPATCH & FLEET OPS COPILOT */}
        {filterTab === "dispatch" && (
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="pb-3 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-serif font-bold text-white flex items-center gap-2.5">
                  <Sparkles className="w-6 h-6 text-[#DFAB6C]" />
                  <span>AI Operations &amp; Autonomous Dispatch Fleet</span>
                </h1>
                <p className="text-xs text-[#8C7C70] mt-0.5">
                  Smart operational copilots: Van parking advisor, Yield flash deals, and localized social broadcaster.
                </p>
              </div>
            </div>

            {/* AGENT #3: YIELD OPTIMIZER / FLASH SPECIAL MANAGER */}
            <div className="p-6 rounded-3xl bg-[#22160F] border border-amber-500/30 shadow-xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/5">
                <div className="flex items-center gap-2.5">
                  <span className="p-2 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/20">
                    <Zap className="w-5 h-5 text-amber-300 fill-amber-300" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                      Yield Optimizer — Flash Specials &amp; Bakery Waste Prevention
                    </h2>
                    <p className="text-xs text-[#8C7C70]">
                      Broadcasts an instant 25% discount bundle banner across the website to accelerate afternoon pastry sales.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-mono font-bold ${
                      flashDeal.isActive
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        : "bg-white/10 text-[#8C7C70]"
                    }`}
                  >
                    {flashDeal.isActive ? "● Live on Site Banner" : "○ Deal Paused"}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleFlashDeal()}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-md ${
                      flashDeal.isActive
                        ? "bg-red-500/20 hover:bg-red-500 text-red-200 hover:text-white border border-red-500/40"
                        : "bg-[#DFAB6C] hover:bg-white text-[#1A110B]"
                    }`}
                  >
                    {flashDeal.isActive ? "Pause Flash Deal" : "Activate Flash Bundle"}
                  </button>
                </div>
              </div>

              {/* Deal Card Preview */}
              <div className="p-4 rounded-2xl bg-black/40 border border-white/5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{flashDeal.title}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold uppercase">
                      {flashDeal.discountPercent}% Off
                    </span>
                  </div>
                  <p className="text-xs text-[#C4B4A8]">{flashDeal.tagline}</p>
                  <p className="text-[11px] text-[#8C7C70]">
                    Bundle: <strong>{flashDeal.beverageName}</strong> + <strong>{flashDeal.pastryName}</strong>
                  </p>
                </div>

                <div className="flex items-baseline gap-2 shrink-0">
                  <span className="text-xs text-[#8C7C70] line-through font-mono">
                    ₹{flashDeal.originalPrice}
                  </span>
                  <span className="text-xl font-extrabold text-[#DFAB6C] font-mono">
                    ₹{flashDeal.dealPrice}
                  </span>
                </div>
              </div>
            </div>

            {/* AGENT #5: HYPER-LOCAL HYPE BROADCASTER */}
            <div className="p-6 rounded-3xl bg-[#22160F] border border-amber-500/30 shadow-xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-white/5">
                <div className="flex items-center gap-2.5">
                  <span className="p-2 rounded-xl bg-blue-500/10 text-blue-300 border border-blue-500/20">
                    <Share2 className="w-5 h-5" />
                  </span>
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider font-sans">
                      Hyper-Local Hype Broadcaster
                    </h2>
                    <p className="text-xs text-[#8C7C70]">
                      AI auto-generates localized social updates for WhatsApp &amp; Instagram whenever the van parks.
                    </p>
                  </div>
                </div>

                <span className="text-[11px] font-mono text-[#DFAB6C] bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
                  📍 {vanLocation.spotName}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {generateSocialBroadcast({
                  spotName: vanLocation.spotName,
                  city: vanLocation.city,
                  landmark: vanLocation.address,
                  weatherCondition: "Warm Afternoon",
                  tempC: 31,
                }).map((post, idx) => (
                  <div
                    key={idx}
                    className="p-4 rounded-2xl bg-black/40 border border-white/5 flex flex-col justify-between space-y-3"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-bold text-white uppercase tracking-wider">
                          {post.platform}
                        </span>
                        <span className="text-[10px] text-[#8C7C70] font-mono">1-Click Blast</span>
                      </div>
                      <h4 className="text-xs font-semibold text-[#DFAB6C]">{post.headline}</h4>
                      <p className="text-[11px] text-[#EDE4DA]/80 mt-1.5 whitespace-pre-line leading-relaxed">
                        {post.body}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-white/5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1 overflow-hidden">
                        {post.hashtags.map((h, hIdx) => (
                          <span key={hIdx} className="text-[10px] text-[#8C7C70] font-mono">
                            {h}
                          </span>
                        ))}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {post.shareableUrl && post.platform === "WhatsApp Status" && (
                          <a
                            href={post.shareableUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold flex items-center gap-1 shadow-sm"
                          >
                            <span>Open WhatsApp</span>
                          </a>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            if (typeof navigator !== "undefined" && navigator.clipboard) {
                              navigator.clipboard.writeText(`${post.headline}\n\n${post.body}\n\n${post.hashtags.join(" ")}`);
                              setCopiedPlatform(post.platform);
                              setTimeout(() => setCopiedPlatform(null), 2500);
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[11px] font-semibold flex items-center gap-1 transition-all"
                        >
                          {copiedPlatform === post.platform ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span className="text-emerald-400">Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 text-[#C4B4A8]" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* AI Ops Assistant Dispatch Chatbot */}
            <div className="pt-4 border-t border-white/10">
              <div className="mb-4">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Autonomous Fleet Dispatch &amp; Location Intelligence
                </h3>
                <p className="text-xs text-[#8C7C70]">
                  Query optimal parking bays, coordinate fleet logistics, and receive AI operational advice.
                </p>
              </div>
              <BaristaOpsAssistant />
            </div>
          </div>
        )}
      </div>

      {/* Floating AI Ops Copilot Drawer Trigger (available when on other tabs) */}
      {filterTab !== "dispatch" && (
        <div className="fixed bottom-6 right-6 z-40">
          <button
            onClick={() => setIsCopilotOpen(!isCopilotOpen)}
            className="flex items-center gap-2 px-4 py-3 rounded-full bg-gradient-to-tr from-[#8E5324] via-[#DFAB6C] to-[#E5B57A] text-[#140D08] font-bold text-xs shadow-2xl hover:scale-105 transition-all cursor-pointer border-2 border-white/20"
            title="Open AI Dispatch & Operations Copilot"
          >
            <Sparkles className="w-4 h-4" />
            <span>AI Ops Copilot</span>
          </button>
        </div>
      )}

      {/* Floating Copilot Modal */}
      <AnimatePresence>
        {isCopilotOpen && filterTab !== "dispatch" && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
            <div className="relative w-full max-w-4xl">
              <button
                onClick={() => setIsCopilotOpen(false)}
                className="absolute -top-10 right-0 px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-semibold cursor-pointer"
              >
                ✕ Close Copilot
              </button>
              <BaristaOpsAssistant />
            </div>
          </div>
        )}
      </AnimatePresence>
    </main>
  );
}
