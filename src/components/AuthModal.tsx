"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Mail, Lock, User as UserIcon, AlertCircle, CheckCircle2, ArrowRight, Sparkles } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export const AuthModal: React.FC = () => {
  const {
    authModalOpen,
    closeAuthModal,
    authModalTab,
    setAuthModalTab,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    resetPassword,
    demoSignIn,
    isConfigured,
  } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetFormState = () => {
    setError(null);
    setSuccessMessage(null);
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setDisplayName("");
  };

  const switchTab = (tab: "login" | "signup" | "reset") => {
    resetFormState();
    setAuthModalTab(tab);
  };

  interface ErrorWithCode {
    code?: string;
    message?: string;
  }

  const getFirebaseErrorMessage = (err: unknown): string => {
    const errorObj = err as ErrorWithCode;
    const code = errorObj?.code || errorObj?.message || "";
    switch (code) {
      case "FIREBASE_NOT_CONFIGURED":
        return "Firebase credentials not configured yet. Add keys to .env.local or use Quick Demo Sign In below!";
      case "auth/invalid-email":
        return "Please enter a valid email address.";
      case "auth/user-disabled":
        return "This account has been disabled.";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Invalid email or password. Please try again.";
      case "auth/email-already-in-use":
        return "An account with this email already exists.";
      case "auth/weak-password":
        return "Password must be at least 6 characters long.";
      case "auth/popup-closed-by-user":
        return "Google sign-in popup was closed before completing.";
      case "auth/cancelled-popup-request":
        return "Previous sign-in popup was cancelled.";
      case "auth/network-request-failed":
        return "Network connection issue. Please check your internet.";
      default:
        return errorObj?.message || "An unexpected authentication error occurred.";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (authModalTab === "reset") {
      if (!email || !email.includes("@")) {
        setError("Please enter a valid email to receive reset instructions.");
        return;
      }
      setSubmitting(true);
      try {
        await resetPassword(email);
        setSuccessMessage("Password reset email sent! Please check your inbox.");
      } catch (err: unknown) {
        setError(getFirebaseErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (authModalTab === "signup") {
      if (!displayName.trim()) {
        setError("Please provide your name.");
        return;
      }
      if (!email || !email.includes("@")) {
        setError("Please enter a valid email address.");
        return;
      }
      if (password.length < 6) {
        setError("Password should be at least 6 characters.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      setSubmitting(true);
      try {
        await signUpWithEmail(email, password, displayName.trim());
      } catch (err: unknown) {
        setError(getFirebaseErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Default: login
    if (!email || !password) {
      setError("Please fill in both email and password.");
      return;
    }

    setSubmitting(true);
    try {
      await signInWithEmail(email, password);
    } catch (err: unknown) {
      setError(getFirebaseErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err: unknown) {
      setError(getFirebaseErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDemoSignIn = () => {
    demoSignIn("Elena Vance", "elena.vance@brew.coffee");
  };

  if (!authModalOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={closeAuthModal}
          className="fixed inset-0 bg-black/80 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-md bg-[#24170F]/95 backdrop-blur-2xl rounded-3xl border border-white/10 p-6 sm:p-8 shadow-[0_25px_60px_rgba(0,0,0,0.8)] text-[#F4EFE6] overflow-hidden my-auto"
        >
          {/* Subtle Ambient Glow */}
          <div className="absolute -top-24 -right-24 w-48 h-48 bg-[#DFAB6C]/15 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-[#DFAB6C]/10 rounded-full blur-3xl pointer-events-none" />

          {/* Close Button */}
          <button
            onClick={closeAuthModal}
            aria-label="Close modal"
            className="absolute top-5 right-5 w-8 h-8 rounded-full bg-white/5 hover:bg-white/15 border border-white/10 flex items-center justify-center text-[#8C7C70] hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Logo & Header */}
          <div className="text-center mb-6">
            <span className="text-xl font-extrabold tracking-[0.25em] text-[#DFAB6C] uppercase font-sans">
              BREW
            </span>
            <h2 className="text-2xl font-serif font-medium mt-1 text-white tracking-wide">
              {authModalTab === "login" && "Welcome Back"}
              {authModalTab === "signup" && "Join the Sanctuary"}
              {authModalTab === "reset" && "Reset Password"}
            </h2>
            <p className="text-xs text-[#8C7C70] mt-1 font-sans">
              {authModalTab === "login" && "Sign in to access your orders and member perks"}
              {authModalTab === "signup" && "Create your account for personalized roasts and faster checkout"}
              {authModalTab === "reset" && "Enter your email to receive recovery instructions"}
            </p>
          </div>

          {/* Environment Status Notice */}
          {!isConfigured && (
            <div className="mb-5 p-3 rounded-xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/25 text-[11px] leading-relaxed text-[#F4EFE6]/90 flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-[#DFAB6C] shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-[#DFAB6C]">Firebase Config:</span> To use live Firebase accounts, fill <code className="bg-black/30 px-1 py-0.5 rounded text-[10px]">.env.local</code> with your Firebase project keys.
                </div>
              </div>
              <button
                type="button"
                onClick={handleDemoSignIn}
                className="w-full py-1.5 px-3 rounded-lg bg-[#DFAB6C] text-[#1A110B] font-semibold text-xs hover:bg-white transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>Instant Demo Login (Test Full App)</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Tab Navigation (Login / Signup) */}
          {authModalTab !== "reset" && (
            <div className="flex rounded-xl bg-black/40 p-1 mb-6 border border-white/5">
              <button
                type="button"
                onClick={() => switchTab("login")}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all duration-200 ${
                  authModalTab === "login"
                    ? "bg-[#3D2619] text-[#F4EFE6] shadow-md border border-white/10"
                    : "text-[#8C7C70] hover:text-white"
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => switchTab("signup")}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all duration-200 ${
                  authModalTab === "signup"
                    ? "bg-[#3D2619] text-[#F4EFE6] shadow-md border border-white/10"
                    : "text-[#8C7C70] hover:text-white"
                }`}
              >
                Create Account
              </button>
            </div>
          )}

          {/* Alerts */}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {authModalTab === "signup" && (
              <div>
                <label className="block text-[11px] uppercase tracking-wider font-semibold text-[#8C7C70] mb-1">
                  Full Name
                </label>
                <div className="relative">
                  <UserIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8C7C70]" />
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Jane Doe"
                    className="w-full pl-10 pr-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-[11px] uppercase tracking-wider font-semibold text-[#8C7C70] mb-1">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8C7C70]" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors"
                />
              </div>
            </div>

            {authModalTab !== "reset" && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[11px] uppercase tracking-wider font-semibold text-[#8C7C70]">
                    Password
                  </label>
                  {authModalTab === "login" && (
                    <button
                      type="button"
                      onClick={() => switchTab("reset")}
                      className="text-[11px] text-[#DFAB6C] hover:underline"
                    >
                      Forgot?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8C7C70]" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-10 pr-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors"
                  />
                </div>
              </div>
            )}

            {authModalTab === "signup" && (
              <div>
                <label className="block text-[11px] uppercase tracking-wider font-semibold text-[#8C7C70] mb-1">
                  Confirm Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8C7C70]" />
                  <input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-10 pr-4 py-2.5 bg-black/40 rounded-xl border border-white/10 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-4 bg-[#F4EFE6] text-[#1A110B] font-bold rounded-xl text-sm hover:bg-white hover:shadow-[0_0_20px_rgba(244,239,230,0.3)] transition-all duration-300 disabled:opacity-50 mt-4 cursor-pointer"
            >
              {submitting ? (
                <div className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-[#1A110B] border-t-transparent rounded-full animate-spin" />
                  <span>Processing...</span>
                </div>
              ) : (
                <span>
                  {authModalTab === "login" && "Sign In with Email"}
                  {authModalTab === "signup" && "Create Account"}
                  {authModalTab === "reset" && "Send Reset Link"}
                </span>
              )}
            </button>
          </form>

          {/* Social Auth Divider */}
          {authModalTab !== "reset" && (
            <>
              <div className="relative my-5 flex items-center justify-center">
                <div className="border-t border-white/10 w-full" />
                <span className="bg-[#24170F] px-3 text-[10px] uppercase tracking-widest text-[#8C7C70] absolute">
                  or continue with
                </span>
              </div>

              {/* Google Sign In Button */}
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={submitting}
                className="w-full py-2.5 px-4 bg-black/30 hover:bg-black/50 border border-white/10 rounded-xl text-xs font-semibold text-white flex items-center justify-center gap-3 transition-colors duration-200 cursor-pointer disabled:opacity-50"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.16 0 9.97 0 12s.45 3.84 1.25 5.42l4.03-3.15z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                  />
                </svg>
                <span>Continue with Google</span>
              </button>
            </>
          )}

          {/* Reset Tab Back Link */}
          {authModalTab === "reset" && (
            <div className="mt-5 text-center">
              <button
                type="button"
                onClick={() => switchTab("login")}
                className="text-xs text-[#DFAB6C] hover:underline"
              >
                Back to Sign In
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
