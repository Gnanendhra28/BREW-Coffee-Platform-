# BREW Coffee Platform — Phase 6.6.2 Implementation Report
## Exotel Voice Provider & Status Webhook Integration

**Date**: 2026-11-06  
**Status**: COMPLETE & VERIFIED (15/15 tests passing)  
**Safety Invariants Preserved**:
- `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
- Zero live outbound calls made.
- Zero telephony billing, numbers, or paid accounts activated.
- HMAC-SHA256 quotation integrity and staff approval gates strictly enforced.
- Zero git staging, commits, pushes, or deployments performed.

---

### 1. Executive Summary

In Phase 6.6.2, we implemented the carrier integration layer connecting the BREW Coffee Platform's voice attempt foundation to Exotel Cloud Telephony:
1. **`ExotelVoiceProvider`** (`src/lib/communication/providers/exotelVoiceProvider.ts`):
   - Implements `VoiceProvider` interface for asynchronous PSTN outbound call initiation.
   - Generates standardized HTTP Basic Authentication with `EXOTEL_API_KEY` and `EXOTEL_API_TOKEN`.
   - Normalizes customer destination phone numbers to standard format (`+91XXXXXXXXXX`).
   - Packages `attemptId` and `sessionId` into Exotel's 128-character `CustomField` parameter for end-to-end correlation.
   - Enforces strict request timeouts (10s) using `AbortController`, classifying timeouts as **UNCERTAIN** and strictly blocking automated redials to prevent double calling.
   - Bounded safe retries: Restricts automatic retries solely to pre-request DNS / connection establishment failures (`ENOTFOUND`, `ECONNREFUSED`) or HTTP 429 rate limits; never retries after request transmission or read timeout.
   - Secret Redaction: Completely strips API tokens, keys, account SIDs, and Authorization headers from all logs, diagnostic outputs, and thrown error messages.
2. **Authenticated Exotel Status Webhook** (`src/app/api/webhooks/voice/exotel/status/route.ts`):
   - Endpoint: `POST /api/webhooks/voice/exotel/status`.
   - Authenticates incoming requests via constant-time verification (`crypto.timingSafeEqual`) of `token` query parameter or `x-exotel-token` header against `EXOTEL_WEBHOOK_SECRET`.
   - Parses `application/x-www-form-urlencoded`, `multipart/form-data`, and `application/json` payloads.
   - Maps Exotel status codes (`queued`, `ringing`, `in-progress`, `answered`, `completed`, `busy`, `no-answer`, `failed`, `canceled`) to canonical internal statuses.
   - Applies state transitions using `VoiceCallAttemptRepository`:
     - Updates indexed attempts via `updateStatusByProviderCallId`.
     - Recovers unmapped attempts (e.g. worker crashed before saving `providerCallId`) via `correlateWebhookByAttemptId`.
   - Idempotently handles duplicate webhooks, out-of-order events, and preserves `terminalConflict` records.
   - Fails closed with HTTP 503 if Firestore database is uninitialized on deployed environments.

---

### 2. Environment Variables & Secret Configuration

To activate Exotel in a staging or production environment, the following environment variables are required:

| Variable Name | Required | Description | Example / Format |
| :--- | :---: | :--- | :--- |
| `EXOTEL_ACCOUNT_SID` | Yes | Exotel Account SID (found in Exotel API settings) | `brewcoffee123` |
| `EXOTEL_API_KEY` | Yes | Exotel API Key | `exo_key_abcdef0123456789` |
| `EXOTEL_API_TOKEN` | Yes | Exotel API Token | `exo_tok_9876543210fedcba` |
| `EXOTEL_SUBDOMAIN` | No | Exotel API cluster subdomain (default: `api.exotel.com`) | `api.exotel.com` or `api.in.exotel.com` |
| `EXOTEL_CALLER_ID` | Yes | Dedicated Exotel Virtual Number (ExoPhone) | `08047190000` or `+918047190000` |
| `EXOTEL_APPLET_ID` | Yes | Flow Builder Applet ID containing Voicebot Applet | `123456` |
| `EXOTEL_WEBHOOK_SECRET` | Yes | Secret token for authenticating status webhooks | `whsec_exotel_status_987654...` |
| `EXOTEL_STATUS_CALLBACK_URL` | No | Explicit callback URL override (default: `${APP_URL}/api/webhooks/voice/exotel/status`) | `https://api.brewcoffee.in/api/webhooks/voice/exotel/status` |
| `EXOTEL_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in milliseconds (default: `10000`) | `10000` |

---

### 3. Exotel Official Protocol Verification & Account Requirements

#### Verified against Exotel Official Documentation:
1. **Connect API Endpoint**:
   - `POST https://<api_key>:<api_token>@<subdomain>/v1/Accounts/<account_sid>/Calls/connect.json`
   - Form-encoded parameters:
     - `From`: Destination phone number.
     - `CallerId`: ExoPhone virtual number.
     - `Url`: `http://my.exotel.com/<account_sid>/exoml/start_voice/<applet_id>`
     - `StatusCallback`: Public webhook URL.
     - `CustomField`: Metadata string (up to 128 chars) returned in all webhooks.
     - `StatusCallbackEvents[]`: `terminal`, `answered`, `ringing`.
   - Response: JSON object with `Call.Sid` and initial status (`queued` or `in-progress`).
2. **Voicebot Applet Streaming Protocol**:
   - Bidirectional full-duplex WebSocket:
     - Endpoint: `wss://<domain>/media`
     - Audio format: Raw Linear PCM 16-bit mono little-endian in base64.
     - Frame Interval: ~100 ms.
     - Chunk size: minimum 3.2 KB, always multiples of 320 bytes.
     - Lifecycle events: `connected` / `start`, `media`, `stop`.

#### Unresolved Exotel Account & Commercial Requirements:
Before enabling live outbound calls in production, the following business prerequisites must be satisfied:
1. **TRAI DLT Principal Entity Registration**:
   - Under TRAI TCCCPR 2018 regulations, the business entity must be registered on an Indian telecom operator's DLT portal (e.g. Jio, Airtel, Vodafone Idea, or BSNL DLT).
   - Category: Service Explicit / Transactional.
2. **Dedicated ExoPhone Number Assignment**:
   - Virtual Number (VN) procured from Exotel with Bangalore/Karnataka or national domestic CLI.
   - Whitelisted against the DLT Principal Entity registration.
3. **Voicebot Applet Enablement**:
   - Confirm with Exotel account manager whether Voicebot/Audio Streaming Applet access requires an enterprise contract add-on or minimum billing tier.
4. **Public Webhook & Streaming Host**:
   - A persistent server instance (Compute Engine, Cloud Run with WebSocket support, or Kubernetes) with public HTTPS / WSS endpoint and valid SSL certificate.

---

### 4. Verification Suite Results

Dedicated Suite: `scripts/verify-phase6-6-2-exotel-voice-provider.ts` (`npm run test:p662`):
```
--- 1. OUTBOUND CALL INITIATION & PROVIDER ACCEPTANCE ---
  ✓ 1.1 ExotelVoiceProvider initiates call, sends correct auth & params, and extracts CallSid

--- 2. CUSTOMFIELD FORMATTING & PARSING ---
  ✓ 2.1 formatExotelCustomField and parseExotelCustomField round-trip JSON and delimited data

--- 3. TIMEOUT HANDLING & UNCERTAIN OUTCOME ---
  ✓ 3.1 Request timeout aborts request, classifies outcome as uncertain, and does not retry

--- 4. SAFE ERROR CLASSIFICATION & SECRET REDACTION ---
  ✓ 4.1 Exotel 401/400 errors redact sensitive tokens and mark certain rejection

--- 5. BOUNDED RETRIES ON PRE-REQUEST NETWORK FAILURE ---
  ✓ 5.1 Provider safely retries on pre-request DNS failure up to maxRetries

--- 6. AUTHENTICATED EXOTEL STATUS WEBHOOK ---
  ✓ 6.1 Webhook rejects missing token (401) and mismatched token (403)
  ✓ 6.2 Webhook accepts valid token via query param and header

--- 7. WEBHOOK LIFECYCLE STATUS TRANSITIONS ---
  ✓ 7.1 Webhook advances attempt through ringing -> answered -> completed with duration
  ✓ 7.2 Webhook transitions to terminal failure states: busy, no-answer, and failed

--- 8. IDEMPOTENT DUPLICATE & CONFLICT RESOLUTION ---
  ✓ 8.1 Repeated identical status returns idempotent_duplicate with 200 OK
  ✓ 8.2 Out-of-order lower rank event ignored; conflicting terminal event records terminalConflict

--- 9. UNMAPPED ATTEMPT RECOVERY VIA CUSTOMFIELD ---
  ✓ 9.1 Webhook with CustomField correlates unmapped attempt when worker crashed prior to persistence
  ✓ 9.2 Webhook with mismatched sessionId is rejected with 409 Conflict

--- 10. GETSTATUS AND ENDSESSION APIS ---
  ✓ 10.1 getStatus retrieves and maps Exotel Call Details
  ✓ 10.2 endSession invokes hangup API cleanly

Phase 6.6.2 Verification Complete: 15/15 checks passed (SUCCESS)
```

**Regression Test Suites**:
- `npm run test:p6612`: **7/7 PASSED**
- `npm run test:p6611`: **7/7 PASSED**
- `npm run test:p661`: **10/10 PASSED**
- `npm run typecheck`: **PASSED (0 errors)**
- `npm run lint`: **PASSED (0 errors)**
