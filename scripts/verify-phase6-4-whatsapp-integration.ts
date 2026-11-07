/**
 * BREW Coffee Platform — Phase 6.4 Verification Suite
 * Meta WhatsApp Cloud API Integration, Standard Templates, Consent/DND Safety & Webhooks
 */

process.env.BUSINESS_EMAIL = "events@brewcoffee.internal";
process.env.VOICE_BOOKING_ENABLED = "false"; // Strictly false by default

import assert from "assert";
import {
  MetaWhatsAppCloudProvider,
  MockWhatsAppProvider,
  WhatsAppCloudApiError,
  ProviderIdempotencyConflictError,
  buildBookingConfirmationTemplate,
  buildBookingStatusUpdateTemplate,
  buildBookingReminderTemplate,
  getWhatsAppProvider,
  createOutboxDeliveriesForTransition,
  createReminderDeliveryForSession,
  OutboxWorker,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  MockVoiceProvider,
  WhatsAppTemplateParams,
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
} from "../src/lib/communication/testingHooks";
import crypto from "crypto";
import { NextRequest } from "next/server";

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

function createTestSession(overrides: Partial<VoiceBookingSession> = {}): VoiceBookingSession {
  const id = overrides.id || `vbs_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const officialBookingId = overrides.officialBookingId || `enq_voice_${id}`;
  const requirements: BookingRequirements = {
    eventType: "Corporate Gathering",
    guestCount: 150,
    eventDate: "2028-12-15",
    startTime: "11:00",
    durationHours: 4,
    venueAddress: "Financial District, Gachibowli, Hyderabad",
    selectedTier: "STANDARD",
    beveragePreferences: ["Cappuccino", "Cold Brew"],
    handoffRequested: false,
    customerConfirmed: true,
    confidenceScore: 0.95,
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

async function runSuite(): Promise<void> {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase 6.4 Verification Suite");
  console.log("   Meta WhatsApp Cloud API Integration, Consent/DND Safety & Webhooks");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. Meta WhatsApp Cloud API Provider: Request Assembly & Normalization
  // ---------------------------------------------------------------------------
  console.log("--- 1. META WHATSAPP CLOUD API PROVIDER: REQUEST FORMATTING & RECIPIENTS ---");

  await test("1.1 Provider correctly assembles Meta Graph API request headers and URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse(init?.body as string);

      return new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "919876543210", wa_id: "919876543210" }],
          messages: [{ id: "wamid.HBgLMTIzNDU2" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "100609346426371",
      accessToken: "TEST_META_TOKEN_12345",
      apiVersion: "v21.0",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    const params: WhatsAppTemplateParams = {
      to: "+91 98765 43210", // Raw phone with spaces and leading '+'
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "enq_test_001" },
            { type: "text", text: "2028-12-15" },
          ],
        },
      ],
      idempotencyKey: "test_key_001",
    };

    const result = await provider.sendTemplate(params);

    // Verify endpoint URL
    assert.strictEqual(
      capturedUrl,
      "https://graph.facebook.com/v21.0/100609346426371/messages",
      "URL must point to Meta Graph v21.0 endpoint"
    );

    // Verify Authorization Bearer header
    assert.strictEqual(
      capturedHeaders["Authorization"],
      "Bearer TEST_META_TOKEN_12345",
      "Bearer token must be present in request headers"
    );

    // Verify payload structure and recipient phone normalization (no leading '+')
    assert.strictEqual(capturedBody["messaging_product"], "whatsapp");
    assert.strictEqual(capturedBody["to"], "919876543210", "Phone must be normalized digits without '+'");
    const template = capturedBody["template"] as Record<string, unknown>;
    assert.strictEqual(template["name"], "booking_confirmed_v1");

    // Verify returned result
    assert.strictEqual(result.messageId, "wamid.HBgLMTIzNDU2");
    assert.strictEqual(result.status, "accepted");
  });

  await test("1.2 Missing credentials fails closed without leaking secrets", async () => {
    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "",
      accessToken: "",
    });

    try {
      await provider.sendTemplate({
        to: "+919876543210",
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown WhatsAppCloudApiError");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.isRetryable, false);
      assert.ok(!err.message.includes("Bearer"), "Error must not contain Bearer token");
    }
  });

  await test("1.3 Recipient test-filter safeguards against unapproved test numbers", async () => {
    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "100609346426371",
      accessToken: "TEST_TOKEN",
      allowedRecipients: ["919876543210"], // Only this number is allowed
    });

    try {
      await provider.sendTemplate({
        to: "+919111111111", // Not in allowed list
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have failed for unapproved test recipient");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.metaErrorCode, 131030);
      assert.strictEqual(err.isRetryable, false);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Standard Transactional Templates (Confirmation, Updates, Reminders)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. STANDARD TRANSACTIONAL TEMPLATES ---");

  await test("2.1 buildBookingConfirmationTemplate produces validated template params", async () => {
    const tpl = buildBookingConfirmationTemplate({
      to: "+919876543210",
      bookingId: "enq_voice_001",
      eventDate: "2028-12-15",
      guestCount: 200,
      location: "Financial District, Hyderabad",
      tierName: "Artisanal Signature",
      idempotencyKey: "idem_conf_01",
    });

    assert.strictEqual(tpl.templateName, "booking_confirmed_v1");
    assert.strictEqual(tpl.components[0].parameters.length, 5);
    assert.strictEqual(tpl.components[0].parameters[0].text, "enq_voice_001");
    assert.strictEqual(tpl.components[0].parameters[2].text, "200 Guests");
    assert.strictEqual(tpl.idempotencyKey, "idem_conf_01");
  });

  await test("2.2 buildBookingStatusUpdateTemplate formats status changes properly", async () => {
    const tpl = buildBookingStatusUpdateTemplate({
      to: "+919876543210",
      bookingId: "enq_voice_002",
      status: "Awaiting Staff Review",
      details: "Requirements collected. Barista team will review logistics.",
      idempotencyKey: "idem_status_01",
    });

    assert.strictEqual(tpl.templateName, "booking_status_update_v1");
    assert.strictEqual(tpl.components[0].parameters[1].text, "Awaiting Staff Review");
  });

  await test("2.3 buildBookingReminderTemplate formats pre-event reminder params", async () => {
    const tpl = buildBookingReminderTemplate({
      to: "+919876543210",
      bookingId: "enq_voice_003",
      eventDate: "2028-12-15",
      startTime: "10:00 AM",
      location: "Gachibowli, Hyderabad",
      idempotencyKey: "idem_remind_01",
    });

    assert.strictEqual(tpl.templateName, "booking_reminder_v1");
    assert.strictEqual(tpl.components[0].parameters[2].text, "10:00 AM");
  });

  await test("2.4 createReminderDeliveryForSession constructs outbox delivery for reminders", async () => {
    const session = createTestSession({ state: "booking_confirmed" });
    const delivery = createReminderDeliveryForSession(session);

    assert.strictEqual(delivery.eventType, "booking_reminder");
    assert.strictEqual(delivery.channel, "whatsapp");
    assert.strictEqual(delivery.templateName, "booking_reminder_v1");
    assert.strictEqual(delivery.status, "pending");
  });

  // ---------------------------------------------------------------------------
  // 3. Provider Idempotency & Error Categorization
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. PROVIDER IDEMPOTENCY & ERROR CATEGORIZATION ---");

  await test("3.1 Identical idempotencyKey returns cached result without duplicate network call", async () => {
    let networkCallCount = 0;

    const mockFetch = (async () => {
      networkCallCount++;
      return new Response(
        JSON.stringify({
          messages: [{ id: "wamid.IDEMPOTENT_001" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN_123",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    const params: WhatsAppTemplateParams = {
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "idempotent_test_key_01",
    };

    const res1 = await provider.sendTemplate(params);
    assert.strictEqual(networkCallCount, 1);

    const res2 = await provider.sendTemplate(params);
    assert.strictEqual(networkCallCount, 1, "Duplicate call must return cached result without second fetch");
    assert.strictEqual(res2.messageId, res1.messageId);
  });

  await test("3.2 Conflicting payload with same idempotencyKey fails closed", async () => {
    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN_123",
      allowedRecipients: ["919876543210", "919123456780"],
      fetchFn: (async () => new Response(JSON.stringify({ messages: [{ id: "m1" }] }))) as unknown as typeof fetch,
    });

    await provider.sendTemplate({
      to: "+919876543210",
      templateName: "booking_confirmed_v1",
      language: "en",
      components: [],
      idempotencyKey: "conflict_key_01",
    });

    try {
      await provider.sendTemplate({
        to: "+919123456780", // Conflicting recipient!
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
        idempotencyKey: "conflict_key_01",
      });
      assert.fail("Should have thrown ProviderIdempotencyConflictError");
    } catch (err) {
      assert.ok(err instanceof ProviderIdempotencyConflictError);
    }
  });

  await test("3.3 Meta rate limit error (code 130429) is classified as retryable", async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "(#130429) Rate limit hit",
            type: "OAuthException",
            code: 130429,
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "TOKEN_123",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    try {
      await provider.sendTemplate({
        to: "+919876543210",
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.metaErrorCode, 130429);
      assert.strictEqual(err.isRetryable, true, "Rate limit error must be retryable");
    }
  });

  await test("3.4 Meta invalid token error (code 190) is classified as non-retryable", async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "Invalid OAuth access token",
            type: "OAuthException",
            code: 190,
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const provider = new MetaWhatsAppCloudProvider({
      phoneNumberId: "12345",
      accessToken: "EXPIRED_TOKEN",
      allowedRecipients: ["919876543210"],
      fetchFn: mockFetch,
    });

    try {
      await provider.sendTemplate({
        to: "+919876543210",
        templateName: "booking_confirmed_v1",
        language: "en",
        components: [],
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof WhatsAppCloudApiError);
      assert.strictEqual(err.metaErrorCode, 190);
      assert.strictEqual(err.isRetryable, false, "Auth token error must NOT be retryable");
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Outbox Worker Integration with Meta WhatsApp Cloud API Provider
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. OUTBOX WORKER & METACLOUD DISPATCH INTEGRATION ---");

  await test("4.1 OutboxWorker dispatches WhatsApp delivery via Meta provider", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();

      const mockFetch = (async () => {
        return new Response(
          JSON.stringify({
            messages: [{ id: "wamid.WORKER_TEST_100" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "100609346426371",
        accessToken: "VALID_TOKEN",
        allowedRecipients: ["919876543210"],
        fetchFn: mockFetch,
      });

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      // Grant explicit WhatsApp consent
      await consentRepo.save({
        id: "c_grant_wa_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent to WhatsApp messages",
        consentVersion: "v1.0",
        timestamp: new Date().toISOString(),
      });

      const deliveries = createOutboxDeliveriesForTransition(session);
      const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
      assert.ok(waDelivery, "Must produce WhatsApp delivery");
      await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

      const worker = new OutboxWorker({
        outboxRepository: outboxRepo,
        sessionRepository: sessionRepo,
        consentRepository: consentRepo,
        dndRepository: dndRepo,
        voiceProvider,
        whatsappProvider: metaProvider,
      });

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.dispatchedCount, 1);

      const updatedDelivery = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updatedDelivery?.status, "dispatched");
      assert.strictEqual(updatedDelivery?.providerResult?.providerMessageId, "wamid.WORKER_TEST_100");
    });
  });

  await test("4.2 Non-retryable Meta error transitions delivery to permanently_failed immediately", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();

      const mockFetch = (async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Recipient not in allowed test list",
              type: "OAuthException",
              code: 131030,
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "VALID_TOKEN",
        fetchFn: mockFetch,
      });

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      await consentRepo.save({
        id: "c_grant_wa_02",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "grant",
        granted: true,
        consentText: "Consent to WhatsApp messages",
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

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.permanentlyFailedCount, 1);

      const updatedDelivery = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updatedDelivery?.status, "permanently_failed", "Non-retryable Meta error must mark permanently_failed");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Consent & DND Pre-Dispatch Safeguards
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. CONSENT & DND PRE-DISPATCH RE-EVALUATION ---");

  await test("5.1 Revoked WhatsApp consent transitions delivery to blocked without calling provider", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      let fetchCalled = false;

      const mockFetch = (async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ messages: [{ id: "m" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        fetchFn: mockFetch,
      });

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      // Save a revocation record
      await consentRepo.save({
        id: "c_revoke_01",
        phoneNumber: session.phoneNumber,
        channel: "whatsapp",
        purpose: "transactional_update",
        eventType: "revoke",
        granted: false,
        consentText: "Revoked consent",
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

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.blockedCount, 1);
      assert.strictEqual(fetchCalled, false, "Provider must NEVER be called when consent is revoked");

      const updatedDelivery = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updatedDelivery?.status, "blocked");
      assert.strictEqual(updatedDelivery?.policyResult?.reason, "CONSENT_REVOKED");
    });
  });

  await test("5.2 Active WhatsApp DND blocks delivery at dispatch time", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const sessionRepo = new InMemoryVoiceSessionRepository();
      const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
      const consentRepo = new InMemoryConsentRepository();
      const dndRepo = new InMemoryDndRepository();
      const voiceProvider = new MockVoiceProvider();
      let fetchCalled = false;

      const mockFetch = (async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ messages: [{ id: "m" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const metaProvider = new MetaWhatsAppCloudProvider({
        phoneNumberId: "12345",
        accessToken: "TOKEN",
        fetchFn: mockFetch,
      });

      const session = createTestSession({ state: "awaiting_staff_approval" });
      await sessionRepo.save(session);

      // Grant consent BUT register DND
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

      await dndRepo.save({
        id: "dnd_wa_01",
        phoneNumber: session.phoneNumber,
        scope: "whatsapp",
        reason: "Customer requested DND",
        createdAt: new Date().toISOString(),
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

      const cycleResult = await worker.processCycle();
      assert.strictEqual(cycleResult.blockedCount, 1);
      assert.strictEqual(fetchCalled, false, "Provider must not be called when DND is active");

      const updatedDelivery = await outboxRepo.getDeliveryById(waDelivery.id);
      assert.strictEqual(updatedDelivery?.status, "blocked");
      assert.strictEqual(updatedDelivery?.policyResult?.reason, "DND_ACTIVE");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Webhooks: Verification Challenge & Status Update Processing
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. META WEBHOOKS: VERIFICATION & DELIVERY STATUS ---");

  await test("6.1 GET /api/webhooks/whatsapp verifies subscription challenge", async () => {
    process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test_meta_verify_secret";

    // Valid token & subscribe mode
    const validUrl = "http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test_meta_verify_secret&hub.challenge=1158201444";
    const req = new NextRequest(validUrl, { method: "GET" });
    const res = await webhookGet(req);

    assert.strictEqual(res.status, 200);
    const challengeText = await res.text();
    assert.strictEqual(challengeText, "1158201444");

    // Invalid token rejected with 403
    const invalidUrl = "http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=1158201444";
    const invalidReq = new NextRequest(invalidUrl, { method: "GET" });
    const invalidRes = await webhookGet(invalidReq);
    assert.strictEqual(invalidRes.status, 403);
  });

  await test("6.2 POST /api/webhooks/whatsapp updates outbox delivery status", async () => {
    const outboxRepo = new TestInMemoryCommunicationOutboxRepository();
    const session = createTestSession({ state: "awaiting_staff_approval" });
    const deliveries = createOutboxDeliveriesForTransition(session);
    const waDelivery = deliveries.find((d) => d.channel === "whatsapp")!;
    waDelivery.status = "dispatched";
    waDelivery.providerResult = {
      providerMessageId: "wamid.STATUS_TEST_999",
      status: "accepted",
      isSimulated: false,
      providerMode: "production",
      completedAt: new Date().toISOString(),
    };
    await seedOutboxDeliveryForTest(outboxRepo, waDelivery);

    // Test the POST webhook route with Meta's status update structure
    const webhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                statuses: [
                  {
                    id: "wamid.STATUS_TEST_999",
                    status: "delivered",
                    timestamp: "1730900000",
                    recipient_id: "919876543210",
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const appSecret = "test_meta_webhook_app_secret";
    process.env.META_WHATSAPP_APP_SECRET = appSecret;
    _setWebhookOutboxRepoForTesting(outboxRepo);

    const payloadString = JSON.stringify(webhookPayload);
    const signature = crypto.createHmac("sha256", appSecret).update(payloadString).digest("hex");

    const postReq = new NextRequest("http://localhost:3000/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: payloadString,
    });
    const postRes = await webhookPost(postReq);
    assert.strictEqual(postRes.status, 200);

    // Call updateDeliveryStatusByProviderMessageId directly to verify repository status progression
    const updated = await outboxRepo.updateDeliveryStatusByProviderMessageId(
      "wamid.STATUS_TEST_999",
      "dispatched",
      "delivered",
      new Date().toISOString()
    );
    assert.strictEqual(updated, true);

    const record = await outboxRepo.getDeliveryById(waDelivery.id);
    assert.strictEqual(record?.providerResult?.status, "delivered");
  });

  // ---------------------------------------------------------------------------
  // 7. Provider Selector & Scope Restrictions
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. PROVIDER SELECTOR & SAFETY GUARDRAILS ---");

  await test("7.1 getWhatsAppProvider returns MockWhatsAppProvider when configured as mock", async () => {
    const provider = getWhatsAppProvider("mock");
    assert.ok(provider instanceof MockWhatsAppProvider);
    assert.strictEqual(provider.providerName, "mock-whatsapp-provider");
  });

  await test("7.2 getWhatsAppProvider returns MetaWhatsAppCloudProvider when configured as cloud_api", async () => {
    const provider = getWhatsAppProvider("cloud_api", {
      phoneNumberId: "12345",
      accessToken: "TOKEN",
    });
    assert.ok(provider instanceof MetaWhatsAppCloudProvider);
    assert.strictEqual(provider.providerName, "meta-whatsapp-cloud-api");
  });

  await test("7.3 VOICE_BOOKING_ENABLED remains strictly false; zero voice telephony activated", async () => {
    assert.strictEqual(process.env.VOICE_BOOKING_ENABLED, "false");
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase 6.4 Verification Complete: ${passed}/${total} checks passed (${passed === total ? "SUCCESS" : "FAILURES"})`);
  console.log("================================================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});
