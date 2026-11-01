/**
 * BREW Coffee Platform — Phase 6.1 Verification Suite
 * Automated tests for Communication Foundation, Consent Engine, DND, Policy & Mock Providers.
 */

import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import {
  assertValidPhoneNumber,
  createConsentRecord,
  createDndRecord,
  evaluateCommunicationPolicy,
  hasActiveConsent,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  isChannelBlockedByDnd,
  isConsentRevoked,
  isOptOutPhrase,
  isVoiceBookingEnabled,
  isWithinCallingHours,
  maskPhoneNumber,
  MockVoiceProvider,
  MockWhatsAppProvider,
  normalizePhoneNumber,
  revokeConsentRecord,
} from "../src/lib/communication/index";

console.log("===============================================================");
console.log("📡 VERIFICATION SUITE: Phase 6.1 Communication Foundation");
console.log("===============================================================\n");

let passedCount = 0;
let failedCount = 0;

async function runTest(description: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${description}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failedCount++;
  }
}

async function runSuite() {
  /* ======================================================================== */
  /* 1. Phone Number Normalization & Consent Engine                           */
  /* ======================================================================== */
  console.log("1. Consent Engine & Phone Number Normalization");

  await runTest("Normalizes standard 10-digit Indian numbers to E.164", () => {
    assert.equal(normalizePhoneNumber("9876543210"), "+919876543210");
    assert.equal(normalizePhoneNumber("09876543210"), "+919876543210");
    assert.equal(normalizePhoneNumber("919876543210"), "+919876543210");
    assert.equal(normalizePhoneNumber("+91 98765 43210"), "+919876543210");
    assert.equal(normalizePhoneNumber("+91-98765-43210"), "+919876543210");
  });

  await runTest("Rejects malformed or invalid phone numbers", () => {
    assert.equal(normalizePhoneNumber(""), null);
    assert.equal(normalizePhoneNumber("12345"), null);
    assert.equal(normalizePhoneNumber("abcdefghij"), null);
    assert.equal(normalizePhoneNumber("+1"), null);
    assert.throws(
      () => assertValidPhoneNumber("invalid-number"),
      (err: unknown) => err instanceof Error && err.name === "InvalidPhoneNumberError"
    );
  });

  await runTest("Creates validated, auditable ConsentRecord with E.164 phone", () => {
    const record = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "I consent to receiving an automated voice call regarding my booking enquiry.",
      consentVersion: "v1.0",
      enquiryId: "enq_test_101",
    });

    assert.equal(record.phoneNumber, "+919876543210");
    assert.equal(record.channel, "voice");
    assert.equal(record.purpose, "voice_booking");
    assert.equal(record.granted, true);
    assert.ok(record.id.startsWith("consent_"));
    assert.ok(record.timestamp);
    assert.equal(record.revokedAt, undefined);
  });

  await runTest("Missing consent returns false", () => {
    assert.equal(hasActiveConsent([], "voice", "voice_booking"), false);
  });

  await runTest("Voice consent is independent of WhatsApp consent", () => {
    const voiceOnlyRecord = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Voice consent only.",
    });

    const records = [voiceOnlyRecord];
    assert.equal(hasActiveConsent(records, "voice", "voice_booking"), true);
    assert.equal(hasActiveConsent(records, "whatsapp", "transactional_update"), false);
  });

  await runTest("Transactional consent does not imply marketing consent", () => {
    const transactionalRecord = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "whatsapp",
      purpose: "transactional_update",
      consentText: "WhatsApp transactional updates.",
    });

    const records = [transactionalRecord];
    assert.equal(hasActiveConsent(records, "whatsapp", "transactional_update"), true);
    assert.equal(hasActiveConsent(records, "whatsapp", "marketing"), false);
  });

  await runTest("Revocation overrides earlier grant and cannot be undone by older records", () => {
    const initialGrant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Initial voice consent.",
      timestamp: "2026-11-01T08:00:00.000Z",
    });

    assert.equal(hasActiveConsent([initialGrant], "voice", "voice_booking"), true);

    const revokedGrant = revokeConsentRecord(
      initialGrant,
      "Customer requested stop",
      "2026-11-01T09:00:00.000Z"
    );

    assert.equal(isConsentRevoked(revokedGrant), true);
    assert.equal(hasActiveConsent([revokedGrant], "voice", "voice_booking"), false);

    // List with both initial and revoked (revoked newer)
    const history = [initialGrant, revokedGrant];
    assert.equal(hasActiveConsent(history, "voice", "voice_booking"), false);
  });

  await runTest("InMemoryConsentRepository handles saving, querying, and revoking", async () => {
    const repo = new InMemoryConsentRepository();
    const phone = "9876543210";

    const grant = createConsentRecord({
      phoneNumber: phone,
      channel: "whatsapp",
      purpose: "transactional_update",
      consentText: "WhatsApp updates",
    });

    await repo.save(grant);
    const active = await repo.getActiveConsent(phone, "whatsapp", "transactional_update");
    assert.ok(active);
    assert.equal(active.phoneNumber, "+919876543210");

    await repo.revoke(phone, "whatsapp", "transactional_update", "user_opt_out");
    const activeAfterRevoke = await repo.getActiveConsent(phone, "whatsapp", "transactional_update");
    assert.equal(activeAfterRevoke, null);
  });

  /* ======================================================================== */
  /* 2. Do-Not-Contact (DND) Engine & Multilingual Opt-Out Phrases           */
  /* ======================================================================== */
  console.log("\n2. Do-Not-Contact (DND) Engine & Multilingual Opt-Out Matching");

  await runTest("Global DND ('all') blocks all outbound channels", () => {
    const dnd = createDndRecord({
      phoneNumber: "9876543210",
      scope: "all",
      reason: "User sent STOP",
    });

    assert.equal(isChannelBlockedByDnd(dnd, "voice"), true);
    assert.equal(isChannelBlockedByDnd(dnd, "whatsapp"), true);
  });

  await runTest("Voice-only DND blocks voice but allows WhatsApp", () => {
    const dnd = createDndRecord({
      phoneNumber: "9876543210",
      scope: "voice",
      reason: "User does not want phone calls",
    });

    assert.equal(isChannelBlockedByDnd(dnd, "voice"), true);
    assert.equal(isChannelBlockedByDnd(dnd, "whatsapp"), false);
  });

  await runTest("WhatsApp-only DND blocks WhatsApp but allows voice", () => {
    const dnd = createDndRecord({
      phoneNumber: "9876543210",
      scope: "whatsapp",
      reason: "User opted out of WhatsApp messages",
    });

    assert.equal(isChannelBlockedByDnd(dnd, "whatsapp"), true);
    assert.equal(isChannelBlockedByDnd(dnd, "voice"), false);
  });

  await runTest("Repeated opt-out events are idempotent and preserve 'all' scope", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    const globalDnd = createDndRecord({
      phoneNumber: phone,
      scope: "all",
      reason: "STOP",
    });
    await repo.save(globalDnd);

    // Attempt to register narrower scope; idempotency preserves 'all'
    const voiceOnlyDnd = createDndRecord({
      phoneNumber: phone,
      scope: "voice",
      reason: "Repeated call",
    });
    await repo.save(voiceOnlyDnd);

    const saved = await repo.findByPhone(phone);
    assert.equal(saved?.scope, "all");
  });

  await runTest("DND removal strictly requires explicit auditable justification", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "all", reason: "STOP" }));

    // Empty justification rejected
    await assert.rejects(
      () => repo.remove(phone, ""),
      /DND removal requires an explicit, auditable justification/
    );

    // Valid auditable justification succeeds
    const removed = await repo.remove(phone, "Customer contacted support via email to re-opt-in");
    assert.equal(removed, true);
    const lookup = await repo.findByPhone(phone);
    assert.equal(lookup, null);
  });

  await runTest("Recognizes English, Hindi, and Telugu opt-out phrases deterministically", () => {
    const positiveCases = [
      // English
      "STOP",
      "Stop",
      "  stop  ",
      "UNSUBSCRIBE",
      "Cancel",
      "Quit",
      "End",
      "Opt out",
      "DO NOT CALL",
      "Don't call me",
      "Please stop calling",
      // Hindi (Devanagari)
      "रोको",
      "बंद करो",
      "कॉल मत करो",
      "संदेश मत भेजो",
      "अनसब्सक्राइब",
      "फोन मत करना",
      // Telugu (Script)
      "ఆపండి",
      "వద్దు",
      "కాల్ చేయవద్దు",
      "ఫోన్ చేయకండి",
      "మెసేజ్ చేయవద్దు",
      "రద్దు చేయండి",
      // Hinglish / Tenglish
      "band karo",
      "call mat karo",
      "aapandi",
      "vaddu",
      "call cheyavaddhu",
    ];

    for (const phrase of positiveCases) {
      assert.equal(
        isOptOutPhrase(phrase),
        true,
        `Expected "${phrase}" to be recognized as opt-out command.`
      );
    }
  });

  await runTest("Safely rejects conversational or ambiguous phrases from triggering DND", () => {
    const negativeCases = [
      "I will stop by at 4pm",
      "Can you call me tomorrow?",
      "Coffee stop near me",
      "Please hold my order",
      "Can I cancel my coffee?",
      "Quick stop on the way",
      "Wait for my call",
    ];

    for (const phrase of negativeCases) {
      assert.equal(
        isOptOutPhrase(phrase),
        false,
        `Expected "${phrase}" to NOT trigger opt-out.`
      );
    }
  });

  /* ======================================================================== */
  /* 3. Communication Policy Engine                                           */
  /* ======================================================================== */
  console.log("\n3. Communication Policy Engine");

  await runTest("Blocks communication when feature flag is disabled", () => {
    const original = process.env.VOICE_BOOKING_ENABLED;
    try {
      delete process.env.VOICE_BOOKING_ENABLED;
      assert.equal(isVoiceBookingEnabled(), false);

      const decision = evaluateCommunicationPolicy(
        {
          phoneNumber: "+919876543210",
          channel: "voice",
          purpose: "voice_booking",
        },
        { consentRecords: [] },
        { checkFeatureFlag: true }
      );

      assert.equal(decision.status, "blocked");
      assert.equal(decision.reason, "FEATURE_DISABLED");
    } finally {
      process.env.VOICE_BOOKING_ENABLED = original;
    }
  });

  await runTest("Blocks communication when consent is missing", () => {
    const decision = evaluateCommunicationPolicy(
      {
        phoneNumber: "+919876543210",
        channel: "voice",
        purpose: "voice_booking",
      },
      { consentRecords: [] },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "blocked");
    assert.equal(decision.reason, "CONSENT_MISSING");
  });

  await runTest("Blocks communication when consent was revoked", () => {
    const revoked = revokeConsentRecord(
      createConsentRecord({
        phoneNumber: "9876543210",
        channel: "voice",
        purpose: "voice_booking",
        consentText: "Voice consent",
      }),
      "User revoked"
    );

    const decision = evaluateCommunicationPolicy(
      {
        phoneNumber: "+919876543210",
        channel: "voice",
        purpose: "voice_booking",
      },
      { consentRecords: [revoked] },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "blocked");
    assert.equal(decision.reason, "CONSENT_REVOKED");
  });

  await runTest("Blocks communication when customer is in DND registry", () => {
    const grant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Voice consent",
    });

    const dnd = createDndRecord({
      phoneNumber: "9876543210",
      scope: "voice",
      reason: "Customer opted out of calls",
    });

    const decision = evaluateCommunicationPolicy(
      {
        phoneNumber: "+919876543210",
        channel: "voice",
        purpose: "voice_booking",
      },
      { consentRecords: [grant], dndRecord: dnd },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "blocked");
    assert.equal(decision.reason, "DND_ACTIVE");
  });

  await runTest("Calling-hour policy enforces 09:00 - 20:00 IST boundaries for voice", () => {
    // 03:29:59 UTC = 08:59:59 IST (outside window)
    const timeBefore9 = new Date("2026-11-01T03:29:59.000Z");
    assert.equal(isWithinCallingHours(timeBefore9), false);

    // 03:30:00 UTC = 09:00:00 IST (boundary open)
    const timeAt9 = new Date("2026-11-01T03:30:00.000Z");
    assert.equal(isWithinCallingHours(timeAt9), true);

    // 14:29:59 UTC = 19:59:59 IST (inside window)
    const timeAt759 = new Date("2026-11-01T14:29:59.000Z");
    assert.equal(isWithinCallingHours(timeAt759), true);

    // 14:30:00 UTC = 20:00:00 IST (cutoff)
    const timeAt800 = new Date("2026-11-01T14:30:00.000Z");
    assert.equal(isWithinCallingHours(timeAt800), false);

    // 14:30:01 UTC = 20:00:01 IST (outside window)
    const timeAt801 = new Date("2026-11-01T14:30:01.000Z");
    assert.equal(isWithinCallingHours(timeAt801), false);
  });

  await runTest("Voice call outside calling hours is blocked by policy", () => {
    const grant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Voice consent",
    });

    const lateNightUtc = new Date("2026-11-01T17:00:00.000Z"); // 22:30 IST

    const decision = evaluateCommunicationPolicy(
      {
        phoneNumber: "+919876543210",
        channel: "voice",
        purpose: "voice_booking",
        currentTime: lateNightUtc,
      },
      { consentRecords: [grant] },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "blocked");
    assert.equal(decision.reason, "OUTSIDE_CALLING_HOURS");
  });

  await runTest("Non-voice transactional messages (WhatsApp) do NOT inherit voice calling hours", () => {
    const grant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "whatsapp",
      purpose: "transactional_update",
      consentText: "WhatsApp updates",
    });

    const lateNightUtc = new Date("2026-11-01T17:00:00.000Z"); // 22:30 IST

    const decision = evaluateCommunicationPolicy(
      {
        phoneNumber: "+919876543210",
        channel: "whatsapp",
        purpose: "transactional_update",
        currentTime: lateNightUtc,
      },
      { consentRecords: [grant] },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "allowed");
    assert.equal(decision.reason, "ALLOWED");
  });

  await runTest("Masks phone number in policy result without leaking PII", () => {
    assert.equal(maskPhoneNumber("+919876543210"), "+91******3210");
  });

  /* ======================================================================== */
  /* 4. Provider Contracts & Deterministic Mocks                             */
  /* ======================================================================== */
  console.log("\n4. Provider Contracts & Deterministic Mocks");

  await runTest("MockVoiceProvider handles successful lifecycle deterministically", async () => {
    const voiceProvider = new MockVoiceProvider();

    const startRes = await voiceProvider.startSession({
      sessionId: "sess_voice_101",
      phoneNumber: "+919876543210",
      language: "hi",
    });

    assert.equal(startRes.sessionId, "sess_voice_101");
    assert.equal(startRes.status, "initiated");
    assert.ok(startRes.providerCallId.startsWith("mock_call_"));

    const statusRes = await voiceProvider.getStatus("sess_voice_101");
    assert.equal(statusRes.status, "in_progress");

    const endRes = await voiceProvider.endSession("sess_voice_101");
    assert.equal(endRes.status, "ended");
    assert.equal(voiceProvider.getActiveSessionCount(), 0);
  });

  await runTest("MockVoiceProvider simulates failures when configured", async () => {
    const voiceProvider = new MockVoiceProvider();
    voiceProvider.setSimulateFailure(true, "Carrier SIP Gateway unavailable");

    await assert.rejects(
      () =>
        voiceProvider.startSession({
          sessionId: "sess_voice_fail",
          phoneNumber: "+919876543210",
          language: "te",
        }),
      /Carrier SIP Gateway unavailable/
    );
  });

  await runTest("MockWhatsAppProvider handles transactional template dispatch", async () => {
    const waProvider = new MockWhatsAppProvider();

    const sendRes = await waProvider.sendTemplate({
      to: "+919876543210",
      templateName: "brew_booking_quote_v1",
      language: "en_US",
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Gnanendhra" },
            { type: "text", text: "Classic Brew" },
          ],
        },
      ],
    });

    assert.ok(sendRes.messageId.startsWith("mock_wa_"));
    assert.equal(sendRes.status, "accepted");
    assert.equal(waProvider.getDispatchedMessageCount(), 1);
    assert.equal(waProvider.getLastDispatchedTemplateName(), "brew_booking_quote_v1");

    const statusRes = await waProvider.getMessageStatus(sendRes.messageId);
    assert.equal(statusRes.status, "delivered");
  });

  await runTest("MockWhatsAppProvider simulates provider failure cleanly", async () => {
    const waProvider = new MockWhatsAppProvider();
    waProvider.setSimulateFailure(true, "Meta Cloud API rate limited (429)");

    await assert.rejects(
      () =>
        waProvider.sendTemplate({
          to: "+919876543210",
          templateName: "test_tmpl",
          language: "en",
          components: [],
        }),
      /Meta Cloud API rate limited/
    );
  });

  await runTest("Zero external network requests from mock providers", async () => {
    // Monkey-patch http.request and https.request to ensure neither is called
    let networkRequestAttempted = false;
    const origHttpRequest = http.request;
    const origHttpsRequest = https.request;

    http.request = (() => {
      networkRequestAttempted = true;
      throw new Error("Violation: External HTTP request attempted by mock provider");
    }) as unknown as typeof http.request;

    https.request = (() => {
      networkRequestAttempted = true;
      throw new Error("Violation: External HTTPS request attempted by mock provider");
    }) as unknown as typeof https.request;

    try {
      const voice = new MockVoiceProvider();
      await voice.startSession({
        sessionId: "net_test_1",
        phoneNumber: "+919876543210",
        language: "en",
      });
      await voice.getStatus("net_test_1");
      await voice.endSession("net_test_1");

      const wa = new MockWhatsAppProvider();
      const sendRes = await wa.sendTemplate({
        to: "+919876543210",
        templateName: "test_isolated",
        language: "en",
        components: [],
      });
      await wa.getMessageStatus(sendRes.messageId);

      assert.equal(networkRequestAttempted, false);
    } finally {
      http.request = origHttpRequest;
      https.request = origHttpsRequest;
    }
  });

  /* ======================================================================== */
  /* Final Summary                                                            */
  /* ======================================================================== */
  console.log("\n---------------------------------------------------------------");
  console.log(`Phase 6.1 Results: ${passedCount} passed, ${failedCount} failed`);
  console.log("---------------------------------------------------------------");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Suite execution failure:", err);
  process.exit(1);
});
