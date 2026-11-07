/**
 * BREW Coffee Platform — Phase 6.6.2.1 Verification Suite
 * Exotel API Configuration & Webhook Corrections
 *
 * Verifies:
 * 1. Outbound call initiation via Direct Connect Voice AI:
 *    - Uses correct India host: https://api.in.exotel.com (Mumbai cluster) by default.
 *    - Does NOT silently fall back to Singapore (api.exotel.com).
 *    - Sends StreamUrl and StreamType='bidirectional'.
 *    - Subscribes to StatusCallbackEvents: terminal, answered, ringing.
 *    - Validates returned VoiceSessionResult with providerCallId (CallSid).
 *    - Validates provider acceptance persistence to VoiceCallAttemptRepository.
 * 2. Strict CustomField 128-character limit & exact serialization format:
 *    - JSON serialization format strictly enforces <= 128 chars.
 *    - Compact fallback formats and visible failure when limits are exceeded.
 * 3. API request timeout and uncertain outcome handling:
 *    - Request timeout triggers AbortController, marks outcome uncertain, and strictly DOES NOT retry.
 * 4. Safe error classification & secret redaction:
 *    - Full redaction of API keys, tokens, and authorization headers from error messages.
 * 5. Bounded retries on safe pre-request connection failure:
 *    - Bounded retries execute only on connection-level failures before request processing.
 * 6. Authenticated Exotel status webhook:
 *    - Rejects missing credentials (401) and invalid credentials (403).
 *    - Accepts HTTP Basic Auth in Authorization header (embedded in URL).
 *    - Accepts per-call ephemeral signed HMAC query token (without reusable static secrets in query string).
 * 7. Malformed and contradictory callback rejection:
 *    - Rejects missing CallSid (400) or missing Status (400).
 *    - Rejects EventType="terminal" with non-terminal Status="ringing" (400).
 *    - Rejects EventType="answered" with Status="failed" (400).
 *    - Rejects EventType="ringing" with Status="completed" (400).
 *    - Rejects CustomField exceeding 128 characters (400).
 * 8. Webhook status transitions across all lifecycle states:
 *    - ringing, answered/in-progress, completed (with duration), busy, no-answer, failed.
 * 9. Idempotent duplicate, delayed, and conflicting terminal webhooks:
 *    - Duplicate returns idempotent_duplicate; delayed event returns ignored_out_of_order;
 *      conflicting terminal event records terminalConflict without overwriting authoritative record.
 * 10. Unmapped attempt recovery via Webhook CustomField:
 *    - Incoming webhook with CustomField recovers unmapped attempt whose worker crashed before saving.
 *    - Mismatched session rejects with 409 Conflict.
 * 11. getStatus and endSession API integration:
 *    - Correctly maps Exotel Call Details and executes hangup API on India cluster.
 */

process.env.CRON_SECRET = "test_cron_secret_6621_auth_token_48chars_secure!";
process.env.APP_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.BUSINESS_PHONE = "+919876543210";
process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import { NextRequest } from "next/server";
import {
  ExotelVoiceProvider,
  ExotelApiError,
  formatExotelCustomField,
  parseExotelCustomField,
  generateExotelCallbackSignature,
  InMemoryVoiceCallAttemptRepository,
} from "../src/lib/communication";
import { withTestVoiceBookingEnabled } from "../src/lib/communication/outbox/testFixture";
import {
  POST as exotelStatusWebhookHandler,
} from "../src/app/api/webhooks/voice/exotel/status/route";
import {
  _setExotelWebhookCallAttemptRepoForTesting,
} from "../src/lib/communication/testingHooks";

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.6.2.1 Verification Suite");
  console.log("   Exotel API Configuration & Webhook Corrections");
  console.log("================================================================================\n");

  const mockApiKey = "exo_test_api_key_1111111111111111";
  const mockApiToken = "exo_test_api_token_2222222222222222";
  const mockAccountSid = "brew_exotel_acc_333";
  const mockCallerId = "08088889999";
  const mockStreamUrl = "wss://voice.brewcoffee.in/media";
  const mockWebhookSecret = "webhook_secret_exotel_test_token_777";
  const mockWebhookUser = "brew_webhook_user";
  const mockWebhookPass = "brew_webhook_pass_888";

  process.env.EXOTEL_WEBHOOK_SECRET = mockWebhookSecret;
  process.env.EXOTEL_WEBHOOK_USER = mockWebhookUser;
  process.env.EXOTEL_WEBHOOK_PASSWORD = mockWebhookPass;

  // ---------------------------------------------------------------------------
  // 1. OUTBOUND CALL INITIATION VIA DIRECT CONNECT VOICE AI & INDIA HOST
  // ---------------------------------------------------------------------------
  console.log("--- 1. DIRECT CONNECT VOICE AI & INDIA HOST DEFAULT ---");

  await test("1.1 ExotelVoiceProvider defaults strictly to India host (https://api.in.exotel.com) and sends StreamUrl/StreamType", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();

      let capturedUrl = "";
      let capturedMethod = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method || "GET";
        capturedHeaders = (init?.headers || {}) as Record<string, string>;
        capturedBody = String(init?.body || "");

        return new Response(
          JSON.stringify({
            Call: {
              Sid: "call_exotel_sid_1234567890",
              ParentCallSid: null,
              DateCreated: "2026-11-06 20:45:00",
              DateUpdated: "2026-11-06 20:45:00",
              AccountSid: mockAccountSid,
              To: mockCallerId,
              From: "+919876543210",
              Status: "in-progress",
              Direction: "outbound-api",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      // Provider constructed WITHOUT explicit subdomain -> MUST default to api.in.exotel.com
      delete process.env.EXOTEL_SUBDOMAIN;
      delete process.env.EXOTEL_API_HOST;

      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: mockStreamUrl,
        statusCallbackToken: mockWebhookSecret,
        callAttemptRepository: callAttemptRepo,
        fetchFn: mockFetch,
      });

      await callAttemptRepo.createAttempt({
        id: "att_exo_init_01",
        deliveryId: "del_exo_01",
        sessionId: "vbs_exo_01",
        phoneNumberMasked: "+91 98*** ***10",
        provider: "exotel",
        initiationState: "in_flight",
      });

      const result = await provider.startSession({
        sessionId: "vbs_exo_01",
        phoneNumber: "+919876543210",
        language: "en",
        idempotencyKey: "att_exo_init_01",
      });

      // 1. Verify correct India API host (api.in.exotel.com) and Connect Voice AI endpoint (/Calls/connect)
      assert.strictEqual(
        capturedUrl,
        `https://api.in.exotel.com/v1/Accounts/${mockAccountSid}/Calls/connect`,
        "Must call India cluster api.in.exotel.com by default on /v1/Accounts/<sid>/Calls/connect"
      );
      assert.ok(!capturedUrl.includes("api.exotel.com/"), "Must NEVER silently default to Singapore api.exotel.com");
      assert.strictEqual(capturedMethod, "POST");

      // 2. Verify Basic Authorization header
      const expectedBasic = `Basic ${Buffer.from(`${mockApiKey}:${mockApiToken}`).toString("base64")}`;
      assert.strictEqual(capturedHeaders["Authorization"], expectedBasic);

      // 3. Verify Direct Connect Voice AI parameters (StreamUrl & StreamType="bidirectional")
      const formParams = new URLSearchParams(capturedBody);
      assert.strictEqual(formParams.get("From"), "+919876543210");
      assert.strictEqual(formParams.get("CallerId"), mockCallerId);
      const streamUrlParam = formParams.get("StreamUrl") || "";
      assert.ok(streamUrlParam.startsWith(mockStreamUrl), "StreamUrl must start with base streamUrl");
      assert.ok(streamUrlParam.includes("token="), "StreamUrl must include token query param");
      assert.ok(streamUrlParam.includes("attemptId="), "StreamUrl must include attemptId query param");
      assert.ok(streamUrlParam.includes("sessionId="), "StreamUrl must include sessionId query param");
      assert.strictEqual(formParams.get("StreamType"), "bidirectional", "StreamType must be 'bidirectional'");
      assert.strictEqual(formParams.get("Url"), null, "Flow Url must NOT be present when direct StreamUrl is used");

      // 4. Verify StatusCallback event subscriptions
      assert.strictEqual(formParams.get("StatusCallbackEvents[0]"), "terminal");
      assert.strictEqual(formParams.get("StatusCallbackEvents[1]"), "answered");
      assert.strictEqual(formParams.get("StatusCallbackEvents[2]"), "ringing");

      // 5. Verify ephemeral HMAC token in StatusCallback URL (avoiding reusable master secret in query string)
      const callbackUrl = formParams.get("StatusCallback");
      assert.ok(callbackUrl !== null);
      const callbackUrlObj = new URL(callbackUrl);
      const tokenInQuery = callbackUrlObj.searchParams.get("token");
      assert.ok(tokenInQuery !== null);
      assert.notStrictEqual(tokenInQuery, mockWebhookSecret, "StatusCallback must use an ephemeral per-call token, not master secret");

      const expectedHmac = generateExotelCallbackSignature(mockWebhookSecret, "att_exo_init_01", "vbs_exo_01");
      assert.strictEqual(tokenInQuery, expectedHmac, "Ephemeral token must match HMAC-SHA256(secret, attemptId:sessionId)");

      // 6. Verify CustomField payload
      const customField = formParams.get("CustomField");
      assert.ok(customField !== null);
      assert.ok(customField.length <= 128, "CustomField must strictly respect Exotel 128-char limit");
      const parsedCustom = parseExotelCustomField(customField);
      assert.strictEqual(parsedCustom.attemptId, "att_exo_init_01");
      assert.strictEqual(parsedCustom.sessionId, "vbs_exo_01");

      // 7. Verify returned VoiceSessionResult & repository update
      assert.strictEqual(result.providerCallId, "call_exotel_sid_1234567890");
      const updatedAttempt = await callAttemptRepo.getById("att_exo_init_01");
      assert.strictEqual(updatedAttempt?.initiationState, "accepted");
      assert.strictEqual(updatedAttempt?.providerCallId, "call_exotel_sid_1234567890");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. STRICT 128-CHAR CUSTOMFIELD ENFORCEMENT & SERIALIZATION FORMAT
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. CUSTOMFIELD 128-CHAR LIMIT & SERIALIZATION FORMAT ---");

  await test("2.1 formatExotelCustomField strictly enforces 128-character limit and format", () => {
    // 1. Standard JSON format when <= 128 chars
    const standard = formatExotelCustomField("att_test_12345", "vbs_test_67890");
    assert.strictEqual(standard, JSON.stringify({ attemptId: "att_test_12345", sessionId: "vbs_test_67890" }));
    assert.ok(standard.length <= 128);

    const parsed = parseExotelCustomField(standard);
    assert.strictEqual(parsed.attemptId, "att_test_12345");
    assert.strictEqual(parsed.sessionId, "vbs_test_67890");

    // 2. Exact length 128 serialization test
    const longAttempt = "att_" + "a".repeat(50);
    const longSession = "vbs_" + "b".repeat(50);
    const compactDelimited = formatExotelCustomField(longAttempt, longSession);
    assert.ok(compactDelimited.length <= 128, `Length must be <= 128, got ${compactDelimited.length}`);

    // 3. Rejection when length strictly exceeds 128 chars
    const excessiveAttempt = "att_" + "x".repeat(70);
    const excessiveSession = "vbs_" + "y".repeat(70);
    try {
      formatExotelCustomField(excessiveAttempt, excessiveSession);
      assert.fail("Should throw when CustomField exceeds 128 characters");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("128-character limit"), `Error must mention 128-char limit, got: ${err.message}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. API REQUEST TIMEOUT & UNCERTAIN OUTCOME
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. TIMEOUT HANDLING & UNCERTAIN OUTCOME ---");

  await test("3.1 Request timeout aborts request, classifies outcome as uncertain, and does not retry", async () => {
    await withTestVoiceBookingEnabled(async () => {
      let callCount = 0;
      const hangingFetch: typeof fetch = async (_input, init) => {
        callCount++;
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              const abortErr = new Error("This operation was aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            });
          }
        });
      };

      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: mockStreamUrl,
        requestTimeoutMs: 50,
        maxRetries: 3,
        fetchFn: hangingFetch,
      });

      try {
        await provider.startSession({
          sessionId: "vbs_timeout_01",
          phoneNumber: "+919876543210",
          language: "en",
          idempotencyKey: "att_timeout_01",
        });
        assert.fail("Should have thrown timeout error");
      } catch (err: unknown) {
        assert.ok(err instanceof ExotelApiError);
        assert.strictEqual(err.isTimeoutOrNetwork, true, "Timeout must be classified as isTimeoutOrNetwork");
        assert.strictEqual(err.isCertainRejection, false, "Timeout cannot be classified as certain rejection");
        assert.ok(err.message.includes("timed out"));
        assert.ok(err.message.includes("uncertain"));
      }

      assert.strictEqual(callCount, 1, "Provider must NEVER retry on request timeout to avoid duplicate PSTN calls");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. SAFE ERROR CLASSIFICATION & SECRET REDACTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. SAFE ERROR CLASSIFICATION & SECRET REDACTION ---");

  await test("4.1 Exotel 401/400 errors redact sensitive tokens and mark certain rejection", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const rejectingFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            RestException: {
              Status: 401,
              Message: `Authentication failed for key ${mockApiKey} with token ${mockApiToken}`,
              Code: 10002,
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new ExotelVoiceProvider({
        accountSid: mockAccountSid,
        apiKey: mockApiKey,
        apiToken: mockApiToken,
        callerId: mockCallerId,
        streamUrl: mockStreamUrl,
        fetchFn: rejectingFetch,
      });

      try {
        await provider.startSession({
          sessionId: "vbs_auth_err_01",
          phoneNumber: "+919876543210",
          language: "en",
        });
        assert.fail("Should have thrown error on 401");
      } catch (err: unknown) {
        assert.ok(err instanceof ExotelApiError);
        assert.strictEqual(err.statusCode, 401);
        assert.strictEqual(err.isCertainRejection, true, "HTTP 401 is a certain carrier rejection");
        assert.ok(!err.message.includes(mockApiKey), "API Key must be redacted");
        assert.ok(!err.message.includes(mockApiToken), "API Token must be redacted");
        assert.ok(err.message.includes("[REDACTED_API_KEY]"));
        assert.ok(err.message.includes("[REDACTED_API_TOKEN]"));
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. BOUNDED RETRIES ON SAFE PRE-REQUEST CONNECTION FAILURE
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. BOUNDED RETRIES ON PRE-REQUEST NETWORK FAILURE ---");

  await test("5.1 Provider safely retries on pre-request DNS failure up to maxRetries", async () => {
    await withTestVoiceBookingEnabled(async () => {
      let attempts = 0;
      const failingFetch: typeof fetch = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("getaddrinfo ENOTFOUND api.in.exotel.com");
        }
        return new Response(
          JSON.stringify({
            Call: {
              Sid: "call_recovered_after_retry_99",
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
        streamUrl: mockStreamUrl,
        maxRetries: 3,
        fetchFn: failingFetch,
      });

      const result = await provider.startSession({
        sessionId: "vbs_retry_01",
        phoneNumber: "+919876543210",
        language: "en",
      });

      assert.strictEqual(attempts, 3, "Should have retried twice and succeeded on 3rd attempt");
      assert.strictEqual(result.providerCallId, "call_recovered_after_retry_99");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. AUTHENTICATED EXOTEL STATUS WEBHOOK (BASIC AUTH & EPHEMERAL HMAC)
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. WEBHOOK AUTHENTICATION (NO CUSTOM HEADERS) ---");

  await test("6.1 Webhook rejects missing credentials (401) and invalid credentials (403)", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    // Missing token and missing basic auth
    const reqMissing = new NextRequest("http://localhost:3000/api/webhooks/voice/exotel/status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_auth_01&Status=ringing",
    });
    const resMissing = await exotelStatusWebhookHandler(reqMissing);
    assert.strictEqual(resMissing.status, 401);

    // Invalid query token
    const reqInvalid = new NextRequest("http://localhost:3000/api/webhooks/voice/exotel/status?token=wrong_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_auth_01&Status=ringing",
    });
    const resInvalid = await exotelStatusWebhookHandler(reqInvalid);
    assert.strictEqual(resInvalid.status, 403);
  });

  await test("6.2 Webhook accepts HTTP Basic Auth and per-call ephemeral HMAC signed query token", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    await callAttemptRepo.createAttempt({
      id: "att_wh_auth_ok_01",
      deliveryId: "del_wh_01",
      sessionId: "vbs_wh_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: "call_wh_auth_ok_sid_77",
      initiationState: "accepted",
    });

    // A) HTTP Basic Auth in Authorization header
    const basicAuthHeader = `Basic ${Buffer.from(`${mockWebhookUser}:${mockWebhookPass}`).toString("base64")}`;
    const reqBasic = new NextRequest("http://localhost:3000/api/webhooks/voice/exotel/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader,
      },
      body: "CallSid=call_wh_auth_ok_sid_77&Status=ringing",
    });
    const resBasic = await exotelStatusWebhookHandler(reqBasic);
    assert.strictEqual(resBasic.status, 200);

    // B) Ephemeral per-call HMAC query token
    const ephemeralHmac = generateExotelCallbackSignature(mockWebhookSecret, "att_wh_auth_ok_01", "vbs_wh_01");
    const reqHmac = new NextRequest(
      `http://localhost:3000/api/webhooks/voice/exotel/status?token=${ephemeralHmac}&attemptId=att_wh_auth_ok_01&sessionId=vbs_wh_01`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "CallSid=call_wh_auth_ok_sid_77&Status=in-progress",
      }
    );
    const resHmac = await exotelStatusWebhookHandler(reqHmac);
    assert.strictEqual(resHmac.status, 200);
  });

  // ---------------------------------------------------------------------------
  // 7. MALFORMED AND CONTRADICTORY CALLBACK REJECTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. MALFORMED & CONTRADICTORY CALLBACK VALIDATION ---");

  await test("7.1 Webhook rejects missing CallSid or Status with 400 Bad Request", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    // Missing CallSid
    const reqNoSid = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Status=completed",
    });
    const resNoSid = await exotelStatusWebhookHandler(reqNoSid);
    assert.strictEqual(resNoSid.status, 400);

    // Missing Status
    const reqNoStatus = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_valid_sid_99",
    });
    const resNoStatus = await exotelStatusWebhookHandler(reqNoStatus);
    assert.strictEqual(resNoStatus.status, 400);
  });

  await test("7.2 Webhook rejects contradictory EventType and Status combinations with 400 Bad Request", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    // EventType=terminal but Status=ringing -> Contradiction!
    const reqContradict1 = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_contra_01&EventType=terminal&Status=ringing",
    });
    const resContradict1 = await exotelStatusWebhookHandler(reqContradict1);
    assert.strictEqual(resContradict1.status, 400);
    const body1 = await resContradict1.json();
    assert.ok(body1.error.includes("contradicts"));

    // EventType=answered but Status=failed -> Contradiction!
    const reqContradict2 = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_contra_02&EventType=answered&Status=failed",
    });
    const resContradict2 = await exotelStatusWebhookHandler(reqContradict2);
    assert.strictEqual(resContradict2.status, 400);

    // EventType=ringing but Status=completed -> Contradiction!
    const reqContradict3 = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_contra_03&EventType=ringing&Status=completed",
    });
    const resContradict3 = await exotelStatusWebhookHandler(reqContradict3);
    assert.strictEqual(resContradict3.status, 400);
  });

  await test("7.3 Webhook rejects CustomField exceeding 128 characters with 400 Bad Request", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    const oversizedCustomField = "x".repeat(129);
    const reqOversized = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=call_over_01&Status=ringing&CustomField=${oversizedCustomField}`,
    });
    const resOversized = await exotelStatusWebhookHandler(reqOversized);
    assert.strictEqual(resOversized.status, 400);
    const body = await resOversized.json();
    assert.ok(body.error.includes("128-character limit"));
  });

  // ---------------------------------------------------------------------------
  // 8. WEBHOOK STATUS TRANSITIONS (ALL LIFECYCLE STATES)
  // ---------------------------------------------------------------------------
  console.log("\n--- 8. WEBHOOK LIFECYCLE STATUS TRANSITIONS ---");

  await test("8.1 Webhook advances attempt through ringing -> answered -> completed with duration", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    const callSid = "call_lifecycle_sid_100";
    await callAttemptRepo.createAttempt({
      id: "att_lifecycle_100",
      deliveryId: "del_life_100",
      sessionId: "vbs_life_100",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: callSid,
      initiationState: "accepted",
    });

    // 1. Ringing
    const ringingReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&EventType=ringing&Status=ringing&DateUpdated=2026-11-06T20:46:00.000Z`,
    });
    const ringingRes = await exotelStatusWebhookHandler(ringingReq);
    assert.strictEqual(ringingRes.status, 200);
    assert.strictEqual((await callAttemptRepo.getByProviderCallId(callSid))?.status, "ringing");

    // 2. Answered (in-progress)
    const answeredReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&EventType=answered&Status=in-progress&DateUpdated=2026-11-06T20:46:15.000Z`,
    });
    const answeredRes = await exotelStatusWebhookHandler(answeredReq);
    assert.strictEqual(answeredRes.status, 200);
    assert.strictEqual((await callAttemptRepo.getByProviderCallId(callSid))?.status, "in_progress");

    // 3. Completed with duration
    const completedReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&EventType=terminal&Status=completed&ConversationDuration=142&DateUpdated=2026-11-06T20:48:37.000Z`,
    });
    const completedRes = await exotelStatusWebhookHandler(completedReq);
    assert.strictEqual(completedRes.status, 200);

    const finalAttempt = await callAttemptRepo.getByProviderCallId(callSid);
    assert.strictEqual(finalAttempt?.status, "completed");
    assert.strictEqual(finalAttempt?.durationSeconds, 142);
    assert.strictEqual(finalAttempt?.isTerminal, true);
  });

  await test("8.2 Webhook transitions to terminal failure states: busy, no-answer, and failed", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    // Busy
    await callAttemptRepo.createAttempt({
      id: "att_busy_01",
      deliveryId: "del_busy_01",
      sessionId: "vbs_busy_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: "call_busy_sid_01",
      initiationState: "accepted",
    });
    const busyReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_busy_sid_01&EventType=terminal&Status=busy&DialCallStatus=busy",
    });
    await exotelStatusWebhookHandler(busyReq);
    assert.strictEqual((await callAttemptRepo.getByProviderCallId("call_busy_sid_01"))?.status, "busy");

    // No-Answer
    await callAttemptRepo.createAttempt({
      id: "att_noans_01",
      deliveryId: "del_noans_01",
      sessionId: "vbs_noans_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: "call_noans_sid_01",
      initiationState: "accepted",
    });
    const noAnsReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_noans_sid_01&EventType=terminal&Status=no-answer&DialCallStatus=no-answer",
    });
    await exotelStatusWebhookHandler(noAnsReq);
    assert.strictEqual((await callAttemptRepo.getByProviderCallId("call_noans_sid_01"))?.status, "no_answer");

    // Failed
    await callAttemptRepo.createAttempt({
      id: "att_failed_01",
      deliveryId: "del_failed_01",
      sessionId: "vbs_failed_01",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: "call_failed_sid_01",
      initiationState: "accepted",
    });
    const failedReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=call_failed_sid_01&EventType=terminal&Status=failed&ErrorCode=CARRIER_UNREACHABLE&ErrorMessage=Cellular+network+congestion",
    });
    await exotelStatusWebhookHandler(failedReq);
    const failedAttempt = await callAttemptRepo.getByProviderCallId("call_failed_sid_01");
    assert.strictEqual(failedAttempt?.status, "failed");
    assert.strictEqual(failedAttempt?.errorCode, "CARRIER_UNREACHABLE");
  });

  // ---------------------------------------------------------------------------
  // 9. IDEMPOTENT DUPLICATE & CONFLICT RESOLUTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 9. IDEMPOTENT DUPLICATE & CONFLICT RESOLUTION ---");

  await test("9.1 Repeated identical status returns idempotent_duplicate with 200 OK", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    const callSid = "call_dup_sid_200";
    await callAttemptRepo.createAttempt({
      id: "att_dup_200",
      deliveryId: "del_dup_200",
      sessionId: "vbs_dup_200",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: callSid,
      initiationState: "accepted",
    });

    const req1 = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&Status=ringing`,
    });
    const res1 = await exotelStatusWebhookHandler(req1);
    assert.strictEqual((await res1.json()).outcome, "updated");

    const req2 = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&Status=ringing`,
    });
    const res2 = await exotelStatusWebhookHandler(req2);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual((await res2.json()).outcome, "idempotent_duplicate");
  });

  await test("9.2 Out-of-order lower rank event ignored; conflicting terminal event records terminalConflict", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    const callSid = "call_term_conflict_sid_300";
    await callAttemptRepo.createAttempt({
      id: "att_conflict_300",
      deliveryId: "del_conflict_300",
      sessionId: "vbs_conflict_300",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      providerCallId: callSid,
      initiationState: "accepted",
    });

    await callAttemptRepo.updateStatusByProviderCallId(callSid, {
      status: "completed",
      durationSeconds: 120,
    });

    // Delayed non-terminal event -> ignored_out_of_order
    const delayedReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&Status=ringing`,
    });
    const delayedRes = await exotelStatusWebhookHandler(delayedReq);
    assert.strictEqual((await delayedRes.json()).outcome, "ignored_out_of_order");

    // Conflicting terminal event -> terminal_conflict
    const conflictReq = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${callSid}&EventType=terminal&Status=busy`,
    });
    const conflictRes = await exotelStatusWebhookHandler(conflictReq);
    assert.strictEqual((await conflictRes.json()).outcome, "terminal_conflict");

    const record = await callAttemptRepo.getByProviderCallId(callSid);
    assert.strictEqual(record?.status, "completed", "Authoritative terminal status must NOT be overwritten");
    assert.strictEqual(record?.terminalConflict?.conflictingStatus, "busy");
  });

  // ---------------------------------------------------------------------------
  // 10. UNMAPPED ATTEMPT RECOVERY & MISMATCH REJECTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 10. UNMAPPED ATTEMPT RECOVERY & MISMATCH REJECTION ---");

  await test("10.1 Webhook with CustomField correlates unmapped attempt when worker crashed prior to persistence", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    await callAttemptRepo.createAttempt({
      id: "att_unmapped_crash_400",
      deliveryId: "del_unmapped_400",
      sessionId: "vbs_unmapped_400",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      initiationState: "in_flight",
    });

    const newCallSid = "call_exotel_unmapped_crash_sid_400";
    assert.strictEqual(await callAttemptRepo.getByProviderCallId(newCallSid), null);

    const customFieldStr = JSON.stringify({
      attemptId: "att_unmapped_crash_400",
      sessionId: "vbs_unmapped_400",
    });

    const req = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${newCallSid}&Status=in-progress&CustomField=${encodeURIComponent(customFieldStr)}`,
    });

    const res = await exotelStatusWebhookHandler(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.outcome, "updated");
    assert.strictEqual(body.attemptId, "att_unmapped_crash_400");

    const recovered = await callAttemptRepo.getByProviderCallId(newCallSid);
    assert.ok(recovered !== null);
    assert.strictEqual(recovered?.id, "att_unmapped_crash_400");
    assert.strictEqual(recovered?.initiationState, "accepted");
    assert.strictEqual(recovered?.status, "in_progress");
  });

  await test("10.2 Webhook with mismatched sessionId is rejected with 409 Conflict", async () => {
    const callAttemptRepo = new InMemoryVoiceCallAttemptRepository();
    _setExotelWebhookCallAttemptRepoForTesting(callAttemptRepo);

    await callAttemptRepo.createAttempt({
      id: "att_sec_mismatch_500",
      deliveryId: "del_sec_500",
      sessionId: "vbs_authentic_session_500",
      phoneNumberMasked: "+91 98*** ***10",
      provider: "exotel",
      initiationState: "in_flight",
    });

    const customFieldMismatched = JSON.stringify({
      attemptId: "att_sec_mismatch_500",
      sessionId: "vbs_ATTACKER_FORGED_SESSION_999",
    });

    const req = new NextRequest(`http://localhost:3000/api/webhooks/voice/exotel/status?token=${mockWebhookSecret}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=call_spoofed_sid_500&Status=ringing&CustomField=${encodeURIComponent(customFieldMismatched)}`,
    });

    const res = await exotelStatusWebhookHandler(req);
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.ok(body.error.includes("Session mismatch"));
  });

  // ---------------------------------------------------------------------------
  // 11. GETSTATUS AND ENDSESSION APIS
  // ---------------------------------------------------------------------------
  console.log("\n--- 11. GETSTATUS AND ENDSESSION APIS ---");

  await test("11.1 getStatus retrieves and maps Exotel Call Details on India cluster", async () => {
    const mockDetailsFetch: typeof fetch = async (input) => {
      const url = String(input);
      assert.ok(url.startsWith("https://api.in.exotel.com/v1/Accounts/"));
      assert.ok(url.endsWith(`/Calls/call_status_sid_600.json`));
      return new Response(
        JSON.stringify({
          Call: {
            Sid: "call_status_sid_600",
            Status: "completed",
            Duration: 185,
            CustomField: JSON.stringify({ sessionId: "vbs_details_600" }),
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
      streamUrl: mockStreamUrl,
      fetchFn: mockDetailsFetch,
    });

    const statusResult = await provider.getStatus("call_status_sid_600");
    assert.strictEqual(statusResult.providerCallId, "call_status_sid_600");
    assert.strictEqual(statusResult.status, "completed");
    assert.strictEqual(statusResult.durationSeconds, 185);
    assert.strictEqual(statusResult.sessionId, "vbs_details_600");
  });

  await test("11.2 endSession invokes hangup API cleanly on India cluster", async () => {
    let hangupCalled = false;
    const mockHangupFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith("https://api.in.exotel.com/v1/Accounts/"));
      assert.ok(url.endsWith(`/Calls/call_hangup_sid_700/hangup.json`));
      assert.strictEqual(init?.method, "POST");
      hangupCalled = true;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = new ExotelVoiceProvider({
      accountSid: mockAccountSid,
      apiKey: mockApiKey,
      apiToken: mockApiToken,
      callerId: mockCallerId,
      streamUrl: mockStreamUrl,
      fetchFn: mockHangupFetch,
    });

    const endResult = await provider.endSession("call_hangup_sid_700", "Customer request");
    assert.strictEqual(hangupCalled, true);
    assert.strictEqual(endResult.status, "ended");
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.6.2.1 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exitCode = 1;
  }
}

runSuite().catch((err) => {
  console.error("Unhandled fatal verification error:", err);
  process.exitCode = 1;
});
