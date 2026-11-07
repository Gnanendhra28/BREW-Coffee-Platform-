# BREW Coffee Platform — Phase 6.6.3.1 Exotel Audio Protocol Compatibility Corrections Report

## 1. Executive Summary

Phase 6.6.3.1 delivers strict compatibility corrections for the **Exotel AgentStream WebSocket protocol**, addressing packetization bounds, media format negotiation, replay-protected authentication, and authoritative call SID correlation.

All operations execute with **zero real telephony charges, zero third-party billing activation, and strict customer data privacy**:
- `VOICE_BOOKING_ENABLED=false` unconditionally preserved.
- Outbound media packets strictly packetized to **>= 3.2 KB (3,200 bytes)** in **integer multiples of 320 bytes**.
- Exotel media format negotiated to **signed 16-bit little-endian mono PCM (`audio/x-l16`)** by default; G.711 μ-law is strictly guarded and only sent when explicitly negotiated.
- Stream authentication reinforced with short-lived (`exp`), attempt-bound, session-bound HMAC-SHA256 signatures preventing token replay.
- Authoritative validation of incoming `call_sid` against stored provider call attempts before processing audio (rejects spoofed or mismatched calls with `4409`).
- Complete Exotel AgentStream lifecycle supported: `connected`, `start`, `media`, `mark`, and `stop`.
- Full preservation of quotation integrity (HMAC-SHA256), customer consent, and staff approval gates.

---

## 2. Exotel Audio Protocol Specifications & Verified Packetization

### 2.1 Packet Size & Duration Matrix

Exotel AgentStream requires bidirectional audio frames in integer multiples of **320 bytes** with a minimum packet size of **3.2 KB (3,200 bytes)**:

| Encoding | Sample Rate | Bytes / Sec | 320 Bytes (Granularity) | 1,600 Bytes (100ms) | 3,200 Bytes (3.2 KB Minimum) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Linear PCM 16-bit Mono (`pcm16`)** | 8,000 Hz | 16,000 B/s | **20 ms** | **100 ms** | **200 ms** (10x 320B) |
| **Linear PCM 16-bit Mono (`pcm16`)** | 16,000 Hz | 32,000 B/s | **10 ms** | **50 ms** | **100 ms** (10x 320B) |
| **G.711 μ-law (`mulaw`)** | 8,000 Hz | 8,000 B/s | **40 ms** | **200 ms** | **400 ms** (10x 320B) |

### 2.2 Packetization Algorithm (`packetizeAudioForExotel`)

1. **Target Chunk Size**: Defaults to `3,200 bytes` (10 multiples of 320 bytes).
2. **Chunk Slicing**: Slices audio stream at 3,200-byte boundaries.
3. **Trailing Fragment Padding**:
   - If trailing fragment `< 3,200 bytes`, it is padded with digital silence (`0x00` for PCM16, `0xFF` for μ-law) to exactly 3,200 bytes.
   - If trailing fragment `>= 3,200 bytes` but not an exact multiple of 320, it is padded to `ceil(len / 320) * 320`.
4. **Packet Invariant**: Every transmitted outbound `media` packet strictly satisfies:
   `packet.length >= 3200 && packet.length % 320 === 0`.

---

## 3. Short-Lived, Replay-Protected Stream Authentication

### 3.1 Token Structure & Binding
- Token Format: `${exp}.${signature}`
- Payload: `${attemptId}:${sessionId}:${exp}`
- Signature: `HMAC-SHA256(secretKey, payload)`
- Expiration: Defaults to 300 seconds (5 minutes).

### 3.2 Security Validation Sequence
1. **Handshake Verification (`verifyStreamToken`)**:
   - Parses `exp` and `signature`.
   - Rejects if `nowSec > exp` (`4401 Unauthorized - Token has expired`).
   - Rejects if `attemptId` or `sessionId` does not match query credentials.
   - Rejects if HMAC signature fails `timingSafeCompare`.
2. **Authoritative Call SID Verification**:
   - On `start` event, fetches `VoiceCallAttemptRecord` from `VoiceCallAttemptRepository` by `attemptId`.
   - If attempt does not exist: closes socket with `4404 Attempt not found`.
   - If attempt has a stored `providerCallId` and `attempt.providerCallId !== event.start.call_sid`: closes socket with `4409 Call SID mismatch`.
   - If attempt has a stored `sessionId` and `attempt.sessionId !== event.start.custom_parameters.sessionId`: closes socket with `4409 Session ID mismatch`.

---

## 4. Complete Exotel AgentStream Event Lifecycle

```
Carrier (Exotel)                                          Audio Bridge Server
      |                                                           |
      | ------------- 1. WSS Handshake with Token --------------> |
      | <------------ 101 Switching Protocols ------------------- |
      |                                                           |
      | ------------- 2. { event: "connected" } ----------------> | (Records connectedAt)
      |                                                           |
      | ------------- 3. { event: "start", call_sid: ... } -----> | (Validates call_sid & format)
      | <------------ 4. { event: "media", payload: >=3.2KB } -- | (Initial greeting audio)
      | <------------ 5. { event: "mark", name: "turn_0" } ------ |
      |                                                           |
      | ------------- 6. { event: "mark", name: "turn_0" } -----> | (Exotel confirms playback)
      |                                                           |
      | ------------- 7. { event: "media", payload: ... } ------> | (Customer audio stream)
      |   (If bot is speaking, immediately sends "clear")         |
      | <------------ 8. { event: "clear" } --------------------- | (Barge-in interruption)
      |                                                           |
      |                                                           | (STT -> Engine -> TTS)
      | <------------ 9. { event: "media", payload: >=3.2KB } --- | (Bot response audio)
      | <------------ 10. { event: "mark", name: "turn_1" } ----- |
      |                                                           |
      | ------------- 11. { event: "stop", reason: ... } -------> | (Marks attempt completed)
      | <------------ 12. WebSocket Close (1000) ---------------- |
```

---

## 5. Verification Results

All 80 checks in `scripts/verify-phase6-6-3-websocket-audio-bridge.ts` passed:

```
================================================================================
  PHASE 6.6.3.1 EXOTEL AUDIO PROTOCOL COMPATIBILITY TEST SUITE
================================================================================

--- TEST GROUP 1: Duration, Byte-Size & Codec Mathematics (22/22) ---
✅ PASS: Accurate duration and byte-size calculations for PCM16 (8kHz & 16kHz) and μ-law (8kHz)
✅ PASS: Companding and round-trip transcoding fidelity

--- TEST GROUP 2: Exotel Outbound Audio Packetizer (16/16) ---
✅ PASS: Minimum packet size is 3,200 bytes (3.2 KB)
✅ PASS: Granularity is strictly integer multiples of 320 bytes
✅ PASS: Trailing fragments padded with silence up to 3,200 bytes

--- TEST GROUP 3: Short-Lived, Attempt-Bound Authentication (8/8) ---
✅ PASS: Unexpired tokens accepted
✅ PASS: Expired tokens rejected
✅ PASS: Replay attempts with mismatched attemptId or sessionId rejected

--- TEST GROUP 4: WebSocket Server Handshake Rejection Tests (6/6) ---
✅ PASS: Missing token rejected (4401)
✅ PASS: Expired token rejected (4401)
✅ PASS: Tampered signature rejected (4401)

--- TEST GROUP 5: Authoritative Call SID Validation (2/2) ---
✅ PASS: Mismatched call_sid closed with code 4409
✅ PASS: Nonexistent attempt closed with code 4404

--- TEST GROUP 6: Complete Exotel Event Lifecycle (7/7) ---
✅ PASS: connected, start, media (>= 3.2 KB), mark, and stop handled cleanly

--- TEST GROUP 7: Media Format Negotiation (2/2) ---
✅ PASS: Explicit μ-law delivers >= 3.2 KB chunks
✅ PASS: Unexpected format safely defaults to signed 16-bit PCM

--- TEST GROUP 8: Real-Time Barge-In Interruption (1/1) ---
✅ PASS: Barge-in stops streaming and dispatches clear event

--- TEST GROUP 9: Multilingual Conversational Turns (2/2) ---
✅ PASS: Multi-turn conversation across English, Hindi, and Telugu

--- TEST GROUP 10: Malformed Events & Robustness (2/2) ---
✅ PASS: Invalid JSON and unknown events handled gracefully without crashing

--- TEST GROUP 11: Azure Speech Provider Neural Voices (5/5) ---
✅ PASS: en-IN-NeerjaNeural, hi-IN-SwaraNeural, te-IN-ShrutiNeural
✅ PASS: Fail-closed validation when key missing

--- TEST GROUP 12: Quotation Integrity & Staff Approval Gate (7/7) ---
✅ PASS: HMAC-SHA256 quotation snapshot integrity verified
✅ PASS: Tampered quotation rejected at confirmation safety gate

================================================================================
  PHASE 6.6.3.1 VERIFICATION RESULTS: 80 PASSED, 0 FAILED
================================================================================
```

---

## 6. Files Changed & Summary

| File | Changes Made |
| :--- | :--- |
| [`src/lib/communication/voice/audioBridge/types.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/voice/audioBridge/types.ts) | Added `EXOTEL_MIN_PACKET_BYTES` (3,200), `EXOTEL_FRAME_GRANULARITY_BYTES` (320), `calculateAudioDurationMs`, `calculateAudioByteLength`, separated `ExotelStreamConnectedEventSchema`, and added outbound `mark` schema. |
| [`src/lib/communication/voice/audioBridge/speechProvider.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/voice/audioBridge/speechProvider.ts) | Implemented `packetizeAudioForExotel` enforcing >= 3.2 KB packetization and 320-byte multiple silence padding. |
| [`src/lib/communication/voice/audioBridge/exotelAudioBridge.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/src/lib/communication/voice/audioBridge/exotelAudioBridge.ts) | Implemented `generateStreamToken`, `verifyStreamToken`, authoritative `call_sid` validation against repository, format negotiation defaulting to signed 16-bit PCM, and complete event lifecycle (`connected`, `start`, `media`, `mark`, `stop`). |
| [`scripts/verify-phase6-6-3-websocket-audio-bridge.ts`](file:///Users/gnanendhrajoy/Desktop/BREW/scripts/verify-phase6-6-3-websocket-audio-bridge.ts) | Expanded automated test suite from 38 to 80 checks covering all protocol corrections. |

---

## 7. Remaining Real-Provider Integration Limitations

1. **Commercial Carrier Provisioning**:
   - Live calling requires an active Exotel India commercial account with KYC approval and a registered virtual number (VN).
   - `VOICE_BOOKING_ENABLED=false` remains strictly in place until commercial rollout.
2. **Persistent WebSocket Hosting**:
   - In live deployment, the Fastify audio bridge requires persistent container hosting (e.g. Cloud Run with CPU always allocated or ECS Fargate) colocated in Mumbai (`ap-south-1`) to minimize audio latency.
   - Serverless scale-to-zero environments cannot maintain long-lived PSTN WebSocket sessions.
3. **PSTN Network Jitter & VAD Tuning**:
   - While the packetizer enforces compliant >= 3.2 KB frames, real carrier audio latency will depend on carrier network jitter buffers. Azure Speech continuous recognition or local silence VAD will endpoint user speech dynamically in live calls.
