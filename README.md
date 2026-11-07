# ☕ BREW Coffee — Multilingual Voice Booking & Event Catering Platform

[![Next.js](https://img.shields.io/badge/Next.js-16.3.5-black?style=flat&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.2.8-blue?style=flat&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v4-38B2AC?style=flat&logo=tailwind-css)](https://tailwindcss.com/)
[![Firebase](https://img.shields.io/badge/Firebase-v12-FFCA28?style=flat&logo=firebase)](https://firebase.google.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)]()

> A full-stack artisanal mobile coffee platform with an AI-powered, multilingual browser voice booking concierge. Customers can describe their event in English, Hindi, or Telugu, receive deterministic package quotations, and submit booking requests for staff approval.

**Project Status:** Prototype Completed — Phases P1 to P8  
**Prototype Additional Cost:** $0.00 (Zero paid external voice or cloud speech services)  
**Primary Region:** Hyderabad, India  
**Automated Verification:** 118 / 118 top-level test executions passed across P1–P8 suites

---

## 🌟 Overview

BREW Coffee connects street-side customers, outdoor digital queue boards, mobile kitchen baristas, and an autonomous fleet operations AI engine with a browser-native voice booking concierge.

Instead of filling out static booking forms, customers can speak naturally with the concierge. The system progressively collects event requirements, validates logistical feasibility, calculates deterministic quotations across three service tiers, and submits the request for staff review.

The booking workflow implements a strict **human-in-the-loop** architecture:
1. Customer discusses event details and explicitly confirms quotation selection.
2. The booking enters `awaiting_staff_approval`.
3. Authorized staff inspects route feasibility, ingredient allocations, and quotation HMAC integrity.
4. Staff approves or rejects the booking request.
5. The customer's live dashboard updates automatically via sanitized projections.

The prototype executes browser-native Web Speech APIs (`SpeechRecognition` / `SpeechSynthesis`) at zero additional cost, without invoking paid external telephony (Exotel) or cognitive speech APIs (Azure).

---

## 🚀 Key Features

### 1. Multilingual Voice Booking Concierge
- **Supported Languages**: English (India), Hindi (`hi-IN`), and Telugu (`te-IN`).
- **Browser-Native Audio**: In-browser speech recognition and synthesis.
- **Conversation Modes**: Push-to-Talk and Hands-Free Continuous Voice.
- **Speech Controls**: Real-time transcript display, barge-in interruption, mute/unmute, and clean pause/resume controls.
- **Accessible Fallback**: Full-featured text-chat input available when microphone permissions are denied or unsupported.
- **Robust Extraction**: Supports Devanagari script, Telugu script, and Romanized Hinglish/Tenglish inputs.

### 2. Conversational Requirement Collection
The concierge progressively collects and validates all five mandatory booking parameters:
1. **Guest Count** (10–1,000 guests)
2. **Event Date** (valid future calendar date)
3. **Start Time** (06:00–23:00)
4. **Duration** (1–12 hours, within operating-day boundary)
5. **Venue Address** (serviceable Hyderabad operational radius)

### 3. Deterministic Quotation Engine
Quotation pricing is calculated mathematically using deterministic formulas rather than relying on generative model hallucinations:

| Catering Package | Price per Guest | Service Level & Equipment |
|---|---:|---|
| **Classic Brew** | ₹180 / guest | Handcrafted espresso bar, single-origin brews, teas, 1 dedicated barista |
| **Artisanal Signature** *(Recommended)* | ₹260 / guest | Full specialty espresso bar, whole milk & oat milk bar, fresh pastries, 2 baristas |
| **VIP Unlimited Bar** | ₹360 / guest | Unlimited specialty coffees, Belgian shakes, complete bakery spread, 3-barista crew |

### 4. Cryptographic Quotation Integrity Gate
- Quotations are converted into canonical material snapshots signed via **HMAC-SHA256**.
- Seven immutable pricing variables are bound to the signature.
- Dual-secret verification supports seamless server-side secret rotation (`QUOTATION_SNAPSHOT_SECRET` + `QUOTATION_SNAPSHOT_PREVIOUS_SECRET`).
- Staff approval verifies the HMAC snapshot fail-closed before confirming any reservation.

### 5. Staff Review & Role-Based Access Control (RBAC)
- Authorized staff roles: `barista`, `fleet_admin`, and `admin`.
- Filter bookings by `pending`, `approved`, `rejected`, or `all`.
- View complete turn history, language used, and material quote breakdown.
- Verify cryptographic quotation integrity prior to slot reservation.
- Rejection audits record timestamps, staff identity, and customer-facing reasons.
- Server-side cryptographic token verification (`brew_session` HTTP-only cookie).

### 6. Customer Privacy & Sanitization
- Customer projections use `toSafeCustomerVoiceSessionView`.
- Strips unmasked phone numbers, internal staff notes, staff UIDs, and provider secrets.
- Prevents internal operations data from leaking to customer-facing client browsers.

---

## 🏛️ Architecture

```text
Customer Browser (Mobile / Desktop)
      │
      ├──> Web Speech API (Recognition & Synthesis) ──┐
      └──> Accessible Text Chat Fallback ────────────┤
                                                     │
                                                     ▼
                                        Next.js App Router API
                                         /api/voice-booking/*
                                                     │
                                                     ▼
                                            Conversation Engine
                                                     │
                             ┌───────────────────────┼───────────────────────┐
                             ▼                       ▼                       ▼
                     Entity Extraction       Validation Policy       Session Repository
                             │                       │                       │
                             └───────────────────────┼───────────────────────┘
                                                     │
                                                     ▼
                                         Quotation Pricing Engine
                                                     │
                                                     ▼
                                          HMAC-SHA256 Snapshot Gate
                                                     │
                                                     ▼
                                           Customer Confirmation
                                                     │
                                                     ▼
                                          awaiting_staff_approval
                                                     │
                                                     ▼
                                           Barista KDS Dashboard
                                            (/barista & /admin)
                                                     │
                                       ┌─────────────┴─────────────┐
                                       ▼                           ▼
                                    Approve                      Reject
                                       │                           │
                                       └─────────────┬─────────────┘
                                                     │
                                                     ▼
                                         Safe Customer Projection
                                          (/voice-booking/[id])
```

### Technology Stack

| Layer | Technologies & Implementations |
|---|---|
| **Frontend Framework** | Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS |
| **Conversational Voice** | Web Speech API (`SpeechRecognition`, `SpeechSynthesis`), Audio Fallbacks |
| **Backend & Routing** | Next.js API Route Handlers (`force-dynamic`), Streaming JSON Guards |
| **Quotation & Logic** | Deterministic formulas, ingredient manifests, logistics matrices |
| **Cryptographic Security** | HMAC-SHA256 quote snapshots, JWT HMAC auth cookies, timing-safe equality |
| **Persistence Layer** | Singleton in-memory development repository (`globalThis`), Cloud Firestore |
| **Authorization** | Server-side role checks (`barista`, `fleet_admin`), PIN authentication |

---

## 📱 Application Routes

### Customer Interfaces
- `/voice-booking` — Multilingual voice booking launcher & session start
- `/voice-booking/[id]` — Interactive voice concierge console (live transcript, quote cards, confirmation)
- `/location` — Mobile coffee van live GPS locator & web catering booking form
- `/menu` — Mobile artisanal beverage menu
- `/board` — Outdoor van queue display board

### Staff & Operations Interfaces
- `/barista` — Kitchen Display System (KDS) & Voice Booking Approval Manager
- `/admin` — Fleet operations, live outbox worker metrics & booking audits
- `/login` — Secure staff authentication portal

### Voice Booking API Endpoints
- `POST /api/voice-booking/session` — Initialize a new voice booking session
- `GET /api/voice-booking/session?sessionId=...` — Retrieve sanitized session view
- `GET /api/voice-booking/session/[id]` — Retrieve session view by path parameter
- `POST /api/voice-booking/chat` — Submit a conversational speech or text turn
- `POST /api/voice-booking/approve` — Process authorized staff approval
- `POST /api/voice-booking/reject` — Process authorized staff rejection
- `GET /api/voice-booking/sessions` — Protected staff query for booking list

---

## 🛠️ Local Installation & Setup

### Prerequisites
- Node.js `20.x` or higher
- npm `10.x` or higher

### 1. Clone & Install
```bash
git clone https://github.com/Gnanendhra28/BREW-Coffee-Platform-.git
cd BREW-Coffee-Platform-
npm install
```

### 2. Environment Configuration
Copy the configuration template:
```bash
cp .env.example .env.local
```

Configure your environment variables in `.env.local`:
```bash
# General
NODE_ENV="development"
PORT="3000"
NEXT_PUBLIC_SITE_URL="http://localhost:3000"

# Prototype Safety & Zero-Cost Telephony Invariant
VOICE_BOOKING_ENABLED="false"
VOICE_PROTOTYPE_MODE="true"
NEXT_PUBLIC_VOICE_PROTOTYPE_MODE="true"

# Contact & Business Email
BUSINESS_EMAIL="catering@brewcoffee.in"
NEXT_PUBLIC_BUSINESS_EMAIL="catering@brewcoffee.in"

# Authentication & Quotation Secrets (min 32 characters)
AUTH_SECRET="brew-platform-secure-jwt-hmac-secret-key-2026"
QUOTATION_SNAPSHOT_SECRET="brew-platform-secure-quotation-hmac-key-2026"

# Development Staff PINs (Local demonstration only)
BARISTA_PIN="2026"
FLEET_ADMIN_PIN="7788"
```

> **Security Note:** Never commit `.env.local` or genuine production secrets. In production, dev PINs (`2026`, `7788`) fail closed and are strictly rejected.

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000/voice-booking](http://localhost:3000/voice-booking) to launch the voice concierge.

---

## 🧪 Verification & Test Suites

BREW Coffee includes phase-specific verification suites covering the entire customer-to-staff lifecycle:

```bash
# TypeScript Typecheck
npm run typecheck

# Code Quality & Linter
npm run lint

# Phase-Specific Prototype Test Suites
npm run test:p1  # Free Prototype Foundation & Zero-Cost Isolation (10 tests)
npm run test:p2  # Interactive Browser Voice UI & Speech Integration (9 tests)
npm run test:p3  # AI Voice Conversation & Multilingual Dialogue (10 tests)
npm run test:p4  # Booking Extraction & Deterministic Quotation (20 tests)
npm run test:p5  # Staff Approval & RBAC Boundaries (25 tests)
npm run test:p6  # Customer Booking Experience & Visibility (8 tests)
npm run test:p7  # End-to-End Quality Assurance & Boundary Scenarios (28 tests)
npm run test:p8  # Demo Readiness & Presentation Verification (8 tests)
```

**Automated Test Status:** **118 / 118 passed (100% pass rate, 0 errors).**

---

## 🎬 5-Minute Demonstration Walkthrough

1. **Launch**: Navigate to `/voice-booking` and select **English**, **Hindi**, or **Telugu**.
2. **Speak or Type**: State event requirements:
   > *"I need coffee catering for 75 guests on December 20th in Banjara Hills, starting at 2 PM for 4 hours."*
3. **Inspect Progress**: Observe the live requirement checklist update to **5 / 5 Mandatory Fields Collected**.
4. **Compare Quotations**: Review the 3 tier cards (*Classic Brew*, *Artisanal Signature*, *VIP Unlimited Bar*).
5. **Confirm**: Confirm your selected tier (*"Confirm Artisanal Signature"*). The booking transitions to `awaiting_staff_approval`.
6. **Staff Review**: Navigate to `/barista` and log in with the demo staff PIN (`2026`).
7. **Inspect & Approve**: Click on the pending inquiry, verify the **HMAC Quotation Signature**, and click **Approve Booking Request**.
8. **Customer View**: Return to the customer booking tab to see the live status update to **Confirmed & Approved**.

---

## 🔒 Security & Engineering Best Practices

- **Zero-Cost Guarantees**: `VOICE_BOOKING_ENABLED=false` prevents real outbound carrier calls.
- **Fail-Closed RBAC**: Client requests cannot forge staff approval roles; all permissions are verified via cryptographic HTTP-only session tokens.
- **HMAC Snapshot Integrity**: Any tampering with guest counts, dates, tier IDs, or total pricing invalidates the cryptographic signature and blocks approval.
- **Safe Development Isolation**: In-memory repository is anchored to `globalThis` to prevent chunk isolation in Next.js development without exposing prototype state in production.
- **Timing-Safe Equality**: HMAC signatures and security tokens use `crypto.timingSafeEqual` to prevent timing attacks.

---

## 📋 Prototype Limitations & Production Deployment Notes

- **Web Speech API Availability**: Browser speech recognition (`webkitSpeechRecognition`) requires a supported browser (Google Chrome, Microsoft Edge, Safari) and an active microphone.
- **Offline Speech**: Browser speech recognition may rely on browser-vendor cloud speech models and is not guaranteed to operate offline.
- **Development vs. Production Storage**: The development singleton `InMemoryVoiceSessionRepository` provides local zero-cost persistence. Genuine multi-instance production environments require durable datastores (Google Cloud Firestore).
- **Telephony**: Live PSTN telephone calling (Exotel) and Azure Cognitive Services remain disabled in prototype mode.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
