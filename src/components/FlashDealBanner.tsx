"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import { useVan } from "@/context/VanContext";
import { useCart } from "@/context/CartContext";
import { Zap, X, Check, ShoppingBag } from "lucide-react";

export const FlashDealBanner: React.FC = () => {
  const pathname = usePathname();
  const { flashDeal } = useVan();
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  // Hide on barista operations page or if not active / dismissed
  if (pathname.startsWith("/barista") || !flashDeal.isActive || isDismissed) {
    return null;
  }

  const handleClaimDeal = () => {
    addItem({
      id: flashDeal.id || "deal-pair-bundle",
      name: `${flashDeal.beverageName} + ${flashDeal.pastryName} [Flash Bundle]`,
      price: flashDeal.dealPrice,
      image: "/assets/cup1.webp",
      category: "Flash Special",
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 2500);
  };

  return (
    <aside
      aria-label="Flash Deal Announcement"
      className="relative z-40 bg-gradient-to-r from-amber-700 via-amber-600 to-amber-800 text-amber-50 px-4 py-2.5 shadow-lg border-b border-amber-500/30 transition-all duration-300"
    >
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
        {/* Left: Tag + Headline */}
        <div className="flex items-center gap-2.5 flex-1 min-w-[280px]">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/25 text-amber-200 font-bold uppercase tracking-wider text-[10px] border border-amber-300/30 animate-pulse">
            <Zap className="w-3 h-3 text-amber-300 fill-amber-300" />
            <span>Flash Deal · {flashDeal.discountPercent}% OFF</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 font-medium text-white">
            <span className="font-semibold">{flashDeal.title}</span>
            <span className="hidden md:inline text-amber-200/80">•</span>
            <span className="text-amber-100 text-[11px] sm:text-xs">
              {flashDeal.tagline}
            </span>
          </div>
        </div>

        {/* Right: Price, Claim Button, Dismiss */}
        <div className="flex items-center gap-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-amber-200/70 line-through text-xs font-normal">
              ₹{flashDeal.originalPrice}
            </span>
            <span className="text-white font-bold text-sm sm:text-base tracking-tight">
              ₹{flashDeal.dealPrice}
            </span>
          </div>

          <button
            onClick={handleClaimDeal}
            disabled={added}
            className={`px-3 py-1 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm ${
              added
                ? "bg-emerald-600 text-white cursor-default"
                : "bg-white text-stone-900 hover:bg-amber-100 active:scale-95"
            }`}
          >
            {added ? (
              <>
                <Check className="w-3.5 h-3.5 text-white" />
                <span>Added to Cart!</span>
              </>
            ) : (
              <>
                <ShoppingBag className="w-3.5 h-3.5 text-amber-800" />
                <span>Claim Bundle</span>
              </>
            )}
          </button>

          <button
            onClick={() => setIsDismissed(true)}
            title="Dismiss deal"
            className="text-amber-200/80 hover:text-white p-1 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
};
