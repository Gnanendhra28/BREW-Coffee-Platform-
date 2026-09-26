"use client";

import React, { useState, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Coffee,
  Leaf,
  CupSoda,
  Cookie,
  Sparkles,
  Search,
  X,
  Plus,
  Check,
  Star,
  ArrowLeft,
  Flame,
} from "lucide-react";
import confetti from "canvas-confetti";
import { Header } from "@/components/Header";
import { MENU_ITEMS, CATEGORIES, CategoryType, MenuItem } from "@/data/menuData";
import { useCart } from "@/context/CartContext";

export default function MenuPage() {
  const [activeCategory, setActiveCategory] = useState<CategoryType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [addedItemIds, setAddedItemIds] = useState<Record<string, boolean>>({});
  const { addItem, totalItems } = useCart();

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: MENU_ITEMS.length,
      coffee: 0,
      tea: 0,
      shakes: 0,
      desserts: 0,
    };
    MENU_ITEMS.forEach((item) => {
      counts[item.category] = (counts[item.category] || 0) + 1;
    });
    return counts;
  }, []);

  // Filtered items based on category and search query
  const filteredItems = useMemo(() => {
    return MENU_ITEMS.filter((item) => {
      const matchesCategory =
        activeCategory === "all" ? true : item.category === activeCategory;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        q === "" ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        (item.notes && item.notes.some((n) => n.toLowerCase().includes(q)));
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  const handleAddToCart = (item: MenuItem, e: React.MouseEvent) => {
    e.stopPropagation();
    addItem({
      id: item.id,
      name: item.name,
      price: item.price,
      image: item.image,
      category: item.categoryLabel,
    });
    setAddedItemIds((prev) => ({ ...prev, [item.id]: true }));

    // Gentle confetti burst
    confetti({
      particleCount: 25,
      spread: 50,
      origin: { y: 0.8 },
      colors: ["#C88C50", "#DFAB6C", "#F4EFE6"],
    });

    setTimeout(() => {
      setAddedItemIds((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }, 1200);
  };

  const getCategoryIcon = (id: CategoryType) => {
    switch (id) {
      case "coffee":
        return <Coffee className="w-4 h-4" />;
      case "tea":
        return <Leaf className="w-4 h-4" />;
      case "shakes":
        return <CupSoda className="w-4 h-4" />;
      case "desserts":
        return <Cookie className="w-4 h-4" />;
      default:
        return <Sparkles className="w-4 h-4" />;
    }
  };

  return (
    <main className="relative w-full min-h-screen bg-[#1A110B] text-[#F4EFE6] overflow-x-clip flex flex-col justify-start select-none">
      {/* 1. Deep Espresso Brown Radial Gradient Background */}
      <div
        className="fixed inset-0 pointer-events-none -z-20"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 65% 30%, #382012 0%, #1E130D 35%, #140D08 75%, #0B0704 100%)",
        }}
      />

      {/* Warm ambient glows */}
      <div className="fixed top-1/4 right-1/4 w-[600px] h-[600px] bg-[#D48F47]/10 rounded-full blur-[160px] pointer-events-none -z-10" />
      <div className="fixed bottom-1/3 left-10 w-[500px] h-[500px] bg-[#A06030]/10 rounded-full blur-[160px] pointer-events-none -z-10" />

      {/* 2. Top Navigation Bar */}
      <Header />

      {/* 3. Menu Hero Banner */}
      <section className="relative w-full pt-32 sm:pt-36 md:pt-40 pb-10 px-6 sm:px-10 lg:px-16 max-w-[1440px] mx-auto">
        <div className="flex flex-col items-center text-center max-w-2xl mx-auto mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-[#B38353] hover:text-[#DFAB6C] transition-colors mb-4"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Home</span>
          </Link>

          <span className="text-xs uppercase tracking-[0.25em] text-[#C88C50] font-semibold mb-2 flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-[#DFAB6C]" />
            Artisanal Selection
          </span>

          <h1 className="font-serif text-4xl sm:text-5xl lg:text-6xl text-[#F4EFE6] font-normal leading-[1.12] mb-4">
            Our Handcrafted Menu
          </h1>

          <p className="text-sm sm:text-base text-[#8C7C70] max-w-lg leading-relaxed">
            Slow-roasted specialty coffee beans, aromatic imperial teas, luscious handcrafted shakes, and fresh oven-baked desserts.
          </p>

          {/* Search Bar */}
          <div className="relative w-full max-w-md mt-6">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-[#8C7C70]">
              <Search className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search coffee, tea, shake, dessert..."
              className="w-full pl-11 pr-10 py-3 rounded-full bg-[#2A1C14]/70 border border-white/15 text-[#F4EFE6] placeholder-[#7A6A5E] text-xs sm:text-sm focus:outline-none focus:border-[#C88C50] transition-colors backdrop-blur-md shadow-lg"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-4 flex items-center text-[#8C7C70] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Mobile Horizontal Category Pills (Hidden on lg screens) */}
        <div className="lg:hidden flex items-center gap-2 overflow-x-auto pb-4 pt-2 no-scrollbar">
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-300 border cursor-pointer ${
                  isActive
                    ? "bg-[#DFAB6C] text-[#1A110B] border-[#DFAB6C] font-semibold shadow-[0_4px_15px_rgba(223,171,108,0.35)]"
                    : "bg-[#251810]/70 text-[#A8988C] border-white/10 hover:border-white/20 hover:text-white"
                }`}
              >
                {getCategoryIcon(cat.id)}
                <span>{cat.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    isActive ? "bg-[#1A110B]/20 text-[#1A110B]" : "bg-white/10 text-[#8C7C70]"
                  }`}
                >
                  {categoryCounts[cat.id]}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 4. Menu Body: Sticky Sidebar + Products Grid */}
      <section className="relative w-full px-6 sm:px-10 lg:px-16 max-w-[1440px] mx-auto pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Desktop Sticky Side Navigation Bar */}
          <aside className="hidden lg:block lg:col-span-3 sticky top-28 rounded-3xl bg-[#241710]/70 border border-white/10 backdrop-blur-xl p-5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/10">
              <span className="text-xs uppercase tracking-widest text-[#8C7C70] font-semibold">
                Categories
              </span>
              <span className="text-xs text-[#C88C50] font-mono">
                {MENU_ITEMS.length} items
              </span>
            </div>

            <nav className="space-y-1.5">
              {CATEGORIES.map((cat) => {
                const isActive = activeCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setActiveCategory(cat.id)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl text-sm font-medium transition-all duration-300 cursor-pointer ${
                      isActive
                        ? "bg-[#DFAB6C] text-[#1A110B] font-semibold shadow-[0_4px_20px_rgba(223,171,108,0.3)] scale-[1.02]"
                        : "text-[#A8988C] hover:text-[#F4EFE6] hover:bg-white/5"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${
                          isActive
                            ? "bg-[#1A110B]/15 text-[#1A110B]"
                            : "bg-white/5 text-[#C88C50]"
                        }`}
                      >
                        {getCategoryIcon(cat.id)}
                      </div>
                      <span>{cat.label}</span>
                    </div>

                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                        isActive
                          ? "bg-[#1A110B]/20 text-[#1A110B]"
                          : "bg-white/5 text-[#7A6A5E]"
                      }`}
                    >
                      {categoryCounts[cat.id]}
                    </span>
                  </button>
                );
              })}
            </nav>

            {/* Quick Order Promotion Mini Card */}
            <div className="mt-8 p-4 rounded-2xl bg-gradient-to-br from-[#382012] to-[#20130B] border border-white/10 text-center">
              <span className="text-[11px] uppercase tracking-wider text-[#DFAB6C] font-semibold block mb-1">
                Artisanal Guarantee
              </span>
              <p className="text-xs text-[#8C7C70] leading-relaxed mb-3">
                All beans freshly roasted in small batches. Steamed organic milk & single origin beans.
              </p>
              <Link
                href="/cart"
                className="w-full py-2.5 rounded-xl bg-[#DFAB6C] text-[#1A110B] text-xs font-bold hover:bg-white transition-all cursor-pointer text-center block shadow-md"
              >
                View Cart ({totalItems})
              </Link>
            </div>
          </aside>

          {/* Main Products Grid */}
          <div className="lg:col-span-9 w-full">
            {/* Header info bar */}
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="font-serif text-2xl text-[#F4EFE6]">
                  {CATEGORIES.find((c) => c.id === activeCategory)?.label}
                </span>
                <span className="text-xs text-[#8C7C70]">
                  ({filteredItems.length} {filteredItems.length === 1 ? "item" : "items"})
                </span>
              </div>

              {searchQuery && (
                <span className="text-xs text-[#DFAB6C]">
                  Matching &ldquo;{searchQuery}&rdquo;
                </span>
              )}
            </div>

            {filteredItems.length === 0 ? (
              <div className="text-center py-20 bg-[#241710]/40 rounded-3xl border border-white/10">
                <Coffee className="w-12 h-12 text-[#8C7C70] mx-auto mb-3 opacity-50" />
                <h3 className="font-serif text-xl text-[#F4EFE6] mb-1">
                  No items found
                </h3>
                <p className="text-xs text-[#8C7C70] max-w-sm mx-auto mb-4">
                  We couldn&apos;t find anything matching &ldquo;{searchQuery}&rdquo;. Try another term or choose a different category.
                </p>
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setActiveCategory("all");
                  }}
                  className="px-5 py-2 rounded-full border border-white/20 text-xs text-[#F4EFE6] hover:bg-white/10 transition-colors"
                >
                  Clear Filters
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                {filteredItems.map((item) => {
                  const isAdded = addedItemIds[item.id];
                  return (
                    <motion.div
                      layout
                      key={item.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.35 }}
                      className="group relative rounded-3xl bg-[#281A12]/70 hover:bg-[#342217]/90 border border-white/10 hover:border-white/25 backdrop-blur-xl p-5 sm:p-6 transition-all duration-300 shadow-[0_15px_35px_rgba(0,0,0,0.5)] hover:shadow-[0_20px_50px_rgba(0,0,0,0.7)] flex flex-col justify-between"
                    >
                      {/* Top Row: Badge & Rating */}
                      <div className="flex items-center justify-between mb-3 z-10">
                        {item.badge ? (
                          <span className="text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full bg-[#DFAB6C]/15 border border-[#DFAB6C]/30 text-[#DFAB6C]">
                            {item.badge}
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase font-medium tracking-wider text-[#8C7C70]">
                            {item.categoryLabel}
                          </span>
                        )}

                        <div className="flex items-center gap-1 text-[#DFAB6C] text-xs font-semibold">
                          <Star className="w-3.5 h-3.5 fill-[#DFAB6C]" />
                          <span>{item.rating.toFixed(1)}</span>
                          <span className="text-[#7A6A5E] font-normal text-[10px]">
                            ({item.reviewsCount})
                          </span>
                        </div>
                      </div>

                      {/* Center Product Image with Warm Backlight Glow */}
                      <div className="relative w-full h-48 sm:h-52 my-2 flex items-center justify-center overflow-visible">
                        <div className="absolute inset-0 bg-[#C87A38]/10 rounded-full blur-2xl group-hover:bg-[#C87A38]/20 transition-all duration-500 pointer-events-none" />

                        <div className="relative w-full h-full transform group-hover:scale-105 group-hover:-translate-y-1 transition-transform duration-300">
                          <Image
                            src={item.image}
                            alt={item.name}
                            fill
                            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 33vw"
                            className="object-contain filter drop-shadow-[0_15px_25px_rgba(0,0,0,0.75)]"
                            priority={item.id === "c-1" || item.id === "c-3"}
                          />
                        </div>
                      </div>

                      {/* Product Content */}
                      <div className="mt-2">
                        <h3 className="font-serif text-xl sm:text-2xl text-[#F4EFE6] font-normal group-hover:text-white transition-colors mb-1.5">
                          {item.name}
                        </h3>

                        <p className="text-xs text-[#8C7C70] line-clamp-2 leading-relaxed mb-3">
                          {item.description}
                        </p>

                        {/* Flavor notes tags */}
                        {item.notes && item.notes.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mb-4">
                            {item.notes.map((note) => (
                              <span
                                key={note}
                                className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[#C4B4A8]"
                              >
                                {note}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Bottom Row: Volume/Calories, Price & Add Button */}
                        <div className="flex items-center justify-between pt-3 border-t border-white/10">
                          <div>
                            {item.volumeOrCalories && (
                              <span className="text-[10px] text-[#7A6A5E] block font-mono">
                                {item.volumeOrCalories}
                              </span>
                            )}
                            <span className="font-serif text-lg sm:text-xl font-medium text-[#F4EFE6]">
                              ₹{item.price}
                            </span>
                          </div>

                          <button
                            onClick={(e) => handleAddToCart(item, e)}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 shadow-md cursor-pointer ${
                              isAdded
                                ? "bg-emerald-500 text-white scale-110 shadow-emerald-500/30"
                                : "bg-[#DFAB6C] text-[#1A110B] hover:bg-white hover:scale-105 active:scale-95 shadow-[#DFAB6C]/25"
                            }`}
                            aria-label={`Add ${item.name} to cart`}
                          >
                            {isAdded ? (
                              <Check className="w-5 h-5 stroke-[2.5]" />
                            ) : (
                              <Plus className="w-5 h-5 stroke-[2.5]" />
                            )}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

    </main>
  );
}
