"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Minus, Coffee, ArrowRight } from "lucide-react";
import confetti from "canvas-confetti";
import { useCart } from "@/context/CartContext";

interface OrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  cartCount: number;
  setCartCount: React.Dispatch<React.SetStateAction<number>>;
}

interface MenuItem {
  id: string;
  name: string;
  price: number;
  rating: number;
  tag: string;
  description: string;
}

const MENU_ITEMS: MenuItem[] = [
  {
    id: "c-3",
    name: "Cappuccino",
    price: 220,
    rating: 4.9,
    tag: "Popular",
    description:
      "20% espresso, 40% velvety steamed milk, 40% airy milk foam. Balanced and smooth.",
  },
  {
    id: "c-7",
    name: "Latte",
    price: 240,
    rating: 5.0,
    tag: "Bestseller",
    description:
      "30% espresso and 70% fresh hot milk. Perfect for a creamy coffee treat.",
  },
  {
    id: "c-8",
    name: "Mocha",
    price: 260,
    rating: 4.7,
    tag: "Decadent",
    description:
      "20% espresso, 50% hot milk, 30% single-origin premium dark chocolate.",
  },
  {
    id: "c-5",
    name: "Double Espresso",
    price: 180,
    rating: 4.8,
    tag: "Classic",
    description:
      "Pure extracted crema, intense roasted hazelnut aroma, bold finish.",
  },
];

export const OrderModal: React.FC<OrderModalProps> = ({
  isOpen,
  onClose,
  setCartCount,
}) => {
  const router = useRouter();
  const { addItem, updateQuantity } = useCart();
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const handleIncrement = (id: string) => {
    const item = MENU_ITEMS.find((m) => m.id === id);
    if (item) {
      addItem({
        id: item.id,
        name: item.name,
        price: item.price,
        image: `/assets/coffee/${item.id === "c-3" ? "cappuccino" : item.id === "c-7" ? "latte" : item.id === "c-8" ? "mocha" : "expresso"}.webp`,
        category: "Coffee",
      });
    }
    setQuantities((prev) => ({
      ...prev,
      [id]: (prev[id] || 0) + 1,
    }));
    setCartCount((c) => c + 1);
  };

  const handleDecrement = (id: string) => {
    updateQuantity(id, -1);
    setQuantities((prev) => {
      const cur = prev[id] || 0;
      if (cur <= 1) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: cur - 1 };
    });
    setCartCount((c) => Math.max(0, c - 1));
  };

  const total = Object.entries(quantities).reduce((acc, [id, qty]) => {
    const item = MENU_ITEMS.find((m) => m.id === id);
    return acc + (item?.price || 0) * qty;
  }, 0);

  const handleCheckout = () => {
    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.6 },
      colors: ["#C88C50", "#F4EFE6", "#FFFFFF"],
    });
    onClose();
    router.push("/cart");
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="relative w-full max-w-lg bg-[#20150E] border border-white/15 rounded-3xl p-6 sm:p-8 shadow-[0_25px_60px_rgba(0,0,0,0.9)] overflow-hidden"
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-5 right-5 w-8 h-8 rounded-full flex items-center justify-center text-[#8C7C70] hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          <div>
            <div className="flex items-center gap-2 mb-1 text-[#C88C50] text-xs uppercase tracking-widest font-semibold">
              <Coffee className="w-4 h-4" />
              <span>Handcrafted Selections</span>
            </div>
              <h3 className="font-serif text-2xl text-[#F4EFE6] font-normal mb-5">
                BREW Quick Order
              </h3>

              <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
                {MENU_ITEMS.map((item) => {
                  const qty = quantities[item.id] || 0;
                  return (
                    <div
                      key={item.id}
                      className="p-3.5 rounded-2xl border border-white/10 bg-white/[0.03] flex items-center justify-between gap-3 hover:bg-white/[0.06] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-serif text-base text-[#F4EFE6] font-medium">
                            {item.name}
                          </span>
                          <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-[#C88C50]/20 text-[#C88C50]">
                            ★ {item.rating}
                          </span>
                        </div>
                        <p className="text-xs text-[#8C7C70] truncate mt-0.5">
                          {item.description}
                        </p>
                        <span className="text-sm font-semibold text-[#F4EFE6] mt-1 inline-block">
                          ₹{item.price.toLocaleString('en-IN')}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {qty > 0 ? (
                          <div className="flex items-center gap-2 bg-white/10 rounded-full px-2 py-1">
                            <button
                              onClick={() => handleDecrement(item.id)}
                              className="w-6 h-6 rounded-full flex items-center justify-center text-white/80 hover:text-white"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <span className="text-xs font-semibold text-white px-1">
                              {qty}
                            </span>
                            <button
                              onClick={() => handleIncrement(item.id)}
                              className="w-6 h-6 rounded-full flex items-center justify-center text-white/80 hover:text-white"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleIncrement(item.id)}
                            className="rounded-full bg-[#F4EFE6] text-[#1A110B] p-2 hover:bg-white transition-all transform active:scale-95"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Order total & CTA */}
              <div className="mt-6 pt-4 border-t border-white/10 flex items-center justify-between">
                <div>
                  <span className="text-xs text-[#8C7C70] block">Subtotal</span>
                  <span className="font-serif text-xl text-[#F4EFE6] font-semibold">
                    ₹{total.toLocaleString('en-IN')}
                  </span>
                </div>

                <button
                  disabled={total === 0}
                  onClick={handleCheckout}
                  className="rounded-full bg-[#DFAB6C] disabled:opacity-40 hover:bg-white text-[#1A110B] px-6 py-2.5 text-xs sm:text-sm font-bold transition-all shadow-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <span>Proceed to Checkout</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
