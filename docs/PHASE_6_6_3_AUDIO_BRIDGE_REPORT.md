# BREW Coffee Platform — Phase 6.6.3 Exotel WebSocket Audio Bridge & Speech Integration Report

## 1. Executive Summary

Phase 6.6.3 establishes the real-time bidirectional audio bridge between the **Exotel AgentStream WebSocket protocol** and BREW Coffee's conversational intelligence engine (`processConversationTurn`). 

All processing runs deterministically with **zero live telecom expenses, zero third-party billing activation, and strict preservation of customer privacy**:
- `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
- Audio recording strictly prohibited and guarded at runtime (`enableAudioRecording: true` throws a fatal invariant error).
- Exact mathematical ITU-T G.711 μ-law companding and 16-bit Linear PCM transcoding implemented without external native dependencies.
- Constant-time timing-safe WebSocket handshake authentication.
- Full multilingual support across **English (`en-IN-NeerjaNeural`)**, **Hindi (`hi-IN-SwaraNeural`)**, and **Telugu (`te-IN-ShrutiNeural`)**.
- Barge-in / interruption detection with instant Exotel AgentStream `clear` event dispatch.
- 100% preservation of quotation integrity (HMAC-SHA256) and staff authorization safety gates.

---

## 2. Architecture & Component Diagram

```
+-------------------------------------------------------------------------------------------------+
|                                    BREW Telephony Infrastructure                                 |
+-------------------------------------------------------------------------------------------------+
|                                                                                                 |
|   +-----------------------+     WSS /media?token=...     +----------------------------------+   |
|   |                       | ---------------------------> |                                  |   |
|   |  Exotel AgentStream   |                              |   ExotelAudioBridge              |   |
|   |  (PSTN Audio Stream)  | <--------------------------- |   (Fastify WebSocket Server)     |   |
|   |                       |    media chunks (320B)       |                                  |   |
|   +-----------------------+                              +-----------------+----------------+   |
|                                                                            |                    |
|                                                                            v                    |
|   +-----------------------+                              +-----------------+----------------+   |
|   |                       |   transcribeAudio(buffer)    |                                  |   |
|   |  SpeechProvider       | <--------------------------- |   Audio Codecs                   |   |
|   |  (STT & Neural TTS)   |                              |   - Linear PCM 16-bit (8k/16kHz) |   |
|   |  - AzureSpeechProvider| ---------------------------> |   - G.711 μ-law (8kHz companded) |   |
|   |  - MockSpeechProvider |    synthesizeSpeech(text)    +-----------------+----------------+   |
|   +-----------------------+                                                |                    |
|                                                                            v                    |
|   +------------------------------------------------------------------------+----------------+   |
|   |                                                                                         |   |
|   |                              BREW AI Conversation Engine                                |   |
|   |                                                                                         |   |
|   |   +------------------------------+             +------------------------------------+   |   |
|   |   |   processConversationTurn    |             |  evaluateConfirmationSafetyGate    |   |   |
|   |   |   (Requirements & Multiturn) |             |  (Quotation HMAC-SHA256 Integrity) |   |   |
|   |   +--------------+---------------+             +-----------------+------------------+   |   |
|   |                  |                                               |                      |   |
|   |                  v                                               v                      |   |
|   |   +------------------------------+             +------------------------------------+   |   |
|   |   |   VoiceSessionRepository     |             |  VoiceCallAttemptRepository        |   |   |
|   |   |   (Firestore / In-Memory)    |             |  (Lifecycle & Monotonic States)    |   |   |
|   |   +------------------------------+             +------------------------------------+   |   |
|   |                                                                                         |   |
|   +-----------------------------------------------------------------------------------------+   |
|                                                                                                 |
+-------------------------------------------------------------------------------------------------+
```

---

## 3. Verified Exotel AgentStream Protocol Specification

Exotel AgentStream operates over persistent bidirectional WebSockets.

### 3.1 Event Framing

| Direction | Event Name | Payload Structure | Function |
| :--- | :--- | :--- | :--- |
| **Inbound (Exotel -> Bridge)** | `connected` / `start` | `{ event: "start", sequence_number: 1, stream_sid: "...", start: { call_sid: "...", custom_parameters: { attemptId, sessionId }, media_format: { encoding: "audio/x-l16", sample_rate: 8000 } } }` | Establishes stream session, provides `call_sid`, binds carrier stream to internal booking session, and triggers initial welcome greeting. |
| **Inbound (Exotel -> Bridge)** | `media` | `{ event: "media", sequence_number: n, stream_sid: "...", media: { chunk: n, timestamp: "...", payload: "<base64>" } }` | Inbound caller audio frames. If bot is speaking, triggers barge-in interruption. |
| **Inbound (Exotel -> Bridge)** | `stop` | `{ event: "stop", sequence_number: n, stream_sid: "...", stop: { call_sid: "...", reason: "..." } }` | Carrier signals call completion. Bridge cleans up and marks call attempt `completed`. |
| **Outbound (Bridge -> Exotel)** | `media` | `{ event: "media", stream_sid: "...", media: { payload: "<base64>" } }` | Synthesized bot speech streamed in 320-byte chunks. |
| **Outbound (Bridge -> Exotel)** | `clear` | `{ event: "clear", stream_sid: "..." }` | Dispatched immediately upon customer barge-in to flush Exotel's playback buffer. |
| **Outbound (Bridge -> Exotel)** | `mark` | `{ event: "mark", stream_sid: "...", mark: { name: "turn_n_complete" } }` | Signals end of bot utterance streaming for turn tracking. |

### 3.2 Audio Formats & Framing Invariants

1. **Linear PCM 16-bit Mono (`audio/x-l16`)**:
   - 8,000 Hz or 16,000 Hz sample rate, little-endian signed integer samples.
   - 8 kHz frame: 160 samples (20 ms) = **320 bytes** (Exotel required chunk granularity).
2. **G.711 μ-law (`audio/x-mulaw`)**:
   - 8,000 Hz sample rate, 8-bit companded samples.
   - 8 kHz frame: 320 samples (40 ms) = **320 bytes**.
3. **Midpoint Reconstruction**:
   ITU-T G.711 decode table uses midpoint offset `(((mantissa * 2 + 33) << (exponent + 2)) - 132)` to achieve mathematical symmetry with zero DC bias.

---

## 4. Azure Cognitive Services Speech Integration

### 4.1 Neural Voice Registry

| Language Code | Language | Female Voice Name | Male Voice Name | Locale |
| :---: | :---: | :---: | :---: | :---: |
| `en` | English (India) | `en-IN-NeerjaNeural` | `en-IN-PrabhatNeural` | `en-IN` |
| `hi` | Hindi (India) | `hi-IN-SwaraNeural` | `hi-IN-MadhurNeural` | `hi-IN` |
| `te` | Telugu (India) | `te-IN-ShrutiNeural` | `te-IN-MohanNeural` | `te-IN` |

### 4.2 Security & Credential Safeguards
- In local testing, `MockSpeechProvider` generates deterministic transcription queues and synthetic audio tones.
- `AzureSpeechProvider` validates `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` fail-closed. If missing, requests abort immediately without issuing unauthenticated or degraded network requests.
- All secrets are redacted from error logs.

---

## 5. Conversation Turn Lifecycle & Quotation Preservation

1. **Stream Handshake & Initial Welcome**:
   Exotel connects to `wss://<host>/media?token=<secret>&attemptId=<id>&sessionId=<id>`.
   - Handshake authenticated via `timingSafeCompare`.
   - `attemptRepo.updateStatus(id, { status: "in_progress" })` advances attempt.
   - `GREETINGS[lang]` is synthesized and streamed back in 320-byte frames.
2. **Customer Audio Ingestion & Turn Processing**:
   - Audio chunks accumulate in `inboundAudioChunks`.
   - Once turn threshold is reached, buffered audio is transcribed via `speechProvider.transcribeAudio()`.
   - Transcribed text is dispatched to `processConversationTurn(session, userUtterance, dependencies)`.
   - Monotonic session revision updates are committed to `sessionRepository`.
3. **Quotation Integrity Verification**:
   - Quotation snapshot is generated using HMAC-SHA256 signature across material fields (`guestCount`, `eventDate`, `startTime`, `durationHours`, `venueAddress`, `selectedTier`).
   - Customer confirmation is evaluated via `evaluateConfirmationSafetyGate()`.
   - Tampered requirements or missing snapshots fail closed (`isConfirmed: false`).
4. **Staff Approval Gate**:
   - Confirmed sessions transition to `awaiting_staff_approval`.
   - Final booking confirmation strictly requires authenticated staff approval through `atomicApproveBooking()`.

---

## 6. Verification Results

All 38 automated checks in `scripts/verify-phase6-6-3-websocket-audio-bridge.ts` passed:

```
=======================================================
  PHASE 6.6.3 EXOTEL WEBSOCKET AUDIO BRIDGE TEST SUITE
=======================================================

--- TEST GROUP 1: G.711 μ-Law & PCM 16-bit Codec Verification ---
✅ PASS: Sample 0 encodes to valid 8-bit byte
✅ PASS: G.711 μ-law achieves exact 2:1 compression over 16-bit PCM
✅ PASS: Decoded PCM matches original sample count exactly
✅ PASS: G.711 companding error is bounded (observed max: 510 <= 512)
✅ PASS: 100ms of 8kHz 16-bit PCM silence has length 1600 bytes
✅ PASS: 16-bit PCM silence is filled with 0x00
✅ PASS: 100ms of 8kHz μ-law silence has length 800 bytes
✅ PASS: μ-law silence is filled with 0xFF (digital zero)

--- TEST GROUP 2: Security, Handshake Auth & Safety Controls ---
✅ PASS: timingSafeCompare matches identical strings
✅ PASS: timingSafeCompare rejects mismatched strings
✅ PASS: timingSafeCompare rejects different length strings safely
✅ PASS: parseCustomFieldCorrelation parses attempt and session IDs
✅ PASS: Throws security violation when enableAudioRecording=true
✅ PASS: Prohibits enabling audio recording unconditionally

--- TEST GROUP 3: WebSocket Server Lifecycle & Authentication ---
Test Audio Bridge listening on port 18090
✅ PASS: Health check returns 200 OK
✅ PASS: Health check confirms recordingEnabled=false
✅ PASS: Unauthorized connection closed with expected code (received: 4401)
✅ PASS: Missing token connection closed with expected code (received: 4401)

--- TEST GROUP 4: Stream Connection & Initial Greeting ---
✅ PASS: Outbound media frame matches stream_sid
✅ PASS: Outbound media has base64 payload
✅ PASS: Attempt transitioned to in_progress upon stream start

--- TEST GROUP 5: Multilingual Conversational Turns ---
Initial greeting completed (mark received). Triggering Hindi turn...
Hindi turn completed (mark received). Triggering Telugu turn...
Telugu turn completed (mark received). Closing stream session.
✅ PASS: Session record persisted in repository
✅ PASS: Conversation history contains turns

--- TEST GROUP 6: G.711 μ-law Format Negotiation ---
✅ PASS: μ-law audio frame is delivered in exact 320-byte chunks (received: 320)

--- TEST GROUP 7: Barge-In Interruption Detection ---
✅ PASS: Barge-in triggers 'clear' event with matching stream_sid

--- TEST GROUP 8: Clean Termination & 'stop' Event Lifecycle ---
✅ PASS: Socket closed cleanly with code 1000 on stop event
✅ PASS: Call attempt transitioned to 'completed' status

--- TEST GROUP 9: Azure Speech Provider Neural Voices ---
✅ PASS: English neural voice mapped to en-IN-NeerjaNeural
✅ PASS: Hindi neural voice mapped to hi-IN-SwaraNeural
✅ PASS: Telugu neural voice mapped to te-IN-ShrutiNeural
✅ PASS: AzureSpeechProvider fails closed when key is missing
✅ PASS: Azure Speech key validation prevents unauthorized live API invocations

--- TEST GROUP 10: Quotation Integrity & Staff Approval Gate ---
✅ PASS: Quotation snapshot generates valid 64-char SHA-256 hash
✅ PASS: Unmodified quotation requirements match snapshot hash
✅ PASS: Tampered guest count fails quotation snapshot verification
✅ PASS: Identifies guestCount as mismatched field
✅ PASS: Confirmation safety gate rejects confirmation when quotation integrity fails
✅ PASS: Safety gate reason explicitly cites quotation integrity failure
Test Audio Bridge closed.

=======================================================
  PHASE 6.6.3 VERIFICATION RESULTS: 38 PASSED, 0 FAILED
=======================================================
```

---

## 7. Production Hosting Requirements for Live Audio

When transitioning from local verification to live outbound telephony, the audio bridge requires persistent full-duplex TCP WebSocket hosting:
1. **Serverless Limitations**: Serverless environments (e.g. Next.js API Routes on Vercel or standard Cloud Run scale-to-zero) cannot hold persistent WebSocket connections during a 2 to 5 minute PSTN call.
2. **Dedicated Fastify Container**:
   - The standalone Fastify service (`createExotelAudioBridgeApp`) should run in a persistent container (e.g. GCP Cloud Run with CPU always allocated, AWS ECS Fargate, or a managed Node.js VM).
   - WebSocket keep-alive pings must be configured to prevent reverse-proxy timeouts (e.g. Cloudflare / NGINX 60-second idle timeouts).
3. **Network Latency & Colocation**:
   - Exotel India PSTN cluster resides in Mumbai (`ap-south-1` / `in.exotel.com`).
   - Hosting the Fastify audio bridge and Azure Speech in India Central / Mumbai minimizes round-trip latency to < 120 ms, ensuring seamless human conversational turns.
