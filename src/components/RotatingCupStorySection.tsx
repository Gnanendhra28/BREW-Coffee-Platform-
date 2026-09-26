"use client";

import React, { useRef, useState, useEffect } from "react";
import { CupCanvas3D } from "./CupCanvas3D";

interface StoryItem {
  title: string;
  description: string;
}

const STORY_ITEMS_LEFT: StoryItem[] = [
  {
    title: "Premium Bean Quality",
    description:
      "Our passion for coffee begins with selecting the finest beans. We pay attention to every detail so that each cup delivers exceptional quality and pleasure. We don't just pour coffee — we immerse you in a world of unforgettable flavours.",
  },
  {
    title: "Atmosphere of Inspiration",
    description:
      "Our cozy space is filled with warmth and comfort. Here, surrounded by attentive service, you can relax, enjoy a cup of coffee, and be inspired by pleasant conversation.",
  },
];

const STORY_ITEMS_RIGHT: StoryItem[] = [
  {
    title: "Personalised Approach to Every Guest",
    description:
      "We craft coffee that reflects your preferences, creating unique drinks especially for you. With us it's not just coffee — it's a personalised experience, so every visit becomes a memorable occasion.",
  },
  {
    title: "Professional Barista Team",
    description:
      "Our baristas have extensive experience in brewing coffee and are ready to demonstrate all their exceptional talents in the art of coffee-making.",
  },
];

export const RotatingCupStorySection: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [entryProgress, setEntryProgress] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const H = window.innerHeight;
      const scrollableRange = el.offsetHeight - H;

      // Scroll progress tracking through the brief reading hold (0 -> 1)
      const rawProgress = scrollableRange > 0 ? -rect.top / scrollableRange : 0;
      setScrollProgress(Math.min(Math.max(rawProgress, 0), 1));

      // Entry progress: starts as soon as cup is half visible in the lower viewport (rect.top <= 0.75 * H)
      // Reaches full 1.0 when the section locks in view (rect.top <= 0)
      // Stays strictly at 1.0 throughout the reading hold and beyond (no fade-out / no disappearance)
      const startY = H * 0.75;
      if (rect.top <= 0) {
        setEntryProgress(1);
      } else if (rect.top < startY) {
        setEntryProgress((startY - rect.top) / startY);
      } else {
        setEntryProgress(0);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });
    handleScroll();
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, []);

  // Pair 1: Top-Left (Premium Bean Quality) & Top-Right (Personalised Approach)
  // Starts transitioning as soon as the cup is half visible (entryProgress > 0)
  // Reaches full opacity (1.0) and offset (0px) at entryProgress >= 0.70
  const t1 = Math.min(Math.max(entryProgress / 0.7, 0), 1);
  const opacity1 = t1;
  const xOffset1 = -40 * (1 - t1);

  // Pair 2: Bottom-Left (Atmosphere of Inspiration) & Bottom-Right (Professional Barista Team)
  // Starts transitioning smoothly at entryProgress > 0.20
  // Reaches full opacity (1.0) and offset (0px) at entryProgress >= 1.0
  const t2 = Math.min(Math.max((entryProgress - 0.2) / 0.8, 0), 1);
  const opacity2 = t2;
  const xOffset2 = -40 * (1 - t2);

  return (
    <section
      ref={containerRef}
      id="about"
      className="relative w-full min-h-screen lg:h-[140vh] z-20 scroll-mt-0"
    >
      {/* Viewport Frame with a gentle ~0.5s - 1s reading hold on desktop */}
      <div className="relative lg:sticky lg:top-0 min-h-screen lg:h-screen w-full flex items-center justify-center overflow-hidden px-6 sm:px-10 lg:px-16 xl:px-20 select-none py-12 lg:py-0">
        {/* Subtle Ambient Radial Glow behind the central cup */}
        <div className="absolute top-1/2 left-1/2 -translate-y-1/2 -translate-x-1/2 w-[600px] sm:w-[750px] h-[600px] sm:h-[750px] bg-[#C88C50]/18 rounded-full blur-[160px] pointer-events-none -z-10" />

        <div className="relative w-full max-w-[1520px] mx-auto grid grid-cols-1 lg:grid-cols-12 items-center gap-8 lg:gap-10 h-full py-4">
          {/* Left Column: Features 1 & 2 */}
          <div className="lg:col-span-4 flex flex-col justify-between gap-10 lg:gap-24 lg:h-[70vh] z-20 pointer-events-auto py-2">
            {/* Feature 1 (Top Left): Premium Bean Quality */}
            <div
              style={{
                opacity: opacity1,
                transform: `translateX(${xOffset1}px)`,
                transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
              }}
              className="flex flex-col text-left max-w-[430px]"
            >
              <h3 className="font-sans font-bold text-2xl sm:text-[28px] lg:text-[32px] text-white tracking-tight mb-3 drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_LEFT[0].title}
              </h3>
              <p className="font-sans text-sm sm:text-[15px] lg:text-base text-[#EDE4DA] leading-relaxed drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_LEFT[0].description}
              </p>
            </div>

            {/* Feature 2 (Bottom Left): Atmosphere of Inspiration */}
            <div
              style={{
                opacity: opacity2,
                transform: `translateX(${xOffset2}px)`,
                transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
              }}
              className="flex flex-col text-left max-w-[430px]"
            >
              <h3 className="font-sans font-bold text-2xl sm:text-[28px] lg:text-[32px] text-white tracking-tight mb-3 drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_LEFT[1].title}
              </h3>
              <p className="font-sans text-sm sm:text-[15px] lg:text-base text-[#EDE4DA] leading-relaxed drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_LEFT[1].description}
              </p>
            </div>
          </div>

          {/* Center Column: User's exact cup with 3D rotating branding */}
          <div className="lg:col-span-4 relative flex items-center justify-center h-[55vh] sm:h-[65vh] lg:h-[78vh] w-full select-none pointer-events-none">
            <div className="relative w-full h-full max-w-[420px] sm:max-w-[480px] lg:max-w-[520px] xl:max-w-[560px] flex items-center justify-center">
              <CupCanvas3D scrollProgress={scrollProgress} />
            </div>
          </div>

          {/* Right Column: Features 3 & 4 */}
          <div className="lg:col-span-4 flex flex-col justify-between gap-10 lg:gap-24 lg:h-[70vh] z-20 pointer-events-auto py-2">
            {/* Feature 3 (Top Right): Personalised Approach to Every Guest */}
            <div
              style={{
                opacity: opacity1,
                transform: `translateX(${-xOffset1}px)`,
                transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
              }}
              className="flex flex-col text-left max-w-[430px] ml-auto"
            >
              <h3 className="font-sans font-bold text-2xl sm:text-[28px] lg:text-[32px] text-white tracking-tight mb-3 drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_RIGHT[0].title}
              </h3>
              <p className="font-sans text-sm sm:text-[15px] lg:text-base text-[#EDE4DA] leading-relaxed drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_RIGHT[0].description}
              </p>
            </div>

            {/* Feature 4 (Bottom Right): Professional Barista Team */}
            <div
              style={{
                opacity: opacity2,
                transform: `translateX(${-xOffset2}px)`,
                transition: "opacity 0.2s ease-out, transform 0.2s ease-out",
              }}
              className="flex flex-col text-left max-w-[430px] ml-auto"
            >
              <h3 className="font-sans font-bold text-2xl sm:text-[28px] lg:text-[32px] text-white tracking-tight mb-3 drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_RIGHT[1].title}
              </h3>
              <p className="font-sans text-sm sm:text-[15px] lg:text-base text-[#EDE4DA] leading-relaxed drop-shadow-[0_1px_8px_rgba(0,0,0,0.8)]">
                {STORY_ITEMS_RIGHT[1].description}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
