"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { FileText, ShieldAlert, Coffee, CreditCard, Compass, HelpCircle, ArrowLeft } from "lucide-react";
import { Header } from "../../components/Header";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#140D08] text-[#F4EFE6] font-sans selection:bg-[#DFAB6C]/30 selection:text-[#DFAB6C]">
      <Header />

      <main className="max-w-4xl mx-auto px-5 sm:px-8 pt-28 pb-20">
        {/* Navigation Breadcrumb */}
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs sm:text-sm text-[#8C7C70] hover:text-[#DFAB6C] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>

        {/* Page Hero */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-12 border-b border-white/10 pb-8"
        >
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#DFAB6C]/10 border border-[#DFAB6C]/20 text-[#DFAB6C] text-xs font-semibold tracking-wider uppercase mb-4">
            <FileText className="w-3.5 h-3.5" />
            Platform Conditions
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-serif font-light text-[#F4EFE6] tracking-tight mb-4">
            Terms of Service & Demo Usage
          </h1>
          <p className="text-[#A8988C] text-sm sm:text-base leading-relaxed max-w-2xl">
            Welcome to the BREW Coffee artisanal platform. Please review the terms governing use of this public showcase, mobile van tracking, interactive order simulators, and event concierge services.
          </p>
          <p className="text-xs text-[#8C7C70] mt-3">
            Effective: November 2026 • Platform Demonstration Edition
          </p>
        </motion.div>

        {/* Terms Sections */}
        <div className="space-y-10 text-[#C7B9AC] text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <Coffee className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">1. Public Demonstration Nature</h2>
            </div>
            <p className="mb-3">
              This deployment of BREW Coffee is a functional, full-stack demonstration system designed to showcase artisanal coffee van operations, real-time kitchen displays, multi-agent AI logistics, and digital buzzer workflows.
            </p>
            <p className="text-xs text-[#8C7C70]">
              Features and services are provided for evaluation, technology preview, and demonstration purposes. Operational schedules and menu availability are subject to active demonstration scenarios.
            </p>
          </section>

          {/* Section 2 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <CreditCard className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">2. Payment Simulation & Zero Financial Liability</h2>
            </div>
            <p className="mb-4">
              All payment integrations on this deployment operate exclusively in <strong className="text-[#DFAB6C]">Test Mode</strong> via Razorpay.
            </p>
            <div className="bg-[#140D08] p-4 rounded-xl border border-white/5 space-y-2 text-xs text-[#A8988C]">
              <p>• <strong className="text-[#F4EFE6]">No Real Currency Charged:</strong> Orders paid via online checkout use sandbox test credentials. You will never be charged real money.</p>
              <p>• <strong className="text-[#F4EFE6]">Cash on Delivery (COD) Simulation:</strong> COD selections create simulated orders on the kitchen display for live workflow testing.</p>
              <p>• <strong className="text-[#F4EFE6]">No Financial Data Stored:</strong> Credit card numbers, CVVs, and banking passwords are never requested, stored, or processed by our servers.</p>
            </div>
          </section>

          {/* Section 3 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <Compass className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">3. Mobile Van Schedules & GPS Telemetry</h2>
            </div>
            <p className="mb-3">
              The Van Tracker and Live Outlet Board display real-time coordinates, service hours, and upcoming stop schedules across Hyderabad (HITEC City, Waverock, Knowledge City) and Visakhapatnam.
            </p>
            <p className="text-xs text-[#8C7C70]">
              While GPS locations and service stops reflect active operations, physical van deployments are subject to weather, street parking regulations, and campus access permissions.
            </p>
          </section>

          {/* Section 4 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <HelpCircle className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">4. AI Concierge & Catering Estimates</h2>
            </div>
            <p className="mb-3">
              Event booking calculations, equipment recommendations, and budget estimates generated by the platform AI agents are instant automated planning aids.
            </p>
            <p className="text-xs text-[#8C7C70]">
              Official catering contracts, final commercial quotations, and booking confirmations are confirmed directly with our fleet coordinator following request submission.
            </p>
          </section>

          {/* Section 5 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <ShieldAlert className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">5. Acceptable Use & Fair Access</h2>
            </div>
            <p className="mb-3">
              To guarantee seamless performance for all showcase visitors, the platform employs distributed rate limiting powered by Upstash Redis:
            </p>
            <ul className="space-y-2 list-disc list-inside text-sm text-[#A8988C]">
              <li>Visitors agree not to perform automated denial-of-service, scraping, or rapid endpoint hammering.</li>
              <li>Requests exceeding standard interactive limits will receive HTTP 429 rate limit responses.</li>
              <li>Unauthorized attempts to tamper with staff authentication tokens, inject malicious scripts, or bypass Firestore security rules are automatically denied and logged.</li>
            </ul>
          </section>
        </div>

        {/* Footer Navigation */}
        <div className="mt-14 pt-8 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-[#8C7C70]">
          <p>© {new Date().getFullYear()} BREW Coffee Platform. Public Demonstration Edition.</p>
          <div className="flex items-center gap-6">
            <Link href="/privacy" className="hover:text-[#DFAB6C] transition-colors">Privacy Policy</Link>
            <Link href="/menu" className="hover:text-[#DFAB6C] transition-colors">Menu</Link>
            <Link href="/location" className="hover:text-[#DFAB6C] transition-colors">Van Tracker</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
