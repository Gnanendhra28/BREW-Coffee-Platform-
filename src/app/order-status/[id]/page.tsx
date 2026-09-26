"use client";

import React, { useEffect, useState, use } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  MapPin,
  ArrowLeft,
  Car,
  Navigation,
  Sparkles,
  BellRing,
  Volume2,
} from "lucide-react";
import confetti from "canvas-confetti";
import { useVan, VanOrder } from "@/context/VanContext";
import { Header } from "@/components/Header";
import {
  registerBuzzerServiceWorker,
  requestBuzzerPermission,
  triggerHardwareBuzzer,
} from "@/lib/pushBuzzer";

const FALLBACK_CREATED_AT = 1710000000000;

export default function CustomerOrderStatusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const orderId = resolvedParams.id;
  const { orders, vanLocation, curbsideArrivals, updateCurbsideArrival } = useVan();

  const [hasAlertedReady, setHasAlertedReady] = useState(false);
  const [permissionState, setPermissionState] = useState<NotificationPermission | "unsupported">(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      return Notification.permission;
    }
    return "default";
  });
  const [isTestingBuzzer, setIsTestingBuzzer] = useState(false);

  // Find order in context
  const order = orders.find((o) => o.id === orderId || o.orderNumber === orderId);

  // Fallback demo order if directly visiting page without placing order
  const displayOrder: VanOrder = order || {
    id: orderId,
    orderNumber: "102",
    customerName: "Sanctuary Guest",
    items: [
      { id: "c-3", name: "Cappuccino", price: 220, image: "/assets/cup1.png", category: "Coffee", quantity: 1 },
      { id: "d-4", name: "Cinnamon Roll", price: 180, image: "/assets/desserts /Cinnamon Roll.png", category: "Desserts", quantity: 1 },
    ],
    notes: "Oat milk please!",
    totalAmount: 400,
    status: "brewing",
    createdAt: FALLBACK_CREATED_AT,
    pickupType: "walkup",
  };

  // Register service worker on mount & check notification permissions
  useEffect(() => {
    registerBuzzerServiceWorker();
    if (typeof window !== "undefined" && "Notification" in window) {
      const current = Notification.permission;
      queueMicrotask(() => {
        setPermissionState(current);
      });
    } else {
      queueMicrotask(() => {
        setPermissionState("unsupported");
      });
    }
  }, []);

  // Sound chime & haptic feedback when order becomes ready
  useEffect(() => {
    if (displayOrder.status === "ready" && !hasAlertedReady) {
      queueMicrotask(() => {
        setHasAlertedReady(true);
      });

      // Trigger full hardware haptic pager vibration & sound chime
      triggerHardwareBuzzer({
        orderNumber: displayOrder.orderNumber,
        orderId: displayOrder.id,
        vanLocationName: vanLocation.spotName || "Van Window 1",
      });

      // Celebratory confetti
      confetti({
        particleCount: 60,
        spread: 60,
        origin: { y: 0.6 },
        colors: ["#34D399", "#DFAB6C", "#F4EFE6"],
      });
    }
  }, [displayOrder.status, displayOrder.orderNumber, displayOrder.id, vanLocation.spotName, hasAlertedReady]);

  const steps = [
    { key: "received", label: "Order Received", desc: "Ticket dispatched to van" },
    { key: "brewing", label: "Grinding & Brewing", desc: "Barista pulling fresh espresso" },
    { key: "ready", label: "Ready at Window", desc: "Collect at mobile service counter" },
    { key: "served", label: "Served", desc: "Enjoy your artisanal brew" },
  ];

  const getCurrentStepIndex = () => {
    switch (displayOrder.status) {
      case "received":
        return 0;
      case "brewing":
        return 1;
      case "ready":
        return 2;
      case "served":
        return 3;
      default:
        return 0;
    }
  };

  const currentStep = getCurrentStepIndex();

  return (
    <main className="relative w-full min-h-screen bg-[#140D08] text-[#F4EFE6] flex flex-col justify-start select-none font-sans">
      {/* Background radial gradient */}
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 50% 25%, #301A10 0%, #170E08 55%, #0B0604 100%)",
        }}
      />

      <Header />

      <div className="relative w-full max-w-2xl mx-auto pt-28 sm:pt-36 pb-16 px-5 sm:px-8 flex-1">
        {/* Back link */}
        <Link
          href="/menu"
          className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-[#8C7C70] hover:text-[#DFAB6C] transition-colors mb-4 group cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-1" />
          <span>Back to Menu</span>
        </Link>

        {/* BUZZER CARD */}
        <div
          className={`relative rounded-3xl border p-6 sm:p-8 shadow-2xl transition-all overflow-hidden ${
            displayOrder.status === "ready"
              ? "bg-gradient-to-b from-[#1E3324] to-[#142318] border-emerald-500/50 shadow-[0_20px_60px_rgba(16,185,129,0.3)] animate-pulse"
              : "bg-[#24170F]/90 backdrop-blur-xl border-white/10"
          }`}
        >
          {/* Ambient Glow */}
          <div className="absolute -top-20 -right-20 w-44 h-44 bg-[#DFAB6C]/15 rounded-full blur-3xl pointer-events-none" />

          {/* Top Status Header */}
          <div className="text-center pb-6 border-b border-white/10">
            <span className="text-xs uppercase tracking-widest font-mono text-[#DFAB6C] font-semibold">
              Live Digital Buzzer
            </span>
            <div className="flex items-center justify-center gap-2 my-2">
              <span className="text-xs text-[#8C7C70] font-mono">TOKEN</span>
              <h1 className="text-5xl sm:text-6xl font-extrabold text-white font-mono tracking-tight drop-shadow-md">
                #{displayOrder.orderNumber}
              </h1>
            </div>
            <p className="text-sm text-[#EDE4DA]">
              Ordered by <strong className="text-white">{displayOrder.customerName}</strong>
            </p>

            {/* Ready Alert Banner */}
            {displayOrder.status === "ready" && (
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="mt-4 p-4 rounded-2xl bg-emerald-500 text-black font-extrabold flex items-center justify-center gap-2.5 shadow-lg"
              >
                <CheckCircle2 className="w-6 h-6 stroke-[3]" />
                <span className="text-sm sm:text-base uppercase tracking-wider">
                  Ready! Please collect at Van Window 1
                </span>
              </motion.div>
            )}
          </div>

          {/* SMART MOBILE VIBRATING PAGER & WEB PUSH */}
          <div className="my-6 p-4 sm:p-5 rounded-2xl bg-black/40 border border-white/10 backdrop-blur-md">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-start sm:items-center gap-3.5">
                <div
                  className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-inner ${
                    permissionState === "granted"
                      ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                      : "bg-[#3D2619] text-[#DFAB6C] border border-[#DFAB6C]/20"
                  }`}
                >
                  <BellRing className={`w-5 h-5 ${permissionState === "granted" ? "animate-bounce" : ""}`} />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                      Mobile Vibrating Pager
                    </h3>
                    <span
                      className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-bold uppercase border ${
                        permissionState === "granted"
                          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                          : permissionState === "denied"
                          ? "bg-red-500/20 text-red-300 border-red-500/30"
                          : "bg-amber-500/20 text-amber-300 border-amber-500/30"
                      }`}
                    >
                      {permissionState === "granted"
                        ? "Active"
                        : permissionState === "denied"
                        ? "Disabled"
                        : "Tap to Enable"}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#A8988B] mt-1">
                    {permissionState === "granted"
                      ? "Your phone will vibrate with custom haptic pulse & chime when ready."
                      : permissionState === "denied"
                      ? "Notifications blocked in browser. Re-enable in site permissions to get buzzer."
                      : "Replicates physical restaurant buzzer on your phone even with screen locked."}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                {permissionState !== "granted" && permissionState !== "unsupported" && (
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await requestBuzzerPermission(
                        displayOrder.id,
                        displayOrder.orderNumber
                      );
                      setPermissionState(res.permission);
                    }}
                    className="flex-1 sm:flex-none px-3.5 py-2 rounded-xl bg-gradient-to-r from-[#DFAB6C] to-[#E8BA7E] text-stone-950 text-xs font-bold hover:brightness-110 active:scale-95 transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <BellRing className="w-3.5 h-3.5" />
                    <span>Enable Pager</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={isTestingBuzzer}
                  onClick={() => {
                    setIsTestingBuzzer(true);
                    triggerHardwareBuzzer({
                      orderNumber: displayOrder.orderNumber,
                      orderId: displayOrder.id,
                      vanLocationName: vanLocation.spotName || "Van Window 1",
                    });
                    setTimeout(() => setIsTestingBuzzer(false), 1600);
                  }}
                  className={`flex-1 sm:flex-none px-3.5 py-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                    isTestingBuzzer
                      ? "bg-emerald-500/20 border-emerald-400 text-emerald-300 animate-pulse"
                      : "bg-white/10 hover:bg-white/15 border-white/10 text-white active:scale-95"
                  }`}
                >
                  <Volume2 className="w-3.5 h-3.5 text-[#DFAB6C]" />
                  <span>
                    {isTestingBuzzer ? "Buzzing [300-100-300-100-600ms]..." : "Test Pager"}
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* Step-by-Step Progress Pipeline */}
          <div className="my-8">
            <div className="relative flex justify-between items-center">
              {/* Connector line */}
              <div className="absolute top-4 left-4 right-4 h-1 bg-white/10 -z-0" />
              <div
                className="absolute top-4 left-4 h-1 bg-[#DFAB6C] -z-0 transition-all duration-700"
                style={{
                  width: `${(currentStep / (steps.length - 1)) * 100}%`,
                }}
              />

              {steps.map((step, idx) => {
                const isPassed = idx <= currentStep;
                const isCurrent = idx === currentStep;
                return (
                  <div key={step.key} className="flex flex-col items-center text-center relative z-10">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs transition-all ${
                        isCurrent
                          ? "bg-[#DFAB6C] text-[#1A110B] ring-4 ring-[#DFAB6C]/30 scale-110 shadow-lg"
                          : isPassed
                          ? "bg-emerald-500 text-white"
                          : "bg-[#2E1B10] text-[#8C7C70] border border-white/10"
                      }`}
                    >
                      {isPassed && !isCurrent ? (
                        <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
                      ) : (
                        idx + 1
                      )}
                    </div>
                    <span
                      className={`text-[11px] font-semibold mt-2 ${
                        isCurrent ? "text-white" : isPassed ? "text-[#EDE4DA]" : "text-[#8C7C70]"
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Van Location Box */}
          <div className="p-4 rounded-2xl bg-black/40 border border-white/5 flex items-center justify-between gap-3 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#3D2619] text-[#DFAB6C] flex items-center justify-center shrink-0">
                <MapPin className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-[#8C7C70]">
                  Stationed At
                </p>
                <p className="text-xs font-semibold text-white">
                  {vanLocation.spotName}
                </p>
                <p className="text-[11px] text-[#8C7C70]">{vanLocation.address}</p>
              </div>
            </div>

            <span
              className={`text-[10px] font-mono font-bold px-2 py-1 rounded-full border ${
                displayOrder.pickupType === "curbside"
                  ? "text-amber-300 bg-amber-500/10 border-amber-500/20"
                  : "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
              }`}
            >
              {displayOrder.pickupType === "curbside" ? "Curbside Pickup" : "Counter Pickup"}
            </span>
          </div>

          {/* CURBSIDE EXPEDITER ARRIVAL CHECK-IN (Agent #2) */}
          {displayOrder.pickupType === "curbside" && (
            <div className="mb-6 p-4 rounded-2xl bg-gradient-to-br from-[#2D1B0F] via-[#24160E] to-[#190E08] border border-amber-500/30 shadow-xl">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-amber-500/20 text-amber-300">
                    <Car className="w-4 h-4" />
                  </span>
                  <div>
                    <h3 className="text-xs font-bold text-white tracking-wide uppercase">
                      Curbside Drive-Thru Expediter
                    </h3>
                    <p className="text-[11px] text-amber-200/80">
                      Vehicle: <span className="font-semibold text-white">{displayOrder.vehicleInfo || "Curbside Van Bay"}</span>
                    </p>
                  </div>
                </div>

                <span className="flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/20">
                  <Sparkles className="w-2.5 h-2.5" />
                  Sub-60s Handover
                </span>
              </div>

              {/* Dynamic Status message */}
              <div className="my-3 p-3 rounded-xl bg-black/40 border border-white/5 text-xs">
                {curbsideArrivals[displayOrder.id] === "arrived" ? (
                  <div className="flex items-center gap-2 text-emerald-300 font-medium">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                    </span>
                    <span>Arrived! Barista is stepping out to hand over your tray to your car.</span>
                  </div>
                ) : curbsideArrivals[displayOrder.id] === "approaching" ? (
                  <div className="flex items-center gap-2 text-amber-300 font-medium">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                    </span>
                    <span>ETA Pulsed: Barista notified that you are ~2 mins away. Espresso extraction synced!</span>
                  </div>
                ) : (
                  <p className="text-[#C4B4A8] text-[11px]">
                    Tap below as you approach so the barista pulls your espresso shots at peak crema for immediate car handover.
                  </p>
                )}
              </div>

              {/* 1-Click Arrival Actions */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => updateCurbsideArrival(displayOrder.id, "approaching")}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                    curbsideArrivals[displayOrder.id] === "approaching"
                      ? "bg-amber-500 text-stone-950 shadow-md scale-[1.02] ring-2 ring-amber-400"
                      : "bg-white/10 text-white hover:bg-white/15"
                  }`}
                >
                  <Navigation className="w-3.5 h-3.5 text-amber-300" />
                  <span>I&apos;m 2 Mins Away</span>
                </button>

                <button
                  type="button"
                  onClick={() => updateCurbsideArrival(displayOrder.id, "arrived")}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                    curbsideArrivals[displayOrder.id] === "arrived"
                      ? "bg-emerald-500 text-stone-950 shadow-md scale-[1.02] ring-2 ring-emerald-400"
                      : "bg-white/10 text-white hover:bg-white/15"
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>I&apos;ve Arrived at Curb</span>
                </button>
              </div>
            </div>
          )}

          {/* Items Summary */}
          <div className="border-t border-white/10 pt-4 space-y-2 mb-6">
            <span className="text-[11px] uppercase tracking-wider font-bold text-[#8C7C70]">
              Ordered Items
            </span>
            {displayOrder.items.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs py-1">
                <span className="text-[#EDE4DA]">
                  {item.quantity}x {item.name}
                </span>
                <span className="font-mono text-white">
                  ₹{(item.price * item.quantity).toLocaleString('en-IN')}
                </span>
              </div>
            ))}
            {displayOrder.notes && (
              <div className="p-2 rounded-lg bg-white/5 text-[11px] text-[#C4B4A8]">
                <strong>Notes:</strong> {displayOrder.notes}
              </div>
            )}
            <div className="flex justify-between items-center pt-2 border-t border-white/5 text-sm font-bold">
              <span>Total</span>
              <span className="font-mono text-[#DFAB6C]">
                ₹{displayOrder.totalAmount.toLocaleString('en-IN')}
              </span>
            </div>
          </div>

          {/* Action Links */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/menu"
              className="flex-1 py-3 px-4 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] text-xs font-bold text-center transition-all cursor-pointer shadow-md"
            >
              Order Another Item
            </Link>
            <Link
              href="/board"
              target="_blank"
              className="py-3 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold text-center transition-all cursor-pointer"
            >
              View Outdoor Board
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
