# Phase 6.6.3.3 — Final Audio Packet and Distributed Token Safety Report

## Executive Summary

Phase 6.6.3.3 implements the final distributed safety enhancements for the BREW Coffee Exotel real-time audio bridge. This phase corrects the outbound packet maximum to 99,840 bytes (exact multiple of 320 bytes), establishes distributed single-use token replay protection across bridge instances via Upstash Redis REST and Firestore transaction adapters, enforces fail-closed behavior when the shared registry is unavailable, preserves process-local in-memory registries for unit tests without conflating them with distributed safety, and verifies packet boundary conditions (3,199, 3,200, 99,840, 100,000, and 250,000 bytes).

---

## 1. Key Corrections & Architectural Enhancements

### 1.1 Outbound Packet Maximum & Boundary Hardening
- **Packet Maximum**: Corrected `EXOTEL_MAX_PACKET_BYTES` to `99,840 bytes` (`312 * 320 bytes`). 100,000 is not divisible by 320, so 99,840 bytes is the true aligned maximum packet.
- **Trailing-Fragment Merging**:
  - In `packetizeAudioForExotel`, trailing fragments `< 3,200 bytes` are merged into preceding chunks only if `targetMergedLen <= EXOTEL_MAX_PACKET_BYTES` (99,840 bytes).
  - If merging would cause the packet to exceed 99,840 bytes (e.g. 100,000-byte input buffer), the trailing fragment is not merged; instead, it is emitted as an independent packet padded to the 3,200-byte minimum.
- **Boundary Verification**:
  1. `3,199 bytes`: 1 packet, padded with 1 byte of PCM silence to 3,200 bytes (`3200 % 320 === 0`).
  2. `3,200 bytes`: 1 packet, exact minimum 3,200 bytes with 0 padding (`3200 % 320 === 0`).
  3. `99,840 bytes`: 1 packet, exact maximum 99,840 bytes with 0 padding (`99840 % 320 === 0`).
  4. `100,000 bytes`: 2 packets. Packet 1 = 99,840 bytes (max). Packet 2 = 160 bytes padded to 3,200 bytes. Both packets in `[3200, 99840]` and `packet.length % 320 === 0`.
  5. `250,000 bytes`: 3 packets (99,840 bytes, 99,840 bytes, and 50,560 bytes). All in `[3200, 99840]` and multiples of 320 bytes.

### 1.2 Inspection of `TokenNonceRegistry` (Process-Local vs. Distributed)
- **Inspection Findings**:
  - The previous `TokenNonceRegistry` was strictly **process-local** (backed by an in-memory `Map<string, number>`).
  - In a clustered or auto-scaling deployment (e.g. Cloud Run, Render, multi-container instances), replaying a token to Instance B after consuming it on Instance A would succeed because the in-memory map was isolated to Instance A.
- **Architectural Resolution**:
  - Extracted the provider-independent `TokenNonceRegistry` interface with an asynchronous `atomicConsume(nonce, exp, nowMs): Promise<boolean> | boolean` contract.
  - Implemented `UpstashRedisTokenNonceRegistry`:
    - Executes atomic Redis `SET key "consumed" EX <ttl> NX` via Upstash REST API (`/pipeline`).
    - Key format: `brew:voice:nonce:${nonce}`.
    - TTL set to `Math.max(60, exp - nowSec)`, guaranteeing expiry at least as long as token validity.
    - If Redis returns `"OK"`: first claim succeeds. If `null`: replay or concurrent use rejected.
    - If Redis is unreachable or returns non-200: **fails closed** (returns `false`).
  - Implemented `FirestoreTokenNonceRegistry`:
    - Executes atomic Firestore transactions on collection `voice_stream_nonces`, document `${nonce}`.
    - Serializes concurrent attempts and rejects existing unexpired nonces.
    - If Firestore is unavailable or times out: **fails closed** (returns `false`).
  - Implemented `InMemoryTokenNonceRegistry`:
    - Process-local adapter dedicated to deterministic, hermetic unit tests.
    - Docstrings explicitly document that it does NOT provide distributed protection across multiple server instances.
  - Factory `createSharedTokenNonceRegistry()` selects Upstash Redis when configured, Firestore when running in production / emulator, or falls back to in-memory for offline testing.

### 1.3 Asynchronous Fastify Handshake Authentication
- `verifyStreamToken` was converted to `async`, safely awaiting the distributed atomic claim.
- The Fastify WebSocket route handler `/media` awaits `verifyStreamToken` before accepting or disconnecting connections. Replayed tokens across separate bridge instances fail the handshake and are disconnected immediately with code `4401`.

---

## 2. Test Verification & Results

### 2.1 Focused Phase 6.6.3 Verification Suite
All 119 automated tests passed with 0 failures:

```bash
npm run test:p663
# Output:
# PHASE 6.6.3.1 VERIFICATION RESULTS: 119 PASSED, 0 FAILED
```

Key verified items:
- Packet bounds for 3,199, 3,200, 99,840, 100,000, and 250,000 bytes.
- Upstash Redis distributed atomic token claim and replay rejection across simulated separate bridge instances (`Instance A` and `Instance B`).
- Concurrent token consumption across separate bridge instances: exactly one claim succeeds, one fails.
- Fail-closed behavior on unreachable / broken Redis and Firestore registries.
- Rejection of malformed, unsupported, or stereo media formats (`code 4415`).

### 2.2 Regression Suites
- Phase 6.6.2.1 (Exotel Carrier & Webhook Configuration): 18/18 passed.
- Phase 6.6.1.2 (Expired Initiation Recovery & Webhook Correlation): 7/7 passed.
- Phase 6.6.1.1 (Voice Initiation Idempotency & Safe Recovery): 7/7 passed.
- Phase 6.6.1 (Durable Voice Call Attempt Foundation): 10/10 passed.
- Static Analysis (`tsc --noEmit`): 0 errors.
- ESLint (`eslint`): 0 errors.

---

## 3. Policy Commitments & Invariants

1. `VOICE_BOOKING_ENABLED=false` unconditionally preserved across all configs.
2. Audio recording remains unconditionally prohibited (`enableAudioRecording: true` throws a fatal invariant error).
3. Zero PSTN calls dialed, zero live minutes consumed, zero cloud billing activated.
4. Quotation integrity preserved via SHA-256 snapshots and staff confirmation safety gates.
5. Zero files staged for commit.
