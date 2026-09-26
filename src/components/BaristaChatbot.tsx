"use client";

import React, { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Send,
  Sparkles,
  Coffee,
  Check,
  RotateCcw,
  ShoppingBag,
  ExternalLink,
  ChevronDown,
} from "lucide-react";
import confetti from "canvas-confetti";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";
import { MenuItem } from "@/data/menuData";
import { ChatMessage } from "@/lib/baristaEngine";

const INITIAL_QUICK_CHIPS = [
  "☕ Something bold & iced",
  "🍫 Sweet chocolate craving",
  "🌿 Soothing caffeine-free tea",
  "🍰 Best dessert to eat",
];

export const BaristaChatbot: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [inputMessage, setInputMessage] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [addedItemIds, setAddedItemIds] = useState<Record<string, boolean>>({});
  const [showTooltip, setShowTooltip] = useState(true);

  const { addItem } = useCart();
  const { user } = useAuth();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idCounter = useRef(10);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setMounted(true);
    });
  }, []);

  // Initial welcome message
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: "msg-init",
      sender: "barista",
      text: user?.displayName
        ? `Hello ${user.displayName}! ☕ I'm your BREW Barista Sommelier. Tell me how you're feeling, your taste preferences (sweet, strong, iced, nutty?), or what you'd like to eat, and I'll find your perfect match!`
        : "Welcome to BREW! ☕ I'm your Barista Sommelier. Tell me your taste specifications (sweet, strong, iced, nutty, low-sugar?) or what you'd like to pair, and I'll recommend the ideal drink or food for you!",
      timestamp: 0,
      quickReplies: INITIAL_QUICK_CHIPS,
    },
  ]);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, messages]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputMessage).trim();
    if (!text || isTyping) return;

    const currentId = idCounter.current++;
    const userMsgId = `user-${currentId}`;
    const newMessages: ChatMessage[] = [
      ...messages,
      {
        id: userMsgId,
        sender: "user",
        text,
        timestamp: currentId,
      },
    ];

    setMessages(newMessages);
    setInputMessage("");
    setIsTyping(true);

    try {
      const historyPayload = newMessages.slice(-6).map((m) => ({
        sender: m.sender,
        text: m.text,
      }));

      const res = await fetch("/api/barista-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: historyPayload,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to get recommendation");
      }

      const data = await res.json();
      const baristaId = idCounter.current++;

      setMessages((prev) => [
        ...prev,
        {
          id: `barista-${baristaId}`,
          sender: "barista",
          text: data.replyText,
          timestamp: baristaId,
          recommendations: data.recommendations,
          quickReplies: data.quickReplies,
        },
      ]);
    } catch (err) {
      console.error("Chat error:", err);
      const fallbackId = idCounter.current++;
      setMessages((prev) => [
        ...prev,
        {
          id: `barista-${fallbackId}`,
          sender: "barista",
          text: "I'm having a little trouble connecting to the van's coffee grinder, but our signature Affogato or Iced Latte are always supreme choices! Let me know what flavours you enjoy.",
          timestamp: fallbackId,
          quickReplies: INITIAL_QUICK_CHIPS,
        },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleAddToCart = (item: MenuItem) => {
    addItem({
      id: item.id,
      name: item.name,
      price: item.price,
      image: item.image,
      category: item.category,
    });

    setAddedItemIds((prev) => ({ ...prev, [item.id]: true }));
    setTimeout(() => {
      setAddedItemIds((prev) => ({ ...prev, [item.id]: false }));
    }, 2200);

    confetti({
      particleCount: 35,
      spread: 45,
      origin: { y: 0.85, x: 0.85 },
      colors: ["#C88C50", "#F4EFE6", "#E5A869"],
    });
  };

  const handleClearChat = () => {
    const resetId = idCounter.current++;
    setMessages([
      {
        id: `msg-reset-${resetId}`,
        sender: "barista",
        text: "Fresh brew started! What kind of flavor, mood, or drink are you in the mood for now?",
        timestamp: resetId,
        quickReplies: INITIAL_QUICK_CHIPS,
      },
    ]);
  };

  const isBaristaPage =
    (pathname && pathname.startsWith("/barista")) ||
    (typeof window !== "undefined" && window.location.pathname.startsWith("/barista"));

  // Strictly hide customer chatbot on the employee /barista page
  if (!mounted || isBaristaPage) {
    return null;
  }

  return (
    <>
      {/* 1. Floating Barista AI Trigger Button */}
      <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end pointer-events-none">
        {/* Tooltip prompt */}
        <AnimatePresence>
          {!isOpen && showTooltip && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="pointer-events-auto mb-3 max-w-[210px] bg-[#22150E]/95 border border-[#C88C50]/40 rounded-2xl p-3 shadow-2xl backdrop-blur-md relative"
            >
              <button
                onClick={() => setShowTooltip(false)}
                className="absolute top-1.5 right-1.5 text-[#8C7C70] hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
              <div className="flex items-center gap-1.5 text-[#C88C50] text-[11px] font-semibold uppercase tracking-wider mb-0.5">
                <Sparkles className="w-3 h-3" />
                <span>Barista AI</span>
              </div>
              <p className="text-[12px] text-[#EDE4DA] leading-snug">
                Tell me your taste & I&apos;ll find your dream coffee or dessert! ☕
              </p>
              <div className="absolute -bottom-1.5 right-6 w-3 h-3 bg-[#22150E] border-r border-b border-[#C88C50]/40 rotate-45" />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          onClick={() => {
            setIsOpen((prev) => !prev);
            setShowTooltip(false);
          }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          aria-label="Open Barista AI Chat"
          className="pointer-events-auto relative w-14 h-14 rounded-full bg-gradient-to-tr from-[#8E5324] via-[#C88C50] to-[#E5A869] p-[2px] shadow-[0_10px_30px_rgba(200,140,80,0.35)] flex items-center justify-center group focus:outline-none"
        >
          <div className="w-full h-full rounded-full bg-[#1E130D] flex items-center justify-center transition-colors group-hover:bg-[#150D08]">
            {isOpen ? (
              <ChevronDown className="w-6 h-6 text-[#F4EFE6]" />
            ) : (
              <div className="relative flex items-center justify-center">
                <Coffee className="w-6 h-6 text-[#C88C50] group-hover:text-white transition-colors" />
                <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#C88C50] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#E5A869]" />
                </span>
              </div>
            )}
          </div>
        </motion.button>
      </div>

      {/* 2. Glassmorphic Chat Window */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.94 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="fixed bottom-24 right-4 sm:right-6 z-50 w-[calc(100vw-2rem)] sm:w-[420px] h-[580px] max-h-[82vh] bg-[#1A110B]/95 border border-white/15 rounded-3xl shadow-[0_25px_70px_rgba(0,0,0,0.9)] backdrop-blur-2xl flex flex-col overflow-hidden select-none"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-[#22150E]/80">
              <div className="flex items-center gap-3">
                <div className="relative w-10 h-10 rounded-full bg-[#C88C50]/20 border border-[#C88C50]/40 flex items-center justify-center text-[#C88C50]">
                  <Coffee className="w-5 h-5" />
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#1A110B]" />
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-serif text-[#F4EFE6] font-semibold text-base">
                      BREW Barista AI
                    </h3>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#C88C50]/20 text-[#C88C50] font-medium">
                      Sommelier
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8C7C70]">
                    Taste & food recommendation expert
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 text-[#8C7C70]">
                <button
                  onClick={handleClearChat}
                  title="Reset Conversation"
                  className="p-1.5 rounded-full hover:bg-white/10 hover:text-white transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  title="Close Chat"
                  className="p-1.5 rounded-full hover:bg-white/10 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Chat Thread Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${
                    msg.sender === "user" ? "items-end" : "items-start"
                  }`}
                >
                  {/* Sender Name / Timestamp */}
                  <span className="text-[10px] text-[#8C7C70] mb-1 px-1">
                    {msg.sender === "user" ? "You" : "BREW Barista"}
                  </span>

                  {/* Message Bubble */}
                  <div
                    className={`max-w-[88%] rounded-2xl px-4 py-3 leading-relaxed ${
                      msg.sender === "user"
                        ? "bg-[#C88C50] text-[#140D08] font-medium rounded-br-none shadow-md"
                        : "bg-white/[0.06] border border-white/10 text-[#EDE4DA] rounded-bl-none shadow-md"
                    }`}
                  >
                    <p className="whitespace-pre-line">{msg.text}</p>
                  </div>

                  {/* Embedded Menu Item Recommendations */}
                  {msg.recommendations && msg.recommendations.length > 0 && (
                    <div className="mt-3 w-full space-y-2.5">
                      {msg.recommendations.map(({ item, reason }) => {
                        const isAdded = addedItemIds[item.id];
                        return (
                          <div
                            key={item.id}
                            className="w-full bg-[#261811]/90 border border-[#C88C50]/30 rounded-2xl p-3 flex gap-3 shadow-lg hover:border-[#C88C50]/60 transition-colors group"
                          >
                            {/* Item Image */}
                            <div className="relative w-20 h-20 rounded-xl overflow-hidden bg-black/40 flex-shrink-0">
                              <Image
                                src={item.image}
                                alt={item.name}
                                fill
                                sizes="80px"
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                              {item.badge && (
                                <span className="absolute top-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#C88C50] text-[#140D08]">
                                  {item.badge}
                                </span>
                              )}
                            </div>

                            {/* Info */}
                            <div className="flex-1 flex flex-col justify-between min-w-0">
                              <div>
                                <div className="flex items-start justify-between gap-1">
                                  <h4 className="font-serif text-[#F4EFE6] font-medium text-sm truncate">
                                    {item.name}
                                  </h4>
                                  <span className="font-sans font-bold text-xs text-[#C88C50] whitespace-nowrap">
                                    ₹{item.price}
                                  </span>
                                </div>
                                <p className="text-[11px] text-[#A09085] leading-tight line-clamp-2 mt-0.5">
                                  {reason}
                                </p>

                                {/* Notes badges */}
                                {item.notes && item.notes.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    {item.notes.slice(0, 2).map((n) => (
                                      <span
                                        key={n}
                                        className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[#C88C50]"
                                      >
                                        {n}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Action Buttons */}
                              <div className="flex items-center gap-2 mt-2">
                                <button
                                  onClick={() => handleAddToCart(item)}
                                  className={`flex-1 py-1.5 px-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all duration-200 ${
                                    isAdded
                                      ? "bg-emerald-500 text-white"
                                      : "bg-[#C88C50] text-[#140D08] hover:bg-[#E5A869]"
                                  }`}
                                >
                                  {isAdded ? (
                                    <>
                                      <Check className="w-3.5 h-3.5" />
                                      <span>Added!</span>
                                    </>
                                  ) : (
                                    <>
                                      <ShoppingBag className="w-3.5 h-3.5" />
                                      <span>Add to Cart</span>
                                    </>
                                  )}
                                </button>

                                <Link
                                  href={`/menu#${item.category}`}
                                  onClick={() => setIsOpen(false)}
                                  className="p-1.5 rounded-xl border border-white/10 text-[#8C7C70] hover:text-white hover:bg-white/10 transition-colors"
                                  title="Inspect in Menu"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </Link>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Quick Replies */}
                  {msg.quickReplies && msg.quickReplies.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {msg.quickReplies.map((chip) => (
                        <button
                          key={chip}
                          onClick={() => {
                            if (chip === "Explore Full Menu") {
                              setIsOpen(false);
                              router.push("/menu");
                            } else {
                              handleSendMessage(chip);
                            }
                          }}
                          className="text-[11px] px-2.5 py-1 rounded-full border border-[#C88C50]/30 bg-[#C88C50]/10 text-[#EDE4DA] hover:bg-[#C88C50]/20 hover:border-[#C88C50] transition-colors"
                        >
                          {chip}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Typing indicator */}
              {isTyping && (
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-full bg-[#C88C50]/20 border border-[#C88C50]/40 flex items-center justify-center text-[#C88C50] text-xs">
                    ☕
                  </div>
                  <div className="bg-white/[0.06] border border-white/10 rounded-2xl px-3.5 py-2.5 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#C88C50] animate-bounce" />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#C88C50] animate-bounce [animation-delay:0.2s]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#C88C50] animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="p-3 border-t border-white/10 bg-[#22150E]/90 flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Ask for recommendations (e.g. sweet & cold)..."
                disabled={isTyping}
                className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-3.5 py-2.5 text-xs sm:text-sm text-[#F4EFE6] placeholder-[#8C7C70] focus:outline-none focus:border-[#C88C50] transition-colors disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!inputMessage.trim() || isTyping}
                aria-label="Send message"
                className="w-10 h-10 rounded-2xl bg-[#C88C50] text-[#140D08] flex items-center justify-center hover:bg-[#E5A869] disabled:opacity-40 disabled:hover:bg-[#C88C50] transition-all flex-shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
