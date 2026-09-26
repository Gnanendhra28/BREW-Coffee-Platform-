"use client";

import React, { useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { Plus, Check, Star, ArrowRight } from "lucide-react";
import confetti from "canvas-confetti";
import { useCart } from "@/context/CartContext";

interface Product {
  id: string;
  name: string;
  rating: string;
  description: string;
  price: number;
  image: string;
}

const PRODUCTS: Product[] = [
  {
    id: "cappuccino",
    name: "Cappuccino",
    rating: "4.9",
    description:
      "A timeless classic: 20% espresso, 40% velvety steamed milk, and 40% airy milk foam. Balanced and smooth.",
    price: 4.5,
    image: "/assets/cup1.webp",
  },
  {
    id: "latte",
    name: "Latte",
    rating: "5.0",
    description:
      "Smooth and creamy: 30% espresso and 70% fresh, hot milk. Perfect for a creamy coffee treat.",
    price: 5.0,
    image: "/assets/cup3.webp",
  },
  {
    id: "mocha",
    name: "Mocha",
    rating: "4.7",
    description:
      "For the chocolate lover: 20% espresso, 50% hot milk, and 30% premium chocolate. Decadently sweet.",
    price: 5.0,
    image: "/assets/cup2.webp",
  },
];

interface CoffeeSelectionSectionProps {
  onAddToCart?: (productName: string, price: number) => void;
  onFullMenuClick?: () => void;
}

export const CoffeeSelectionSection: React.FC<CoffeeSelectionSectionProps> = ({
  onAddToCart,
  onFullMenuClick,
}) => {
  const [addedId, setAddedId] = useState<string | null>(null);
  const { addItem } = useCart();

  const handleAdd = (product: Product) => {
    setAddedId(product.id);
    addItem({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image,
      category: "coffee",
    });
    if (onAddToCart) {
      onAddToCart(product.name, product.price);
    }
    confetti({
      particleCount: 25,
      spread: 50,
      origin: { y: 0.8 },
      colors: ["#5FA396", "#DFAB6C", "#F4EFE6"],
    });
    setTimeout(() => {
      setAddedId(null);
    }, 1200);
  };

  const marqueeChunk = "LIMITED COFFEE SELECTED • LIMITED COFFEE SELECTION • ";
  const fullMarquee = marqueeChunk.repeat(4);

  return (
    <section
      id="selection"
      className="relative w-full py-16 sm:py-24 overflow-hidden z-20"
    >
      {/* 1. Continuous Right-to-Left Marquee Text with Increased Height */}
      <div className="relative w-full overflow-hidden select-none pt-8 sm:pt-12 pb-4 sm:pb-6 min-h-[140px] sm:min-h-[200px] lg:min-h-[240px] flex items-center pointer-events-none">
        <motion.div
          animate={{ x: [0, -2200] }}
          transition={{
            repeat: Infinity,
            repeatType: "loop",
            duration: 26,
            ease: "linear",
          }}
          className="flex whitespace-nowrap will-change-transform"
        >
          <span className="font-serif font-black text-7xl sm:text-8xl md:text-9xl lg:text-[145px] xl:text-[175px] 2xl:text-[195px] leading-none uppercase tracking-wider text-[#B38353]/30 drop-shadow-[0_4px_25px_rgba(0,0,0,0.5)] pr-14">
            {fullMarquee}
          </span>
          <span className="font-serif font-black text-7xl sm:text-8xl md:text-9xl lg:text-[145px] xl:text-[175px] 2xl:text-[195px] leading-none uppercase tracking-wider text-[#B38353]/30 drop-shadow-[0_4px_25px_rgba(0,0,0,0.5)] pr-14">
            {fullMarquee}
          </span>
        </motion.div>
      </div>

      {/* 2. Three Coffee Cups Product Cards */}
      <div className="relative max-w-[1340px] mx-auto px-6 sm:px-10 md:px-14 lg:px-16 pt-20 sm:pt-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-24 md:gap-8 lg:gap-10">
          {PRODUCTS.map((product, idx) => (
            <motion.div
              key={product.id}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{
                duration: 0.8,
                delay: idx * 0.15,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="relative rounded-3xl md:rounded-[36px] bg-[#22160F]/85 backdrop-blur-2xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.7)] p-6 sm:p-8 pt-32 sm:pt-36 md:pt-38 flex flex-col items-center text-center transition-all duration-300 hover:border-white/20 hover:shadow-[0_30px_60px_rgba(0,0,0,0.85)] group cursor-pointer"
            >
              {/* 3D Coffee Cup Image - sits in front with z-30, smooth hover that reliably glides back */}
              <div className="absolute -top-28 sm:-top-32 md:-top-34 left-1/2 -translate-x-1/2 w-[165px] sm:w-[180px] md:w-[200px] aspect-[500/660] z-30 transition-transform duration-300 ease-out group-hover:-translate-y-3 group-hover:scale-105 pointer-events-none select-none filter drop-shadow-[0_20px_25px_rgba(0,0,0,0.85)]">
                <Image
                  src={product.image}
                  alt={product.name}
                  width={400}
                  height={520}
                  className="w-full h-full object-contain pointer-events-none"
                  priority
                />
              </div>

              {/* Rating badge in top-right corner of card */}
              <div className="absolute top-5 right-5 sm:top-6 sm:right-6 px-3 py-1 rounded-full bg-black/45 border border-white/10 text-xs font-semibold text-[#F4EFE6] flex items-center gap-1 shadow-md select-none z-20">
                <span>{product.rating}</span>
                <Star className="w-3 h-3 fill-[#DFAB6C] text-[#DFAB6C]" />
              </div>

              {/* Title */}
              <h3 className="font-serif text-2xl sm:text-3xl font-normal text-[#F4EFE6] tracking-tight mb-2 select-none z-20">
                {product.name}
              </h3>

              {/* Description */}
              <p className="font-sans text-xs sm:text-[13px] text-[#8C7C70] leading-relaxed max-w-[280px] min-h-[58px] mb-6 select-none z-20">
                {product.description}
              </p>

              {/* Price & Add to Cart Button Centered */}
              <div className="flex items-center justify-center gap-4 w-full mx-auto mt-auto pt-4 border-t border-white/5 z-20">
                <span className="font-sans text-xl sm:text-2xl font-bold text-[#F4EFE6] tracking-tight">
                  ${product.price.toFixed(2)}
                </span>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAdd(product);
                  }}
                  aria-label={`Add ${product.name} to cart`}
                  className={`w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300 transform active:scale-90 shadow-[0_4px_15px_rgba(95,163,150,0.4)] ${
                    addedId === product.id
                      ? "bg-emerald-500 text-white scale-110"
                      : "bg-[#5FA396] hover:bg-[#6DB3A6] text-[#F4EFE6] hover:scale-105"
                  }`}
                >
                  {addedId === product.id ? (
                    <Check className="w-5 h-5 stroke-[2.5]" />
                  ) : (
                    <Plus className="w-5 h-5 stroke-[2.5]" />
                  )}
                </button>
              </div>
            </motion.div>
          ))}
        </div>

        {/* 3. "Full Menu" Button centered right below the Latte card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="flex justify-center items-center mt-14 sm:mt-16 z-20"
        >
          <button
            onClick={onFullMenuClick}
            className="group relative inline-flex items-center gap-2.5 px-9 sm:px-11 py-3.5 sm:py-4 rounded-full bg-[#5B6E63] text-[#F4EFE6] text-sm sm:text-base font-semibold tracking-wide shadow-[0_15px_35px_rgba(40,55,45,0.7)] hover:bg-[#687D71] hover:shadow-[0_15px_40px_rgba(91,110,99,0.5)] transition-all duration-300 transform active:scale-95 cursor-pointer"
          >
            <span>Full Menu</span>
            <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
          </button>
        </motion.div>
      </div>
    </section>
  );
};
