"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Star,
  Coffee,
  MapPin,
  CheckCircle2,
  ThumbsUp,
  Tv,
  MessageSquarePlus,
  ArrowRight,
  Clock,
  Sparkles,
  Search,
  X,
  Copy,
  Check,
  Gift,
  HeartHandshake,
} from "lucide-react";
import { Header } from "@/components/Header";
import { useAuth } from "@/context/AuthContext";
import { useVan } from "@/context/VanContext";
import {
  analyzeReviewSentiment,
  ReviewRecoveryNotice,
} from "@/lib/smartAgentsEngine";

interface ReviewItem {
  id: string;
  name: string;
  rating: number;
  date: string;
  location: string;
  item: string;
  comment: string;
  helpfulCount: number;
  isVerified: boolean;
}

const INITIAL_REVIEWS: ReviewItem[] = [
  {
    id: "rev-1",
    name: "Arjun Reddy",
    rating: 5,
    date: "Today",
    location: "HITEC City — Cyber Towers, Hyderabad",
    item: "Single-Origin Cappuccino",
    comment:
      "The mobile van concept outside Mindspace is a lifesaver before morning standup! Velvety microfoam and the single-origin espresso has genuine fruity undertones. Scanned the board QR and got my cup in 3 minutes.",
    helpfulCount: 24,
    isVerified: true,
  },
  {
    id: "rev-2",
    name: "Sravani Rao",
    rating: 5,
    date: "Yesterday",
    location: "RK Beach Promenade, Visakhapatnam",
    item: "Artisanal Cold Brew",
    comment:
      "Hands down the smoothest cold brew in Vizag. Enjoying this chilled dark roast with the sea breeze during a morning walk was unbeatable. Super clean van setup and friendly baristas!",
    helpfulCount: 19,
    isVerified: true,
  },
  {
    id: "rev-3",
    name: "Karthik Varma",
    rating: 5,
    date: "2 days ago",
    location: "Benz Circle, Vijayawada",
    item: "Cinnamon Roll & Filter Coffee",
    comment:
      "Freshly warmed cinnamon roll that practically melts in your mouth paired with rich South Indian filter coffee. The digital buzzer on my phone vibrated right when the order was ready at the window!",
    helpfulCount: 15,
    isVerified: true,
  },
  {
    id: "rev-4",
    name: "Pooja Sharma",
    rating: 4,
    date: "3 days ago",
    location: "Financial District — Waverock, Hyderabad",
    item: "Caramel Macchiato",
    comment:
      "Really rich caramel drizzle and perfectly balanced espresso shot. Peak lunchtime queue was a bit busy, but tracking my ticket on the outdoor board made waiting totally stress-free.",
    helpfulCount: 8,
    isVerified: true,
  },
  {
    id: "rev-5",
    name: "Vikram Naidu",
    rating: 5,
    date: "4 days ago",
    location: "Siripuram Hub, Visakhapatnam",
    item: "Double Espresso",
    comment:
      "Golden crema, intense hazelnut notes, zero bitterness. These guys know how to calibrate an espresso machine on wheels. Highly recommended for true coffee nerds!",
    helpfulCount: 12,
    isVerified: true,
  },
  {
    id: "rev-6",
    name: "Divya Teja",
    rating: 5,
    date: "5 days ago",
    location: "Jubilee Hills Road No. 36, Hyderabad",
    item: "Belgian Dark Chocolate Shake",
    comment:
      "Thick, decadent, and made with authentic single-origin dark cocoa. Not overly sweet like standard commercial shakes. 10/10 curbside pickup experience.",
    helpfulCount: 11,
    isVerified: true,
  },
];

const POPULAR_ITEMS = [
  "Single-Origin Cappuccino",
  "Artisanal Cold Brew",
  "Caramel Macchiato",
  "Classic Filter Coffee",
  "Double Espresso",
  "Vanilla Latte",
  "Belgian Dark Chocolate Shake",
  "Cinnamon Roll",
  "Blueberry Crumble Muffin",
];

const VAN_LOCATIONS = [
  "HITEC City — Cyber Towers (Hyderabad)",
  "Financial District — Waverock (Hyderabad)",
  "Jubilee Hills Road No. 36 (Hyderabad)",
  "RK Beach Promenade (Visakhapatnam)",
  "Siripuram Campus Hub (Visakhapatnam)",
  "Benz Circle & MG Road (Vijayawada)",
  "Necklace Road Waterfront (Hyderabad)",
];

export default function ReviewsPage() {
  const { user } = useAuth();
  const {
    orders,
    nowServingOrders,
    brewingOrders,
    estimatedWaitMinutes,
    vanLocation,
  } = useVan();

  const [reviews, setReviews] = useState<ReviewItem[]>(INITIAL_REVIEWS);
  const [selectedFilter, setSelectedFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [votedIds, setVotedIds] = useState<Record<string, boolean>>({});

  // Review Form State
  const [authorName, setAuthorName] = useState("");
  const [rating, setRating] = useState(5);
  const [hoverRating, setHoverRating] = useState(0);
  const [selectedItem, setSelectedItem] = useState(POPULAR_ITEMS[0]);
  const [selectedLocation, setSelectedLocation] = useState(VAN_LOCATIONS[0]);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submittedSuccess, setSubmittedSuccess] = useState(false);
  const [sentimentNotice, setSentimentNotice] = useState<ReviewRecoveryNotice | null>(null);
  const [copiedVoucher, setCopiedVoucher] = useState(false);

  // Match orders by authorName (case-insensitive and partial match)
  const matchedOrders = React.useMemo(() => {
    const query = authorName.trim().toLowerCase();
    if (!query || query.length < 2) return [];
    return orders.filter((o) => {
      const cName = (o.customerName || "").trim().toLowerCase();
      return cName === query || cName.includes(query) || query.includes(cName);
    });
  }, [authorName, orders]);

  // Unique ordered items for matched customer (most recent first)
  const orderedItemsList = React.useMemo(() => {
    if (matchedOrders.length === 0) return [];
    const items: string[] = [];
    matchedOrders
      .slice()
      .reverse()
      .forEach((o) => {
        o.items.forEach((it) => {
          if (it.name && !items.includes(it.name)) {
            items.push(it.name);
          }
        });
      });
    return items;
  }, [matchedOrders]);

  // Unique van locations where customer ordered
  const orderedLocationsList = React.useMemo(() => {
    if (matchedOrders.length === 0) return [];
    const locs: string[] = [];
    matchedOrders
      .slice()
      .reverse()
      .forEach((o) => {
        const loc = o.vanLocationName || vanLocation?.spotName;
        if (loc && !locs.includes(loc)) {
          locs.push(loc);
        }
      });
    return locs;
  }, [matchedOrders, vanLocation]);

  // Keep track of previously matched customer query so we don't clobber manual selection
  const lastCustomerRef = React.useRef("");

  useEffect(() => {
    const query = authorName.trim().toLowerCase();
    if (matchedOrders.length > 0 && query !== lastCustomerRef.current) {
      lastCustomerRef.current = query;
      queueMicrotask(() => {
        if (orderedItemsList.length > 0) {
          setSelectedItem(orderedItemsList[0]);
        }
        if (orderedLocationsList.length > 0) {
          setSelectedLocation(orderedLocationsList[0]);
        }
      });
    } else if (matchedOrders.length === 0 && lastCustomerRef.current) {
      lastCustomerRef.current = "";
    }
  }, [authorName, matchedOrders, orderedItemsList, orderedLocationsList]);

  // Load reviews and votes from localStorage on mount
  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        try {
          const stored = localStorage.getItem("brew_customer_reviews_v2");
          if (stored) {
            setReviews(JSON.parse(stored));
          }
        } catch {}

        try {
          const storedVotes = localStorage.getItem("brew_review_votes_v2");
          if (storedVotes) {
            setVotedIds(JSON.parse(storedVotes));
          }
        } catch {}
      }
    });
  }, []);

  // Handle Review Submission
  const handleSubmitReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;

    setSubmitting(true);

    setTimeout(() => {
      const newReview: ReviewItem = {
        id: `rev-${Date.now()}`,
        name: authorName.trim() || user?.displayName || "Artisan Coffee Guest",
        rating,
        date: "Just now",
        location: selectedLocation,
        item: selectedItem,
        comment: comment.trim(),
        helpfulCount: 0,
        isVerified: true,
      };

      const updated = [newReview, ...reviews];
      setReviews(updated);

      try {
        localStorage.setItem(
          "brew_customer_reviews_v2",
          JSON.stringify(updated),
        );
      } catch {}

      // Activate Agent #6: Guest Sentiment Guardian if review is <= 3 stars
      if (rating <= 3) {
        const recovery = analyzeReviewSentiment({
          name: newReview.name,
          rating: newReview.rating,
          comment: newReview.comment,
        });
        if (recovery) {
          setSentimentNotice(recovery);
        }
      }

      setSubmitting(false);
      setSubmittedSuccess(true);
      setAuthorName("");
      setComment("");

      setTimeout(() => {
        setSubmittedSuccess(false);
        setIsFormOpen(false);
      }, rating <= 3 ? 500 : 2500);
    }, 600);
  };

  // Upvote a review
  const handleHelpful = (id: string) => {
    if (votedIds[id]) return;

    const nextVotes = { ...votedIds, [id]: true };
    setVotedIds(nextVotes);
    try {
      localStorage.setItem("brew_review_votes_v2", JSON.stringify(nextVotes));
    } catch {}

    const updated = reviews.map((r) =>
      r.id === id ? { ...r, helpfulCount: r.helpfulCount + 1 } : r,
    );
    setReviews(updated);
    try {
      localStorage.setItem("brew_customer_reviews_v2", JSON.stringify(updated));
    } catch {}
  };

  // Filter reviews
  const filteredReviews = reviews.filter((r) => {
    if (selectedFilter === "5star" && r.rating !== 5) return false;
    if (selectedFilter === "telangana" && !r.location.includes("Hyderabad"))
      return false;
    if (
      selectedFilter === "andhra" &&
      !r.location.includes("Visakhapatnam") &&
      !r.location.includes("Vijayawada")
    )
      return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        r.comment.toLowerCase().includes(q) ||
        r.item.toLowerCase().includes(q) ||
        r.location.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const avgRating = (
    reviews.reduce((s, r) => s + r.rating, 0) / (reviews.length || 1)
  ).toFixed(1);

  const starDescriptions: Record<number, string> = {
    1: "Needs Polish ☕",
    2: "Fair Taste",
    3: "Good Cup",
    4: "Great Blend!",
    5: "Exceptional Artisanal Brew! ☕✨",
  };

  return (
    <div className="relative min-h-screen bg-[#140D08] text-[#F4EFE6] select-none">
      {/* Background Gradients */}
      <div
        className="fixed inset-0 pointer-events-none -z-10"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 50% 15%, #2D1A10 0%, #170E08 45%, #0F0905 100%)",
        }}
      />
      <div className="fixed top-1/4 right-10 w-96 h-96 bg-[#DFAB6C]/10 rounded-full blur-3xl pointer-events-none -z-10" />
      <div className="fixed bottom-1/4 left-10 w-96 h-96 bg-[#3D2619]/30 rounded-full blur-3xl pointer-events-none -z-10" />

      {/* Top Header */}
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-32 pb-24">
        {/* Page Hero */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#3D2619]/60 border border-[#DFAB6C]/30 text-[#DFAB6C] text-xs font-semibold uppercase tracking-widest mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Community Ratings & Feedback</span>
          </div>

          <h1 className="text-3xl sm:text-5xl font-serif font-bold text-white tracking-tight">
            Real Sips & Honest Reviews
          </h1>
          <p className="text-sm sm:text-base text-[#8C7C70] mt-3 leading-relaxed">
            Every handcrafted roast, milk foam layer, and warm dessert reviewed
            by our patrons across Telangana & Andhra Pradesh visiting our outlet
            on wheels.
          </p>
        </div>

        {/* Rating Overview & Metric Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 mb-12">
          {/* Overall Score */}
          <div className="p-6 rounded-3xl bg-[#22160F]/90 border border-white/10 backdrop-blur-md flex items-center justify-between shadow-xl">
            <div>
              <p className="text-xs uppercase font-bold tracking-wider text-[#8C7C70]">
                Overall Community Score
              </p>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-4xl font-bold font-serif text-white">
                  {avgRating}
                </span>
                <span className="text-sm text-[#8C7C70] font-mono">/ 5.0</span>
              </div>
              <div className="flex items-center gap-1 text-[#DFAB6C] mt-1.5">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star key={s} className="w-4 h-4 fill-[#DFAB6C]" />
                ))}
              </div>
            </div>
            <div className="text-right">
              <span className="text-xs font-mono text-emerald-400 font-bold bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                98% Loved
              </span>
              <p className="text-[11px] text-[#8C7C70] mt-1.5">
                {reviews.length} Verified Patron Reviews
              </p>
            </div>
          </div>

          {/* Speed & Service */}
          <div className="p-6 rounded-3xl bg-[#22160F]/90 border border-white/10 backdrop-blur-md flex items-center justify-between shadow-xl">
            <div>
              <p className="text-xs uppercase font-bold tracking-wider text-[#8C7C70]">
                Curbside Van Speed
              </p>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-4xl font-bold font-serif text-[#DFAB6C]">
                  ~3.2
                </span>
                <span className="text-sm text-[#8C7C70]">mins</span>
              </div>
              <p className="text-xs text-[#C4B4A8] mt-1.5 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-[#DFAB6C]" />
                Average pickup window time
              </p>
            </div>
            <div className="w-12 h-12 rounded-2xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/20 flex items-center justify-center text-xl">
              ⚡
            </div>
          </div>

          {/* Action: Write a review CTA */}
          <div className="p-6 rounded-3xl bg-gradient-to-br from-[#3D2619] to-[#24170F] border border-[#DFAB6C]/40 flex flex-col justify-between shadow-xl">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-wider text-[#DFAB6C]">
                Had a sip recently?
              </span>
              <h3 className="text-lg font-bold text-white mt-0.5">
                Share Your Experience
              </h3>
              <p className="text-xs text-[#C4B4A8] mt-1">
                Help fellow coffee enthusiasts discover their next favorite
                blend.
              </p>
            </div>
            <button
              onClick={() => setIsFormOpen(!isFormOpen)}
              className="mt-4 w-full py-2.5 px-4 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg"
            >
              <MessageSquarePlus className="w-4 h-4" />
              <span>{isFormOpen ? "Close Review Form" : "Write a Review"}</span>
            </button>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* PROMINENT LIVE OUTLET BOARD SECTION (Directs to /board)                   */}
        {/* ========================================================================= */}
        <div className="mb-14 rounded-3xl p-6 sm:p-8 bg-gradient-to-r from-[#24170F] via-[#352014] to-[#24170F] border border-[#DFAB6C]/40 shadow-2xl relative overflow-hidden">
          {/* Ambient Glow */}
          <div className="absolute top-0 right-0 w-80 h-80 bg-[#DFAB6C]/15 rounded-full blur-3xl pointer-events-none" />

          <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#DFAB6C]/15 border border-[#DFAB6C]/30 text-[#DFAB6C] text-[11px] font-bold tracking-wider uppercase mb-2.5">
                <Tv className="w-3.5 h-3.5" />
                <span>Outlet On Wheels • Live Outdoor Board</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-serif font-bold text-white">
                Watching For Your Coffee? Track the Live Board
              </h2>
              <p className="text-xs sm:text-sm text-[#C4B4A8] mt-2 leading-relaxed">
                When you order at our van or from your phone, your ticket number
                updates in real-time on the outdoor display. See who is
                currently brewing, orders ready at the pickup window, and
                zero-contact scannable QR codes.
              </p>

              {/* Live Status Indicators */}
              <div className="flex flex-wrap items-center gap-4 mt-4 text-xs font-mono">
                <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-emerald-500/30">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-emerald-400 font-bold">
                    Now Serving:{" "}
                    {nowServingOrders.length > 0
                      ? nowServingOrders
                          .map((o) => `#${o.orderNumber}`)
                          .join(", ")
                      : "Next order ready shortly"}
                  </span>
                </div>
                <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-[#DFAB6C]/30 text-[#DFAB6C]">
                  <span>
                    🔥 In Queue: {brewingOrders.length} order
                    {brewingOrders.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/10 text-[#8C7C70]">
                  <span>⏱️ Wait Time: ~{estimatedWaitMinutes}m</span>
                </div>
              </div>
            </div>

            {/* Direct Link Button to http://localhost:3000/board */}
            <div className="flex flex-col sm:flex-row lg:flex-col gap-3 w-full lg:w-auto">
              <Link
                href="/board"
                className="py-3 px-6 rounded-2xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] text-sm font-bold text-center transition-all flex items-center justify-center gap-2 shadow-xl hover:shadow-[0_0_20px_rgba(223,171,108,0.4)] cursor-pointer"
              >
                <Tv className="w-4 h-4" />
                <span>Open Live Outlet Board</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>

        {/* AGENT #6: GUEST SENTIMENT GUARDIAN RECOVERY CARD */}
        <AnimatePresence>
          {sentimentNotice && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mb-10 p-6 sm:p-8 rounded-3xl bg-gradient-to-br from-[#2D1B13] via-[#24150E] to-[#170E08] border-2 border-amber-500/50 shadow-2xl relative overflow-hidden"
            >
              <div className="flex items-center justify-between pb-4 mb-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center justify-center">
                    <HeartHandshake className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                      <span>BREW Guest Care &amp; Service Recovery</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono font-bold uppercase">
                        AI Guardian
                      </span>
                    </h3>
                    <p className="text-xs text-[#8C7C70]">
                      We noticed your visit did not meet perfection. Our Head Barista sends this personal resolution.
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setSentimentNotice(null)}
                  className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-[#8C7C70] hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-4 rounded-2xl bg-black/40 border border-white/5 space-y-3 mb-5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[#8C7C70]">Detected Service Area:</span>
                  {sentimentNotice.detectedIssues.map((issue, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-200 border border-amber-500/25 font-medium text-[11px]"
                    >
                      {issue}
                    </span>
                  ))}
                </div>

                <p className="text-xs sm:text-sm text-[#EDE4DA] leading-relaxed whitespace-pre-line italic">
                  &ldquo;{sentimentNotice.managerApologyText}&rdquo;
                </p>
              </div>

              {/* Recovery Voucher Box */}
              <div className="p-4 rounded-2xl bg-gradient-to-r from-amber-600/20 via-amber-500/10 to-amber-700/20 border border-amber-500/30 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center">
                    <Gift className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="text-xs text-amber-200 font-bold uppercase tracking-wider block">
                      Instant ₹{sentimentNotice.discountAmount} Courtesy Credit
                    </span>
                    <span className="text-[11px] text-[#C4B4A8]">
                      Valid for any artisanal coffee, tea, shake, or bakery roll
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="px-3.5 py-1.5 rounded-xl bg-black/60 border border-amber-400/40 text-amber-300 font-mono font-bold text-sm tracking-wider">
                    {sentimentNotice.voucherCode}
                  </div>
                  <button
                    onClick={() => {
                      if (typeof navigator !== "undefined" && navigator.clipboard) {
                        navigator.clipboard.writeText(sentimentNotice.voucherCode);
                        setCopiedVoucher(true);
                        setTimeout(() => setCopiedVoucher(false), 2000);
                      }
                    }}
                    className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-stone-950 font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-md"
                  >
                    {copiedVoucher ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Code</span>
                      </>
                    )}
                  </button>
                  <Link
                    href="/menu"
                    className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-semibold text-xs transition-colors"
                  >
                    Use at Menu
                  </Link>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Interactive "Write a Review" Expandable Card */}
        <AnimatePresence>
          {isFormOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-14 overflow-hidden"
            >
              <div className="p-6 sm:p-8 rounded-3xl bg-[#22160F] border-2 border-[#DFAB6C]/40 shadow-2xl">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/10">
                  <div>
                    <h3 className="text-xl font-serif font-bold text-white">
                      Write Your Review
                    </h3>
                    <p className="text-xs text-[#8C7C70] mt-0.5">
                      Your feedback will appear immediately for fellow coffee
                      lovers
                    </p>
                  </div>
                  <span className="text-xs text-[#DFAB6C] font-semibold bg-[#DFAB6C]/10 px-3 py-1 rounded-full border border-[#DFAB6C]/20">
                    Verified Van Order
                  </span>
                </div>

                {submittedSuccess ? (
                  <div className="py-8 text-center space-y-3">
                    <div className="w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto text-2xl">
                      ✓
                    </div>
                    <h4 className="text-lg font-bold text-white">
                      Thank You for Your Review!
                    </h4>
                    <p className="text-xs text-[#C4B4A8]">
                      Your review and rating have been published to the
                      community feed.
                    </p>
                  </div>
                ) : (
                  <form onSubmit={handleSubmitReview} className="space-y-6">
                    {/* Star Rating Selector */}
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-[#C4B4A8] mb-2">
                        Your Rating *
                      </label>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          {[1, 2, 3, 4, 5].map((starValue) => {
                            const isFilled =
                              hoverRating >= starValue ||
                              (!hoverRating && rating >= starValue);
                            return (
                              <button
                                type="button"
                                key={starValue}
                                onClick={() => setRating(starValue)}
                                onMouseEnter={() => setHoverRating(starValue)}
                                onMouseLeave={() => setHoverRating(0)}
                                className="p-1 text-2xl transition-transform hover:scale-125 focus:outline-none cursor-pointer"
                                aria-label={`Rate ${starValue} stars`}
                              >
                                <Star
                                  className={`w-7 h-7 transition-colors ${
                                    isFilled
                                      ? "text-[#DFAB6C] fill-[#DFAB6C] drop-shadow-[0_0_8px_rgba(223,171,108,0.5)]"
                                      : "text-[#8C7C70]/40"
                                  }`}
                                />
                              </button>
                            );
                          })}
                        </div>
                        <span className="text-xs font-semibold text-[#DFAB6C] font-mono">
                          {starDescriptions[hoverRating || rating]}
                        </span>
                      </div>
                    </div>

                    {/* Name Input & Order Match Status */}
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-[#C4B4A8] mb-1.5">
                        Your Name *
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={authorName}
                          onChange={(e) => setAuthorName(e.target.value)}
                          placeholder="Enter the name on your order"
                          className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-2.5 pr-9 text-xs text-white placeholder:text-[#8C7C70] focus:outline-none focus:border-[#DFAB6C]"
                        />
                        {authorName && (
                          <button
                            type="button"
                            onClick={() => setAuthorName("")}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8C7C70] hover:text-white p-1 rounded-md transition-colors cursor-pointer"
                            title="Clear name"
                            aria-label="Clear name"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Dynamic Order Verification State */}
                      {matchedOrders.length > 0 ? (
                        <div className="mt-2.5 p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-start gap-2.5 animate-in fade-in duration-200">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          <div className="text-xs">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-emerald-300">
                                Verified Order Found ({matchedOrders.length}{" "}
                                order{matchedOrders.length > 1 ? "s" : ""})
                              </span>
                              <span className="font-mono text-[10px] bg-emerald-500/20 text-emerald-200 px-2 py-0.5 rounded-full">
                                Token #
                                {
                                  matchedOrders[matchedOrders.length - 1]
                                    .orderNumber
                                }
                              </span>
                            </div>
                            <p className="text-[11px] text-[#C4B4A8] mt-1 leading-relaxed">
                              Your ordered items (
                              <strong className="text-emerald-300">
                                {orderedItemsList.slice(0, 3).join(", ")}
                              </strong>
                              ) and van location have been auto-selected below.
                            </p>
                          </div>
                        </div>
                      ) : authorName.trim().length >= 2 ? (
                        <p className="text-[11px] text-[#8C7C70] mt-1.5 flex items-center gap-1">
                          <span>
                            ℹ️ No order history found under &quot;
                            {authorName.trim()}&quot;. Showing full standard
                            menu & outlet locations.
                          </span>
                        </p>
                      ) : (
                        <p className="text-[11px] text-[#8C7C70] mt-1.5">
                          💡 Type your name to automatically match your ordered
                          items and visited van stop!
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* Item Ordered */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block text-xs font-bold uppercase tracking-wider text-[#C4B4A8]">
                            Item You Enjoyed
                          </label>
                          {orderedItemsList.length > 0 && (
                            <span className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                              <Sparkles className="w-3 h-3" /> From your order
                            </span>
                          )}
                        </div>
                        <select
                          value={selectedItem}
                          onChange={(e) => setSelectedItem(e.target.value)}
                          className="w-full bg-[#1A110B] border border-white/15 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-[#DFAB6C] cursor-pointer"
                        >
                          {orderedItemsList.length > 0 ? (
                            <>
                              <optgroup label="✨ From Your Orders">
                                {orderedItemsList.map((it) => (
                                  <option
                                    key={`ord-item-${it}`}
                                    value={it}
                                    className="bg-[#1A110B] text-emerald-300"
                                  >
                                    {it}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Other Menu Favorites">
                                {POPULAR_ITEMS.filter(
                                  (it) => !orderedItemsList.includes(it),
                                ).map((it) => (
                                  <option
                                    key={`all-item-${it}`}
                                    value={it}
                                    className="bg-[#1A110B] text-white"
                                  >
                                    {it}
                                  </option>
                                ))}
                              </optgroup>
                            </>
                          ) : (
                            POPULAR_ITEMS.map((it) => (
                              <option
                                key={it}
                                value={it}
                                className="bg-[#1A110B] text-white"
                              >
                                {it}
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      {/* Van Location Visited */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block text-xs font-bold uppercase tracking-wider text-[#C4B4A8]">
                            Van Location Visited
                          </label>
                          {orderedLocationsList.length > 0 && (
                            <span className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                              <MapPin className="w-3 h-3" /> Your van stop
                            </span>
                          )}
                        </div>
                        <select
                          value={selectedLocation}
                          onChange={(e) => setSelectedLocation(e.target.value)}
                          className="w-full bg-[#1A110B] border border-white/15 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-[#DFAB6C] cursor-pointer"
                        >
                          {orderedLocationsList.length > 0 ? (
                            <>
                              <optgroup label="📍 Where You Placed Your Order">
                                {orderedLocationsList.map((loc) => (
                                  <option
                                    key={`ord-loc-${loc}`}
                                    value={loc}
                                    className="bg-[#1A110B] text-emerald-300"
                                  >
                                    {loc}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="All Other Outlets">
                                {VAN_LOCATIONS.filter(
                                  (loc) => !orderedLocationsList.includes(loc),
                                ).map((loc) => (
                                  <option
                                    key={`all-loc-${loc}`}
                                    value={loc}
                                    className="bg-[#1A110B] text-white"
                                  >
                                    {loc}
                                  </option>
                                ))}
                              </optgroup>
                            </>
                          ) : (
                            VAN_LOCATIONS.map((loc) => (
                              <option
                                key={loc}
                                value={loc}
                                className="bg-[#1A110B] text-white"
                              >
                                {loc}
                              </option>
                            ))
                          )}
                        </select>
                      </div>
                    </div>

                    {/* Review Comments */}
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-[#C4B4A8] mb-1.5">
                        Your Review Comments *
                      </label>
                      <textarea
                        rows={4}
                        required
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="How was the flavor, milk texture, and curbside service? Share details for fellow coffee enthusiasts..."
                        className="w-full bg-white/5 border border-white/15 rounded-xl p-4 text-xs text-white placeholder:text-[#8C7C70] focus:outline-none focus:border-[#DFAB6C] leading-relaxed"
                      />
                    </div>

                    {/* Submit Button */}
                    <div className="flex items-center justify-end gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setIsFormOpen(false)}
                        className="px-5 py-2.5 rounded-xl text-xs font-medium text-[#8C7C70] hover:text-white transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting || !comment.trim()}
                        className="px-7 py-2.5 rounded-xl bg-[#DFAB6C] disabled:opacity-40 hover:bg-white text-[#1A110B] text-xs font-bold transition-all shadow-lg flex items-center gap-2 cursor-pointer"
                      >
                        {submitting ? (
                          <>
                            <span className="w-3.5 h-3.5 border-2 border-[#1A110B] border-t-transparent rounded-full animate-spin" />
                            <span>Posting Review...</span>
                          </>
                        ) : (
                          <>
                            <span>Publish Review</span>
                            <Sparkles className="w-3.5 h-3.5" />
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Reviews Feed Controls (Filter Pills + Search) */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-8">
          {/* Filter Pills */}
          <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto pb-1">
            <button
              onClick={() => setSelectedFilter("all")}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                selectedFilter === "all"
                  ? "bg-[#DFAB6C] text-[#1A110B] font-bold shadow-md"
                  : "bg-white/5 text-[#8C7C70] hover:text-white border border-white/10"
              }`}
            >
              All Reviews ({reviews.length})
            </button>
            <button
              onClick={() => setSelectedFilter("5star")}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                selectedFilter === "5star"
                  ? "bg-[#DFAB6C] text-[#1A110B] font-bold shadow-md"
                  : "bg-white/5 text-[#8C7C70] hover:text-white border border-white/10"
              }`}
            >
              ★ 5 Stars Only
            </button>
            <button
              onClick={() => setSelectedFilter("telangana")}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                selectedFilter === "telangana"
                  ? "bg-[#DFAB6C] text-[#1A110B] font-bold shadow-md"
                  : "bg-white/5 text-[#8C7C70] hover:text-white border border-white/10"
              }`}
            >
              Telangana (Hyderabad)
            </button>
            <button
              onClick={() => setSelectedFilter("andhra")}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                selectedFilter === "andhra"
                  ? "bg-[#DFAB6C] text-[#1A110B] font-bold shadow-md"
                  : "bg-white/5 text-[#8C7C70] hover:text-white border border-white/10"
              }`}
            >
              Andhra Pradesh
            </button>
          </div>

          {/* Search Box */}
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-[#8C7C70] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search drinks or notes..."
              className="w-full bg-white/5 border border-white/10 rounded-full pl-9 pr-4 py-1.5 text-xs text-white placeholder:text-[#8C7C70] focus:outline-none focus:border-[#DFAB6C]"
            />
          </div>
        </div>

        {/* Reviews Masonry / Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredReviews.map((rev) => (
            <motion.div
              key={rev.id}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="p-6 rounded-3xl bg-[#22160F]/80 border border-white/10 backdrop-blur-sm flex flex-col justify-between hover:border-[#DFAB6C]/40 transition-all shadow-xl"
            >
              <div>
                {/* Header: Author & Verified */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-[#3D2619] border border-[#DFAB6C]/40 text-[#DFAB6C] flex items-center justify-center text-xs font-bold">
                      {rev.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-white flex items-center gap-1.5">
                        <span>{rev.name}</span>
                        {rev.isVerified && (
                          <span
                            title="Verified Van Customer"
                            className="inline-flex items-center"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          </span>
                        )}
                      </h4>
                      <span className="text-[10px] text-[#8C7C70] font-mono">
                        {rev.date}
                      </span>
                    </div>
                  </div>

                  {/* Stars */}
                  <div className="flex items-center gap-0.5 text-[#DFAB6C]">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star
                        key={s}
                        className={`w-3.5 h-3.5 ${
                          s <= rev.rating
                            ? "fill-[#DFAB6C]"
                            : "text-[#8C7C70]/30"
                        }`}
                      />
                    ))}
                  </div>
                </div>

                {/* Ordered Item Badge */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#3D2619] border border-[#DFAB6C]/30 text-[#DFAB6C] text-[11px] font-medium">
                    <Coffee className="w-3 h-3" />
                    {rev.item}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-[#8C7C70]">
                    <MapPin className="w-3 h-3 text-blue-400" />
                    <span className="truncate max-w-[150px]">
                      {rev.location}
                    </span>
                  </span>
                </div>

                {/* Comment */}
                <p className="text-xs text-[#EDE4DA] leading-relaxed font-sans">
                  &ldquo;{rev.comment}&rdquo;
                </p>
              </div>

              {/* Card Footer: Helpful button */}
              <div className="mt-5 pt-3 border-t border-white/5 flex items-center justify-between text-xs text-[#8C7C70]">
                <span className="text-[11px]">Was this review helpful?</span>
                <button
                  onClick={() => handleHelpful(rev.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors cursor-pointer text-xs ${
                    votedIds[rev.id]
                      ? "text-emerald-400 bg-emerald-500/10 font-bold"
                      : "hover:bg-white/5 text-[#8C7C70] hover:text-white"
                  }`}
                >
                  <ThumbsUp className="w-3 h-3" />
                  <span>{rev.helpfulCount}</span>
                </button>
              </div>
            </motion.div>
          ))}
        </div>

        {filteredReviews.length === 0 && (
          <div className="text-center py-16 bg-white/5 rounded-3xl border border-white/10 mt-6">
            <Coffee className="w-8 h-8 text-[#DFAB6C] mx-auto mb-2 opacity-60" />
            <p className="text-sm font-semibold text-white">
              No reviews found matching your search.
            </p>
            <p className="text-xs text-[#8C7C70] mt-1">
              Try adjusting your filter or search query above.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
