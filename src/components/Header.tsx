"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  User,
  ShoppingBag,
  LogOut,
  CheckCircle2,
  Coffee,
  Tv,
  MapPin,
  ClipboardList,
  ExternalLink,
  Star,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useCart } from "@/context/CartContext";

interface HeaderProps {
  onOrderClick?: () => void;
  cartCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  cartCount: propCartCount,
}) => {
  const pathname = usePathname();
  const router = useRouter();
  const isMenuPage = pathname === "/menu";
  const isCartPage = pathname === "/cart";
  const isLocationPage = pathname === "/location";
  const isBoardPage = pathname === "/board";
  const isReviewsPage = pathname === "/reviews";
  const { user, openAuthModal, signOutUser } = useAuth();
  const { totalItems } = useCart();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const displayCartCount = propCartCount !== undefined ? Math.max(propCartCount, totalItems) : totalItems;

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const navItems = [
    { label: "Home", active: pathname === "/", href: "/" },
    { label: "Menu", active: isMenuPage, href: "/menu" },
    { label: "Van Tracker", active: isLocationPage, href: "/location" },
    { label: "Board", active: isBoardPage, href: "/board" },
    { label: "Reviews", active: isReviewsPage, href: "/reviews" },
    { label: "About Us", active: false, href: pathname === "/" ? "#about" : "/#about" },
  ];

  const handleProfileClick = () => {
    if (!user) {
      openAuthModal("login");
    } else {
      setDropdownOpen((prev) => !prev);
    }
  };

  const getUserInitial = () => {
    if (user?.displayName) return user.displayName.charAt(0).toUpperCase();
    if (user?.email) return user.email.charAt(0).toUpperCase();
    return "U";
  };

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (href === "#about" || href === "/#about") {
      if (pathname === "/") {
        e.preventDefault();
        const el = document.getElementById("about");
        if (el) {
          el.scrollIntoView({ behavior: "smooth" });
          window.history.pushState(null, "", "#about");
        }
      }
    }
  };

  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between py-6 px-6 sm:px-10 md:px-14 lg:px-16"
    >
      {/* Left: Brand Logo */}
      <Link href="/" className="flex items-center gap-2 cursor-pointer group">
        <span className="text-2xl sm:text-3xl font-extrabold tracking-[0.2em] text-white transition-opacity group-hover:opacity-90 font-sans">
          BREW
        </span>
      </Link>

      {/* Center: Glassmorphism Nav Pill */}
      <nav className="hidden md:flex items-center gap-1.5 bg-[#2A1C14]/40 backdrop-blur-md rounded-full px-2 py-1.5 shadow-2xl border border-white/10">
        {navItems.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            onClick={(e) => handleNavClick(e, item.href)}
            className={`text-xs uppercase tracking-wider font-medium px-4 py-1.5 rounded-full transition-all duration-300 ${
              item.active
                ? "bg-[#3D2619]/80 text-[#F4EFE6] shadow-[0_2px_10px_rgba(0,0,0,0.4)] font-semibold border border-white/5"
                : "text-[#8C7C70] hover:text-[#F4EFE6] hover:bg-white/5"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Right: Actions */}
      <div className="flex items-center gap-2.5 sm:gap-3.5 relative" ref={dropdownRef}>
        {/* User profile button / Avatar */}
        <div className="relative">
          <button
            onClick={handleProfileClick}
            aria-label={user ? "User Menu" : "Sign In"}
            title={user ? (user.displayName || user.email || "Account") : "Sign In"}
            className={`w-9 h-9 rounded-full flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              user
                ? "bg-[#3D2619] border-[#DFAB6C]/60 text-[#DFAB6C] hover:ring-2 hover:ring-[#DFAB6C]/40"
                : "bg-black/30 text-[#F4EFE6]/80 hover:text-white hover:bg-white/10 border-white/10"
            }`}
          >
            {user?.photoURL ? (
              <Image
                src={user.photoURL}
                alt="User Avatar"
                width={36}
                height={36}
                className="w-full h-full rounded-full object-cover"
                unoptimized
              />
            ) : user ? (
              <span className="font-bold text-xs tracking-wider">
                {getUserInitial()}
              </span>
            ) : (
              <User className="w-4 h-4 stroke-[1.75]" />
            )}
          </button>

          {/* User Dropdown Menu */}
          <AnimatePresence>
            {dropdownOpen && user && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className="absolute right-0 top-12 w-72 bg-[#24170F]/95 backdrop-blur-xl rounded-2xl border border-white/10 shadow-[0_20px_40px_rgba(0,0,0,0.7)] p-4 text-[#F4EFE6] z-50"
              >
                {/* User Info Header */}
                <div className="border-b border-white/10 pb-3 mb-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-[#8C7C70] uppercase tracking-wider font-semibold">
                      Brew Club Member
                    </p>
                    {user.isDemo && (
                      <span className="text-[9px] bg-[#DFAB6C]/20 text-[#DFAB6C] px-1.5 py-0.5 rounded font-mono">
                        DEMO
                      </span>
                    )}
                  </div>
                  <p className="font-medium text-sm text-white truncate mt-0.5">
                    {user.displayName || "Coffee Lover"}
                  </p>
                  <p className="text-xs text-[#8C7C70] truncate">
                    {user.email}
                  </p>
                </div>

                {/* Mobile Van Tools Section */}
                <div className="space-y-1 mb-3 pb-3 border-b border-white/10">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-[#8C7C70] px-2 block mb-1">
                    Van Staff & Outlets
                  </span>

                  <Link
                    href="/barista"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs text-[#EDE4DA] rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <ClipboardList className="w-3.5 h-3.5 text-[#DFAB6C]" />
                      <span>Barista Order KDS</span>
                    </div>
                    <span className="text-[9px] font-mono bg-[#DFAB6C]/20 text-[#DFAB6C] px-1.5 py-0.5 rounded">
                      VAN
                    </span>
                  </Link>

                  <Link
                    href="/board"
                    target="_blank"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs text-[#EDE4DA] rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Tv className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Outdoor Display Board</span>
                    </div>
                    <ExternalLink className="w-3 h-3 text-[#8C7C70]" />
                  </Link>

                  <Link
                    href="/location"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs text-[#EDE4DA] rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-blue-400" />
                      <span>Where&apos;s the Van Today?</span>
                    </div>
                  </Link>

                  <Link
                    href="/reviews"
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs text-[#EDE4DA] rounded-lg hover:bg-white/10 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Star className="w-3.5 h-3.5 text-[#DFAB6C]" />
                      <span>Customer Reviews</span>
                    </div>
                  </Link>
                </div>

                {/* Member Perks */}
                <div className="space-y-1 mb-3">
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-[#F4EFE6]/80 rounded-lg bg-white/5">
                    <Coffee className="w-3.5 h-3.5 text-[#DFAB6C]" />
                    <span>Member discount: <strong>10% OFF</strong></span>
                  </div>
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-[#F4EFE6]/80 rounded-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Complimentary Curbside Delivery</span>
                  </div>
                </div>

                {/* Sign Out Button */}
                <button
                  onClick={async () => {
                    setDropdownOpen(false);
                    await signOutUser();
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-black/40 hover:bg-red-500/20 text-xs font-semibold text-red-400 border border-red-500/20 hover:border-red-500/40 transition-all cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Shopping cart icon -> Navigates to /cart */}
        <Link
          href="/cart"
          aria-label="View Cart"
          className={`relative w-9 h-9 rounded-full flex items-center justify-center border transition-all duration-200 cursor-pointer ${
            isCartPage
              ? "bg-[#DFAB6C] text-[#1A110B] border-[#DFAB6C] shadow-[0_0_15px_rgba(223,171,108,0.4)]"
              : "bg-black/30 text-[#F4EFE6]/80 hover:text-white hover:bg-white/10 border-white/10"
          }`}
        >
          <ShoppingBag className="w-4 h-4 stroke-[1.75]" />
          {displayCartCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#DFAB6C] text-black font-bold text-[10px] flex items-center justify-center animate-pulse">
              {displayCartCount}
            </span>
          )}
        </Link>

        {/* Primary CTA Button */}
        <button
          onClick={() => {
            if (displayCartCount > 0) {
              router.push("/cart");
            } else {
              router.push("/menu");
            }
          }}
          className="bg-[#F4EFE6] text-[#1A110B] rounded-full px-5 sm:px-6 py-2 text-xs sm:text-sm font-semibold tracking-wide hover:bg-white hover:shadow-[0_0_20px_rgba(244,239,230,0.3)] transition-all duration-300 transform active:scale-95 cursor-pointer"
        >
          {displayCartCount > 0 ? "View Cart" : "Order Now"}
        </button>
      </div>
    </motion.header>
  );
};
