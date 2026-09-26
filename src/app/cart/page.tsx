"use client";

import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShoppingBag,
  Trash2,
  Plus,
  Minus,
  ArrowLeft,
  Sparkles,
  CheckCircle2,
  Clock,
  Tag,
  ShieldCheck,
  ChevronRight,
  ArrowRight,
  X,
  Smartphone,
  CreditCard,
  MessageSquare,
} from "lucide-react";
import confetti from "canvas-confetti";
import { Header } from "@/components/Header";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";
import { useVan } from "@/context/VanContext";
import { MENU_ITEMS } from "@/data/menuData";
import { openRazorpayCheckout } from "@/lib/razorpayCheckout";
import { formatWhatsAppReceipt, getWhatsAppReceiptUrl } from "@/lib/receiptNotifier";
import { registerBuzzerServiceWorker } from "@/lib/pushBuzzer";

export default function CartPage() {
  const router = useRouter();

  React.useEffect(() => {
    registerBuzzerServiceWorker();
  }, []);
  const { items, updateQuantity, removeItem, clearCart, totalItems, subtotal, addItem } = useCart();
  const { user, openAuthModal } = useAuth();
  const { createOrder, vanLocation } = useVan();

  const [guestName, setGuestName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"razorpay" | "counter">("razorpay");
  const [paymentId, setPaymentId] = useState("");
  const [digitalReceiptUrl, setDigitalReceiptUrl] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [promoMessage, setPromoMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [baristaNotes, setBaristaNotes] = useState("");
  const [pickupType, setPickupType] = useState<"walkup" | "curbside">("walkup");
  const [vehicleInfo, setVehicleInfo] = useState("");
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [confirmedOrderId, setConfirmedOrderId] = useState("");

  // Member discount: 10% if logged in
  const memberDiscountRate = user ? 0.1 : 0;
  const memberDiscount = subtotal * memberDiscountRate;

  // Delivery fee: Free for members or orders over ₹399, otherwise ₹49
  const isDeliveryFree = user !== null || subtotal >= 399 || promoDiscount > 0;
  const deliveryFee = items.length === 0 ? 0 : isDeliveryFree ? 0 : 49;

  // Tax 5% GST
  const taxableAmount = Math.max(0, subtotal - memberDiscount - promoDiscount);
  const estimatedTax = items.length === 0 ? 0 : Math.round(taxableAmount * 0.05);

  // Final Total
  const finalTotal = Math.max(0, taxableAmount + estimatedTax + deliveryFee);

  const handleApplyPromo = (e: React.FormEvent) => {
    e.preventDefault();
    const code = promoCode.trim().toUpperCase();
    if (!code) return;

    if (code === "BREW10" || code === "WELCOME") {
      const discount = Math.round(subtotal * 0.1);
      setPromoDiscount(discount);
      setPromoMessage({ text: "Promo code applied! 10% discount added." });
    } else if (code.startsWith("BREWCARE")) {
      const discount = Math.min(subtotal, 50);
      setPromoDiscount(discount);
      setPromoMessage({ text: "❤️ Guest Care Recovery Credit applied! ₹50 courtesy discount added." });
    } else if (code === "FREESHIP") {
      setPromoDiscount(49);
      setPromoMessage({ text: "Free sanctuary delivery code applied!" });
    } else {
      setPromoMessage({ text: "Invalid promo code. Try 'BREW10', 'WELCOME', or your 'BREWCARE' code", error: true });
    }
  };

  const handlePlaceOrder = async () => {
    if (items.length === 0) return;

    setIsPlacingOrder(true);
    setPaymentError("");

    const customerName = guestName.trim() || user?.displayName || "Sanctuary Guest";
    const phone = customerPhone.trim();

    try {
      if (paymentMethod === "razorpay") {
        // 1. Request server to create Razorpay Order
        const orderRes = await fetch("/api/payments/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: finalTotal,
            currency: "INR",
            customerName,
            customerPhone: phone,
            vanLocationName: vanLocation.spotName,
          }),
        });

        if (!orderRes.ok) {
          const errData = await orderRes.json();
          throw new Error(errData.error || "Payment gateway connection failed");
        }

        const orderData = await orderRes.json();

        // 2. Open Razorpay Checkout modal (UPI / GPay / PhonePe / Cards)
        await openRazorpayCheckout({
          keyId: orderData.keyId,
          orderId: orderData.orderId,
          amount: orderData.amount,
          customerName,
          customerPhone: phone,
          customerEmail: user?.email || "guest@brew.cafe",
          onSuccess: async (rzpResponse) => {
            // Verify payment signature
            await fetch("/api/payments/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(rzpResponse),
            });

            // Create order with verified payment
            const newOrderId = createOrder({
              customerName,
              customerPhone: phone,
              items: [...items],
              notes: baristaNotes,
              totalAmount: finalTotal,
              pickupType,
              vehicleInfo: pickupType === "curbside" ? vehicleInfo : undefined,
              vanLocationName: vanLocation.spotName,
              paymentStatus: "paid",
              paymentId: rzpResponse.razorpay_payment_id,
              paymentMethod: "Razorpay (UPI / Cards)",
            });

            // Format WhatsApp digital receipt
            const receiptText = formatWhatsAppReceipt({
              orderId: newOrderId,
              orderNumber: newOrderId.replace(/^ord-/, "").split("-")[0] || "101",
              customerName,
              customerPhone: phone,
              items: items.map((i) => ({ name: i.name, price: i.price, quantity: i.quantity })),
              totalAmount: finalTotal,
              vanLocationName: vanLocation.spotName,
              paymentId: rzpResponse.razorpay_payment_id,
              pickupType,
              vehicleInfo,
              createdAt: Date.now(),
            });
            const waUrl = getWhatsAppReceiptUrl(phone, receiptText);

            setDigitalReceiptUrl(waUrl);
            setPaymentId(rzpResponse.razorpay_payment_id);
            setConfirmedOrderId(newOrderId);
            setOrderConfirmed(true);
            setIsPlacingOrder(false);

            confetti({
              particleCount: 80,
              spread: 70,
              origin: { y: 0.6 },
              colors: ["#DFAB6C", "#C88C50", "#F4EFE6", "#FFFFFF"],
            });

            clearCart();
          },
          onDismiss: () => {
            setIsPlacingOrder(false);
          },
          onError: () => {
            setIsPlacingOrder(false);
            setPaymentError("Payment was cancelled or failed. Please try again.");
          },
        });
      } else {
        // Counter payment
        const newOrderId = createOrder({
          customerName,
          customerPhone: phone,
          items: [...items],
          notes: baristaNotes,
          totalAmount: finalTotal,
          pickupType,
          vehicleInfo: pickupType === "curbside" ? vehicleInfo : undefined,
          vanLocationName: vanLocation.spotName,
          paymentStatus: "pending",
          paymentMethod: "Pay at Van Counter",
        });

        const receiptText = formatWhatsAppReceipt({
          orderId: newOrderId,
          orderNumber: newOrderId.replace(/^ord-/, "").split("-")[0] || "101",
          customerName,
          customerPhone: phone,
          items: items.map((i) => ({ name: i.name, price: i.price, quantity: i.quantity })),
          totalAmount: finalTotal,
          vanLocationName: vanLocation.spotName,
          paymentId: "Counter Payment",
          pickupType,
          vehicleInfo,
          createdAt: Date.now(),
        });
        const waUrl = getWhatsAppReceiptUrl(phone, receiptText);

        setDigitalReceiptUrl(waUrl);
        setPaymentId("Pay Upon Pickup");
        setConfirmedOrderId(newOrderId);
        setOrderConfirmed(true);
        setIsPlacingOrder(false);

        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
          colors: ["#DFAB6C", "#C88C50", "#F4EFE6", "#FFFFFF"],
        });

        clearCart();
      }
    } catch (err: unknown) {
      setIsPlacingOrder(false);
      const msg = err instanceof Error ? err.message : "Payment processing failed";
      setPaymentError(msg);
    }
  };

  // 3 popular suggestions for empty state
  const quickSuggestions = MENU_ITEMS.slice(0, 3);

  return (
    <main className="relative w-full min-h-screen bg-[#1A110B] text-[#F4EFE6] overflow-x-clip flex flex-col justify-start select-none">
      {/* Background radial gradient */}
      <div
        className="fixed inset-0 pointer-events-none -z-20"
        style={{
          background:
            "radial-gradient(ellipse 95% 80% at 65% 30%, #382012 0%, #1E130D 35%, #140D08 75%, #0B0704 100%)",
        }}
      />
      <div className="fixed top-1/4 right-1/4 w-[600px] h-[600px] bg-[#D48F47]/10 rounded-full blur-[160px] pointer-events-none -z-10" />

      {/* Top Header */}
      <Header />

      {/* Main Container */}
      <div className="relative w-full max-w-[1400px] mx-auto pt-28 sm:pt-36 pb-20 px-6 sm:px-10 lg:px-14 flex-1">
        {/* Back Link & Title */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <Link
              href="/menu"
              className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-[#8C7C70] hover:text-[#DFAB6C] transition-colors mb-2 group cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-1" />
              <span>Back to Menu</span>
            </Link>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-serif font-bold text-white tracking-tight">
              Your Sanctuary Cart
            </h1>
          </div>

          {items.length > 0 && (
            <div className="flex items-center gap-4">
              <span className="text-xs text-[#8C7C70] font-sans">
                {totalItems} {totalItems === 1 ? "item" : "items"} selected
              </span>
              <button
                onClick={clearCart}
                className="text-xs text-red-400/80 hover:text-red-300 hover:underline transition-colors cursor-pointer"
              >
                Clear all
              </button>
            </div>
          )}
        </div>

        {/* Empty State */}
        {items.length === 0 && !orderConfirmed ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center text-center py-16 px-6 max-w-lg mx-auto bg-[#24170F]/50 backdrop-blur-md rounded-3xl border border-white/5 shadow-2xl"
          >
            <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-6 text-[#DFAB6C]">
              <ShoppingBag className="w-10 h-10 stroke-[1.5]" />
            </div>
            <h2 className="text-2xl font-serif font-medium text-white mb-2">
              Your Cup is Empty
            </h2>
            <p className="text-sm text-[#8C7C70] max-w-sm mb-8 leading-relaxed font-sans">
              You haven&apos;t added any items to your order yet. Explore our handcrafted roasts, artisanal teas, and fresh gourmet desserts.
            </p>
            <Link
              href="/menu"
              className="bg-[#DFAB6C] text-[#1A110B] font-bold text-sm px-8 py-3 rounded-full hover:bg-white hover:shadow-[0_0_25px_rgba(223,171,108,0.4)] transition-all duration-300 transform active:scale-95 flex items-center gap-2 cursor-pointer"
            >
              <span>Explore Full Menu</span>
              <ArrowRight className="w-4 h-4" />
            </Link>

            {/* Quick Add Recommendations */}
            <div className="w-full mt-12 pt-8 border-t border-white/5 text-left">
              <p className="text-xs uppercase tracking-wider font-semibold text-[#8C7C70] mb-4">
                Popular Recommendations
              </p>
              <div className="space-y-3">
                {quickSuggestions.map((sug) => (
                  <div
                    key={sug.id}
                    className="flex items-center justify-between p-3 rounded-2xl bg-black/30 border border-white/5 hover:border-white/10 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-black/40 overflow-hidden relative shrink-0">
                        <Image
                          src={sug.image}
                          alt={sug.name}
                          fill
                          className="object-contain p-1"
                        />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white">{sug.name}</p>
                        <p className="text-xs text-[#DFAB6C] font-mono">₹{sug.price}</p>
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        addItem({
                          id: sug.id,
                          name: sug.name,
                          price: sug.price,
                          image: sug.image,
                          category: sug.categoryLabel,
                        })
                      }
                      className="px-3 py-1.5 rounded-lg bg-[#3D2619] hover:bg-[#DFAB6C] hover:text-[#1A110B] text-xs font-semibold text-[#F4EFE6] transition-colors cursor-pointer"
                    >
                      + Add
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        ) : items.length > 0 && !orderConfirmed ? (
          /* Filled Cart State: 2-Column Responsive Layout */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
            {/* Left Column: Cart Items List & Notes (7 cols on lg) */}
            <div className="lg:col-span-7 xl:col-span-8 space-y-4">
              <AnimatePresence>
                {items.map((item) => (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:p-5 rounded-3xl bg-[#24170F]/70 backdrop-blur-md border border-white/10 shadow-lg hover:border-white/15 transition-all"
                  >
                    {/* Item Image & Info */}
                    <div className="flex items-center gap-4">
                      <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-black/40 border border-white/5 relative overflow-hidden shrink-0 flex items-center justify-center">
                        <Image
                          src={item.image}
                          alt={item.name}
                          fill
                          sizes="96px"
                          className="object-contain p-2 hover:scale-105 transition-transform duration-300"
                        />
                      </div>
                      <div className="flex flex-col">
                        {item.category && (
                          <span className="text-[10px] uppercase tracking-wider font-semibold text-[#8C7C70] mb-0.5">
                            {item.category}
                          </span>
                        )}
                        <h3 className="font-serif font-bold text-lg sm:text-xl text-white">
                          {item.name}
                        </h3>
                        <p className="text-xs sm:text-sm text-[#DFAB6C] font-mono mt-0.5 font-medium">
                          ₹{item.price} each
                        </p>
                      </div>
                    </div>

                    {/* Quantity Stepper & Line Total */}
                    <div className="flex items-center justify-between sm:justify-end gap-6 pt-2 sm:pt-0 border-t sm:border-t-0 border-white/5">
                      {/* Stepper */}
                      <div className="flex items-center rounded-xl bg-black/50 border border-white/10 p-1">
                        <button
                          onClick={() => updateQuantity(item.id, -1)}
                          aria-label="Decrease quantity"
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8C7C70] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-9 text-center font-mono font-bold text-sm text-white">
                          {item.quantity}
                        </span>
                        <button
                          onClick={() => updateQuantity(item.id, 1)}
                          aria-label="Increase quantity"
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8C7C70] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Line Total */}
                      <div className="text-right min-w-[75px]">
                        <p className="text-base sm:text-lg font-bold text-white font-mono">
                          ₹{(item.price * item.quantity).toLocaleString("en-IN")}
                        </p>
                      </div>

                      {/* Delete Button */}
                      <button
                        onClick={() => removeItem(item.id)}
                        aria-label={`Remove ${item.name}`}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-[#8C7C70] hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {/* Pickup Mode (Walk-up Window vs Curbside) */}
              <div className="p-5 rounded-3xl bg-[#24170F]/60 backdrop-blur-md border border-white/10 mt-6">
                <label className="block text-xs uppercase tracking-wider font-semibold text-[#8C7C70] mb-3">
                  How would you like to collect your brew?
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <button
                    type="button"
                    onClick={() => setPickupType("walkup")}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                      pickupType === "walkup"
                        ? "bg-[#3D2619] border-[#DFAB6C] text-white shadow-md"
                        : "bg-black/30 border-white/5 text-[#8C7C70] hover:text-white"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white">🚶 Walk-up Window</span>
                      {pickupType === "walkup" && <span className="w-2 h-2 rounded-full bg-[#DFAB6C]" />}
                    </div>
                    <p className="text-[11px] text-[#C4B4A8]">Pick up directly at the van serving counter</p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPickupType("curbside")}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                      pickupType === "curbside"
                        ? "bg-[#3D2619] border-[#DFAB6C] text-white shadow-md"
                        : "bg-black/30 border-white/5 text-[#8C7C70] hover:text-white"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-xs text-white">🚗 Curbside Delivery</span>
                      {pickupType === "curbside" && <span className="w-2 h-2 rounded-full bg-[#DFAB6C]" />}
                    </div>
                    <p className="text-[11px] text-[#C4B4A8]">Barista brings coffee to your car parked nearby</p>
                  </button>
                </div>

                {pickupType === "curbside" && (
                  <div className="mt-3 pt-3 border-t border-white/5">
                    <label className="block text-[11px] uppercase tracking-wider font-semibold text-[#DFAB6C] mb-1">
                      Vehicle Description (Make, Color, Hazard Lights)
                    </label>
                    <input
                      type="text"
                      value={vehicleInfo}
                      onChange={(e) => setVehicleInfo(e.target.value)}
                      placeholder="e.g. Silver Honda Civic, Hazard lights on"
                      className="w-full bg-black/40 rounded-xl border border-white/10 px-3.5 py-2 text-xs text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C]"
                    />
                  </div>
                )}
              </div>

              {/* Customer Name Input Card */}
              <div className="p-5 rounded-3xl bg-[#24170F]/50 backdrop-blur-md border border-white/10 mt-4">
                <label className="block text-xs uppercase tracking-wider font-semibold text-[#8C7C70] mb-1.5">
                  Your Name (for Token Callout & Reviews)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    placeholder="Enter your name"
                    className="w-full bg-black/40 rounded-2xl border border-white/10 px-4 py-3 pr-10 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors"
                  />
                  {guestName && (
                    <button
                      type="button"
                      onClick={() => setGuestName("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8C7C70] hover:text-white p-1 rounded-md transition-colors cursor-pointer"
                      title="Clear name"
                      aria-label="Clear name"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-[#8C7C70] mt-1.5">
                  Displayed on the live outdoor board and enables verified reviews under your name.
                </p>
              </div>

              {/* Customer Mobile Phone (For WhatsApp Digital Receipt) */}
              <div className="p-5 rounded-3xl bg-[#24170F]/50 backdrop-blur-md border border-white/10 mt-4">
                <label className="block text-xs uppercase tracking-wider font-semibold text-[#8C7C70] mb-1.5 flex items-center justify-between">
                  <span>Mobile Phone (Instant WhatsApp Receipt)</span>
                  <span className="text-[10px] text-[#DFAB6C] font-semibold">Live Buzz Tracker</span>
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-4 text-xs font-mono text-[#DFAB6C] font-bold">
                    +91
                  </span>
                  <input
                    type="tel"
                    maxLength={10}
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value.replace(/\D/g, ""))}
                    placeholder="98765 43210"
                    className="w-full bg-black/40 rounded-2xl border border-white/10 pl-14 pr-4 py-3 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors font-mono"
                  />
                </div>
                <p className="text-[11px] text-[#8C7C70] mt-1.5">
                  Instant itemized tax invoice & buzzer status link sent directly to your phone.
                </p>
              </div>

              {/* Payment Method Selector */}
              <div className="p-5 rounded-3xl bg-[#24170F]/50 backdrop-blur-md border border-white/10 mt-4">
                <label className="block text-xs uppercase tracking-wider font-semibold text-[#8C7C70] mb-3">
                  Select Payment Method
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("razorpay")}
                    className={`p-3.5 rounded-2xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      paymentMethod === "razorpay"
                        ? "bg-[#DFAB6C]/15 border-[#DFAB6C] text-white shadow-md"
                        : "bg-black/30 border-white/5 text-[#8C7C70] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-bold text-xs text-white flex items-center gap-1.5">
                        <Smartphone className="w-4 h-4 text-[#DFAB6C]" />
                        <span>UPI & Cards (Razorpay)</span>
                      </span>
                      {paymentMethod === "razorpay" && (
                        <span className="w-2 h-2 rounded-full bg-[#DFAB6C]" />
                      )}
                    </div>
                    <p className="text-[10px] text-[#C4B4A8]">
                      Google Pay, PhonePe, Paytm, Cards, NetBanking
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaymentMethod("counter")}
                    className={`p-3.5 rounded-2xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      paymentMethod === "counter"
                        ? "bg-[#DFAB6C]/15 border-[#DFAB6C] text-white shadow-md"
                        : "bg-black/30 border-white/5 text-[#8C7C70] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-bold text-xs text-white flex items-center gap-1.5">
                        <CreditCard className="w-4 h-4 text-[#DFAB6C]" />
                        <span>Pay at Van Counter</span>
                      </span>
                      {paymentMethod === "counter" && (
                        <span className="w-2 h-2 rounded-full bg-[#DFAB6C]" />
                      )}
                    </div>
                    <p className="text-[10px] text-[#C4B4A8]">
                      Pay cash or tap card at mobile van pickup
                    </p>
                  </button>
                </div>
              </div>

              {/* Barista Notes Card */}
              <div className="p-5 rounded-3xl bg-[#24170F]/50 backdrop-blur-md border border-white/10 mt-4">
                <label className="block text-xs uppercase tracking-wider font-semibold text-[#8C7C70] mb-2">
                  Special Notes for Barista
                </label>
                <textarea
                  rows={2}
                  value={baristaNotes}
                  onChange={(e) => setBaristaNotes(e.target.value)}
                  placeholder="e.g. Extra hot, oat milk substitute, light ice on cold brew, no lid..."
                  className="w-full bg-black/40 rounded-2xl border border-white/10 p-3.5 text-sm text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] transition-colors resize-none"
                />
              </div>

              {/* Brew Club Perks Alert */}
              {!user ? (
                <div className="p-4 rounded-2xl bg-[#DFAB6C]/10 border border-[#DFAB6C]/20 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Sparkles className="w-5 h-5 text-[#DFAB6C] shrink-0" />
                    <div>
                      <p className="text-xs font-semibold text-white">
                        Join the Brew Club
                      </p>
                      <p className="text-[11px] text-[#8C7C70]">
                        Sign in to save 10% on this order and unlock complimentary sanctuary delivery.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => openAuthModal("login")}
                    className="px-4 py-2 rounded-xl bg-[#DFAB6C] text-[#1A110B] text-xs font-bold hover:bg-white transition-all shrink-0 cursor-pointer shadow-md"
                  >
                    Sign In
                  </button>
                </div>
              ) : (
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <p className="text-xs text-emerald-300">
                    <strong>Brew Club Member:</strong> 10% discount and free sanctuary delivery automatically applied!
                  </p>
                </div>
              )}
            </div>

            {/* Right Column: Order Summary & Checkout Card (5 cols on lg) */}
            <div className="lg:col-span-5 xl:col-span-4 sticky top-28 space-y-4">
              <div className="p-6 sm:p-7 rounded-3xl bg-[#24170F]/90 backdrop-blur-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
                <h2 className="font-serif font-bold text-xl text-white mb-5 pb-4 border-b border-white/10">
                  Order Summary
                </h2>

                {/* Subtotal & Breakdown */}
                <div className="space-y-3 text-sm mb-6">
                  <div className="flex justify-between text-[#EDE4DA]">
                    <span>Items Subtotal</span>
                    <span className="font-mono">₹{subtotal.toLocaleString("en-IN")}</span>
                  </div>

                  {memberDiscount > 0 && (
                    <div className="flex justify-between text-emerald-400">
                      <span>Brew Club 10% Off</span>
                      <span className="font-mono">-₹{memberDiscount.toLocaleString("en-IN")}</span>
                    </div>
                  )}

                  {promoDiscount > 0 && (
                    <div className="flex justify-between text-[#DFAB6C]">
                      <span>Promo Discount</span>
                      <span className="font-mono">-₹{promoDiscount.toLocaleString("en-IN")}</span>
                    </div>
                  )}

                  <div className="flex justify-between text-[#EDE4DA]">
                    <span>Estimated GST (5%)</span>
                    <span className="font-mono">₹{estimatedTax.toLocaleString("en-IN")}</span>
                  </div>

                  <div className="flex justify-between text-[#EDE4DA]">
                    <span>Sanctuary Delivery</span>
                    <span className="font-mono">
                      {deliveryFee === 0 ? (
                        <span className="text-emerald-400 font-semibold uppercase text-xs">
                          Free
                        </span>
                      ) : (
                        `₹${deliveryFee}`
                      )}
                    </span>
                  </div>
                </div>

                {/* Promo Code Input */}
                <form onSubmit={handleApplyPromo} className="mb-6">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Tag className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#8C7C70]" />
                      <input
                        type="text"
                        value={promoCode}
                        onChange={(e) => setPromoCode(e.target.value)}
                        placeholder="Promo code (e.g. BREW10)"
                        className="w-full pl-9 pr-3 py-2 bg-black/40 rounded-xl border border-white/10 text-xs text-white placeholder-[#8C7C70]/60 focus:outline-none focus:border-[#DFAB6C] uppercase font-mono"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-4 py-2 bg-white/10 hover:bg-white/20 text-xs font-semibold rounded-xl text-white transition-colors cursor-pointer"
                    >
                      Apply
                    </button>
                  </div>
                  {promoMessage && (
                    <p
                      className={`text-[11px] mt-1.5 ${
                        promoMessage.error ? "text-red-400" : "text-emerald-400"
                      }`}
                    >
                      {promoMessage.text}
                    </p>
                  )}
                </form>

                {/* Total */}
                <div className="pt-4 border-t border-white/10 flex justify-between items-baseline mb-6">
                  <span className="font-serif font-bold text-lg text-white">Total</span>
                  <div className="text-right">
                    <span className="font-mono font-extrabold text-2xl sm:text-3xl text-[#DFAB6C]">
                      ₹{finalTotal.toLocaleString("en-IN")}
                    </span>
                    <p className="text-[10px] text-[#8C7C70] mt-0.5">Including all taxes & service</p>
                  </div>
                </div>

                {/* Est Prep time */}
                <div className="flex items-center gap-2 p-3 rounded-xl bg-black/30 border border-white/5 text-xs text-[#8C7C70] mb-6">
                  <Clock className="w-4 h-4 text-[#DFAB6C] shrink-0" />
                  <span>Estimated brewing time: <strong>8-12 minutes</strong></span>
                </div>

                {/* Error message */}
                {paymentError && (
                  <p className="p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs text-center">
                    {paymentError}
                  </p>
                )}

                {/* Place Order CTA Button */}
                <button
                  onClick={handlePlaceOrder}
                  disabled={isPlacingOrder}
                  className="w-full py-4 px-6 bg-[#DFAB6C] text-[#1A110B] font-extrabold text-sm uppercase tracking-wider rounded-2xl hover:bg-white hover:shadow-[0_0_30px_rgba(223,171,108,0.4)] transition-all duration-300 transform active:scale-95 disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2"
                >
                  {isPlacingOrder ? (
                    <>
                      <div className="w-4 h-4 border-2 border-[#1A110B] border-t-transparent rounded-full animate-spin" />
                      <span>Processing Payment & Brewing...</span>
                    </>
                  ) : (
                    <>
                      <span>
                        {paymentMethod === "razorpay"
                          ? `Pay ₹${finalTotal.toLocaleString("en-IN")} via UPI / Cards`
                          : `Place Order & Pay at Van (₹${finalTotal.toLocaleString("en-IN")})`}
                      </span>
                      <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                {/* Security Badge */}
                <div className="flex items-center justify-center gap-1.5 text-[11px] text-[#8C7C70] mt-4">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>256-bit Encrypted Checkout • Verified by Razorpay</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Order Confirmed Modal */}
        <AnimatePresence>
          {orderConfirmed && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/85 backdrop-blur-md"
              />

              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="relative w-full max-w-md bg-[#24170F] rounded-3xl border border-white/10 p-6 sm:p-8 text-center text-[#F4EFE6] shadow-[0_25px_60px_rgba(0,0,0,0.8)] z-10"
              >
                <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 mx-auto flex items-center justify-center mb-5">
                  <CheckCircle2 className="w-8 h-8" />
                </div>

                <span className="text-xs uppercase tracking-widest font-mono text-[#DFAB6C]">
                  Order #{confirmedOrderId}
                </span>
                <h3 className="font-serif font-bold text-2xl sm:text-3xl text-white mt-1 mb-2">
                  Order & Payment Confirmed!
                </h3>
                <p className="text-xs sm:text-sm text-[#8C7C70] mb-5 leading-relaxed font-sans">
                  Your ticket has been beamed to the mobile van KDS screen. We are handcrafting your brew.
                </p>

                {/* Payment & Receipt Summary */}
                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 text-left text-xs space-y-2 mb-6">
                  <div className="flex justify-between text-[#8C7C70]">
                    <span>Payment Status</span>
                    <span className="text-emerald-400 font-semibold flex items-center gap-1">
                      <span>{paymentId.startsWith("pay_") ? "✅ Verified Paid (Razorpay)" : "💵 Pay at Counter"}</span>
                    </span>
                  </div>
                  {paymentId.startsWith("pay_") && (
                    <div className="flex justify-between text-[#8C7C70] text-[11px]">
                      <span>Transaction ID</span>
                      <span className="font-mono text-white/80">{paymentId}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-[#8C7C70]">
                    <span>Estimated Ready</span>
                    <span className="text-white font-mono font-medium">8 - 12 mins</span>
                  </div>
                  <div className="flex justify-between text-[#8C7C70]">
                    <span>Station</span>
                    <span className="text-white truncate max-w-[180px]">{vanLocation.spotName}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2.5">
                  {/* WhatsApp Digital Receipt Link */}
                  {digitalReceiptUrl && (
                    <a
                      href={digitalReceiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-3.5 rounded-xl bg-[#25D366] hover:bg-[#20ba5a] text-black font-extrabold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer"
                    >
                      <MessageSquare className="w-4 h-4 fill-black" />
                      <span>View WhatsApp Digital Receipt</span>
                    </a>
                  )}

                  <Link
                    href={`/order-status/${confirmedOrderId}`}
                    className="w-full py-3.5 rounded-xl bg-[#DFAB6C] hover:bg-white text-[#1A110B] font-extrabold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer"
                  >
                    <span>Open Live Digital Buzzer Tracker</span>
                    <ArrowRight className="w-4 h-4" />
                  </Link>

                  <button
                    onClick={() => {
                      setOrderConfirmed(false);
                      router.push("/menu");
                    }}
                    className="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs text-[#8C7C70] hover:text-white transition-all cursor-pointer"
                  >
                    Return to Menu
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
