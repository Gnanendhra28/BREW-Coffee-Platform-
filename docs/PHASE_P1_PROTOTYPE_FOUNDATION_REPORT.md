# Phase P1 — BREW Coffee Free Voice Prototype Foundation Report

**Date:** 2026-11-07  
**Status:** Complete & Verified  
**System:** BREW Coffee Platform — AI Voice Booking Platform  
**Operational Objective:** Zero-Cost ($0.00) Functional Browser AI Voice Prototype

---

## 1. Executive Summary

Phase P1 pivots the immediate objective of BREW Coffee to establish a **fully functional AI voice-booking prototype at zero additional cost ($0.00)**, eliminating any reliance on paid telephony minutes (Exotel) or cloud neural speech billing (Azure Speech).

By leveraging browser-native Web Speech APIs (`SpeechRecognition` and `SpeechSynthesis`) combined with the existing Next.js conversation engine, deterministic quote engine, and staff approval workflow, users can engage in live multilingual voice booking conversations directly in the web browser without generating external carrier calls or cloud API bills.

---

## 2. Reused Existing Components

The prototype foundation directly reuses the existing hardened architecture without redesigning it:

| Component | Existing File | Reused Functionality in Prototype Mode |
|---|---|---|
| **Multilingual AI Conversation Engine** | `src/lib/voiceBooking/conversationEngine.ts` | `processConversationTurn()`, multilingual state transitions (`created` -> `in_conversation` -> `awaiting_staff_approval` -> `booking_confirmed`), turn deduplication, and requirement extraction. |
| **Deterministic Quotation Engine** | `src/lib/eventBookingConcierge/quoteEngine.ts`<br/>`src/lib/voiceBooking/quotationAdapter.ts` | `generateVoiceBookingQuotation()`, 3-tier catering price calculation (Standard, Premium, Basic), logistics & equipment allocation, without fabricating quotes. |
| **Quotation HMAC Integrity** | `src/lib/voiceBooking/quotationAdapter.ts` | `createQuotationSnapshot()` and `verifyQuotationIntegrity()` ensuring cryptographic HMAC-SHA256 signature verification over all 7 material event parameters. |
| **Staff Approval Boundary** | `src/lib/auth/adminAuth.ts`<br/>`src/app/api/voice-booking/approve/route.ts` | `approveBookingByStaff()`, RBAC role enforcement (`barista`, `fleet_admin`, `admin`), atomic transition, and official booking ID creation (`enq_voice_...`). |
| **Session Repositories** | `src/lib/voiceBooking/repositories/` | `InMemoryVoiceSessionRepository` (for offline local development) and `FirestoreSessionRepository` (for cloud prototype persistence). |
| **Customer Conversation Endpoint** | `src/app/api/voice-booking/chat/route.ts` | Receives transcribed customer turns, executes conversation state machine, and returns sanitized customer projection. |
| **Mock Voice & Speech Simulators** | `src/lib/communication/providers/voiceProvider.ts`<br/>`src/lib/communication/voice/audioBridge/speechProvider.ts` | `MockVoiceProvider` and `MockSpeechProvider` providing zero-cost local simulation for automated tests. |

---

## 3. Prototype Configuration Changes

We introduced a dedicated configuration module: `src/lib/voiceBooking/prototypeConfig.ts`.

### 3.1 Operating Modes & Defaults
- **Mode Resolution**:
  - If `VOICE_PROTOTYPE_MODE` is `"true"` or `"1"` -> Prototype Mode.
  - If `NEXT_PUBLIC_VOICE_PROTOTYPE_MODE` !== `"false"` in browser -> Prototype Mode.
  - If real outbound telephony (`VOICE_BOOKING_ENABLED`) is not explicitly `"true"` -> Safe default to Prototype Mode.
- **Safety Guard**: `assertPrototypeSafetyGuard(serviceName)` actively throws if any code path attempts to contact Exotel or Azure Speech during prototype mode.
- **Preservation of Production Adapters**: `ExotelVoiceProvider`, `AzureSpeechProvider`, and `FastifyAudioBridge` remain completely intact in the repository, ready for future activation when paid provider accounts are provisioned.

---

## 4. Browser Speech Compatibility Analysis

We investigated browser-native speech interfaces and established locale mapping and compatibility detection in `src/lib/voiceBooking/browserSpeechAdapter.ts`.

### 4.1 Web Speech API Architecture

```
[Browser Microphone]
        |
        v
[SpeechRecognition / webkitSpeechRecognition]
  - STT Locales: en-IN, hi-IN, te-IN
  - Continuous: false (push-to-talk) / true
  - Emits interim and final transcripts
        |
        v
[POST /api/voice-booking/chat]
  - processConversationTurn(session, transcript)
  - Deterministic quoteEngine & snapshot HMAC
  - State machine advance
        |
        v
[SpeechSynthesis / SpeechSynthesisUtterance]
  - window.speechSynthesis.speak()
  - Native TTS Locales: en-IN, hi-IN, te-IN
  - Curated Indian female voice selection
```

### 4.2 Cross-Browser & Device Matrix

| Browser / Platform | Speech Recognition (`STT`) | Speech Synthesis (`TTS`) | Multilingual Quality (`en-IN`, `hi-IN`, `te-IN`) | Constraints / Caveats |
|---|---|---|---|---|
| **Google Chrome (Desktop)** | **Native** (`webkitSpeechRecognition`) | **Native** (`window.speechSynthesis`) | **Excellent**: Google Cloud speech models run behind Chrome's API for free; natural voices available. | Requires active internet connection for Google speech backend. |
| **Microsoft Edge (Desktop)** | **Native** (`webkitSpeechRecognition`) | **Native** (`window.speechSynthesis`) | **Excellent**: Edge provides natural neural voices (e.g. `Microsoft Neerja Online`). | Internet connection required for recognition. |
| **Chrome for Android** | **Native** (`webkitSpeechRecognition`) | **Native** (`window.speechSynthesis`) | **Excellent**: Android native Google speech stack; smooth recognition across Hindi and English. | Microphone permission prompt required on first use. |
| **Apple Safari (macOS & iOS)** | **Native** (`webkitSpeechRecognition` since v14.1) | **Native** (`window.speechSynthesis`) | **Good for English/Hindi; Variable for Telugu**: Depends on installed Apple system voices. | **iOS Gesture Mandate**: Audio capture and speech synthesis MUST be initiated by a user gesture (e.g. tapping "Mic" or "Start Conversation"). Cannot autoplay audio unprompted. |
| **Mozilla Firefox (Desktop)** | Behind config flag (`media.webspeech.recognition.enable`) | **Native** (`window.speechSynthesis`) | **Limited STT**: Firefox disables recognition by default. Text fallback provided. | Text input fallback in chat UI ensures 100% functionality even when recognition is absent. |

### 4.3 Multilingual Locales Mapped

- **English (India)**:
  - STT Locale: `en-IN`
  - TTS Locales: `["en-IN", "en-GB", "en-US"]`
- **Hindi (हिंदी)**:
  - STT Locale: `hi-IN`
  - TTS Locales: `["hi-IN", "hi"]`
- **Telugu (తెలుగు)**:
  - STT Locale: `te-IN`
  - TTS Locales: `["te-IN", "te"]`

---

## 5. External Integrations Successfully Isolated

The following external dependencies are 100% isolated and bypassed in prototype mode:
- **Exotel Outbound REST API**: Zero HTTP POST requests made to `api.in.exotel.com`.
- **Exotel AgentStream WebSockets**: Zero connections made to Exotel telephony carriers.
- **Azure Cognitive Services Speech**: Zero calls made to Azure STT or neural TTS endpoints. Zero billing meters triggered.
- **Fastify Audio Bridge Server**: No persistent WebSocket bridge deployment is needed for browser voice prototype testing.
- **DLT / Telecom Registrations**: Completely bypassed since no carrier telephony is placed.

---

## 6. Verification Results

The dedicated Phase P1 verification suite (`scripts/verify-phase-p1-prototype-foundation.ts`) passed 10/10 checks:

```
================================================================================
   BREW Coffee Platform — Phase P1 Verification Suite
   Free Voice Prototype Foundation & Zero-Cost Isolation Audit
================================================================================

--- 1. PROTOTYPE CONFIGURATION & SAFETY GUARDS ---
  ✓ 1.1 Default operating mode is prototype when real dialing is disabled
  ✓ 1.2 Prototype safety guard throws on paid service invocation
  ✓ 1.3 MockVoiceProvider operates as zero-cost simulator without external APIs

--- 2. BROWSER SPEECH ADAPTER & MULTILINGUAL LOCALES ---
  ✓ 2.1 Supported languages configure valid locales for STT and TTS
  ✓ 2.2 detectBrowserSpeechCapabilities executes safely in non-browser context
  ✓ 2.3 checkMicrophonePermission handles non-browser context safely

--- 3. CONVERSATION ENGINE & DETERMINISTIC QUOTATION ---
  ✓ 3.1 Full multi-turn booking conversation flow runs on prototype engine
  ✓ 3.2 Deterministic quotation engine produces consistent, non-fabricated quotes
  ✓ 3.3 Quotation HMAC snapshot integrity detects tampering fail-closed

--- 4. STAFF APPROVAL WORKFLOW PRESERVATION ---
  ✓ 4.1 Staff approval is strictly required before booking confirmation

================================================================================
   Phase P1 Verification Complete: 10/10 checks passed
   RESULT: ALL TESTS PASSED (SUCCESS)
================================================================================
```

### Full Regression Test Suite Status
- `npm run test:p1`: 10/10 passed
- `npm run test:p6651`: 12/12 passed
- `npm run test:p6641`: 12/12 passed
- `npm run test:p662`: 18/18 passed
- `npm run test:p661`: 10/10 passed
- `npm run typecheck && npm run lint`: 0 errors, 0 warnings

---

## 7. Remaining Implementation Steps for Browser Voice Interface

With the prototype foundation in place, the remaining implementation steps for the interactive browser voice experience are:
1. **Interactive Audio Controls**: Enhance `src/app/voice-booking/[id]/page.tsx` with a microphone button ("Push-to-Talk" / "Continuous Listening") using `createBrowserSpeechRecognizer`.
2. **Audio Visualizer & Speech State**: Add visual indicator states (`idle`, `listening`, `processing`, `speaking`, `error`).
3. **Voice Response Toggle**: Add an in-page audio mute / voice playback toggle using `createBrowserSpeechSynthesizer`.
4. **Multilingual Language Selector**: Allow live language toggling (`English`, `हिंदी`, `తెలుగు`) directly in the UI.
5. **Safari User-Gesture Optimization**: Ensure the first synthesis invocation occurs synchronously inside the user's initial click handler to unlock iOS audio playback.

---

## 8. Cost & Safety Attestation

- **Carrier Calls Placed**: 0
- **Exotel Minutes Billed**: 0 min ($0.00)
- **Azure Speech Requests Made**: 0 ($0.00)
- **Production Secrets Modified**: None
- **Files Staged / Committed / Pushed**: None
- **Operational Mode**: `VOICE_BOOKING_ENABLED=false` (Confirmed)
