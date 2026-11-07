# Phase 6.6.6.1 — Final Provider Compatibility Corrections

**Date:** 2026-11-06  
**Status:** Complete & Verified  
**System:** BREW Coffee Platform — AI Voice Booking Platform  
**Operational Mode:** `VOICE_BOOKING_ENABLED=false` (Strictly Preserved)

---

## 1. Executive Summary

Phase 6.6.6.1 applies targeted compatibility corrections and operational qualifications identified during the final readiness review. It aligns Exotel's REST API endpoint with the documented Connect Voice AI specification, corrects Azure Speech quota documentation, clarifies WebSocket hosting architecture, and records the exact regulatory and technical questions requiring written confirmation from Exotel.

---

## 2. Technical Corrections Implemented

### 2.1 Exotel Connect Voice AI Endpoint Alignment

- **Previous State**: In `src/lib/communication/providers/exotelVoiceProvider.ts:302`, the provider constructed the endpoint as:
  ```ts
  https://${this.subdomain}/v1/Accounts/${encodeURIComponent(this.accountSid)}/Calls/connect.json
  ```
- **Finding**: While legacy Exotel telephony endpoints (such as classic Call Connect or SMS) supported `.json` and `.xml` extensions, the current official Exotel Connect Voice AI (AgentStream) documentation specifies:
  ```
  POST /v1/Accounts/{account_sid}/Calls/connect
  ```
  without the `.json` extension.
- **Correction Applied**: Updated `getConnectUrl()` in `src/lib/communication/providers/exotelVoiceProvider.ts` to generate:
  ```ts
  https://${this.subdomain}/v1/Accounts/${encodeURIComponent(this.accountSid)}/Calls/connect
  ```
- **Test Alignment**: Updated assertion in `scripts/verify-phase6-6-2-exotel-voice-provider.ts` to verify the `/Calls/connect` endpoint.
- **Preserved Invariants**:
  - Strict India cluster enforcement (`https://api.in.exotel.com`).
  - HTTP Basic Authentication (`Authorization: Basic ...`).
  - Direct Connect Voice AI parameters (`StreamUrl`, `StreamType="bidirectional"`).
  - StreamUrl token signing and 600-character boundary validation.
  - Safe error classification and secret redaction.
  - Pre-request retry vs read-timeout uncertain outcome classification.

### 2.2 Azure Cognitive Services Concurrency Clarification

- **Free Tier (F0)**: Documented quota allows strictly **1 concurrent real-time STT request** (and 5 audio hours per month). Suitable only for single-user dev testing; prone to throttling under any concurrent load.
- **Standard Tier (S0)**: Documented default quota is **100 concurrent real-time requests** per Speech resource.
- **Capacity Planning Target**: Our **20 concurrent streams** metric is an internal application capacity target for initial van fleet rollout, not an Azure quota limit. Azure S0 supports 100 concurrent streams out of the box without requiring custom quota increases.
- **Application Configuration**: No arbitrary concurrency caps were added to the application code without empirical evidence.

### 2.3 Hosting and Capacity Assumptions

- **Cloud Run WebSocket Capability**: Google Cloud Run natively supports WebSockets with session affinity and request timeouts up to 60 minutes.
- **Architectural Isolation Decision**: Packaging the Fastify WebSocket audio bridge as an independent service (`npm run start:voice-bridge`) is an **architectural isolation decision**, not a platform constraint. It prevents persistent, stateful, binary-audio WebSocket streaming from consuming Next.js application server memory and thread pools.
- **Provisional Sizing**: 512 MB RAM and 1 vCPU are documented as **provisional estimates** pending empirical load benchmarking.
- **Capacity Testing Metrics**: The following 7 metrics must be captured during an upcoming load benchmark:
  1. **Memory RSS**: Resident Set Size growth per concurrent audio stream.
  2. **CPU Utilization**: CPU load percentage per active stream during simultaneous STT/TTS.
  3. **Active Connections**: Peak stable concurrent WebSocket sessions.
  4. **Audio Buffer Latency**: Frame queuing delay in the Exotel outbound packetizer.
  5. **STT Latency**: End-to-end recognition delay from voice input to transcribed text.
  6. **TTS Latency**: First-packet audio response latency from assistant turn completion.
  7. **Disconnect Rate**: Socket hangup or unexpected termination rate during packet bursts.

---

## 3. Regulatory Qualification & Exotel Written Inquiries

### 3.1 Service vs. Promotional Classification

- Calls placed by the AI voice concierge to confirm customer-requested event catering bookings are classified as **transactional/service-implicit** communications.
- Whether DLT Principal Entity (PE) registration, commercial telemarketing 140-series headers, or DLT registration fees are universally mandatory for this specific service-implicit use case depends on carrier interpretation and telecom operator regulations.

### 3.2 Written Questions to Exotel

The following questions must be submitted to the assigned Exotel account manager for written confirmation:

1. **Endpoint Specification**: Does the Connect Voice AI endpoint accept `POST /v1/Accounts/{account_sid}/Calls/connect` exclusively, or is `connect.json` also supported?
2. **Traffic Classification**: For outbound voice calls confirming customer-initiated event catering requests, does Exotel classify this traffic as transactional/service or promotional telemarketing?
3. **DLT & ExoPhone Prerequisites**: Does this transactional audio stream require enterprise DLT PE registration and approved voice templates, or is a standard provisioned ExoPhone DID (e.g. 080 series) sufficient?
4. **StreamUrl Query Parameters**: Are custom query parameters appended to `StreamUrl` (e.g. `?token=...&attemptId=...&sessionId=...`) passed through intact to the WebSocket handshake without stripping or truncation?
5. **AgentStream Metadata**: Are `CustomField` values or custom parameters exposed in the `start` event (`start.custom_parameters`) during the WebSocket stream lifecycle?

---

## 4. Verification Suite Results

All relevant Exotel and voice lifecycle test suites pass cleanly:

```
================================================================================
   Phase 6.6.2.1 Exotel Voice Provider Verification
   Result: 18/18 checks passed (SUCCESS)
================================================================================

================================================================================
   Phase 6.6.5.1 Controlled Test Authorization & Safety
   Result: 12/12 checks passed (SUCCESS)
================================================================================

================================================================================
   Phase 6.6.4.1 Voice Bridge Integration Gap Closure
   Result: 12/12 checks passed (SUCCESS)
================================================================================
```

### Full Regression Suite
- `npm run test:p6651`: 12/12 passed
- `npm run test:p6641`: 12/12 passed
- `npm run test:p663`: All passed
- `npm run test:p662`: 18/18 passed
- `npm run test:p6612`: 7/7 passed
- `npm run test:p6611`: 7/7 passed
- `npm run test:p661`: 10/10 passed
- `npm run typecheck && npm run lint`: 0 errors, 0 warnings

---

## 5. Remaining Provider-Side Blockers

Prior to placing the first real controlled test call, the following external items must be completed:
1. **Exotel Account Activation**: Connect Voice AI streaming feature activated by Exotel account manager.
2. **ExoPhone Provisioning**: Dedicated India virtual number assigned and caller ID approved.
3. **Written Answers**: Formal response to the 5 Exotel technical inquiries.
4. **Azure S0 Resource**: Provisioning of Azure Speech resource in `centralindia` (Pune).
5. **Bridge Deployment**: Hosting Fastify bridge on persistent infrastructure with public TLS and WebSocket support.
