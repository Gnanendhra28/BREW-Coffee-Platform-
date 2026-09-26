"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Coffee } from "lucide-react";
import confetti from "canvas-confetti";

interface CoffeeQuizModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCoffee?: (coffeeName: string) => void;
}

interface Question {
  id: number;
  title: string;
  options: { label: string; desc: string; tag: string }[];
}

const QUESTIONS: Question[] = [
  {
    id: 1,
    title: "How do you prefer your coffee profile?",
    options: [
      {
        label: "Rich & Velvety",
        desc: "Notes of dark cocoa, roasted hazelnuts, and molasses",
        tag: "espresso",
      },
      {
        label: "Smooth & Balanced",
        desc: "Caramelized sugar, milk chocolate, and biscuit warmth",
        tag: "balanced",
      },
      {
        label: "Bright & Floral",
        desc: "Jasmine blossoms, stone fruit, and vibrant citrus zest",
        tag: "bright",
      },
    ],
  },
  {
    id: 2,
    title: "What is your relationship with milk?",
    options: [
      {
        label: "Pure Black",
        desc: "Unadulterated clarity of bean origin and roasting craft",
        tag: "black",
      },
      {
        label: "Velvety Micro-Foam",
        desc: "Silky steamed oat milk or whole dairy for luscious mouthfeel",
        tag: "milk",
      },
      {
        label: "Sweet Confection",
        desc: "Infused with artisanal dark mocha or vanilla bean drizzle",
        tag: "sweet",
      },
    ],
  },
];

export const CoffeeQuizModal: React.FC<CoffeeQuizModalProps> = ({
  isOpen,
  onClose,
  onSelectCoffee,
}) => {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [recommended, setRecommended] = useState<{
    name: string;
    description: string;
    roast: string;
    notes: string[];
  } | null>(null);

  const handleSelectOption = (tag: string) => {
    const nextAnswers = [...answers, tag];
    setAnswers(nextAnswers);

    if (step + 1 < QUESTIONS.length) {
      setStep(step + 1);
    } else {
      // Calculate match
      const result = {
        name:
          nextAnswers[1] === "sweet"
            ? "BREW Signature Mocha Velvet"
            : nextAnswers[1] === "milk"
              ? "Artisanal Silk Flat White"
              : nextAnswers[0] === "bright"
                ? "Ethiopian Yirgacheffe Pour-Over"
                : "Single-Origin Dark Roast Espresso",
        description:
          "Handpicked high-altitude beans roasted in small batches to preserve delicate aromatics and full-bodied richness.",
        roast:
          nextAnswers[0] === "bright"
            ? "Light-Medium Roast"
            : "Medium-Dark Roast",
        notes:
          nextAnswers[1] === "sweet"
            ? [
                "70% Valrhona Dark Chocolate",
                "Velvety Foam",
                "Toasted Hazelnut",
              ]
            : ["Golden Honey", "Citrus Blossom", "Toffee Undertone"],
      };
      setRecommended(result);
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.6 },
        colors: ["#C88C50", "#F4EFE6", "#8C7C70"],
      });
    }
  };

  const handleReset = () => {
    setStep(0);
    setAnswers([]);
    setRecommended(null);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative w-full max-w-lg bg-[#20150E] border border-white/15 rounded-3xl p-6 sm:p-8 shadow-[0_25px_60px_rgba(0,0,0,0.9)] overflow-hidden"
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-5 right-5 w-8 h-8 rounded-full flex items-center justify-center text-[#8C7C70] hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          {!recommended ? (
            <div>
              {/* Header */}
              <div className="flex items-center gap-2 mb-2 text-[#C88C50] text-xs uppercase tracking-widest font-semibold">
                <Sparkles className="w-3.5 h-3.5" />
                <span>
                  Coffee Palate Test • Question {step + 1} of {QUESTIONS.length}
                </span>
              </div>

              <h3 className="font-serif text-2xl text-[#F4EFE6] font-normal leading-tight mb-6">
                {QUESTIONS[step].title}
              </h3>

              {/* Options */}
              <div className="space-y-3">
                {QUESTIONS[step].options.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => handleSelectOption(opt.tag)}
                    className="w-full text-left p-4 rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] hover:border-[#C88C50]/50 transition-all duration-200 group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-serif text-[#F4EFE6] group-hover:text-white text-base">
                        {opt.label}
                      </span>
                      <span className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center text-xs text-[#8C7C70] group-hover:border-[#C88C50] group-hover:text-[#C88C50]">
                        →
                      </span>
                    </div>
                    <p className="text-xs text-[#8C7C70] mt-1 group-hover:text-[#A09085]">
                      {opt.desc}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-2">
              <div className="w-14 h-14 rounded-full bg-[#C88C50]/20 border border-[#C88C50]/40 flex items-center justify-center mx-auto mb-4 text-[#C88C50]">
                <Coffee className="w-7 h-7" />
              </div>

              <span className="text-xs uppercase tracking-widest text-[#C88C50] font-semibold">
                Your Ideal Match
              </span>

              <h3 className="font-serif text-2xl sm:text-3xl text-[#F4EFE6] font-normal mt-1 mb-2">
                {recommended.name}
              </h3>

              <p className="text-xs text-[#8C7C70] max-w-sm mx-auto mb-5 leading-relaxed">
                {recommended.description}
              </p>

              {/* Flavor notes */}
              <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
                {recommended.notes.map((note) => (
                  <span
                    key={note}
                    className="text-[11px] px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[#F4EFE6]/90"
                  >
                    {note}
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={handleReset}
                  className="rounded-full border border-white/15 px-5 py-2 text-xs text-[#8C7C70] hover:text-white hover:bg-white/5"
                >
                  Retake Test
                </button>
                <button
                  onClick={() => {
                    if (onSelectCoffee) onSelectCoffee(recommended.name);
                    onClose();
                  }}
                  className="rounded-full bg-[#F4EFE6] text-[#1A110B] px-6 py-2 text-xs font-semibold hover:bg-white transition-colors"
                >
                  Order This Coffee
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
