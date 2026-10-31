"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Shield, Lock, Eye, Database, Server, RefreshCw, Mail, ArrowLeft } from "lucide-react";
import { Header } from "../../components/Header";

export default function PrivacyPage() {
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
            <Shield className="w-3.5 h-3.5" />
            Transparency & Security
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-serif font-light text-[#F4EFE6] tracking-tight mb-4">
            Privacy Policy & Data Isolation
          </h1>
          <p className="text-[#A8988C] text-sm sm:text-base leading-relaxed max-w-2xl">
            BREW Coffee operates an artisanal mobile espresso platform with public demo capabilities. This policy outlines exactly what data we collect, how it is processed and protected, and our strict data isolation guarantees.
          </p>
          <p className="text-xs text-[#8C7C70] mt-3">
            Last Updated: November 2026 • Platform Demonstration Edition
          </p>
        </motion.div>

        {/* Policy Sections */}
        <div className="space-y-10 text-[#C7B9AC] text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <Database className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">1. Information We Collect</h2>
            </div>
            <p className="mb-4">
              When you interact with the BREW Coffee web platform, mobile ordering interface, or catering enquiry forms, we collect only the minimal data necessary to fulfill beverage requests:
            </p>
            <ul className="space-y-2 list-disc list-inside text-sm text-[#A8988C]">
              <li><strong className="text-[#F4EFE6]">Contact Information:</strong> Customer name and mobile phone number for order tracking and SMS / digital buzzer notifications.</li>
              <li><strong className="text-[#F4EFE6]">Order Details:</strong> Beverage selections, customizations (milk choices, syrups), temperature preferences, and total bill amounts.</li>
              <li><strong className="text-[#F4EFE6]">Curbside Arrival Information:</strong> Vehicle make/model or color voluntarily submitted for drive-by curbside pickup identification.</li>
              <li><strong className="text-[#F4EFE6]">Van Booking Inquiries:</strong> Organization name, event dates, guest count estimates, and campus location details for catering quotes.</li>
              <li><strong className="text-[#F4EFE6]">Customer Feedback:</strong> Voluntary star ratings, tasting notes, and public reviews submitted on the Reviews board.</li>
            </ul>
          </section>

          {/* Section 2 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <Eye className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">2. Purpose of Collection</h2>
            </div>
            <p className="mb-3">
              We process your information solely for direct operational purposes:
            </p>
            <ul className="space-y-2 list-disc list-inside text-sm text-[#A8988C]">
              <li>Transmitting drink tickets to the on-board barista Kitchen Display System (KDS).</li>
              <li>Broadcasting live order status transitions (Received → Brewing → Ready → Served) to your browser and digital buzzer.</li>
              <li>Alerting baristas when curbside vehicles arrive in the designated pickup zone.</li>
              <li>Generating instant AI concierge estimates for campus and corporate catering requests.</li>
            </ul>
            <p className="mt-3 text-xs text-[#8C7C70]">
              We never sell your data, do not use customer records for third-party advertising, and do not track users across external websites.
            </p>
          </section>

          {/* Section 3 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <Lock className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">3. PII Masking & Data Isolation</h2>
            </div>
            <p className="mb-4">
              To safeguard customer privacy across shared displays and public real-time streams, the platform enforces automated engineering guardrails:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-[#140D08] p-4 rounded-xl border border-white/5">
                <h3 className="text-xs font-semibold text-[#DFAB6C] uppercase tracking-wider mb-2">Phone Number Masking</h3>
                <p className="text-xs text-[#8C7C70]">
                  Customer phone numbers are masked before reaching server logs and public Server-Sent Event (SSE) streams (e.g., displaying as <span className="font-mono text-[#F4EFE6]">+91 ****** 8844</span>).
                </p>
              </div>
              <div className="bg-[#140D08] p-4 rounded-xl border border-white/5">
                <h3 className="text-xs font-semibold text-[#DFAB6C] uppercase tracking-wider mb-2">Firestore Security Rules</h3>
                <p className="text-xs text-[#8C7C70]">
                  Client SDK write permissions are denied on operational collections. Ledger collections, payment orders, and staff sessions can only be accessed via authenticated server route handlers.
                </p>
              </div>
            </div>
          </section>

          {/* Section 4 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <Server className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">4. Third-Party Infrastructure & Processors</h2>
            </div>
            <p className="mb-3">
              BREW Coffee leverages enterprise cloud infrastructure to provide high availability and fast response times:
            </p>
            <ul className="space-y-2 list-disc list-inside text-sm text-[#A8988C]">
              <li><strong className="text-[#F4EFE6]">Google Cloud Platform / Firebase:</strong> Secure Cloud Firestore document storage, real-time subscriptions, and security rules enforcement.</li>
              <li><strong className="text-[#F4EFE6]">Render:</strong> Zero-downtime containerized application hosting and TLS termination.</li>
              <li><strong className="text-[#F4EFE6]">Upstash Redis:</strong> High-performance distributed in-memory rate limiting and token revocation ledger.</li>
              <li><strong className="text-[#F4EFE6]">Razorpay:</strong> Digital payment gateway integration operating strictly in <span className="text-[#DFAB6C] font-semibold">Test Mode</span> for this demonstration. No real financial credentials or payment cards are billed.</li>
            </ul>
          </section>

          {/* Section 5 */}
          <section className="bg-[#1C140E] border border-white/10 rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-4 text-[#F4EFE6]">
              <RefreshCw className="w-5 h-5 text-[#DFAB6C]" />
              <h2 className="text-lg sm:text-xl font-medium font-serif">5. Data Retention & Deletion Rights</h2>
            </div>
            <p className="mb-3">
              During this interactive public demonstration period, test order submissions and ephemeral records are retained temporarily for showcase and automated test verification purposes, and are purged periodically.
            </p>
            <p className="mb-4">
              You retain the right to inspect or request the immediate purge of any record referencing your contact information or vehicle details.
            </p>
            <div className="flex items-center gap-3 p-4 rounded-xl bg-[#22160F] border border-[#DFAB6C]/20">
              <Mail className="w-5 h-5 text-[#DFAB6C] shrink-0" />
              <div>
                <p className="text-xs text-[#8C7C70]">To request immediate deletion of your demo order or contact data, email:</p>
                <a href="mailto:privacy@brew-coffee.cafe" className="text-sm font-semibold text-[#DFAB6C] hover:underline">
                  privacy@brew-coffee.cafe
                </a>
                <span className="text-xs text-[#8C7C70] ml-2">or inform the head barista at the van window.</span>
              </div>
            </div>
          </section>
        </div>

        {/* Footer Navigation */}
        <div className="mt-14 pt-8 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-[#8C7C70]">
          <p>© {new Date().getFullYear()} BREW Coffee Platform. Public Demonstration Edition.</p>
          <div className="flex items-center gap-6">
            <Link href="/terms" className="hover:text-[#DFAB6C] transition-colors">Terms of Service</Link>
            <Link href="/menu" className="hover:text-[#DFAB6C] transition-colors">Menu</Link>
            <Link href="/location" className="hover:text-[#DFAB6C] transition-colors">Van Tracker</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
