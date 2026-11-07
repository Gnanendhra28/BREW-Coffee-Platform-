/**
 * BREW Coffee Platform — Phase 6.6.4.1 Verification Test Suite
 * Voice Bridge Integration Gap Closure
 *
 * Verifies:
 * 1. Dynamic Exotel stream-token handoff:
 *    - Generates short-lived, single-use token bound to attemptId and sessionId.
 *    - Appends token, attemptId, and sessionId to StreamUrl using safe URL construction.
 *    - Preserves existing HMAC, nonce-consumption, expiry, and correlation checks.
 *    - Enforces Exotel's documented 600-character StreamUrl limit.
 *    - Secret redaction: never leaks tokens or full authenticated StreamUrls in logs/errors.
 * 2. Token verification & security boundaries:
 *    - Valid tokens are accepted and consumed.
 *    - Mismatched attemptId or sessionId strictly rejected.
 *    - Expired tokens strictly rejected.
 *    - Replayed tokens strictly rejected.
 * 3. Standalone Fastify bridge server:
 *    - Configurable host and port.
 *    - Configuration validation at startup (fails closed if missing required keys).
 *    - Graceful shutdown and resource cleanup.
 * 4. Firestore nonce TTL readiness:
 *    - Documents written with Timestamp expireAt for automated background reclamation.
 *    - Atomic transaction remains the real-time replay-prevention mechanism.
 */

import assert from "assert";
import { ExotelVoiceProvider, ExotelApiError } from "../src/lib/communication/providers/exotelVoiceProvider";
import {
  verifyStreamToken,
  InMemoryTokenNonceRegistry,
  generateStreamToken,
} from "../src/lib/communication/voice/audioBridge/exotelAudioBridge";
import {
  startVoiceBridgeServer,
  validateVoiceBridgeConfig,
} from "../src/server/voiceBridgeServer";
import { InMemoryVoiceCallAttemptRepository } from "../src/lib/communication/voice/callAttemptRepository";
import { withTestVoiceBookingEnabled } from "../src/lib/communication/outbox/testFixture";
import fs from "fs";
import path from "path";

let passedCount = 0;
let failedCount = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passedCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedCount++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.6.4.1 Verification Suite");
  console.log("   Voice Bridge Integration Gap Closure & Stream-Token Handoff");
  console.log("================================================================================\n");

  const mockApiKey = "exo_test_api_key_gap_closure";
  const mockApiToken = "exo_test_api_token_gap_closure";
  const mockAccountSid = "brew_exotel_acc_gap";
  const mockCallerId = "08011223344";
  const mockBaseStreamUrl = "wss://voice.brewcoffee.in/media";
  const mockStreamSecret = "stream_secret_test_key_998877";

  // ---------------------------------------------------------------------------
  // 1. DYNAMIC EXOTEL STREAM-TOKEN HANDOFF
  // ---------------------------------------------------------------------------
  console.log("--- 1. DYNAMIC EXOTEL STREAM-TOKEN HANDOFF ---");

  await test("1.1 ExotelVoiceProvider generates and appends valid stream token to StreamUrl", async () => {
    await withTestVoiceBookingEnabled(async () => {
      let capturedBody = "";

      const mockFetch: typeof fetch = async (_url, init) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            Call: {
              Sid: "call_sid_stream_token_test",
              Status: "in-progress",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: mockBaseStreamUrl,
        streamSecret: mockStreamSecret,
        fetchFn: mockFetch,
      });

      const result = await provider.startSession({
        sessionId: "vbs_gap_101",
        phoneNumber: "+919876543210",
        language: "en",
        idempotencyKey: "vca_gap_101",
      });

      assert.strictEqual(result.providerCallId, "call_sid_stream_token_test");

      const params = new URLSearchParams(capturedBody);
      const streamUrlRaw = params.get("StreamUrl");
      assert.ok(streamUrlRaw, "StreamUrl parameter must be present");
      assert.ok(streamUrlRaw.startsWith(mockBaseStreamUrl), "StreamUrl must start with base URL");

      const parsedUrl = new URL(streamUrlRaw);
      const token = parsedUrl.searchParams.get("token");
      const attemptId = parsedUrl.searchParams.get("attemptId");
      const sessionId = parsedUrl.searchParams.get("sessionId");

      assert.ok(token && token.length > 20, "Token parameter must be populated");
      assert.strictEqual(attemptId, "vca_gap_101", "attemptId query parameter matches idempotencyKey");
      assert.strictEqual(sessionId, "vbs_gap_101", "sessionId query parameter matches session");

      // Verify the generated token with the audio bridge verification logic
      const registry = new InMemoryTokenNonceRegistry();
      const verifyResult = await verifyStreamToken({
        secretKey: mockStreamSecret,
        token,
        attemptId: "vca_gap_101",
        sessionId: "vbs_gap_101",
        tokenNonceRegistry: registry,
      });

      assert.strictEqual(verifyResult.isValid, true, "Generated StreamUrl token is verified successfully");
    });
  });

  await test("1.2 StreamUrl length boundary enforcement (<= 600 characters)", async () => {
    await withTestVoiceBookingEnabled(async () => {
      // Create a base URL that, when appended with parameters, exceeds 600 characters
      const longBase = `wss://voice.brewcoffee.in/media/${"a".repeat(500)}`;

      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: longBase,
        streamSecret: mockStreamSecret,
      });

      let threw = false;
      try {
        await provider.startSession({
          sessionId: "vbs_oversized_url",
          phoneNumber: "+919876543210",
          language: "en",
          idempotencyKey: "vca_oversized_url",
        });
      } catch (err: unknown) {
        threw = true;
        assert.ok(err instanceof ExotelApiError, "Throws ExotelApiError");
        assert.strictEqual((err as ExotelApiError).isCertainRejection, true, "Marked as certain rejection");
        assert.ok((err as Error).message.includes("600-character limit"), "Cites 600-character limit");
      }
      assert.strictEqual(threw, true, "Must throw when StreamUrl exceeds 600 characters");
    });
  });

  await test("1.3 Malformed StreamUrl rejected fail-closed", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: "not-a-valid-absolute-url",
        streamSecret: mockStreamSecret,
      });

      let threw = false;
      try {
        await provider.startSession({
          sessionId: "vbs_bad_url",
          phoneNumber: "+919876543210",
          language: "en",
          idempotencyKey: "vca_bad_url",
        });
      } catch (err: unknown) {
        threw = true;
        assert.ok(err instanceof ExotelApiError);
        assert.strictEqual((err as ExotelApiError).isCertainRejection, true);
        assert.ok((err as Error).message.includes("Invalid EXOTEL_STREAM_URL format"));
      }
      assert.strictEqual(threw, true, "Must throw on malformed StreamUrl format");
    });
  });

  await test("1.4 Missing stream secret throws certain rejection without dispatching call", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const origSecret = process.env.EXOTEL_STREAM_SECRET;
      const origKey = process.env.STREAM_SECRET_KEY;
      const origAuth = process.env.AUTH_SECRET;
      const origWebhook = process.env.EXOTEL_WEBHOOK_SECRET;
      delete process.env.EXOTEL_STREAM_SECRET;
      delete process.env.STREAM_SECRET_KEY;
      delete process.env.AUTH_SECRET;
      delete process.env.EXOTEL_WEBHOOK_SECRET;

      try {
        const provider = new ExotelVoiceProvider({
          accountSid: mockAccountSid,
          apiKey: mockApiKey,
          apiToken: mockApiToken,
          callerId: mockCallerId,
          streamUrl: mockBaseStreamUrl,
          // No streamSecret or statusCallbackToken
        });

        let threw = false;
        try {
          await provider.startSession({
            sessionId: "vbs_no_secret",
            phoneNumber: "+919876543210",
            language: "en",
          });
        } catch (err: unknown) {
          threw = true;
          assert.ok(err instanceof ExotelApiError);
          assert.strictEqual((err as ExotelApiError).isCertainRejection, true);
          assert.ok((err as Error).message.includes("Missing stream secret"));
        }
        assert.strictEqual(threw, true, "Must throw when stream secret is missing");
      } finally {
        if (origSecret) process.env.EXOTEL_STREAM_SECRET = origSecret;
        if (origKey) process.env.STREAM_SECRET_KEY = origKey;
        if (origAuth) process.env.AUTH_SECRET = origAuth;
        if (origWebhook) process.env.EXOTEL_WEBHOOK_SECRET = origWebhook;
      }
    });
  });

  await test("1.5 Secret redaction: stream secret and token are never exposed in error outputs", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const rejectingFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            RestException: {
              Message: `Simulated carrier error with secret=${mockStreamSecret}&token=12345.deadbeef6789`,
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: mockBaseStreamUrl,
        streamSecret: mockStreamSecret,
        fetchFn: rejectingFetch,
      });

      try {
        await provider.startSession({
          sessionId: "vbs_redaction_test",
          phoneNumber: "+919876543210",
          language: "en",
        });
        assert.fail("Should have thrown error");
      } catch (err: unknown) {
        const msg = (err as Error).message;
        assert.ok(!msg.includes(mockStreamSecret), "Stream secret must be redacted from error message");
        assert.ok(!msg.includes("12345.deadbeef6789"), "Stream token must be redacted from error message");
        assert.ok(msg.includes("[REDACTED_STREAM_SECRET]"), "Stream secret placeholder present");
        assert.ok(msg.includes("[REDACTED_STREAM_TOKEN]"), "Stream token placeholder present");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. TOKEN VERIFICATION & CORRELATION INTEGRATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. TOKEN VERIFICATION & CORRELATION INTEGRATION ---");

  await test("2.1 Rejection of token with mismatched attemptId", async () => {
    const registry = new InMemoryTokenNonceRegistry();
    const { token } = generateStreamToken({
      secretKey: mockStreamSecret,
      attemptId: "vca_legit_attempt",
      sessionId: "vbs_session_1",
    });

    const verify = await verifyStreamToken({
      secretKey: mockStreamSecret,
      token,
      attemptId: "vca_ATTACKER_attempt",
      sessionId: "vbs_session_1",
      tokenNonceRegistry: registry,
    });

    assert.strictEqual(verify.isValid, false, "Must reject mismatched attemptId");
  });

  await test("2.2 Rejection of token with mismatched sessionId", async () => {
    const registry = new InMemoryTokenNonceRegistry();
    const { token } = generateStreamToken({
      secretKey: mockStreamSecret,
      attemptId: "vca_attempt_1",
      sessionId: "vbs_legit_session",
    });

    const verify = await verifyStreamToken({
      secretKey: mockStreamSecret,
      token,
      attemptId: "vca_attempt_1",
      sessionId: "vbs_ATTACKER_session",
      tokenNonceRegistry: registry,
    });

    assert.strictEqual(verify.isValid, false, "Must reject mismatched sessionId");
  });

  await test("2.3 Rejection of expired stream token", async () => {
    const registry = new InMemoryTokenNonceRegistry();
    const nowMs = 1700000000000;
    const { token, exp } = generateStreamToken({
      secretKey: mockStreamSecret,
      attemptId: "vca_exp_1",
      sessionId: "vbs_exp_1",
      expiresInSeconds: 60,
      nowMs,
    });

    const verify = await verifyStreamToken({
      secretKey: mockStreamSecret,
      token,
      attemptId: "vca_exp_1",
      sessionId: "vbs_exp_1",
      nowMs: (exp + 10) * 1000, // 10s past expiration
      tokenNonceRegistry: registry,
    });

    assert.strictEqual(verify.isValid, false, "Must reject expired token");
    assert.strictEqual(verify.reason, "Token has expired");
  });

  await test("2.4 Replay rejection of already-consumed stream token", async () => {
    const registry = new InMemoryTokenNonceRegistry();
    const { token } = generateStreamToken({
      secretKey: mockStreamSecret,
      attemptId: "vca_replay_1",
      sessionId: "vbs_replay_1",
    });

    // First consumption: success
    const claim1 = await verifyStreamToken({
      secretKey: mockStreamSecret,
      token,
      attemptId: "vca_replay_1",
      sessionId: "vbs_replay_1",
      tokenNonceRegistry: registry,
    });
    assert.strictEqual(claim1.isValid, true, "First consumption must succeed");

    // Replay attempt: rejected
    const claim2 = await verifyStreamToken({
      secretKey: mockStreamSecret,
      token,
      attemptId: "vca_replay_1",
      sessionId: "vbs_replay_1",
      tokenNonceRegistry: registry,
    });
    assert.strictEqual(claim2.isValid, false, "Replay must be strictly rejected");
    assert.ok(claim2.reason?.includes("already been consumed"));
  });

  // ---------------------------------------------------------------------------
  // 3. STANDALONE FASTIFY AUDIO BRIDGE SERVER
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. STANDALONE FASTIFY AUDIO BRIDGE SERVER ---");

  await test("3.1 validateVoiceBridgeConfig fails closed in production when STREAM_SECRET_KEY is missing", async () => {
    const origSecret = process.env.STREAM_SECRET_KEY;
    const origExotel = process.env.EXOTEL_STREAM_SECRET;
    const origAuth = process.env.AUTH_SECRET;
    delete process.env.STREAM_SECRET_KEY;
    delete process.env.EXOTEL_STREAM_SECRET;
    delete process.env.AUTH_SECRET;

    try {
      let threw = false;
      try {
        validateVoiceBridgeConfig(true); // isProduction = true
      } catch (err: unknown) {
        threw = true;
        assert.ok((err as Error).message.includes("STREAM_SECRET_KEY"));
      }
      assert.strictEqual(threw, true, "Must throw in production when stream secret is missing");
    } finally {
      if (origSecret) process.env.STREAM_SECRET_KEY = origSecret;
      if (origExotel) process.env.EXOTEL_STREAM_SECRET = origExotel;
      if (origAuth) process.env.AUTH_SECRET = origAuth;
    }
  });

  await test("3.2 Standalone server startup, healthcheck, and graceful shutdown", async () => {
    const TEST_SERVER_PORT = 18092;
    const attemptRepo = new InMemoryVoiceCallAttemptRepository();

    const serverInstance = await startVoiceBridgeServer({
      port: TEST_SERVER_PORT,
      host: "127.0.0.1",
      streamSecret: mockStreamSecret,
      callAttemptRepository: attemptRepo,
      tokenNonceRegistry: new InMemoryTokenNonceRegistry(),
    });

    try {
      assert.strictEqual(serverInstance.port, TEST_SERVER_PORT);
      assert.strictEqual(serverInstance.host, "127.0.0.1");

      // Verify health check responds
      const healthRes = await fetch(`http://127.0.0.1:${TEST_SERVER_PORT}/health`);
      assert.strictEqual(healthRes.status, 200, "Health check responds with HTTP 200");
      const healthJson = await healthRes.json();
      assert.strictEqual(healthJson.status, "ok");
      assert.strictEqual(healthJson.service, "exotel-audio-bridge");
      assert.strictEqual(healthJson.recordingEnabled, false, "Recording is strictly disabled");
    } finally {
      // Test graceful shutdown
      await serverInstance.close();
    }

    // Verify port is freed after shutdown
    let connectionRefused = false;
    try {
      await fetch(`http://127.0.0.1:${TEST_SERVER_PORT}/health`);
    } catch {
      connectionRefused = true;
    }
    assert.strictEqual(connectionRefused, true, "Server port freed cleanly after graceful close");
  });

  // ---------------------------------------------------------------------------
  // 4. FIRESTORE NONCE TTL READINESS
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. FIRESTORE NONCE TTL READINESS ---");

  await test("4.1 firestore.indexes.json specifies TTL fieldOverride on voice_stream_nonces.expireAt", async () => {
    const indexesPath = path.resolve(process.cwd(), "firestore.indexes.json");
    assert.ok(fs.existsSync(indexesPath), "firestore.indexes.json must exist");

    const indexesContent = JSON.parse(fs.readFileSync(indexesPath, "utf8"));
    assert.ok(Array.isArray(indexesContent.fieldOverrides), "fieldOverrides must be an array");

    const ttlOverride = indexesContent.fieldOverrides.find(
      (override: Record<string, unknown>) =>
        override.collectionGroup === "voice_stream_nonces" &&
        override.fieldPath === "expireAt" &&
        override.ttl === true
    );

    assert.ok(ttlOverride, "Must define TTL override on voice_stream_nonces.expireAt");
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.6.4.1 Verification Complete: ${passedCount}/${passedCount + failedCount} checks passed`);
  console.log(failedCount === 0 ? "   RESULT: ALL TESTS PASSED (SUCCESS)" : "   RESULT: TESTS FAILED");
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled exception in Phase 6.6.4.1 test suite:", err);
  process.exit(1);
});
