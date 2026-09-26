"use client";

import React, { useEffect } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { sentry } from "@/lib/observability/sentry";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    sentry.captureException(error, {
      boundary: "global-error",
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-[#140D08] text-[#F4EFE6] font-sans">
        <main className="min-h-screen flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="max-w-md w-full flex flex-col items-center">
            <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mb-5 text-red-400">
              <AlertCircle className="w-8 h-8" />
            </div>

            <span className="text-xs font-mono uppercase tracking-[0.2em] text-red-400 font-semibold mb-2">
              Critical Exception Captured
            </span>

            <h1 className="font-serif text-3xl sm:text-4xl font-normal text-[#F4EFE6] mb-3">
              Application Error
            </h1>

            <p className="text-xs sm:text-sm text-[#8C7C70] leading-relaxed mb-6">
              Our automated error tracking system (Sentry) has recorded this exception with stack telemetry.
              Please refresh to reload the mobile sanctuary.
            </p>

            <button
              onClick={() => reset()}
              className="py-3 px-6 rounded-full bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Reload Sanctuary Counter</span>
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
