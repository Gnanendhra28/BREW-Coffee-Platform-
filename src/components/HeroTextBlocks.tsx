"use client";

import React from "react";
import { motion } from "framer-motion";

export const HeroLeftBlock: React.FC = () => {
  return (
    <motion.div
      initial={{ opacity: 0, x: -30 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.9, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-20 flex flex-col items-start select-none"
    >
      {/* Large Faded Background Number "2" */}
      <div className="relative">
        <span className="absolute -top-16 -left-6 sm:-top-20 sm:-left-8 font-serif text-[110px] sm:text-[135px] md:text-[150px] font-normal text-[#C88C50]/20 select-none pointer-events-none -z-10 leading-none">
          2
        </span>
        <h2 className="font-serif text-2xl sm:text-3xl md:text-4xl font-normal tracking-tight text-[#F4EFE6] leading-[1.15] mb-4">
          Atmosphere of
          <br />
          Inspiration
        </h2>
      </div>

      <p className="font-sans text-xs sm:text-sm text-[#8C7C70] leading-relaxed max-w-[250px] font-normal">
        Our cozy space is filled with warmth and comfort. Here, surrounded by
        attentive service, you can relax, enjoy a cup of coffee, and be
        inspired by pleasant conversation.
      </p>
    </motion.div>
  );
};

export const HeroRightBlock: React.FC = () => {
  return (
    <motion.div
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.9, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-20 flex flex-col items-start text-left md:items-end md:text-right select-none md:ml-auto"
    >
      {/* Large Faded Background Number "4" */}
      <div className="relative flex flex-col items-start md:items-end">
        <span className="absolute -top-16 -left-6 md:-left-auto md:-right-6 sm:-top-20 md:-right-8 font-serif text-[110px] sm:text-[135px] md:text-[150px] font-normal text-[#C88C50]/20 select-none pointer-events-none -z-10 leading-none">
          4
        </span>
        <h2 className="font-serif text-2xl sm:text-3xl md:text-4xl font-normal tracking-tight text-[#F4EFE6] leading-[1.15] mb-4 text-left md:text-right">
          Professional
          <br />
          Barista Team
        </h2>
      </div>

      <p className="font-sans text-xs sm:text-sm text-[#8C7C70] leading-relaxed max-w-[250px] font-normal text-left md:text-right">
        Our baristas have extensive experience in brewing coffee and are ready
        to demonstrate all their exceptional talents in the art of
        coffee-making.
      </p>
    </motion.div>
  );
};
