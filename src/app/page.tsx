"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { SplashHero } from "@/components/SplashHero";
import { CoffeeSelectionSection } from "@/components/CoffeeSelectionSection";
import { RotatingCupStorySection } from "@/components/RotatingCupStorySection";
import { BottomCard } from "@/components/BottomCard";
import { CoffeeQuizModal } from "@/components/CoffeeQuizModal";
import { OrderModal } from "@/components/OrderModal";

export default function Home() {
  const router = useRouter();
  const [isOrderOpen, setIsOrderOpen] = useState(false);
  const [isQuizOpen, setIsQuizOpen] = useState(false);
  const [cartCount, setCartCount] = useState(0);

  const handleAddToCart = () => {
    setCartCount((c) => c + 1);
  };

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#about") {
      setTimeout(() => {
        const el = document.getElementById("about");
        if (el) {
          el.scrollIntoView({ behavior: "smooth" });
        }
      }, 150);
    }
  }, []);

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

      {/* Warm amber ambient glow */}
      <div className="fixed top-1/4 right-1/4 w-[600px] h-[600px] bg-[#D48F47]/10 rounded-full blur-[160px] pointer-events-none -z-10" />

      {/* 2. Top Navigation Bar */}
      <Header />

      {/* 3. Hero Section: "Discover the Superior Taste Every Sip!" + 3D Splash Cups */}
      <SplashHero
        onExploreClick={() => {
          const el = document.getElementById("selection");
          if (el) el.scrollIntoView({ behavior: "smooth" });
        }}
        onOrderClick={() => setIsOrderOpen(true)}
      />

      {/* 4. Marquee & Coffee Selection Cards Section */}
      <CoffeeSelectionSection
        onAddToCart={handleAddToCart}
        onFullMenuClick={() => router.push("/menu")}
      />

      {/* 5. Continuation: Rotating Center Cup & Interactive Storytelling */}
      <RotatingCupStorySection />

      {/* 6. Page Ending: Order Now button, Coffee Quiz Card, and Footer */}
      <BottomCard
        onOrderClick={() => setIsOrderOpen(true)}
        onTakeTest={() => setIsQuizOpen(true)}
      />

      {/* Interactive Order Drawer / Modal */}
      <OrderModal
        isOpen={isOrderOpen}
        onClose={() => setIsOrderOpen(false)}
        cartCount={cartCount}
        setCartCount={setCartCount}
      />

      {/* Interactive Coffee Palate Quiz Modal */}
      <CoffeeQuizModal
        isOpen={isQuizOpen}
        onClose={() => setIsQuizOpen(false)}
        onSelectCoffee={() => {
          setIsQuizOpen(false);
          setIsOrderOpen(true);
        }}
      />
    </main>
  );
}
