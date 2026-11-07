/**
 * BREW Coffee Platform — Phase 6.6.3.1 Verification Test Suite
 *
 * Exotel Audio Protocol Compatibility Corrections:
 * 1. Accurate duration & byte-size calculations for PCM16 and μ-law (8kHz & 16kHz).
 * 2. Mathematical G.711 μ-law and Linear PCM 16-bit codecs.
 * 3. Outbound packetization: strictly enforces >= 3.2 KB (3,200 bytes) and 320-byte multiples.
 * 4. Short-lived, attempt-bound, session-bound token authentication with expiration & replay protection.
 * 5. Authoritative Call SID validation against stored provider call attempt (rejects mismatches with 4409).
 * 6. Format negotiation: defaults to signed 16-bit PCM mono; μ-law only when explicitly negotiated.
 * 7. Complete Exotel event lifecycle: connected -> start -> media -> mark -> stop.
 * 8. Real-time barge-in interruption detection and instant 'clear' event dispatch.
 * 9. Resilience to malformed frames, invalid JSON, and unexpected format requests.
 * 10. Multilingual conversational turns across English, Hindi, and Telugu.
 * 11. Quotation integrity (HMAC-SHA256) and staff authorization safety gate preservation.
 * 12. Strict prohibition of audio recording.
 */

import http from "http";
import { WebSocket } from "ws";
import {
  createExotelAudioBridgeApp,
  createSharedTokenNonceRegistry,
  FirestoreTokenNonceRegistry,
  generateStreamToken,
  InMemoryTokenNonceRegistry,
  isValidStreamNonce,
  UpstashRedisTokenNonceRegistry,
  verifyStreamToken,
} from "../src/lib/communication/voice/audioBridge/exotelAudioBridge";
import {
  AZURE_NEURAL_VOICES,
  AzureSpeechProvider,
  ExotelAudioStreamAccumulator,
  generateSilenceAudio,
  generateTestToneAudio,
  linearSampleToMuLaw,
  MockSpeechProvider,
  muLawToPcm16,
  packetizeAudioForExotel,
  pcm16ToMuLaw,
} from "../src/lib/communication/voice/audioBridge/speechProvider";
import {
  calculateAudioByteLength,
  calculateAudioDurationMs,
  DEFAULT_EXOTEL_AUDIO_FORMAT,
  EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
  EXOTEL_FRAME_GRANULARITY_BYTES,
  EXOTEL_MAX_PACKET_BYTES,
  EXOTEL_MIN_PACKET_BYTES,
  MULAW_8K_AUDIO_FORMAT,
  negotiateExotelMediaFormat,
} from "../src/lib/communication/voice/audioBridge/types";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { InMemoryVoiceCallAttemptRepository } from "../src/lib/communication/voice/callAttemptRepository";
import { MockExtractionProvider } from "../src/lib/voiceBooking/providers/extractionProvider";
import { evaluateConfirmationSafetyGate } from "../src/lib/voiceBooking/conversationEngine";
import { isFirebaseAdminAvailable, setAdminFirestoreForTesting } from "../src/lib/firebaseAdmin";
import {
  createQuotationSnapshot,
  generateVoiceBookingQuotation,
  verifyQuotationIntegrity,
} from "../src/lib/voiceBooking/quotationAdapter";
import { BookingRequirements } from "../src/lib/voiceBooking/types";

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    failedCount++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  } else {
    passedCount++;
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log("\n================================================================================");
  console.log("  PHASE 6.6.3.1 EXOTEL AUDIO PROTOCOL COMPATIBILITY TEST SUITE");
  console.log("================================================================================\n");

  // --------------------------------------------------------------------------
  // TEST GROUP 1: Duration, Byte-Size & Codec Mathematics
  // --------------------------------------------------------------------------
  console.log("\n--- TEST GROUP 1: Duration, Byte-Size & Codec Mathematics ---");

  {
    // Test 1.1: PCM16 at 8kHz byte & duration calculations
    // 8,000 samples/sec * 2 bytes/sample = 16,000 bytes/sec
    assert(calculateAudioDurationMs(320, "pcm16", 8000) === 20, "PCM16 8kHz: 320 bytes is exactly 20ms");
    assert(calculateAudioDurationMs(1600, "pcm16", 8000) === 100, "PCM16 8kHz: 1,600 bytes is exactly 100ms");
    assert(calculateAudioDurationMs(3200, "pcm16", 8000) === 200, "PCM16 8kHz: 3,200 bytes (3.2 KB) is exactly 200ms");

    assert(calculateAudioByteLength(20, "pcm16", 8000) === 320, "PCM16 8kHz: 20ms produces exactly 320 bytes");
    assert(calculateAudioByteLength(100, "pcm16", 8000) === 1600, "PCM16 8kHz: 100ms produces exactly 1,600 bytes");
    assert(calculateAudioByteLength(200, "pcm16", 8000) === 3200, "PCM16 8kHz: 200ms produces exactly 3,200 bytes");

    // Test 1.2: PCM16 at 16kHz byte & duration calculations
    // 16,000 samples/sec * 2 bytes/sample = 32,000 bytes/sec
    assert(calculateAudioDurationMs(320, "pcm16", 16000) === 10, "PCM16 16kHz: 320 bytes is exactly 10ms");
    assert(calculateAudioDurationMs(3200, "pcm16", 16000) === 100, "PCM16 16kHz: 3,200 bytes is exactly 100ms");
    assert(calculateAudioByteLength(100, "pcm16", 16000) === 3200, "PCM16 16kHz: 100ms produces exactly 3,200 bytes");

    // Test 1.3: μ-law at 8kHz byte & duration calculations
    // 8,000 samples/sec * 1 byte/sample = 8,000 bytes/sec
    assert(calculateAudioDurationMs(320, "mulaw", 8000) === 40, "μ-law 8kHz: 320 bytes is exactly 40ms");
    assert(calculateAudioDurationMs(800, "mulaw", 8000) === 100, "μ-law 8kHz: 800 bytes is exactly 100ms");
    assert(calculateAudioDurationMs(3200, "mulaw", 8000) === 400, "μ-law 8kHz: 3,200 bytes is exactly 400ms");
    assert(calculateAudioByteLength(100, "mulaw", 8000) === 800, "μ-law 8kHz: 100ms produces exactly 800 bytes");
    assert(calculateAudioByteLength(400, "mulaw", 8000) === 3200, "μ-law 8kHz: 400ms produces exactly 3,200 bytes");

    // Test 1.4: Single Sample Companding & Roundtrip fidelity
    const sampleZero = linearSampleToMuLaw(0);
    assert(typeof sampleZero === "number" && sampleZero >= 0 && sampleZero <= 255, "Sample 0 encodes to valid 8-bit byte");

    const testTone = generateTestToneAudio(440, 50, DEFAULT_EXOTEL_AUDIO_FORMAT, 0.5);
    const muLawEncoded = pcm16ToMuLaw(testTone);
    assert(muLawEncoded.length === testTone.length / 2, "G.711 μ-law achieves exact 2:1 compression over 16-bit PCM");

    const decodedPcm = muLawToPcm16(muLawEncoded);
    assert(decodedPcm.length === testTone.length, "Decoded PCM matches original sample count exactly");

    let maxError = 0;
    for (let i = 0; i < testTone.length / 2; i++) {
      const orig = testTone.readInt16LE(i * 2);
      const decoded = decodedPcm.readInt16LE(i * 2);
      const err = Math.abs(orig - decoded);
      if (err > maxError) maxError = err;
    }
    assert(maxError <= 512, `G.711 companding error is bounded (observed max: ${maxError} <= 512)`);

    // Test 1.5: Silence Generation
    const pcmSilence = generateSilenceAudio(100, DEFAULT_EXOTEL_AUDIO_FORMAT);
    assert(pcmSilence.length === 1600, "100ms of 8kHz 16-bit PCM silence has length 1600 bytes");
    assert(pcmSilence.every((b) => b === 0), "16-bit PCM silence is filled with 0x00");

    const muLawSilence = generateSilenceAudio(100, MULAW_8K_AUDIO_FORMAT);
    assert(muLawSilence.length === 800, "100ms of 8kHz μ-law silence has length 800 bytes");
    assert(muLawSilence.every((b) => b === 0xff), "μ-law silence is filled with 0xFF (digital zero)");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 2: Exotel Outbound Audio Packetizer (>= 3.2 KB & 320B multiples)
  // --------------------------------------------------------------------------
  console.log("\n--- TEST GROUP 2: Exotel Outbound Audio Packetizer ---");

  {
    // Test 2.1: Constants validation
    assert(EXOTEL_MIN_PACKET_BYTES === 3200, "EXOTEL_MIN_PACKET_BYTES is 3,200 bytes (3.2 KB)");
    assert(EXOTEL_MAX_PACKET_BYTES === 99840, "EXOTEL_MAX_PACKET_BYTES is 99,840 bytes (312 * 320 bytes)");
    assert(EXOTEL_FRAME_GRANULARITY_BYTES === 320, "EXOTEL_FRAME_GRANULARITY_BYTES is 320 bytes");
    assert(EXOTEL_MIN_PACKET_BYTES % EXOTEL_FRAME_GRANULARITY_BYTES === 0, "Minimum packet size is exact multiple of 320 bytes (10x)");
    assert(EXOTEL_MAX_PACKET_BYTES % EXOTEL_FRAME_GRANULARITY_BYTES === 0, "Maximum packet size is exact multiple of 320 bytes (312x)");

    // Test 2.2: Boundary test: 3,199 bytes (just below minimum) is padded to 3,200 bytes
    const buf3199 = Buffer.alloc(3199, 0x12);
    const packets3199 = packetizeAudioForExotel(buf3199, DEFAULT_EXOTEL_AUDIO_FORMAT);
    assert(packets3199.length === 1, "3,199-byte audio produces exactly 1 packet");
    assert(packets3199[0].length === 3200, "3,199-byte audio is padded up to 3,200 bytes");
    assert(packets3199[0].length % 320 === 0, "3,199-byte padded packet is an integer multiple of 320 bytes");
    assert(packets3199[0].subarray(0, 3199).equals(buf3199), "Preserves original 3,199 bytes payload");
    assert(packets3199[0][3199] === 0x00, "Padded 1-byte tail is filled with 0x00 PCM silence");

    // Test 2.3: Boundary test: 3,200 bytes (exact minimum) produces 1 packet with 0 padding
    const buf3200 = Buffer.alloc(3200, 0x23);
    const packets3200 = packetizeAudioForExotel(buf3200, DEFAULT_EXOTEL_AUDIO_FORMAT);
    assert(packets3200.length === 1, "3,200-byte audio produces exactly 1 packet");
    assert(packets3200[0].length === 3200, "3,200-byte audio produces exact 3,200-byte packet");
    assert(packets3200[0].equals(buf3200), "3,200-byte audio requires zero padding");

    // Test 2.4: Boundary test: 99,840 bytes (exact maximum) produces exactly 1 99,840-byte packet
    const buf99840 = Buffer.alloc(99840, 0x34);
    const packets99840 = packetizeAudioForExotel(buf99840, DEFAULT_EXOTEL_AUDIO_FORMAT, 99840);
    assert(packets99840.length === 1, "99,840-byte audio produces exactly 1 packet");
    assert(packets99840[0].length === 99840, "99,840-byte audio produces exact 99,840-byte packet");
    assert(packets99840[0].length % 320 === 0, "99,840-byte packet is an integer multiple of 320 bytes");
    assert(packets99840[0].equals(buf99840), "99,840-byte audio requires zero padding");

    // Test 2.5: Boundary test: 100,000 bytes (exceeds maximum packet by 160 bytes)
    // Under balanced chunking, 100,000 bytes splits into:
    // Chunk 1 = 96,640 bytes (99,840 - 3,200), remainder = 3,360 bytes.
    // Chunk 2 (3,360 bytes) is >= 3,200 bytes, so it pads to 3,520 bytes (next 320B multiple).
    // Trailing silence padding is 3,520 - 3,360 = 160 bytes (< 320 bytes), eliminating the 3,040B padding anomaly!
    const buf100k = Buffer.alloc(100000, 0x45);
    const packets100k = packetizeAudioForExotel(buf100k, DEFAULT_EXOTEL_AUDIO_FORMAT, 99840);
    assert(packets100k.length === 2, "100,000-byte audio produces 2 balanced packets");
    assert(packets100k[0].length === 96640, "Packet 1 is 96,640 bytes (balanced to avoid undersized remainder)");
    assert(packets100k[1].length === 3520, "Packet 2 is 3,520 bytes (3,360B padded to 320B multiple)");
    assert(packets100k[1].length - 3360 === 160, "Packet 2 trailing silence is exactly 160 bytes (< 320 bytes)");
    assert(packets100k.every((p) => p.length >= 3200 && p.length <= 99840 && p.length % 320 === 0), "All 100,000-byte packets satisfy [3,200, 99,840] and 320B multiple");

    // Test 2.6: Oversized audio buffer (250,000 bytes)
    const buf250k = Buffer.alloc(250000, 0x56);
    const packets250k = packetizeAudioForExotel(buf250k, DEFAULT_EXOTEL_AUDIO_FORMAT, 99840);
    assert(packets250k.length === 3, "250,000-byte audio produces 3 packets");
    assert(packets250k[0].length === 99840, "Oversized chunk 1 is 99,840 bytes");
    assert(packets250k[1].length === 99840, "Oversized chunk 2 is 99,840 bytes");
    assert(packets250k[2].length === 50560, "Oversized chunk 3 is 50,560 bytes (50,320B padded to 320B multiple)");
    assert(packets250k.every((p) => p.length >= 3200 && p.length <= 99840 && p.length % 320 === 0), "All oversized packets satisfy [3,200, 99,840] and 320B multiple");

    // Test 2.7: Multi-chunk packetization with bounded trailing silence
    const multiBuffer = Buffer.alloc(7000, 0x34);
    const multiPackets = packetizeAudioForExotel(multiBuffer, DEFAULT_EXOTEL_AUDIO_FORMAT);
    // 7,000 bytes: Chunk 1 = 3,200 bytes, Chunk 2 (merged tail 600B) = 3,800 bytes padded to next 320B multiple = 3,840 bytes
    assert(multiPackets.length === 2, "7,000-byte buffer produces 2 packets (tail merged into final chunk)");
    assert(multiPackets[0].length === 3200, "Packet 1 length is 3,200 bytes");
    assert(multiPackets[1].length === 3840, "Packet 2 length is 3,840 bytes (3,800B padded to 320B multiple)");
    assert(multiPackets[1].length % 320 === 0, "Packet 2 is an exact multiple of 320 bytes");
    // Trailing silence padding is 3840 - 3800 = 40 bytes, strictly < 320 bytes (< 20ms)
    assert(multiPackets[1].subarray(3800).length < 320, "Trailing silence is strictly bounded to < 320 bytes (< 20ms)");
    assert(multiPackets.every((p) => p.length >= 3200 && p.length % 320 === 0), "All packets satisfy >= 3,200 bytes and multiple of 320 bytes");

    // Test 2.8: μ-law trailing padding with 0xFF digital zero
    const mulawSmallBuffer = Buffer.alloc(1000, 0x55);
    const mulawPackets = packetizeAudioForExotel(mulawSmallBuffer, MULAW_8K_AUDIO_FORMAT);
    assert(mulawPackets.length === 1 && mulawPackets[0].length === 3200, "μ-law packet is padded to 3,200 bytes");
    assert(mulawPackets[0].subarray(1000).every((b) => b === 0xff), "μ-law padded tail is filled with 0xFF digital silence");

    // Test 2.9: Empty buffer returns empty array
    const emptyPackets = packetizeAudioForExotel(Buffer.alloc(0), DEFAULT_EXOTEL_AUDIO_FORMAT);
    assert(emptyPackets.length === 0, "Empty buffer returns empty packet array");

    // Test 2.10: ExotelAudioStreamAccumulator streaming fragment accumulation
    const accumulator = new ExotelAudioStreamAccumulator(DEFAULT_EXOTEL_AUDIO_FORMAT, 3200);
    // Push 500 bytes -> buffered, 0 packets
    const p1 = accumulator.push(Buffer.alloc(500, 0x11));
    assert(p1.length === 0, "Accumulator retains 500B fragment without emitting undersized packet");
    assert(accumulator.bufferedBytes === 500, "Accumulator buffer tracks 500 bytes");

    // Push 1000 bytes -> total 1500 bytes -> buffered, 0 packets
    const p2 = accumulator.push(Buffer.alloc(1000, 0x22));
    assert(p2.length === 0, "Accumulator retains 1,500B without emitting undersized packet");
    assert(accumulator.bufferedBytes === 1500, "Accumulator buffer tracks 1,500 bytes");

    // Push 1200 bytes -> total 2700 bytes -> buffered, 0 packets (< 3200)
    const p3 = accumulator.push(Buffer.alloc(1200, 0x33));
    assert(p3.length === 0, "Accumulator retains 2,700B (< 3200) without emitting");
    assert(accumulator.bufferedBytes === 2700, "Accumulator buffer tracks 2,700 bytes");

    // Push 1500 bytes -> total 4200 bytes -> emits 1 packet of 3,200 bytes, retains 1,000 bytes
    const p4 = accumulator.push(Buffer.alloc(1500, 0x44));
    assert(p4.length === 1, "Accumulator emits 1 packet once threshold is reached");
    assert(p4[0].length === 3200, "Emitted packet is exactly 3,200 bytes");
    assert(p4[0].length % 320 === 0, "Emitted packet is multiple of 320 bytes");
    assert(accumulator.bufferedBytes === 1000, "Accumulator retains remaining 1,000 bytes");

    // Test 2.11: Explicit final flush with 160-byte remainder padded to 3,200 bytes
    const smallAccumulator = new ExotelAudioStreamAccumulator(DEFAULT_EXOTEL_AUDIO_FORMAT, 3200);
    smallAccumulator.push(Buffer.alloc(160, 0xaa));
    assert(smallAccumulator.bufferedBytes === 160, "Buffered 160 bytes before final flush");
    // Non-final flush should not emit undersized packet
    const nonFinalFlush = smallAccumulator.flush(false);
    assert(nonFinalFlush.length === 0, "Non-final flush retains undersized 160 bytes");
    assert(smallAccumulator.bufferedBytes === 160, "Retains 160 bytes after non-final flush");
    // Final flush must pad remainder < 3200 to 3,200 bytes (Exotel minimum packet wire constraint)
    const finalFlush = smallAccumulator.flush(true);
    assert(finalFlush.length === 1, "Final flush emits remaining audio");
    assert(finalFlush[0].length === 3200, "Final flush pads 160-byte remainder to exactly 3,200 bytes");
    assert(finalFlush[0].length % 320 === 0, "Final flush packet is multiple of 320 bytes");
    assert(finalFlush[0][0] === 0xaa && finalFlush[0][159] === 0xaa, "Final flush preserves original 160 bytes");
    assert(finalFlush[0][160] === 0x00 && finalFlush[0][3199] === 0x00, "Final flush pads remainder with silence");
    assert(smallAccumulator.bufferedBytes === 0, "Accumulator is empty after final flush");
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 3: Short-Lived, Attempt-Bound & Replay-Protected Authentication
  // --------------------------------------------------------------------------
  console.log("\n--- TEST GROUP 3: Short-Lived, Attempt-Bound Authentication ---");

  const SECRET = "brew-carrier-test-secret-987654";

  {
    // Test 3.1: Token Generation
    const nowMs = 1772880000000;
    const { token, exp } = generateStreamToken({
      secretKey: SECRET,
      attemptId: "vca_auth_100",
      sessionId: "vbs_auth_100",
      expiresInSeconds: 300,
      nowMs,
    });
    assert(typeof token === "string" && token.includes("."), "Stream token is generated in exp.signature format");
    assert(exp === Math.floor(nowMs / 1000) + 300, "Expiration is set to 300 seconds in the future");

    // Test 3.2: Valid Token Verification
    const validVerify = await verifyStreamToken({
      secretKey: SECRET,
      token,
      attemptId: "vca_auth_100",
      sessionId: "vbs_auth_100",
      nowMs: nowMs + 10000, // 10s later
    });
    assert(validVerify.isValid === true, "Valid unexpired token is accepted");

    // Test 3.3: Expired Token Rejection
    const expiredVerify = await verifyStreamToken({
      secretKey: SECRET,
      token,
      attemptId: "vca_auth_100",
      sessionId: "vbs_auth_100",
      nowMs: (exp + 1) * 1000, // 1s past expiration
    });
    assert(expiredVerify.isValid === false, "Expired token is strictly rejected");
    assert(expiredVerify.reason === "Token has expired", "Rejection cites expiration reason");

    // Test 3.4: Replay Protection - Mismatched Attempt ID
    const mismatchedAttemptVerify = await verifyStreamToken({
      secretKey: SECRET,
      token,
      attemptId: "vca_auth_ATTACKER",
      sessionId: "vbs_auth_100",
      nowMs: nowMs + 5000,
    });
    assert(mismatchedAttemptVerify.isValid === false, "Token replayed with different attemptId is rejected");

    // Test 3.5: Replay Protection - Mismatched Session ID
    const mismatchedSessionVerify = await verifyStreamToken({
      secretKey: SECRET,
      token,
      attemptId: "vca_auth_100",
      sessionId: "vbs_auth_ATTACKER",
      nowMs: nowMs + 5000,
    });
    assert(mismatchedSessionVerify.isValid === false, "Token replayed with different sessionId is rejected");

    // Test 3.6: Tampered Signature Rejection
    const tamperedToken = `${exp}.deadbeef00112233445566778899aabbccddeeff`;
    const tamperedVerify = await verifyStreamToken({
      secretKey: SECRET,
      token: tamperedToken,
      attemptId: "vca_auth_100",
      sessionId: "vbs_auth_100",
      nowMs: nowMs + 5000,
    });
    assert(tamperedVerify.isValid === false, "Tampered signature is strictly rejected");

    // Test 3.7: Single-use token replay rejection
    const replayVerify = await verifyStreamToken({
      secretKey: SECRET,
      token, // Already consumed in Test 3.2
      attemptId: "vca_auth_100",
      sessionId: "vbs_auth_100",
      nowMs: nowMs + 15000,
    });
    assert(replayVerify.isValid === false, "Already-consumed token is strictly rejected on replay");
    assert(Boolean(replayVerify.reason?.includes("already been consumed")), "Replay rejection cites consumed nonce");

    // Test 3.8: Process-Local InMemoryTokenNonceRegistry Unit Tests
    const testRegistry = new InMemoryTokenNonceRegistry();
    const testNonce = "local_nonce_001";
    const testExp = Math.floor(nowMs / 1000) + 300;
    const [c1, c2] = await Promise.all([
      Promise.resolve(testRegistry.atomicConsume(testNonce, testExp)),
      Promise.resolve(testRegistry.atomicConsume(testNonce, testExp)),
    ]);
    assert((c1 && !c2) || (!c1 && c2), "InMemoryTokenNonceRegistry: Concurrent consumption allows exactly one winner");
    assert(testRegistry.atomicConsume(testNonce, testExp) === false, "InMemoryTokenNonceRegistry: Subsequent replay is rejected");
    assert(testRegistry.size === 1, "InMemoryTokenNonceRegistry: Tracks 1 consumed nonce");

    // Test 3.9: Upstash Redis Token Nonce Registry & Multi-Instance Concurrency
    {
      const redisStore = new Set<string>();
      const mockRedisServer = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/pipeline") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              const commands = JSON.parse(body);
              const cmd = commands[0];
              if (cmd && cmd[0] === "SET") {
                const key = cmd[1];
                if (redisStore.has(key)) {
                  // Key already exists (NX condition fails)
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify([{ result: null }]));
                } else {
                  redisStore.add(key);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify([{ result: "OK" }]));
                }
              } else {
                res.writeHead(400);
                res.end();
              }
            } catch {
              res.writeHead(500);
              res.end();
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => mockRedisServer.listen(0, "127.0.0.1", () => resolve()));
      const address = mockRedisServer.address() as { port: number };
      const redisUrl = `http://127.0.0.1:${address.port}`;

      try {
        const bridgeInstanceA = new UpstashRedisTokenNonceRegistry({
          url: redisUrl,
          token: "mock-test-token",
        });
        const bridgeInstanceB = new UpstashRedisTokenNonceRegistry({
          url: redisUrl,
          token: "mock-test-token",
        });

        const sharedNonce = "shared_nonce_distributed_999";
        const expSec = Math.floor(Date.now() / 1000) + 300;

        // Instance A consumes nonce for the first time
        const claim1 = await bridgeInstanceA.atomicConsume(sharedNonce, expSec);
        assert(claim1 === true, "Upstash Redis: First claim on Instance A succeeds");

        // Instance B attempts to replay the same token on a separate instance
        const claim2 = await bridgeInstanceB.atomicConsume(sharedNonce, expSec);
        assert(claim2 === false, "Upstash Redis: Replay attempt on separate Instance B is strictly rejected");

        // Concurrency test: simulate two separate instances simultaneously receiving the same token
        const concurrentNonce = "concurrent_multi_instance_nonce_123";
        const [concA, concB] = await Promise.all([
          bridgeInstanceA.atomicConsume(concurrentNonce, expSec),
          bridgeInstanceB.atomicConsume(concurrentNonce, expSec),
        ]);
        assert(
          (concA && !concB) || (!concA && concB),
          "Upstash Redis: Concurrent token consumption across separate bridge instances allows exactly one winner"
        );

        // Fail-closed test: when Redis returns an error or is unreachable
        const brokenRedis = new UpstashRedisTokenNonceRegistry({
          url: "http://127.0.0.1:1", // Invalid port
          token: "bad-token",
        });
        const failClosedRes = await brokenRedis.atomicConsume("nonce_unreachable", expSec);
        assert(failClosedRes === false, "Upstash Redis: Unreachable Redis registry strictly fails closed (returns false)");
      } finally {
        await new Promise<void>((resolve) => mockRedisServer.close(() => resolve()));
      }
    }

    // Test 3.10: Firestore Token Nonce Registry Fail-Closed Validation
    {
      const firestoreRegistry = new FirestoreTokenNonceRegistry("voice_stream_nonces_test");
      const expSec = Math.floor(Date.now() / 1000) + 300;
      const fsResult = await firestoreRegistry.atomicConsume("fs_nonce_test_001", expSec);
      assert(typeof fsResult === "boolean", "FirestoreTokenNonceRegistry returns boolean outcome");
      if (!isFirebaseAdminAvailable()) {
        assert(fsResult === false, "FirestoreTokenNonceRegistry strictly fails closed when Firebase Admin is unavailable");
      }
    }

    // Test 3.11: Factory createSharedTokenNonceRegistry
    const sharedReg = createSharedTokenNonceRegistry();
    assert(sharedReg && typeof sharedReg.atomicConsume === "function", "createSharedTokenNonceRegistry creates valid TokenNonceRegistry adapter");

    // Test 3.12: Format negotiation with negotiateExotelMediaFormat
    // 3.9a: Valid PCM16 8kHz
    const pcm8Res = negotiateExotelMediaFormat({
      encoding: "audio/x-l16",
      sample_rate: 8000,
      bit_rate: 128000,
      channels: 1,
    });
    assert(pcm8Res.isValid === true && pcm8Res.format?.encoding === "pcm16" && pcm8Res.format?.sampleRate === 8000, "audio/x-l16 8kHz negotiates to pcm16 8000Hz mono");

    // 3.9b: Valid PCM16 16kHz
    const pcm16Res = negotiateExotelMediaFormat({
      encoding: "L16",
      sample_rate: 16000,
      bit_rate: 256000,
      channels: 1,
    });
    assert(pcm16Res.isValid === true && pcm16Res.format?.encoding === "pcm16" && pcm16Res.format?.sampleRate === 16000, "L16 16kHz negotiates to pcm16 16000Hz mono");

    // 3.9c: Valid μ-law 8kHz
    const mulawRes = negotiateExotelMediaFormat({
      encoding: "audio/x-mulaw",
      sample_rate: 8000,
      bit_rate: 64000,
      channels: 1,
    });
    assert(mulawRes.isValid === true && mulawRes.format?.encoding === "mulaw" && mulawRes.format?.sampleRate === 8000, "audio/x-mulaw 8kHz negotiates to mulaw 8000Hz mono");

    // 3.9d: Valid PCMU 8kHz
    const pcmuRes = negotiateExotelMediaFormat({
      encoding: "PCMU",
      sample_rate: 8000,
      channels: 1,
    });
    assert(pcmuRes.isValid === true && pcmuRes.format?.encoding === "mulaw", "PCMU negotiates to mulaw mono");

    // 3.9e: Unsupported encoding (audio/opus) is rejected fail-closed
    const opusRes = negotiateExotelMediaFormat({
      encoding: "audio/opus",
      sample_rate: 8000,
      channels: 1,
    });
    assert(opusRes.isValid === false && Boolean(opusRes.errorReason?.includes("Unsupported encoding")), "audio/opus is rejected fail-closed");

    // 3.9f: Unsupported sample rate for PCM (44.1kHz) is rejected
    const badSampleRateRes = negotiateExotelMediaFormat({
      encoding: "audio/x-l16",
      sample_rate: 44100,
      channels: 1,
    });
    assert(badSampleRateRes.isValid === false && Boolean(badSampleRateRes.errorReason?.includes("Unsupported sample_rate")), "PCM 44.1kHz is rejected fail-closed");

    // 3.9g: Unsupported sample rate for μ-law (16kHz) is rejected
    const badMulawRateRes = negotiateExotelMediaFormat({
      encoding: "audio/x-mulaw",
      sample_rate: 16000,
      channels: 1,
    });
    assert(badMulawRateRes.isValid === false && Boolean(badMulawRateRes.errorReason?.includes("Unsupported sample_rate")), "μ-law 16kHz is rejected fail-closed");

    // 3.9h: Stereo (channels: 2) is rejected
    const stereoRes = negotiateExotelMediaFormat({
      encoding: "audio/x-l16",
      sample_rate: 8000,
      channels: 2,
    });
    assert(stereoRes.isValid === false && Boolean(stereoRes.errorReason?.includes("channels '2'")), "Stereo channels are rejected fail-closed");

    // 3.9i: Malformed / non-object is rejected
    const missingRes = negotiateExotelMediaFormat(null);
    assert(missingRes.isValid === false, "Null format is rejected fail-closed");

    // Test 3.13: Strict Nonce Validation
    assert(isValidStreamNonce("valid_nonce-12345678"), "Standard nonce is valid");
    assert(isValidStreamNonce("a".repeat(128)), "128-char nonce is valid");
    assert(!isValidStreamNonce("a".repeat(7)), "7-char nonce is rejected (too short)");
    assert(!isValidStreamNonce("a".repeat(129)), "129-char nonce is rejected (too long)");
    assert(!isValidStreamNonce("../../../etc/passwd"), "Path traversal in nonce is rejected");
    assert(!isValidStreamNonce("nonce with space"), "Whitespace in nonce is rejected");
    assert(!isValidStreamNonce("nonce\r\nSET bad 1"), "CRLF in nonce is rejected");
    assert(!isValidStreamNonce(""), "Empty nonce is rejected");
    assert(!isValidStreamNonce(null), "Null nonce is rejected");

    // Test 3.14: createSharedTokenNonceRegistry throws in production without shared backend
    const origEnv = process.env.NODE_ENV;
    const origUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const origUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const origFirestoreEm = process.env.FIRESTORE_EMULATOR_HOST;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.FIRESTORE_EMULATOR_HOST;
      setAdminFirestoreForTesting(null);
      let threwSafetyViolation = false;
      try {
        createSharedTokenNonceRegistry();
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("Configuration safety violation")) {
          threwSafetyViolation = true;
        }
      }
      assert(threwSafetyViolation, "createSharedTokenNonceRegistry throws in production if no shared backend is configured");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
      if (origUpstashUrl) process.env.UPSTASH_REDIS_REST_URL = origUpstashUrl;
      if (origUpstashToken) process.env.UPSTASH_REDIS_REST_TOKEN = origUpstashToken;
      if (origFirestoreEm) process.env.FIRESTORE_EMULATOR_HOST = origFirestoreEm;
      setAdminFirestoreForTesting(undefined);
    }
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 4: WebSocket Server Lifecycle & Handshake Rejection Tests
  // --------------------------------------------------------------------------
  console.log("\n--- TEST GROUP 4: WebSocket Server Handshake Rejection Tests ---");

  const TEST_PORT = 18091;
  const sessionRepo = new InMemoryVoiceSessionRepository();
  const attemptRepo = new InMemoryVoiceCallAttemptRepository();
  const speechProvider = new MockSpeechProvider({ generateSyntheticTone: true });
  const extractionProvider = new MockExtractionProvider();

  const bridgeApp = await createExotelAudioBridgeApp({
    speechProvider,
    sessionRepository: sessionRepo,
    callAttemptRepository: attemptRepo,
    extractionProvider,
    streamSecret: SECRET,
    chunkSizeBytes: EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
    allowStaticSecret: false, // Strict token verification
    tokenNonceRegistry: new InMemoryTokenNonceRegistry(),
  });

  await bridgeApp.listen({ port: TEST_PORT, host: "127.0.0.1" });
  console.log(`Audio Bridge test instance running on port ${TEST_PORT}`);

  try {
    // Test 4.1: Health check endpoint
    const healthRes = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const healthJson = await healthRes.json();
    assert(healthRes.status === 200, "Health check returns 200 OK");
    assert(healthJson.recordingEnabled === false, "Health check verifies recordingEnabled=false");
    assert(healthJson.minPacketBytes === 3200, "Health check verifies minPacketBytes=3,200");

    // Test 4.2: WebSocket handshake rejected with missing token
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/media`);
      ws.on("close", (code) => {
        try {
          assert(code === 4401 || code === 1006, `Missing token connection closed with code ${code}`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", () => resolve());
    });

    // Test 4.3: WebSocket handshake rejected with expired token
    const expiredToken = generateStreamToken({
      secretKey: SECRET,
      attemptId: "vca_exp_1",
      sessionId: "vbs_exp_1",
      expiresInSeconds: -10, // already expired
    }).token;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${TEST_PORT}/media?token=${expiredToken}&attemptId=vca_exp_1&sessionId=vbs_exp_1`
      );
      ws.on("close", (code) => {
        try {
          assert(code === 4401 || code === 1006, `Expired token connection closed with code ${code}`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", () => resolve());
    });

    // Test 4.4: WebSocket handshake rejected with tampered token
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${TEST_PORT}/media?token=9999999999.invalid_signature&attemptId=vca_tamper&sessionId=vbs_tamper`
      );
      ws.on("close", (code) => {
        try {
          assert(code === 4401 || code === 1006, `Tampered token connection closed with code ${code}`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", () => resolve());
    });

    // Test 4.5: WebSocket handshake rejected when token is replayed
    const singleUseToken = generateStreamToken({
      secretKey: SECRET,
      attemptId: "vca_replay_test",
      sessionId: "vbs_replay_test",
    }).token;

    // First connection: valid token consumed
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${TEST_PORT}/media?token=${singleUseToken}&attemptId=vca_replay_test&sessionId=vbs_replay_test`
      );
      ws.on("open", () => {
        ws.close(1000);
        resolve();
      });
      ws.on("error", (e) => reject(e));
    });

    // Second connection with same token: rejected due to consumed nonce
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${TEST_PORT}/media?token=${singleUseToken}&attemptId=vca_replay_test&sessionId=vbs_replay_test`
      );
      ws.on("close", (code) => {
        try {
          assert(code === 4401 || code === 1006, `Replayed token connection closed with code ${code} (expected 4401)`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", () => resolve());
    });

    // ------------------------------------------------------------------------
    // TEST GROUP 5: Authoritative Call SID Validation Against Stored Attempt
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 5: Authoritative Call SID Validation ---");

    // Pre-populate an attempt with providerCallId: "call_authoritative_001"
    await attemptRepo.createAttempt({
      id: "vca_call_sid_check",
      deliveryId: "del_call_sid_check",
      sessionId: "vbs_call_sid_check",
      phoneNumberMasked: "+91 98765 *****",
      provider: "exotel",
    });
    await attemptRepo.attachProviderCallId("vca_call_sid_check", "call_authoritative_001");

    // Test 5.1: Mismatched call_sid in start event is rejected with 4409
    {
      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_call_sid_check",
        sessionId: "vbs_call_sid_check",
        expiresInSeconds: 300,
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_call_sid_check&sessionId=vbs_call_sid_check`
        );

        ws.on("open", () => {
          // Send start event with spoofed/mismatched call_sid
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_mismatch_001",
              start: {
                call_sid: "call_SPOOFED_UNAUTHORIZED", // Mismatch!
                stream_sid: "stream_mismatch_001",
              },
            })
          );
        });

        ws.on("close", (code) => {
          try {
            assert(code === 4409, `Call SID mismatch closed with code 4409 (received: ${code})`);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        ws.on("error", () => resolve());
      });
    }

    // Test 5.2: Nonexistent attemptId is rejected with 4404
    {
      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_nonexistent_999",
        sessionId: "vbs_nonexistent_999",
        expiresInSeconds: 300,
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_nonexistent_999&sessionId=vbs_nonexistent_999`
        );

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_ghost_001",
              start: {
                call_sid: "call_ghost_001",
                stream_sid: "stream_ghost_001",
              },
            })
          );
        });

        ws.on("close", (code) => {
          try {
            assert(code === 4404, `Nonexistent attempt closed with code 4404 (received: ${code})`);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        ws.on("error", () => resolve());
      });
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 6: Exotel Event Lifecycle (connected -> start -> media -> mark -> stop)
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 6: Complete Exotel Event Lifecycle ---");

    {
      await attemptRepo.createAttempt({
        id: "vca_lifecycle_001",
        deliveryId: "del_lifecycle_001",
        sessionId: "vbs_lifecycle_001",
        phoneNumberMasked: "+91 98765 *****",
        provider: "exotel",
      });
      await attemptRepo.attachProviderCallId("vca_lifecycle_001", "call_lifecycle_001");

      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_lifecycle_001",
        sessionId: "vbs_lifecycle_001",
        expiresInSeconds: 300,
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_lifecycle_001&sessionId=vbs_lifecycle_001`
        );

        let greetingPacketAsserted = false;
        let markAsserted = false;

        ws.on("open", () => {
          // 1. Send 'connected' event
          ws.send(
            JSON.stringify({
              event: "connected",
              protocol: "Call",
              version: "1.0.0",
              sequence_number: 1,
              stream_sid: "stream_life_001",
            })
          );

          // 2. Send 'start' event with valid call_sid and Linear PCM 16-bit format
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 2,
              stream_sid: "stream_life_001",
              start: {
                call_sid: "call_lifecycle_001",
                stream_sid: "stream_life_001",
                media_format: {
                  encoding: "audio/x-l16",
                  sample_rate: 8000,
                  channels: 1,
                },
              },
            })
          );
        });

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.event === "media") {
            const buf = Buffer.from(msg.media.payload, "base64");
            if (!greetingPacketAsserted) {
              greetingPacketAsserted = true;
              assert(msg.stream_sid === "stream_life_001", "Outbound media echoes matching stream_sid");
              assert(buf.length >= 3200, `Outbound media packet satisfies Exotel minimum 3.2 KB requirement (received: ${buf.length} bytes)`);
              assert(buf.length % 320 === 0, `Outbound media packet is integer multiple of 320 bytes (received: ${buf.length} bytes)`);
            }
          } else if (msg.event === "mark") {
            if (!markAsserted) {
              markAsserted = true;
              assert(msg.stream_sid === "stream_life_001", "Outbound mark echoes matching stream_sid");
              assert(msg.mark?.name.includes("turn_0_complete"), "Outbound mark signals turn_0_complete");

              // 3. Send inbound mark reflection from Exotel
              ws.send(
                JSON.stringify({
                  event: "mark",
                  sequence_number: 90,
                  stream_sid: "stream_life_001",
                  mark: { name: "turn_0_complete" },
                })
              );

              // 4. Send stop event from Exotel
              ws.send(
                JSON.stringify({
                  event: "stop",
                  sequence_number: 99,
                  stream_sid: "stream_life_001",
                  stop: {
                    call_sid: "call_lifecycle_001",
                    reason: "call_completed_normal",
                  },
                })
              );
            }
          }
        });

        ws.on("close", (code) => {
          try {
            assert(code === 1000, "Socket closed cleanly on stop event");
            attemptRepo.getById("vca_lifecycle_001").then((attempt) => {
              try {
                assert(attempt !== null && attempt.status === "completed", "Attempt transitioned to completed status");
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          } catch (e) {
            reject(e);
          }
        });

        ws.on("error", (err) => reject(err));
      });
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 7: Format Negotiation (Default Signed 16-bit PCM vs Explicit μ-law)
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 7: Media Format Negotiation ---");

    // Test 7.1: Explicit μ-law requested
    {
      await attemptRepo.createAttempt({
        id: "vca_mulaw_req",
        deliveryId: "del_mulaw_req",
        sessionId: "vbs_mulaw_req",
        phoneNumberMasked: "+91 98765 *****",
        provider: "exotel",
      });
      await attemptRepo.attachProviderCallId("vca_mulaw_req", "call_mulaw_req");

      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_mulaw_req",
        sessionId: "vbs_mulaw_req",
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_mulaw_req&sessionId=vbs_mulaw_req`
        );
        let checked = false;

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_mulaw_req",
              start: {
                call_sid: "call_mulaw_req",
                stream_sid: "stream_mulaw_req",
                media_format: {
                  encoding: "audio/x-mulaw",
                  sample_rate: 8000,
                  channels: 1,
                },
              },
            })
          );
        });

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.event === "media" && !checked) {
            checked = true;
            const buf = Buffer.from(msg.media.payload, "base64");
            assert(buf.length >= 3200 && buf.length % 320 === 0, "Explicit μ-law stream delivers compliant >= 3.2 KB chunks");
            ws.close(1000);
            resolve();
          }
        });

        ws.on("error", (err) => reject(err));
      });
    }

    // Test 7.2: Unsupported format is rejected fail-closed with code 4415 (no silent fallback to PCM)
    {
      await attemptRepo.createAttempt({
        id: "vca_unexpected_fmt",
        deliveryId: "del_unexpected_fmt",
        sessionId: "vbs_unexpected_fmt",
        phoneNumberMasked: "+91 98765 *****",
        provider: "exotel",
      });
      await attemptRepo.attachProviderCallId("vca_unexpected_fmt", "call_unexpected_fmt");

      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_unexpected_fmt",
        sessionId: "vbs_unexpected_fmt",
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_unexpected_fmt&sessionId=vbs_unexpected_fmt`
        );

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_unexp_fmt",
              start: {
                call_sid: "call_unexpected_fmt",
                stream_sid: "stream_unexp_fmt",
                media_format: {
                  encoding: "audio/opus-unknown", // Unsupported!
                  sample_rate: 8000,
                  channels: 1,
                },
              },
            })
          );
        });

        ws.on("close", (code) => {
          try {
            assert(code === 4415, `Unsupported format was rejected fail-closed with code ${code} (expected 4415)`);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        ws.on("error", () => {
          // If close was handled, error is expected
        });
      });
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 8: Real-Time Barge-In & 'clear' Event Dispatch
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 8: Real-Time Barge-In Interruption ---");

    {
      await attemptRepo.createAttempt({
        id: "vca_bargein_001",
        deliveryId: "del_bargein_001",
        sessionId: "vbs_bargein_001",
        phoneNumberMasked: "+91 98765 *****",
        provider: "exotel",
      });
      await attemptRepo.attachProviderCallId("vca_bargein_001", "call_bargein_001");

      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_bargein_001",
        sessionId: "vbs_bargein_001",
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_bargein_001&sessionId=vbs_bargein_001`
        );

        let clearReceived = false;

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_barge_001",
              start: {
                call_sid: "call_bargein_001",
                stream_sid: "stream_barge_001",
              },
            })
          );
        });

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.event === "media" && !clearReceived) {
            // While assistant is streaming greeting media, simulate customer barge-in speech
            const interruptionChunk = Buffer.alloc(3200, 0x44);
            ws.send(
              JSON.stringify({
                event: "media",
                sequence_number: 2,
                stream_sid: "stream_barge_001",
                media: {
                  chunk: 1,
                  timestamp: "500",
                  payload: interruptionChunk.toString("base64"),
                },
              })
            );
          } else if (msg.event === "clear") {
            clearReceived = true;
            assert(msg.stream_sid === "stream_barge_001", "Barge-in triggers clear event with matching stream_sid");
            ws.close(1000);
            resolve();
          }
        });

        ws.on("error", (err) => reject(err));
      });
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 9: Multilingual Conversational Turns (English, Hindi, Telugu)
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 9: Multilingual Conversational Turns ---");

    {
      await attemptRepo.createAttempt({
        id: "vca_multi_turn_001",
        deliveryId: "del_multi_turn_001",
        sessionId: "vbs_multi_turn_001",
        phoneNumberMasked: "+91 98765 *****",
        provider: "exotel",
      });
      await attemptRepo.attachProviderCallId("vca_multi_turn_001", "call_multi_turn_001");

      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_multi_turn_001",
        sessionId: "vbs_multi_turn_001",
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_multi_turn_001&sessionId=vbs_multi_turn_001`
        );

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_multi_turn",
              start: {
                call_sid: "call_multi_turn_001",
                stream_sid: "stream_multi_turn",
                media_format: { encoding: "audio/x-l16", sample_rate: 8000, channels: 1 },
              },
            })
          );
        });

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.event === "mark") {
            const markName = msg.mark?.name || "";

            if (markName === "turn_0_complete") {
              console.log("Greeting playback completed. Triggering Hindi turn...");
              speechProvider.enqueueTranscription("नमस्ते, मुझे 75 मेहमानों के लिए 2026-12-25 को कॉफ़ी चाहिए");

              // Send simulated customer audio chunks (total 24,000 bytes = 1.5s threshold at 8kHz 16-bit PCM)
              const audioChunk = Buffer.alloc(12000, 0x11);
              ws.send(
                JSON.stringify({
                  event: "media",
                  sequence_number: 2,
                  stream_sid: "stream_multi_turn",
                  media: { chunk: 1, payload: audioChunk.toString("base64") },
                })
              );
              ws.send(
                JSON.stringify({
                  event: "media",
                  sequence_number: 3,
                  stream_sid: "stream_multi_turn",
                  media: { chunk: 2, payload: audioChunk.toString("base64") },
                })
              );
            } else if (markName === "turn_1_complete") {
              console.log("Hindi turn completed. Triggering Telugu turn...");
              speechProvider.enqueueTranscription("నమస్కారం, మా వేదిక హైటెక్ సిటీ హైదరాబాద్ లో ఉంది");

              const audioChunk = Buffer.alloc(12000, 0x22);
              ws.send(
                JSON.stringify({
                  event: "media",
                  sequence_number: 4,
                  stream_sid: "stream_multi_turn",
                  media: { chunk: 3, payload: audioChunk.toString("base64") },
                })
              );
              ws.send(
                JSON.stringify({
                  event: "media",
                  sequence_number: 5,
                  stream_sid: "stream_multi_turn",
                  media: { chunk: 4, payload: audioChunk.toString("base64") },
                })
              );
            } else if (markName === "turn_2_complete") {
              console.log("Telugu turn completed. Verifying conversation state in repository...");

              sessionRepo.getById("vbs_multi_turn_001").then((session) => {
                try {
                  assert(session !== null, "Session record persisted in repository");
                  assert(Boolean(session && session.conversationHistory.length >= 2), "Conversation history contains turns");
                  ws.close(1000);
                  resolve();
                } catch (err) {
                  reject(err);
                }
              });
            }
          }
        });

        ws.on("error", (err) => reject(err));
      });
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 10: Robustness to Malformed Events & Unknown JSON
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 10: Malformed Events & Robustness ---");

    {
      await attemptRepo.createAttempt({
        id: "vca_robust_001",
        deliveryId: "del_robust_001",
        sessionId: "vbs_robust_001",
        phoneNumberMasked: "+91 98765 *****",
        provider: "exotel",
      });
      await attemptRepo.attachProviderCallId("vca_robust_001", "call_robust_001");

      const token = generateStreamToken({
        secretKey: SECRET,
        attemptId: "vca_robust_001",
        sessionId: "vbs_robust_001",
      }).token;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${TEST_PORT}/media?token=${token}&attemptId=vca_robust_001&sessionId=vbs_robust_001`
        );

        ws.on("open", () => {
          // Send invalid JSON string
          ws.send("THIS_IS_NOT_VALID_JSON{{{");
          // Send JSON without event property
          ws.send(JSON.stringify({ some_random_key: "value" }));
          // Send unknown event name
          ws.send(JSON.stringify({ event: "unknown_event_xyz" }));

          // Now send valid start event: server must still be healthy and responsive!
          ws.send(
            JSON.stringify({
              event: "start",
              sequence_number: 1,
              stream_sid: "stream_robust_001",
              start: {
                call_sid: "call_robust_001",
                stream_sid: "stream_robust_001",
              },
            })
          );
        });

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.event === "media") {
            assert(msg.stream_sid === "stream_robust_001", "Server remains healthy and processes start after malformed frames");
            ws.close(1000);
            resolve();
          }
        });

        ws.on("error", (err) => reject(err));
      });
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 11: Azure Speech Provider Neural Voices & Security
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 11: Azure Speech Provider Neural Voices ---");

    {
      assert(AZURE_NEURAL_VOICES.en.female === "en-IN-NeerjaNeural", "English neural voice mapped to en-IN-NeerjaNeural");
      assert(AZURE_NEURAL_VOICES.hi.female === "hi-IN-SwaraNeural", "Hindi neural voice mapped to hi-IN-SwaraNeural");
      assert(AZURE_NEURAL_VOICES.te.female === "te-IN-ShrutiNeural", "Telugu neural voice mapped to te-IN-ShrutiNeural");

      const azureProvider = new AzureSpeechProvider({ subscriptionKey: "", region: "centralindia" });
      let keyErrorCaught = false;
      try {
        await azureProvider.synthesizeSpeech("Test", {
          language: "en",
          encoding: "pcm16",
          sampleRate: 8000,
        });
      } catch (err: unknown) {
        keyErrorCaught = true;
        assert((err as Error).message.includes("AZURE_SPEECH_KEY is not defined"), "AzureSpeechProvider fails closed when key is missing");
      }
      assert(keyErrorCaught, "Azure Speech key validation prevents unauthorized live API invocations");
    }

    // ------------------------------------------------------------------------
    // TEST GROUP 12: Quotation Integrity (HMAC-SHA256) & Staff Approval Gate
    // ------------------------------------------------------------------------
    console.log("\n--- TEST GROUP 12: Quotation Integrity & Staff Approval Gate ---");

    {
      const validRequirements: BookingRequirements = {
        guestCount: 50,
        eventDate: "2026-12-25",
        startTime: "10:00",
        durationHours: 3,
        venueAddress: "Hitec City, Hyderabad",
        eventType: "Corporate Gathering",
        beveragePreferences: ["Espresso", "Cappuccino"],
        selectedTier: "STANDARD",
        handoffRequested: false,
        customerConfirmed: false,
        confidenceScore: 0.95,
        missingFields: [],
        unresolvedQuestions: [],
      };

      const activeQuotation = generateVoiceBookingQuotation(validRequirements);
      const snapshot = createQuotationSnapshot(validRequirements);
      assert(typeof snapshot.hash === "string" && snapshot.hash.length === 64, "Quotation snapshot generates valid 64-char SHA-256 hash");

      const validCheck = verifyQuotationIntegrity(snapshot, validRequirements, activeQuotation);
      assert(validCheck.isMatch === true, "Unmodified quotation requirements match snapshot hash");

      const tamperedRequirements: BookingRequirements = {
        ...validRequirements,
        guestCount: 200, // Tampered!
      };
      const tamperedCheck = verifyQuotationIntegrity(snapshot, tamperedRequirements, activeQuotation);
      assert(tamperedCheck.isMatch === false, "Tampered guest count fails quotation snapshot verification");
      assert(tamperedCheck.mismatchedFields.includes("guestCount"), "Identifies guestCount as mismatched field");

      const gateEvaluation = evaluateConfirmationSafetyGate({
        userUtterance: "Yes, I confirm this booking",
        language: "en",
        extractionResult: {
          status: "success",
          source: "mock",
          data: { selectedTier: "STANDARD" },
          confidenceScore: 0.98,
          confirmationIntent: "positive_acceptance",
        },
        hasValidQuotation: true,
        activeQuotation,
        currentRequirements: tamperedRequirements,
        quotationSnapshot: snapshot,
      });

      assert(gateEvaluation.isConfirmed === false, "Confirmation safety gate rejects confirmation when quotation integrity fails");
      assert(gateEvaluation.reason.includes("integrity check failed"), "Safety gate reason explicitly cites quotation integrity failure");
    }

  } finally {
    await bridgeApp.close();
    console.log("Audio Bridge test instance closed cleanly.");
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`  PHASE 6.6.3.1 VERIFICATION RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Unhandled exception in Phase 6.6.3.1 test suite:", err);
  process.exit(1);
});
