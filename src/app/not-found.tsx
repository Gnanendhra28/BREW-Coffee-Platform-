import React from "react";
import Link from "next/link";
import { Coffee, ArrowLeft, Navigation, BookOpen } from "lucide-react";

export default function NotFound() {
  return (
    <main className="relative min-h-screen bg-[#140D08] text-[#F4EFE6] flex flex-col items-center justify-center p-6 sm:p-10 select-none">
      {/* Background ambient lighting */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-[#C87A38]/15 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 max-w-md w-full text-center flex flex-col items-center">
        {/* Emblem */}
        <div className="w-20 h-20 rounded-full bg-[#2A1C14] border border-[#DFAB6C]/30 flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(223,171,108,0.2)]">
          <Coffee className="w-9 h-9 text-[#DFAB6C]" />
        </div>

        <span className="text-xs font-mono uppercase tracking-[0.3em] text-[#C88C50] font-semibold mb-2">
          Error 404 • Cup Spilled
        </span>

        <h1 className="font-serif text-4xl sm:text-5xl font-normal text-[#F4EFE6] mb-3">
          Lost Your Brew?
        </h1>

        <p className="text-sm text-[#8C7C70] leading-relaxed mb-8">
          The page or blend you are seeking seems to have evaporated. Our mobile espresso van might be stationed elsewhere.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-3 w-full">
          <Link
            href="/menu"
            className="w-full sm:w-1/2 py-3.5 px-5 rounded-full bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer"
          >
            <BookOpen className="w-4 h-4" />
            <span>Explore Menu</span>
          </Link>

          <Link
            href="/location"
            className="w-full sm:w-1/2 py-3.5 px-5 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-white font-medium text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <Navigation className="w-4 h-4 text-[#DFAB6C]" />
            <span>Locate Van</span>
          </Link>
        </div>

        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-1.5 text-xs text-[#8C7C70] hover:text-[#DFAB6C] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Return to Homepage</span>
        </Link>
      </div>
    </main>
  );
}
