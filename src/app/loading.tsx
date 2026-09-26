import React from "react";
import { Coffee } from "lucide-react";

export default function Loading() {
  return (
    <div className="fixed inset-0 z-50 bg-[#140D08] flex flex-col items-center justify-center select-none pointer-events-none">
      <div className="relative flex items-center justify-center">
        <div className="w-16 h-16 rounded-full border-2 border-[#DFAB6C]/20 border-t-[#DFAB6C] animate-spin" />
        <Coffee className="w-6 h-6 text-[#DFAB6C] absolute animate-pulse" />
      </div>
      <span className="mt-4 text-xs uppercase tracking-[0.3em] text-[#C88C50] font-semibold animate-pulse">
        BREW
      </span>
    </div>
  );
}
