"use client";

import React, { useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";

interface BottomCardProps {
  onTakeTest: () => void;
  onOrderClick?: () => void;
}

export const BottomCard: React.FC<BottomCardProps> = ({
  onTakeTest,
  onOrderClick,
}) => {
  const [hovered, setHovered] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const y = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    setMousePos({ x, y });
  };
  return (
    <footer className="relative w-full flex flex-col items-center justify-start z-30 px-6 sm:px-10 lg:px-16 pt-12 pb-14 select-none">
      {/* 1. Centered 'Order Now' Button */}
      <div className="w-full flex justify-center mb-10 sm:mb-14">
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          onClick={onOrderClick}
          className="px-9 py-3.5 rounded-full border border-white/20 bg-[#2D1F16]/90 hover:bg-[#3D2C20] hover:border-white/40 text-[#F4EFE6] font-sans font-medium text-sm sm:text-base tracking-wide shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur-md transition-all duration-300 flex items-center justify-center cursor-pointer"
        >
          Order Now
        </motion.button>
      </div>

      {/* 2. Wide Quiz Banner Card: 'Find out which coffee suits you best' */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-[1200px] rounded-[28px] sm:rounded-[36px] border border-white/10 bg-[#372A1A] backdrop-blur-xl shadow-[0_30px_70px_rgba(0,0,0,0.75)] px-8 sm:px-12 lg:px-16 py-10 sm:py-12 lg:py-14 flex flex-col md:flex-row items-center justify-between gap-8 overflow-visible"
      >
        {/* Left Side: Heading and Button */}
        <div className="flex-1 flex flex-col items-start justify-center z-20 max-w-[480px]">
          <h3 className="font-serif text-2xl sm:text-3xl lg:text-[40px] text-[#F4EFE6] font-normal leading-[1.18] tracking-tight mb-6 sm:mb-8 drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
            Find out which coffee suits you best
          </h3>

          <button
            onClick={onTakeTest}
            className="rounded-full border border-white/20 px-8 py-3 text-sm sm:text-base font-medium tracking-wide text-[#F4EFE6] bg-[#22160F]/80 hover:bg-white/15 hover:border-white/40 transition-all duration-300 transform active:scale-95 shadow-[0_6px_20px_rgba(0,0,0,0.5)] cursor-pointer"
          >
            Take the test
          </button>
        </div>

        {/* Right Side: Wooden Spoon with Roasted Beans & Flying Beans */}
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            setMousePos({ x: 0, y: 0 });
          }}
          onMouseMove={handleMouseMove}
          className="relative flex-1 flex items-center justify-center md:justify-end w-full md:w-auto min-h-[220px] sm:min-h-[250px] md:min-h-[280px] cursor-pointer group/spoon"
        >
          {/* Ambient warm glow behind beans that blossoms on hover */}
          <motion.div
            animate={
              hovered
                ? { opacity: 0.5, scale: 1.3 }
                : { opacity: 0.2, scale: 1 }
            }
            transition={{ duration: 0.35 }}
            className="absolute right-0 top-1/2 -translate-y-1/2 w-80 h-56 bg-[#C87A38]/30 rounded-full blur-3xl pointer-events-none"
          />

          {/* Spoon & Flying Beans: tail reaches the end of the box, with responsive hover motion */}
          <motion.div
            animate={
              hovered
                ? {
                    x: mousePos.x * 15,
                    y: -18 + mousePos.y * 10,
                    rotate: -2.5 + mousePos.x * 2.5,
                    scale: 1.05,
                  }
                : {
                    x: 0,
                    y: [0, -6, 0],
                    rotate: [0, -0.8, 0],
                    scale: 1,
                  }
            }
            transition={
              hovered
                ? { type: "spring", stiffness: 280, damping: 22 }
                : { duration: 4.5, repeat: Infinity, ease: "easeInOut" }
            }
            className="relative md:absolute md:-right-12 lg:-right-16 xl:-right-20 md:-top-16 lg:-top-22 w-[350px] sm:w-[480px] md:w-[600px] lg:w-[680px] xl:w-[730px] max-w-none select-none filter drop-shadow-[0_25px_40px_rgba(0,0,0,0.7)] will-change-transform"
          >
            <Image
              src="/assets/spoon.webp"
              alt="Wooden spoon holding roasted coffee beans with beans floating in air"
              width={1774}
              height={887}
              className="w-full h-auto object-contain transition-transform duration-300 group-hover/spoon:brightness-105"
              priority
            />
          </motion.div>
        </div>
      </motion.div>

      {/* 3. Footer Links: Board, Reviews, Coffee news, Socials */}
      <div className="w-full max-w-[1200px] flex flex-wrap items-center justify-start gap-6 sm:gap-8 pt-6 px-4 text-xs sm:text-sm text-[#9E8E82] tracking-wider">
        <a
          href="/board"
          className="underline underline-offset-4 decoration-[#DFAB6C]/50 text-[#DFAB6C] hover:decoration-white hover:text-[#F4EFE6] transition-colors duration-200 font-medium"
        >
          Live Outlet Board
        </a>
        <a
          href="/reviews"
          className="underline underline-offset-4 decoration-white/25 hover:decoration-white hover:text-[#F4EFE6] transition-colors duration-200"
        >
          Customer Reviews
        </a>
        <a
          href="/location"
          className="underline underline-offset-4 decoration-white/25 hover:decoration-white hover:text-[#F4EFE6] transition-colors duration-200"
        >
          Van Tracker
        </a>
        <a
          href="/menu"
          className="underline underline-offset-4 decoration-white/25 hover:decoration-white hover:text-[#F4EFE6] transition-colors duration-200"
        >
          Menu
        </a>
      </div>
    </footer>
  );
};
