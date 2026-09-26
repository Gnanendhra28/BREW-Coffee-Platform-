"use client";

import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";

interface SplashHeroProps {
  onExploreClick?: () => void;
  onOrderClick?: () => void;
}

export const SplashHero: React.FC<SplashHeroProps> = ({
  onExploreClick,
}) => {
  return (
    <section className="relative w-full flex-1 flex flex-col justify-center max-w-[1520px] mx-auto px-6 sm:px-10 md:px-14 lg:px-16 pt-16 sm:pt-20 pb-8 overflow-hidden z-20">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-4 items-center min-h-[calc(100vh-140px)]">
        {/* Left Column: Typography & CTAs */}
        <div className="lg:col-span-6 xl:col-span-6 flex flex-col items-start justify-center z-20 pt-0">
          {/* Badge: Artisan Coffee Brewery */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-[#20150F]/70 border border-white/10 backdrop-blur-md shadow-lg mb-4 sm:mb-6"
          >
            <span className="w-2 h-2 rounded-full bg-[#5E7A68] shadow-[0_0_8px_#5E7A68]" />
            <span className="text-xs sm:text-[13px] font-medium tracking-wide text-[#A39284]">
              Artisan Coffee Brewery · Est. 2010
            </span>
          </motion.div>

          {/* Massive Display Heading */}
          <motion.h1
            initial={{ opacity: 0, y: 25 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="font-sans font-extrabold text-5xl sm:text-7xl md:text-8xl lg:text-[84px] xl:text-[94px] leading-[1.01] tracking-[-0.03em] text-[#F4EFE6] select-none"
          >
            Discover the
            <br />
            <span className="text-[#DFAB6C] drop-shadow-[0_2px_15px_rgba(223,171,108,0.2)]">
              Superior Taste
            </span>
            <br />
            Every Sip!
          </motion.h1>

          {/* Subtitle / Paragraph */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="font-sans text-sm sm:text-base text-[#9C897C] leading-relaxed max-w-[430px] mt-6 sm:mt-7 mb-8 sm:mb-10 font-normal"
          >
            For us, coffee is not just a drink — it&apos;s an art. We invite you
            on a unique culinary journey where every sip is a meeting with the
            perfect taste.
          </motion.p>

          {/* Explore Coffee Button */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.65, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-4"
          >
            <button
              onClick={onExploreClick}
              className="rounded-full bg-[#5B6E63] text-[#F4EFE6] px-8 sm:px-10 py-3.5 sm:py-4 text-sm sm:text-base font-semibold tracking-wide shadow-[0_15px_35px_rgba(40,55,45,0.7)] hover:bg-[#687D71] hover:shadow-[0_15px_40px_rgba(91,110,99,0.5)] transition-all duration-300 transform active:scale-95"
            >
              Explore Coffee
            </button>
          </motion.div>
        </div>

        {/* Right Column: 3D Splashing Coffee Cups */}
        <div className="lg:col-span-6 xl:col-span-6 relative flex items-center justify-center lg:justify-end select-none pointer-events-none">
          {/* Subtle warm amber ambient glow behind the cups */}
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[550px] sm:w-[650px] h-[550px] sm:h-[650px] bg-[#C88C50]/18 rounded-full blur-[140px] pointer-events-none -z-10" />

          {/* 3D Cups Container with subtle floating motion */}
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 1.1, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-[700px] sm:max-w-[820px] lg:max-w-[960px] xl:max-w-[1080px] flex items-center justify-center lg:justify-end -mt-8 sm:-mt-12 lg:-mt-16"
          >
            <motion.div
              animate={{
                y: [0, -10, 0],
                rotate: [-0.3, 0.3, -0.3],
              }}
              transition={{
                duration: 7,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              className="relative w-full flex items-center justify-center lg:justify-end filter drop-shadow-[0_30px_60px_rgba(0,0,0,0.85)]"
            >
              <Image
                src="/assets/main 1.png"
                alt="BREW 3D Artisanal Coffee Cups with Dynamic Splash"
                width={1254}
                height={1254}
                priority
                className="w-full h-auto object-contain max-h-[95vh] transform lg:translate-x-10 xl:translate-x-16 scale-110 xl:scale-115"
              />
            </motion.div>
          </motion.div>
        </div>
      </div>

      {/* Subtle Plus watermark in the bottom-right corner */}
      <div className="hidden sm:block absolute bottom-6 right-8 sm:right-12 text-white/20 text-3xl sm:text-4xl font-extralight select-none pointer-events-none">
        +
      </div>
    </section>
  );
};
