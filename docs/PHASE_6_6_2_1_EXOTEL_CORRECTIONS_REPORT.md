# BREW Coffee Platform — Phase 6.6.2.1 Implementation Report
## Exotel API Configuration & Webhook Corrections

**Date**: 2026-11-06  
**Status**: COMPLETE & VERIFIED (18/18 tests passing)  
**Safety Invariants Preserved**:
- `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
- Zero live outbound calls made.
- Zero telephony billing, numbers, or paid accounts activated.
- HMAC-SHA256 quotation integrity and staff approval gates strictly enforced.
- Zero git staging, commits, pushes, or deployments performed.

---

### 1. Executive Summary & Targeted Corrections

In Phase 6.6.2.1, we performed a thorough inspection of the Exotel integration source code and applied targeted corrections across seven critical areas:

1. **Resolution of Call Initiation Architecture: Direct Connect Voice AI**:
   - **Resolved Approach**: Direct Connect Voice AI via `StreamUrl` and `StreamType="bidirectional"` is now the primary standard for the platform.
   - Request fields consistently supply `StreamUrl` and `StreamType` without requiring Flow Builder IVR applets or external `applet_id` configurations.
   - Flow `Url` is retained only as an explicit opt-in legacy fallback if an operator supplies `EXOTEL_APPLET_ID`.
2. **Strict India API Host Default (`https://api.in.exotel.com`)**:
   - Corrected provider host resolution to default strictly to `https://api.in.exotel.com` (Exotel Mumbai Cluster).
   - Removed silent fallback to Singapore (`api.exotel.com`).
   - Supports clean normalization of `EXOTEL_SUBDOMAIN` and `EXOTEL_API_HOST`.
3. **Realistic StatusCallback Authentication**:
   - Verified that Exotel Voice status callbacks do not support custom request headers.
   - Removed assumption of custom headers (`x-exotel-token` / `x-exotel-signature`).
   - Implemented dual-path authentication:
     - **HTTP Basic Authentication**: Embedded in the `StatusCallback` URL (`https://<user>:<pass>@domain/api/webhooks/voice/exotel/status`), verified via `Authorization: Basic ...` using constant-time `timingSafeEqual`.
     - **Ephemeral Per-Call Signed HMAC Query Token**: Signs `?token=<hmac>` using `HMAC-SHA256(secret, attemptId:sessionId)`. Avoids exposing static reusable master secrets in query strings and prevents cross-call forgery.
4. **Validation of Callback Fields (`CallSid`, `EventType`, `Status`)**:
   - Enforced strict presence and non-emptiness of `CallSid` and `Status`.
   - Validates semantic consistency between `EventType` and `Status`:
     - `EventType="terminal"` must have terminal status (`completed`, `failed`, `busy`, `no-answer`, `canceled`). Contradictory statuses (e.g. `ringing`, `in-progress`) are rejected with HTTP 400 Bad Request.
     - `EventType="answered"` must have `in-progress` or `answered` status. Contradictions are rejected with HTTP 400 Bad Request.
     - `EventType="ringing"` must have `ringing` status. Contradictions are rejected with HTTP 400 Bad Request.
5. **Strict 128-Character CustomField Limit Enforcement**:
   - In `formatExotelCustomField(attemptId, sessionId)`:
     - Formats standard JSON `{"attemptId":"...","sessionId":"..."}` when $\le 128$ chars.
     - Falls back to compact JSON `{"a":"...","s":"..."}` or delimited `"attemptId:sessionId"` when nearing the boundary.
     - Strictly throws a visible error if the combined payload cannot fit within 128 characters, preventing silent truncation.
   - In Webhook endpoint:
     - Rejects incoming callbacks with `CustomField` length $> 128$ characters with HTTP 400 Bad Request.
6. **Explicit Event Subscriptions & Terminal Handling**:
   - Subscribes explicitly via `StatusCallbackEvents[0]=terminal`, `StatusCallbackEvents[1]=answered`, `StatusCallbackEvents[2]=ringing`.
   - Preserves monotonic ranking and records conflicting terminal statuses in `terminalConflict` without corrupting authoritative state.
7. **Comprehensive Mock Verification**:
   - Added 18 unit and integration tests covering the Direct Connect Voice AI format, India cluster host, Basic Auth and ephemeral HMAC authentication, malformed/contradictory events, 128-char limit, and session/provider mismatch.

---

### 2. Environment Variables & Secret Configuration

| Variable Name | Required | Description | Example / Format |
| :--- | :---: | :--- | :--- |
| `EXOTEL_ACCOUNT_SID` | Yes | Exotel Account SID | `brewcoffee123` |
| `EXOTEL_API_KEY` | Yes | Exotel API Key | `exo_key_abcdef0123456789` |
| `EXOTEL_API_TOKEN` | Yes | Exotel API Token | `exo_tok_9876543210fedcba` |
| `EXOTEL_CALLER_ID` | Yes | Dedicated Virtual Number (ExoPhone) | `08047190000` |
| `EXOTEL_STREAM_URL` | Yes | Direct Connect Voice AI WebSocket URL | `wss://api.brewcoffee.in/voice/stream` |
| `EXOTEL_WEBHOOK_SECRET` | Yes | Secret token for HMAC signing webhook callbacks | `whsec_exotel_status_987654...` |
| `EXOTEL_WEBHOOK_USER` | Optional | Basic Auth user embedded in StatusCallback URL | `brew_webhook_user` |
| `EXOTEL_WEBHOOK_PASSWORD`| Optional | Basic Auth password embedded in StatusCallback URL | `brew_webhook_pass_888` |
| `EXOTEL_SUBDOMAIN` | No | API cluster subdomain (default: `api.in.exotel.com`) | `api.in.exotel.com` |
| `EXOTEL_STATUS_CALLBACK_URL`| No | Callback URL override (default: `${APP_URL}/api/webhooks/voice/exotel/status`)| `https://api.brewcoffee.in/api/webhooks/voice/exotel/status` |
| `EXOTEL_REQUEST_TIMEOUT_MS` | No | HTTP request timeout in ms (default: `10000`) | `10000` |

---

### 3. Exotel Official Protocol Verification & Account Requirements

#### Verified against Exotel Official Documentation:
1. **Direct Connect Voice AI**:
   - Request: `POST https://api.in.exotel.com/v1/Accounts/{AccountSid}/Calls/connect.json`
   - Form-encoded: `From`, `CallerId`, `StreamUrl`, `StreamType=bidirectional`, `StatusCallback`, `CustomField` ($\le 128$ chars), `StatusCallbackEvents[]`.
   - Host: `https://api.in.exotel.com` (India Mumbai Cluster).
2. **StatusCallback Security**:
   - Exotel voice callbacks do not support custom request headers.
   - Supported security: HTTPS + Basic Auth in URL or signed query parameter token.

#### Unresolved Exotel Account & Commercial Requirements:
1. **TRAI DLT Principal Entity Registration**: Complete registration under TRAI TCCCPR 2018 (Service Explicit / Transactional category).
2. **Dedicated ExoPhone Number**: Procure an Exotel virtual number whitelisted against the DLT entity.
3. **Voicebot Applet Enablement**: Confirm enterprise platform terms and streaming permissions with an Exotel account manager for bidirectional WebSocket audio streaming.
4. **Persistent WebSocket Bridge**: Provision a persistent server environment (e.g. Cloud Run with WebSocket support or Compute Engine) with valid SSL certificates for live audio streaming.

---

### 4. Verification Suite Results

Dedicated Suite: `scripts/verify-phase6-6-2-exotel-voice-provider.ts` (`npm run test:p662`):
```
--- 1. DIRECT CONNECT VOICE AI & INDIA HOST DEFAULT ---
  ✓ 1.1 ExotelVoiceProvider defaults strictly to India host (https://api.in.exotel.com) and sends StreamUrl/StreamType

--- 2. CUSTOMFIELD 128-CHAR LIMIT & SERIALIZATION FORMAT ---
  ✓ 2.1 formatExotelCustomField strictly enforces 128-character limit and format

--- 3. TIMEOUT HANDLING & UNCERTAIN OUTCOME ---
  ✓ 3.1 Request timeout aborts request, classifies outcome as uncertain, and does not retry

--- 4. SAFE ERROR CLASSIFICATION & SECRET REDACTION ---
  ✓ 4.1 Exotel 401/400 errors redact sensitive tokens and mark certain rejection

--- 5. BOUNDED RETRIES ON PRE-REQUEST NETWORK FAILURE ---
  ✓ 5.1 Provider safely retries on pre-request DNS failure up to maxRetries

--- 6. WEBHOOK AUTHENTICATION (NO CUSTOM HEADERS) ---
  ✓ 6.1 Webhook rejects missing credentials (401) and invalid credentials (403)
  ✓ 6.2 Webhook accepts HTTP Basic Auth and per-call ephemeral HMAC signed query token

--- 7. MALFORMED & CONTRADICTORY CALLBACK VALIDATION ---
  ✓ 7.1 Webhook rejects missing CallSid or Status with 400 Bad Request
  ✓ 7.2 Webhook rejects contradictory EventType and Status combinations with 400 Bad Request
  ✓ 7.3 Webhook rejects CustomField exceeding 128 characters with 400 Bad Request

--- 8. WEBHOOK LIFECYCLE STATUS TRANSITIONS ---
  ✓ 8.1 Webhook advances attempt through ringing -> answered -> completed with duration
  ✓ 8.2 Webhook transitions to terminal failure states: busy, no-answer, and failed

--- 9. IDEMPOTENT DUPLICATE & CONFLICT RESOLUTION ---
  ✓ 9.1 Repeated identical status returns idempotent_duplicate with 200 OK
  ✓ 9.2 Out-of-order lower rank event ignored; conflicting terminal event records terminalConflict

--- 10. UNMAPPED ATTEMPT RECOVERY & MISMATCH REJECTION ---
  ✓ 10.1 Webhook with CustomField correlates unmapped attempt when worker crashed prior to persistence
  ✓ 10.2 Webhook with mismatched sessionId is rejected with 409 Conflict

--- 11. GETSTATUS AND ENDSESSION APIS ---
  ✓ 11.1 getStatus retrieves and maps Exotel Call Details on India cluster
  ✓ 11.2 endSession invokes hangup API cleanly on India cluster

Phase 6.6.2.1 Verification Complete: 18/18 checks passed (SUCCESS)
```

**Regression Test Suites**:
- `npm run test:p6612`: **7/7 PASSED**
- `npm run test:p6611`: **7/7 PASSED**
- `npm run test:p661`: **10/10 PASSED**
- `npm run typecheck`: **PASSED (0 errors)**
- `npm run lint`: **PASSED (0 errors)**
