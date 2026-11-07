# Phase 6.6.4.1 — Voice Bridge Integration Gap Closure Report

## Executive Summary

Phase 6.6.4.1 closes the operational and architectural integration gaps identified during the Phase 6.6.4 preflight assessment:
1. **Dynamic Exotel Stream-Token Handoff**: `ExotelVoiceProvider` dynamically generates a single-use, attempt-bound, session-bound stream token and securely appends it along with `attemptId` and `sessionId` to `StreamUrl` via safe URL construction, while strictly enforcing Exotel's 600-character limit and redacting all tokens from error messages and logs.
2. **Standalone Fastify Bridge Entrypoint**: Created `src/server/voiceBridgeServer.ts` and added `npm run start:voice-bridge` to run the Fastify WebSocket audio bridge independently of Next.js, with configurable host/port (defaulting to `0.0.0.0:18091`), startup configuration validation, and graceful SIGTERM/SIGINT shutdown.
3. **Firestore Nonce TTL Readiness**: Enhanced `FirestoreTokenNonceRegistry` to persist `expireAt` as a Firestore Timestamp, and updated `firestore.indexes.json` with a TTL `fieldOverride` for background document deletion while preserving transactional atomic consumption as the real-time replay-prevention mechanism.
4. **Readiness Assumptions Clarified**: Documented Cloud Run WebSocket timeout/billing realities, separate bridge process requirements, codec-dependent packet duration mathematics, and account-level carrier pricing verification.

All 12 checks in Phase 6.6.4.1 pass cleanly, and all 191 legacy voice tests (Phases 6.6.1 through 6.6.3) remain 100% green with zero TypeScript or lint errors.

---

## 1. Dynamic Exotel Stream-Token Handoff

### Implementation Details
- **Token Generation**: In [`ExotelVoiceProvider.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/providers/exotelVoiceProvider.ts#L350-L395), before initiating an outbound call, the provider checks for `streamSecret` (falling back safely through `EXOTEL_STREAM_SECRET`, `STREAM_SECRET_KEY`, `AUTH_SECRET`, etc.).
- **URL Parameter Construction**: Using standard `URL` objects, the provider appends:
  - `token`: Short-lived single-use HMAC token (`exp.nonce.signature`)
  - `attemptId`: Internal attempt identifier (e.g. `vca_...`)
  - `sessionId`: Voice booking session identifier (`vbs_...`)
- **600-Character Limit Boundary**: Throws `ExotelApiError` with `isCertainRejection: true` before dispatching the request if `finalStreamUrl.length > 600`.
- **Secret & Token Redaction**: In `redactSecrets`, any token query parameter matching `([?&]token=)[^& \t\r\n]+` and any configured `streamSecret` are scrubbed with `[REDACTED_STREAM_TOKEN]` and `[REDACTED_STREAM_SECRET]` from all thrown errors, stack traces, and logs.
- **Fail-Closed Retries**: Timeouts and network uncertainties continue to transition attempts to `uncertain` without automated redialing.

---

## 2. Standalone Fastify Audio Bridge Entrypoint

### Implementation Details
- **Entrypoint**: [`src/server/voiceBridgeServer.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/server/voiceBridgeServer.ts)
- **Script**: `npm run start:voice-bridge`
- **Port & Host Defaults**: `VOICE_BRIDGE_HOST` (default `0.0.0.0`) and `VOICE_BRIDGE_PORT` (default `18091`).
- **Configuration Validation**: `validateVoiceBridgeConfig(isProduction)` checks that `STREAM_SECRET_KEY` and Azure credentials are configured when running in production, throwing immediately if missing.
- **Graceful Shutdown**: Traps `SIGTERM` and `SIGINT`, logs graceful shutdown initiation, awaits Fastify `app.close()`, and terminates cleanly.

---

## 3. Firestore Nonce TTL Readiness

### Implementation Details
- **Timestamp Field**: In [`exotelAudioBridge.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/voice/audioBridge/exotelAudioBridge.ts#L279-L284), `FirestoreTokenNonceRegistry` now writes `expireAt: Timestamp.fromMillis(exp * 1000)`.
- **Infrastructure as Code**: Updated [`firestore.indexes.json`](file:///Users/gnanendhrajoy/Desktop/BREW/firestore.indexes.json#L46-L53):
  ```json
  "fieldOverrides": [
    {
      "collectionGroup": "voice_stream_nonces",
      "fieldPath": "expireAt",
      "ttl": true,
      "indexes": []
    }
  ]
  ```
- **Security Boundary**: Firestore TTL runs in the background and may take 24–72 hours to sweep expired documents. Real-time replay prevention remains enforced by the atomic Firestore transaction check `data.exp >= nowSec`.

---

## 4. Clarification of Readiness Assumptions

1. **Cloud Run WebSocket Reality**: Cloud Run supports WebSockets natively up to 3,600s, but active connections keep container instances marked as active, resulting in continuous billing for CPU and memory allocation for the entire call duration. Ingress updates can also sever connections.
2. **Dedicated Bridge Service**: The audio bridge must run in a dedicated process/container separate from Next.js App Router to avoid serverless function execution limits and SSR interference.
3. **Codec-Dependent Packet Durations**:
   - 3,200 bytes PCM16 at 8kHz = **200ms**
   - 3,200 bytes PCM16 at 16kHz = **100ms**
   - 3,200 bytes μ-law at 8kHz = **400ms**
4. **Telephony Pricing**: Exotel does not provide a zero-cost tier; ExoPhones require recurring line rentals (~₹1,000–₹2,000/mo) and outbound calls are metered (~₹0.40–₹0.70/min) along with TRAI DLT verification.

---

## 5. Verification & Test Metrics

| Suite | Checks Passed | Result |
|---|---|---|
| `test:p6641` (Gap Closure) | 12 / 12 | ✅ **PASS** |
| `test:p663` (Audio Bridge & Codecs) | 149 / 149 | ✅ **PASS** |
| `test:p662` (Exotel Provider & Webhooks) | 18 / 18 | ✅ **PASS** |
| `test:p6612` (Expired Lease Recovery) | 7 / 7 | ✅ **PASS** |
| `test:p6611` (Initiation Idempotency) | 7 / 7 | ✅ **PASS** |
| `test:p661` (Durable Attempt Foundation) | 10 / 10 | ✅ **PASS** |
| **Total Voice Assertions** | **203 / 203** | ✅ **100% PASS** |
| `npm run typecheck` | 0 errors | ✅ **PASS** |
| `npm run lint` | 0 errors | ✅ **PASS** |
| `git status` | Clean staging | ✅ **PASS** |

---

## 6. Remaining Carrier-Side Prerequisites

Before executing a live test call:
1. **Exotel Account Manager**: Must enable the Connect Voice AI streaming feature (`StreamUrl` + `StreamType="bidirectional"`) on the Exotel account.
2. **Virtual Number & DLT**: An active ExoPhone provisioned with TRAI Principal Entity registration.
3. **Azure Cognitive Services**: Active subscription key with `centralindia` or `southindia` region.
