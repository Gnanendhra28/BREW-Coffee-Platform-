"use client";

import React, { useEffect, useRef } from "react";
import Image from "next/image";

interface CupCanvas3DProps {
  scrollProgress?: number;
  className?: string;
}

export const CupCanvas3D: React.FC<CupCanvas3DProps> = ({
  scrollProgress = 0,
  className = "",
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef(scrollProgress);

  useEffect(() => {
    scrollRef.current = scrollProgress;
  }, [scrollProgress]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Fixed reference dimensions matching main 2.png
    const W = 1059;
    const H = 1485;
    canvas.width = W;
    canvas.height = H;

    // Load HD clean brew logo
    const logoImg = new window.Image();
    logoImg.src = "/assets/brew_logo_hd.webp";

    // Sleeve dimensions on main_2_clean.png:
    // Center X: 532
    // Vertical center for logo: 818
    // Radius of the sleeve cylinder at logo height: R = 310
    // Logo target height on sleeve: 190
    const cx = 532;
    const cy = 818;
    const R = 310;
    const targetH = 192;

    let animId: number;
    let currentAngle = 0;
    let lastTime = performance.now();

    const render = (now: number) => {
      animId = requestAnimationFrame(render);
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // Continuous rotation around the cup:
      // ~0.65 rad/sec for smooth, elegant movement
      currentAngle += 0.65 * dt;

      // Scroll adds direct rotation influence
      const scrollInfluence = (scrollRef.current || 0) * Math.PI * 2.8;
      const totalAngle = -(currentAngle + scrollInfluence);

      ctx.clearRect(0, 0, W, H);

      if (!logoImg.complete || logoImg.naturalWidth === 0) return;

      const lw = logoImg.naturalWidth;
      const lh = logoImg.naturalHeight;
      const targetW = Math.round(lw * (targetH / lh));

      // Clip drawing strictly to the sleeve trapezoid so nothing spills outside
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(188, 610);
      ctx.lineTo(876, 610);
      ctx.lineTo(812, 1076);
      ctx.lineTo(250, 1076);
      ctx.closePath();
      ctx.clip();

      // Draw 2 logo instances spaced 180 degrees (pi rad) apart around the cylinder
      const sliceStep = 2; // 2px slices for silky smooth 60fps rendering
      for (const baseAngle of [totalAngle, totalAngle + Math.PI]) {
        for (let x = 0; x < targetW; x += sliceStep) {
          // Angular position of this vertical slice around the cylinder
          const u = (x + sliceStep / 2 - targetW / 2) / R;
          const theta = baseAngle + u;

          // Only draw if on the front-facing hemisphere of the cup
          const cosT = Math.cos(theta);
          if (cosT <= 0.02) continue;

          const sinT = Math.sin(theta);
          const screenX = cx + R * sinT;

          // Natural perspective arc curve on the conical sleeve
          const curveY = -10 * (1.0 - cosT);
          const screenY = cy + curveY - targetH / 2;

          // Foreshortened slice width
          const sliceW = Math.max(1, Math.ceil(sliceStep * cosT * 1.15));

          ctx.save();
          // Smooth fade at the extreme curvature silhouette edges
          if (cosT < 0.22) {
            ctx.globalAlpha = Math.max(0, cosT / 0.22);
          }

          ctx.drawImage(
            logoImg,
            (x / targetW) * lw,
            0,
            (sliceStep / targetW) * lw,
            lh,
            Math.round(screenX - sliceW / 2),
            Math.round(screenY),
            sliceW,
            targetH
          );
          ctx.restore();
        }
      }

      ctx.restore();
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, []);

  return (
    <div
      className={`relative w-full max-w-[430px] sm:max-w-[480px] lg:max-w-[510px] aspect-[1059/1485] flex items-center justify-center select-none ${className}`}
    >
      {/* 1. User's exact cup image with clean kraft sleeve */}
      <Image
        src="/assets/main_2_clean.webp"
        alt="Brew Premium Coffee Cup"
        fill
        priority
        sizes="(max-width: 768px) 90vw, 510px"
        className="object-contain filter drop-shadow-[0_28px_50px_rgba(0,0,0,0.85)] pointer-events-none"
      />

      {/* 2. 3D Cylindrical Branding Rotation Layer */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      />
    </div>
  );
};
