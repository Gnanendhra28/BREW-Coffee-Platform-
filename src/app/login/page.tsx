"use client";

import React, { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  ShieldAlert,
  Coffee,
  KeyRound,
  UserCheck,
  Lock,
  ArrowRight,
  Sparkles,
  ChevronLeft,
} from "lucide-react";
import Link from "next/link";

function LoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const {
    user,
    signInWithEmail,
    signInWithGoogle,
    loginWithStaffPin,
    demoSignIn,
    signOutUser,
  } = useAuth();

  const redirectUrl = searchParams.get("redirect") || "/";
  const errorCode = searchParams.get("error");
  const requiredRole = searchParams.get("required");

  const [activeTab, setActiveTab] = useState<"customer" | "barista" | "fleet_admin">(
    requiredRole === "fleet_admin" ? "fleet_admin" : requiredRole === "barista" ? "barista" : "barista"
  );

  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState("");

  const handlePinSubmit = async (e?: React.FormEvent, customPin?: string) => {
    if (e) e.preventDefault();
    const pinToUse = customPin || pin;
    if (!pinToUse) {
      setPinError("Please enter security PIN");
      return;
    }

    setLoading(true);
    setPinError("");

    const res = await loginWithStaffPin(pinToUse);
    setLoading(false);

    if (res.success) {
      // Redirect to the originally requested route or appropriate portal
      if (res.role === "fleet_admin") {
        router.push(redirectUrl.includes("admin") ? redirectUrl : "/admin");
      } else {
        router.push(redirectUrl.includes("barista") ? redirectUrl : "/barista");
      }
    } else {
      setPinError(res.error || "Authentication failed. Incorrect PIN.");
    }
  };

  const handleCustomerLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setFormError("");
    try {
      await signInWithEmail(email, password, "customer");
      router.push(redirectUrl);
    } catch {
      setFormError("Login failed. Check your credentials or use Instant Guest Access.");
    } finally {
      setLoading(false);
    }
  };

  const handleCustomerGoogle = async () => {
    setLoading(true);
    setFormError("");
    try {
      await signInWithGoogle("customer");
      router.push(redirectUrl);
    } catch {
      setFormError("Google Sign-In was cancelled or unavailable.");
    } finally {
      setLoading(false);
    }
  };

  const handleCustomerDemo = async () => {
    setLoading(true);
    await demoSignIn("Coffee Connoisseur", "customer@brew.cafe", "customer");
    setLoading(false);
    router.push(redirectUrl);
  };

  return (
    <div className="min-h-screen bg-[#0e0d0c] text-white flex flex-col justify-center items-center px-4 py-12 relative overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-[#c49a45]/10 rounded-full blur-3xl pointer-events-none" />

      {/* Top Brand & Back Link */}
      <div className="w-full max-w-md mb-8 flex items-center justify-between z-10">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-xs text-white/50 hover:text-[#c49a45] transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Return to Sanctuary</span>
        </Link>
        <span className="font-serif tracking-widest text-[#c49a45] text-sm font-semibold uppercase">
          BREW Mobile KDS
        </span>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-md bg-[#161513]/90 border border-white/10 rounded-3xl p-6 sm:p-8 backdrop-blur-xl shadow-2xl relative z-10">
        {/* Error / Redirect Warning Notice */}
        {errorCode && (
          <div className="mb-6 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3 text-amber-300 text-xs leading-relaxed animate-in fade-in">
            <ShieldAlert className="w-5 h-5 flex-shrink-0 text-amber-400 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-200">
                {errorCode === "forbidden_role"
                  ? "Staff Clearance Required"
                  : errorCode === "session_expired"
                  ? "Session Expired"
                  : "Authentication Required"}
              </p>
              <p className="text-white/70 mt-0.5">
                {requiredRole === "barista"
                  ? "The Kitchen Display System (/barista) is restricted to active shift baristas. Enter your staff PIN below."
                  : requiredRole === "fleet_admin"
                  ? "Fleet management controls require authorized administrator credentials."
                  : "Please sign in to continue to your destination."}
              </p>
            </div>
          </div>
        )}

        {/* Current Active Session Pill (if any) */}
        {user && (
          <div className="mb-6 p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-white/80 font-medium">{user.displayName}</span>
              <span className="px-2 py-0.5 rounded-full bg-white/10 text-[#c49a45] text-[10px] uppercase font-bold tracking-wider">
                {user.role}
              </span>
            </div>
            <button
              onClick={signOutUser}
              className="text-red-400 hover:text-red-300 text-[11px] underline underline-offset-2"
            >
              Sign Out
            </button>
          </div>
        )}

        {/* Role Tab Navigation */}
        <div className="grid grid-cols-3 p-1 rounded-2xl bg-white/5 border border-white/10 mb-6 text-xs font-medium">
          <button
            onClick={() => setActiveTab("barista")}
            className={`py-2 rounded-xl transition-all flex items-center justify-center gap-1.5 ${
              activeTab === "barista"
                ? "bg-[#c49a45] text-black font-semibold shadow-md"
                : "text-white/60 hover:text-white"
            }`}
          >
            <Coffee className="w-3.5 h-3.5" />
            <span>Barista</span>
          </button>
          <button
            onClick={() => setActiveTab("fleet_admin")}
            className={`py-2 rounded-xl transition-all flex items-center justify-center gap-1.5 ${
              activeTab === "fleet_admin"
                ? "bg-[#c49a45] text-black font-semibold shadow-md"
                : "text-white/60 hover:text-white"
            }`}
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Admin</span>
          </button>
          <button
            onClick={() => setActiveTab("customer")}
            className={`py-2 rounded-xl transition-all flex items-center justify-center gap-1.5 ${
              activeTab === "customer"
                ? "bg-[#c49a45] text-black font-semibold shadow-md"
                : "text-white/60 hover:text-white"
            }`}
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>Guest</span>
          </button>
        </div>

        {/* TAB 1: BARISTA PIN KEYPAD */}
        {activeTab === "barista" && (
          <div>
            <div className="text-center mb-5">
              <h2 className="text-lg font-serif font-bold text-white tracking-wide">
                Barista KDS Login
              </h2>
              <p className="text-xs text-white/50 mt-1">
                Enter your shift PIN to unlock live ticket brewing controls
              </p>
            </div>

            <form onSubmit={handlePinSubmit} className="space-y-4">
              <div>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
                  <input
                    type="password"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="Enter Staff PIN (Default: 2026)"
                    className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-center tracking-[0.4em] text-lg font-mono focus:border-[#c49a45] focus:outline-none transition-colors"
                  />
                </div>
                {pinError && (
                  <p className="text-red-400 text-xs mt-1.5 text-center">{pinError}</p>
                )}
              </div>

              {/* Quick Preset Buttons for rapid testing */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPin("2026");
                    handlePinSubmit(undefined, "2026");
                  }}
                  className="flex-1 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-white/80 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3 h-3 text-[#c49a45]" />
                  <span>Preset PIN (2026)</span>
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-[#c49a45] to-[#a37c30] text-black font-bold text-sm tracking-wide hover:brightness-110 active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <span>{loading ? "Authenticating..." : "Unlock Barista KDS"}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          </div>
        )}

        {/* TAB 2: FLEET ADMIN */}
        {activeTab === "fleet_admin" && (
          <div>
            <div className="text-center mb-5">
              <h2 className="text-lg font-serif font-bold text-white tracking-wide">
                Fleet Commander Access
              </h2>
              <p className="text-xs text-white/50 mt-1">
                Authorized management of van tours, telemetry, & schedules
              </p>
            </div>

            <form onSubmit={handlePinSubmit} className="space-y-4">
              <div>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40" />
                  <input
                    type="password"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="Enter Admin PIN (Default: 7788)"
                    className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-center tracking-[0.4em] text-lg font-mono focus:border-[#c49a45] focus:outline-none transition-colors"
                  />
                </div>
                {pinError && (
                  <p className="text-red-400 text-xs mt-1.5 text-center">{pinError}</p>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPin("7788");
                    handlePinSubmit(undefined, "7788");
                  }}
                  className="flex-1 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-white/80 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3 h-3 text-[#c49a45]" />
                  <span>Preset Admin PIN (7788)</span>
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-[#c49a45] to-[#a37c30] text-black font-bold text-sm tracking-wide hover:brightness-110 active:scale-[0.99] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <span>{loading ? "Authenticating..." : "Enter Fleet Portal"}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          </div>
        )}

        {/* TAB 3: CUSTOMER PORTAL */}
        {activeTab === "customer" && (
          <div className="space-y-4">
            <div className="text-center mb-4">
              <h2 className="text-lg font-serif font-bold text-white tracking-wide">
                Sanctuary Member Sign In
              </h2>
              <p className="text-xs text-white/50 mt-1">
                Access order history, live digital buzzers, and exclusive perks
              </p>
            </div>

            {formError && (
              <p className="text-red-400 text-xs text-center">{formError}</p>
            )}

            <form onSubmit={handleCustomerLogin} className="space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:border-[#c49a45] focus:outline-none transition-colors"
              />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm focus:border-[#c49a45] focus:outline-none transition-colors"
              />
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium text-xs transition-colors"
              >
                {loading ? "Signing in..." : "Sign in with Email"}
              </button>
            </form>

            <div className="relative flex py-2 items-center">
              <div className="flex-grow border-t border-white/10"></div>
              <span className="flex-shrink mx-3 text-white/40 text-[10px] uppercase font-bold tracking-wider">
                Or Instant Access
              </span>
              <div className="flex-grow border-t border-white/10"></div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleCustomerGoogle}
                className="py-2.5 px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-white/90 font-medium flex items-center justify-center gap-1.5 transition-colors"
              >
                <span>Google Sign-In</span>
              </button>
              <button
                type="button"
                onClick={handleCustomerDemo}
                className="py-2.5 px-3 rounded-xl bg-[#c49a45]/20 hover:bg-[#c49a45]/30 border border-[#c49a45]/40 text-xs text-[#c49a45] font-semibold flex items-center justify-center gap-1.5 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Guest Pass</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0e0d0c] flex items-center justify-center text-white/40 text-sm">
          Loading authentication gateway...
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
