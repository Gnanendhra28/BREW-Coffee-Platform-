"use client";

import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";

interface CenterCupProps {
  onOrderClick?: () => void;
}

export const CenterCup: React.FC<CenterCupProps> = ({ onOrderClick }) => {
  return (
    <div className="relative flex flex-col items-center justify-start pointer-events-none select-none z-20 w-full">
      {/* 3D Ceramic Coffee Container, partially cropped off the top edge */}
      <motion.div
        initial={{ opacity: 0, y: -40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
        className="relative -mt-28 sm:-mt-36 md:-mt-48 lg:-mt-56 flex justify-center"
      >
        <motion.div
          animate={{
            scale: [1, 1.02, 1],
          }}
          transition={{
            duration: 6,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="relative w-[320px] sm:w-[380px] md:w-[440px] lg:w-[480px] aspect-square flex items-center justify-center filter drop-shadow-[0_25px_45px_rgba(0,0,0,0.9)]"
        >
          {/* Warm ambient backlight behind container */}
          <div className="absolute inset-x-12 top-28 bottom-8 bg-[#C88C50]/20 rounded-full blur-3xl pointer-events-none -z-10" />

          <Image
            src="/assets/ceramic-cup.png"
            alt="3D Handcrafted Ceramic Coffee Container"
            width={480}
            height={480}
            priority
            className="w-full h-auto object-contain pointer-events-none drop-shadow-2xl"
          />
        </motion.div>
      </motion.div>

      {/* Secondary Center "Order Now" Button positioned below the cup */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-auto -mt-4 sm:-mt-6 md:-mt-8 z-30"
      >
        <button
          onClick={onOrderClick}
          className="glass-btn px-8 sm:px-9 py-2.5 sm:py-3 rounded-full text-xs sm:text-sm font-medium tracking-wide text-[#F4EFE6] border border-white/20 hover:border-white/40 hover:bg-white/10 hover:text-white transition-all duration-300 shadow-[0_10px_30px_rgba(0,0,0,0.5)] transform active:scale-95 group"
        >
          <span className="relative z-10 font-sans font-medium">
            Order Now
          </span>
        </button>
      </motion.div>
    </div>
  );
};
