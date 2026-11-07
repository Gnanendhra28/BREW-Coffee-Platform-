/**
 * BREW Coffee Platform — Phase 6.4.1 Verification Suite
 * WhatsApp Integration Corrections: Webhook Security, Strict Template Parameter Counts,
 * Test-Recipient Fail-Closed Protection, At-Least-Once Idempotency Documentation & Firestore Persistence.
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false";

import assert from "assert";
import crypto from "crypto";
import { NextRequest } from "next/server";
import {
  MetaWhatsAppCloudProvider,
  MockWhatsAppProvider,
  WhatsAppCloudApiError,
  ProviderIdempotencyConflictError,
  buildBookingConfirmationTemplate,
  buildBookingStatusUpdateTemplate,
  buildBookingReminderTemplate,
  createOutboxDeliveriesForTransition,
  createReminderDeliveryForSession,
  OutboxWorker,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  MockVoiceProvider,
} from "../src/lib/communication";
import {
  TestInMemoryCommunicationOutboxRepository,
  seedOutboxDeliveryForTest,
  withTestVoiceBookingEnabled,
} from "../src/lib/communication/outbox/testFixture";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { VoiceBookingSession, BookingRequirements } from "../src/lib/voiceBooking/types";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  GET as webhookGet,
  POST as webhookPost,
} from "../src/app/api/webhooks/whatsapp/route";
import {
  _setWebhookOutboxRepoForTesting,
  _setWebhookDbProviderForTesting,
} from "../src/lib/communication/testingHooks";

let passed = 0;
let total = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

function createAuthoritativeSession(overrides: Partial<VoiceBookingSession> = {}): VoiceBookingSession {
  const id = overrides.id || `vbs_p641_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const officialBookingId = overrides.officialBookingId || `enq_voice_${id}`;
  const requirements: BookingRequirements = {
    eventType: "Corporate Gathering",
    guestCount: 120,
    eventDate: "2028-11-20",
    startTime: "14:00",
    durationHours: 3,
    venueAddress: "Jubilee Hills, Hyderabad",
    selectedTier: "PREMIUM",
    beveragePreferences: ["Filter Coffee", "Cold Brew"],
    handoffRequested: false,
    customerConfirmed: true,
    confidenceScore: 0.98,
    missingFields: [],
    unresolvedQuestions: [],
    ...overrides.requirements,
  };
  const quotation = overrides.quotation || generateVoiceBookingQuotation(requirements);
  const quotationSnapshot = overrides.quotationSnapshot || createQuotationSnapshot(requirements);

  return {
    id,
    officialBookingId,
    phoneNumber: "+919876543210",
    language: "en",
    state: "booking_confirmed",
    requirements,
    quotation,
    quotationSnapshot,
    conversationHistory: [],
    staffApprovalId: null,
    staffApprovalAudit: null,
    metadata: {
      officialBookingId,
      ...(overrides.metadata || {}),
    },
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runSuite() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.4.1 Verification Suite");
  console.log("   Webhook HMAC Security, Parameter Counts, Recipient Boundary & Fail-Closed Gates");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. Webhook Security & Signatures
  // ---------------------------------------------------------------------------
  console.log("--- 1. WEBHOOK SECURITY & HMAC-SHA256 SIGNATURE VERIFICATION ---");

  await test("1.1 Forged HMAC signature in X-Hub-Signature-256 fails closed with 403 Forbidden", async () => {
    process.env.META_WHATSAPP_APP_SECRET = "real_configured_app_secret";
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
      body: payload,
    });
    const res = await webhookPost(req);
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error, "Forbidden: signature verification failed");
  });

  await test("1.2 Valid HMAC signature passes constant-time verification", async () => {
    const appSecret = "secure_test_meta_app_secret_99";
    process.env.META_WHATSAPP_APP_SECRET = appSecret;
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const signature = crypto.createHmac("sha256", appSecret).update(payload).digest("hex");

    const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: payload,
    });
    const res = await webhookPost(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
  });

  await test("1.3 Missing or malformed X-Hub-Signature-256 header fails closed with 401 Unauthorized", async () => {
    process.env.META_WHATSAPP_APP_SECRET = "any_app_secret";
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    // Missing header
    const reqNoHeader = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const resNoHeader = await webhookPost(reqNoHeader);
    assert.strictEqual(resNoHeader.status, 401);

    // Malformed header (missing sha256= prefix)
    const reqMalformed = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "invalid_prefix_signature_value",
      },
      body: payload,
    });
    const resMalformed = await webhookPost(reqMalformed);
    assert.strictEqual(resMalformed.status, 401);
  });

  await test("1.4 Missing META_WHATSAPP_APP_SECRET fails closed with 500 Configuration Error", async () => {
    const savedSecret = process.env.META_WHATSAPP_APP_SECRET;
    delete process.env.META_WHATSAPP_APP_SECRET;
    delete process.env.META_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;

    try {
      const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=123456",
        },
        body: JSON.stringify({}),
      });
      const res = await webhookPost(req);
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.ok(body.error.includes("Meta App Secret not configured"));
    } finally {
      process.env.META_WHATSAPP_APP_SECRET = savedSecret;
    }
  });

  await test("1.5 Missing GET verify token fails closed with 500 without hardcoded fallback", async () => {
    const savedVerify = process.env.META_WHATSAPP_VERIFY_TOKEN;
    const savedWebhookVerify = process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const savedWhatsappVerify = process.env.WHATSAPP_VERIFY_TOKEN;

    delete process.env.META_WHATSAPP_VERIFY_TOKEN;
    delete process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    delete process.env.WHATSAPP_VERIFY_TOKEN;

    try {
      const req = new NextRequest(
        "http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=brew_meta_verify_token&hub.challenge=12345",
        { method: "GET" }
      );
      const res = await webhookGet(req);
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.ok(body.error.includes("verify token not configured"));
    } finally {
      process.env.META_WHATSAPP_VERIFY_TOKEN = savedVerify;
      process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = savedWebhookVerify;
      process.env.WHATSAPP_VERIFY_TOKEN = savedWhatsappVerify;
    }
  });

  await test("1.6 GET verification token mismatch fails closed with 403 Forbidden", async () => {
    process.env.META_WHATSAPP_VERIFY_TOKEN = "configured_token_abc";
    const req = new NextRequest(
      "http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=attacker_wrong_token&hub.challenge=12345",
      { method: "GET" }
    );
    const res = await webhookGet(req);
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes("verification token mismatch"));
  });

  await test("1.7 Webhook POST rejects malformed JSON with 400 Bad Request", async () => {
    const appSecret = "secret_for_bad_json";
    process.env.META_WHATSAPP_APP_SECRET = appSecret;
    const badJson = "this is not valid {json}";
    const signature = crypto.createHmac("sha256", appSecret).update(badJson).digest("hex");

    const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: badJson,
    });
    const res = await webhookPost(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("malformed JSON"));
  });

  await test("1.8 Webhook POST rejects missing/invalid entry payload structure with 400 Bad Request", async () => {
    const appSecret = "secret_for_invalid_structure";
    process.env.META_WHATSAPP_APP_SECRET = appSecret;
    const invalidPayload = JSON.stringify({ object: "whatsapp_business_account" }); // missing entry array
    const signature = crypto.createHmac("sha256", appSecret).update(invalidPayload).digest("hex");

    const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: invalidPayload,
    });
    const res = await webhookPost(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("missing entry array"));
  });

  // ---------------------------------------------------------------------------
  // 2. Webhook Repository & Firestore Availability
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. WEBHOOK REPOSITORY PERSISTENCE & FIRESTORE FAILURE SAFETY ---");

  await test("2.1 Deployed webhook path returns 503 when Firestore is uninitialized (no silent in-memory fallback)", async () => {
    const appSecret = "secret_for_persistence_test";
    process.env.META_WHATSAPP_APP_SECRET = appSecret;
    _setWebhookOutboxRepoForTesting(null); // Ensure test repo injection is CLEARED
    _setWebhookDbProviderForTesting(() => null); // Simulate Firestore being uninitialized/unavailable

    try {
      const payload = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID",
            changes: [
              {
                field: "messages",
                value: {
                  statuses: [{ id: "wamid.DEPLOYED_TEST", status: "delivered" }],
                },
              },
            ],
          },
        ],
      });
      const signature = crypto.createHmac("sha256", appSecret).update(payload).digest("hex");

      const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": `sha256=${signature}`,
        },
        body: payload,
      });
      const res = await webhookPost(req);
      assert.strictEqual(res.status, 503);
      const body = await res.json();
      assert.ok(body.error.includes("Firestore database not configured"));
    } finally {
      _setWebhookDbProviderForTesting(null);
    }
  });

  await test("2.2 Webhook POST returns 500 Server Error when database update throws", async () => {
    const appSecret = "secret_for_db_error_test";
    process.env.META_WHATSAPP_APP_SECRET = appSecret;

    // Injected repository that throws on update
    const failingRepo = new TestInMemoryCommunicationOutboxRepository();
    failingRepo.updateDeliveryStatusByProviderMessageId = async () => {
      throw new Error("Simulated Firestore timeout or network error");
    };
    _setWebhookOutboxRepoForTesting(failingRepo);

    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [{ id: "wamid.THROW_TEST", status: "delivered" }],
              },
            },
          ],
        },
      ],
    });
    const signature = crypto.createHmac("sha256", appSecret).update(payload).digest("hex");

    const req = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: payload,
    });
    const res = await webhookPost(req);
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.ok(body.error.includes("Database error processing delivery status update"));

    _setWebhookOutboxRepoForTesting(null);
  });

  // ---------------------------------------------------------------------------
  // 3. Template Dispatch & Parameter Validation
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. TEMPLATE BUILDERS & STRICT PARAMETER COUNTS ---");

  await test("3.1 Confirmation template strictly produces 5 body parameters", async () => {
    const template = buildBookingConfirmationTemplate({
      to: "+919876543210",
      bookingId: "enq_conf_001",
      eventDate: "2028-11-20",
      guestCount: 150,
      location: "Gachibowli, Hyderabad",
      tierName: "Artisanal Signature",
    });

    const bodyComponent = template.components.find((c) => c.type === "body")!;
    assert.ok(bodyComponent, "Must contain body component");
    assert.strictEqual(bodyComponent.parameters.length, 5, "Confirmation MUST have exactly 5 parameters");
    assert.strictEqual(bodyComponent.parameters[0].text, "enq_conf_001");
    assert.strictEqual(bodyComponent.parameters[1].text, "2028-11-20");
    assert.strictEqual(bodyComponent.parameters[2].text, "150 Guests");
    assert.strictEqual(bodyComponent.parameters[3].text, "Gachibowli, Hyderabad");
    assert.strictEqual(bodyComponent.parameters[4].text, "Artisanal Signature");
  });

  await test("3.2 Confirmation template throws if any parameter is missing/empty (never fabricates data)", async () => {
    // Missing tierName
    assert.throws(
      () =>
        buildBookingConfirmationTemplate({
          to: "+919876543210",
          bookingId: "enq_001",
          eventDate: "2028-11-20",
          guestCount: 150,
          location: "Hyderabad",
          tierName: "",
        }),
      /tierName is required/
    );

    // Missing location
    assert.throws(
      () =>
        buildBookingConfirmationTemplate({
          to: "+919876543210",
          bookingId: "enq_001",
          eventDate: "2028-11-20",
          guestCount: 150,
          location: "",
          tierName: "Standard",
        }),
      /location is required/
    );
  });

  await test("3.3 Status update template strictly produces 3 body parameters", async () => {
    const template = buildBookingStatusUpdateTemplate({
      to: "+919876543210",
      bookingId: "enq_status_002",
      status: "Under Review",
      details: "Your booking is currently being reviewed by our events team.",
    });

    const bodyComponent = template.components.find((c) => c.type === "body")!;
    assert.ok(bodyComponent);
    assert.strictEqual(bodyComponent.parameters.length, 3, "Status update MUST have exactly 3 parameters");
    assert.strictEqual(bodyComponent.parameters[0].text, "enq_status_002");
    assert.strictEqual(bodyComponent.parameters[1].text, "Under Review");
    assert.strictEqual(
      bodyComponent.parameters[2].text,
      "Your booking is currently being reviewed by our events team."
    );
  });

  await test("3.4 Status update template throws if any parameter is missing/empty", async () => {
    assert.throws(
      () =>
        buildBookingStatusUpdateTemplate({
          to: "+919876543210",
          bookingId: "enq_002",
          status: "Under Review",
          details: "",
        }),
      /details message is required/
    );
  });

  await test("3.5 Reminder template strictly produces 4 body parameters", async () => {
    const template = buildBookingReminderTemplate({
      to: "+919876543210",
      bookingId: "enq_rem_003",
      eventDate: "2028-11-20",
      startTime: "16:00",
      location: "HITEC City, Hyderabad",
    });

    const bodyComponent = template.components.find((c) => c.type === "body")!;
    assert.ok(bodyComponent);
    assert.strictEqual(bodyComponent.parameters.length, 4, "Reminder MUST have exactly 4 parameters");
    assert.strictEqual(bodyComponent.parameters[0].text, "enq_rem_003");
    assert.strictEqual(bodyComponent.parameters[1].text, "2028-11-20");
    assert.strictEqual(bodyComponent.parameters[2].text, "16:00");
    assert.strictEqual(bodyComponent.parameters[3].text, "HITEC City, Hyderabad");
  });

  await test("3.6 Reminder template throws if any parameter is missing/empty (never fabricates 10:00 AM)", async () => {
    assert.throws(
      () =>
        buildBookingReminderTemplate({
          to: "+919876543210",
          bookingId: "enq_rem_003",
          eventDate: "2028-11-20",
          startTime: "",
          location: "Hyderabad",
        }),
      /startTime is required/
    );
  });

  await test("3.7 Outbox worker dispatches confirmation template with 5 authoritative parameters", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      let dispatchedParams: unknown = null;

      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        dispatchedParams = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ messages: [{ id: "wamid.CONFIRM_5_PARAMS" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider: metaProvider,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.dispatchedCount, 1);

      const payload = dispatchedParams as {
        template: { components: Array<{ type: string; parameters: Array<{ text: string }> }> };
      };
      const bodyComp = payload.template.components.find((c) => c.type === "body")!;
      assert.strictEqual(bodyComp.parameters.length, 5, "Dispatched confirmation must have 5 parameters");
      assert.strictEqual(bodyComp.parameters[4].text, "PREMIUM");
    });
  });

  await test("3.8 Outbox worker dispatches reminder template with 4 authoritative parameters", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      let dispatchedParams: unknown = null;

      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        dispatchedParams = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ messages: [{ id: "wamid.REM_4_PARAMS" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const session = createAuthoritativeSession({ state: "booking_confirmed" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_02",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const remDelivery = createReminderDeliveryForSession(session);
      await seedOutboxDeliveryForTest(outboxRepo, remDelivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider: metaProvider,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(cycle.dispatchedCount, 1);

      const payload = dispatchedParams as {
        template: { components: Array<{ type: string; parameters: Array<{ text: string }> }> };
      };
      const bodyComp = payload.template.components.find((c) => c.type === "body")!;
      assert.strictEqual(bodyComp.parameters.length, 4, "Dispatched reminder must have 4 parameters");
      assert.strictEqual(bodyComp.parameters[2].text, "14:00");
    });
  });

  await test("3.9 Outbox worker fails permanently when authoritative booking details are missing", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: ["919876543210"],
      });

      // Authoritative session where requirements are missing selectedTier and quotation tier
      const baseSession = createAuthoritativeSession({ state: "created" });
      baseSession.officialBookingId = null; // Keep state 'created' without official booking bridge
      baseSession.requirements.selectedTier = null;
      if (baseSession.quotation) {
        (baseSession.quotation as { selectedTier?: string }).selectedTier = undefined;
      }
      await sessionRepo.save(baseSession);

      await consentRepo.save({
        id: "c_grant_03",
        phoneNumber: baseSession.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      // Construct a confirmation delivery that demands 5 parameters, but session lacks tierName
      const waDelivery = createReminderDeliveryForSession(baseSession);
      waDelivery.templateName = "booking_confirmed_v1";
      waDelivery.eventType = "booking_confirmed";
      delete waDelivery.templateParams?.tierName;
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider: metaProvider,
      });

      const cycle = await worker.processCycle();
      assert.strictEqual(
        cycle.permanentlyFailedCount,
        1,
        "Incomplete booking data MUST fail permanently without fabricating fake details"
      );

      const updated = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updated?.status, "permanently_failed");
      assert.ok(updated?.lastError?.message.includes("MISSING_AUTHORITATIVE_BOOKING_DETAILS"));
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Test Recipient Protection Safeguards
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. TEST-RECIPIENT FAIL-CLOSED BOUNDARY PROTECTION ---");

  await test("4.1 Cloud API dispatch fails closed with 403 (131030) if allowed-recipient list is empty", async () => {
    const saved = process.env.META_WHATSAPP_ALLOWED_RECIPIENTS;
    delete process.env.META_WHATSAPP_ALLOWED_RECIPIENTS;
    delete process.env.WHATSAPP_ALLOWED_RECIPIENTS;

    try {
      const provider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        allowedRecipients: [], // Explicitly empty
      });

      await provider.sendTemplate({
        to: "+919876543210",
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown WhatsAppCloudApiError");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.metaErrorCode, 131030);
      assert.strictEqual(err.isRetryable, false);
      assert.ok(err.message.includes("allowed-recipient list is missing or empty"));
    } finally {
      process.env.META_WHATSAPP_ALLOWED_RECIPIENTS = saved;
    }
  });

  await test("4.2 Cloud API dispatch fails closed with 403 (131030) if allowed-recipient list is missing", async () => {
    const saved = process.env.META_WHATSAPP_ALLOWED_RECIPIENTS;
    delete process.env.META_WHATSAPP_ALLOWED_RECIPIENTS;
    delete process.env.WHATSAPP_ALLOWED_RECIPIENTS;

    try {
      const provider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        // No allowedRecipients config supplied
      });

      await provider.sendTemplate({
        to: "+919876543210",
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown WhatsAppCloudApiError");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.metaErrorCode, 131030);
      assert.strictEqual(err.isRetryable, false);
      assert.ok(err.message.includes("allowed-recipient list is missing or empty"));
    } finally {
      process.env.META_WHATSAPP_ALLOWED_RECIPIENTS = saved;
    }
  });

  await test("4.3 Cloud API dispatch fails closed with 403 (131030) if recipient is not in allowlist", async () => {
    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
    });

    try {
      await provider.sendTemplate({
        to: "+919999999999", // Unapproved recipient
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.metaErrorCode, 131030);
      assert.strictEqual(err.isRetryable, false);
      assert.ok(err.message.includes("Recipient number is not registered in the allowed test recipients list"));
    }
  });

  await test("4.4 Cloud API dispatch succeeds when recipient is explicitly in allowlist", async () => {
    let fetchCalled = false;
    const mockFetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ALLOWED_OK" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    const res = await provider.sendTemplate({
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
    });
    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(res.messageId, "wamid.ALLOWED_OK");
  });

  // ---------------------------------------------------------------------------
  // 5. Idempotency Semantics & Provider Boundaries
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. IDEMPOTENCY SEMANTICS & PROCESS RESTART BEHAVIOR ---");

  await test("5.1 In-memory cache deduplicates identical attempts within the same instance", async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.CACHE_SAME_INSTANCE" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    const params = {
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "same_instance_key_01",
    };

    const res1 = await provider.sendTemplate(params);
    assert.strictEqual(callCount, 1);

    const res2 = await provider.sendTemplate(params);
    assert.strictEqual(callCount, 1, "Must return cached result without second network call");
    assert.strictEqual(res2.messageId, res1.messageId);
  });

  await test("5.2 Process restart / new provider instance demonstrates cache non-persistence (at-least-once dispatch)", async () => {
    let totalNetworkCalls = 0;
    const mockFetch = (async () => {
      totalNetworkCalls++;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.CALL_${totalNetworkCalls}` }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Instance 1
    const provider1 = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    const params = {
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "restart_test_key_01",
    };

    await provider1.sendTemplate(params);
    assert.strictEqual(totalNetworkCalls, 1);

    // Simulate process restart: fresh provider instance with identical configuration
    const provider2 = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    // In a process restart without external durable provider idempotency, a second network call occurs
    await provider2.sendTemplate(params);
    assert.strictEqual(
      totalNetworkCalls,
      2,
      "Demonstrates that in-memory cache is ephemeral; external at-least-once retry occurs"
    );
  });

  await test("5.3 In-memory cache fails closed on payload conflict with same idempotencyKey", async () => {
    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN",
      allowedRecipients: ["919876543210", "919123456780"],
      fetchFn: (async () => new Response(JSON.stringify({ messages: [{ id: "m1" }] }))) as unknown as typeof fetch,
    });

    await provider.sendTemplate({
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "conflict_test_key_01",
    });

    try {
      await provider.sendTemplate({
        to: "+919123456780", // Conflicting recipient
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
        idempotencyKey: "conflict_test_key_01",
      });
      assert.fail("Should have thrown ProviderIdempotencyConflictError");
    } catch (err) {
      assert.ok(err instanceof ProviderIdempotencyConflictError);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Scope Restrictions & Safe Defaults
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. SCOPE RESTRICTIONS & ZERO-COST ARCHITECTURE ---");

  await test("6.1 VOICE_BOOKING_ENABLED remains strictly false", async () => {
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
  });

  await test("6.2 MockWhatsAppProvider remains fully operational for zero-cost testing", async () => {
    const mock = new MockWhatsAppProvider();
    const res = await mock.sendTemplate({
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
    });
    assert.strictEqual(res.isSimulated, true);
    assert.strictEqual(res.providerMode, "mock");
    assert.ok(res.messageId.startsWith("mock_wa_"));
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.4.1 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Verification suite execution failed:", err);
  process.exit(1);
});
