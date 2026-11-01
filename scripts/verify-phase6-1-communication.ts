/**
 * BREW Coffee Platform — Phase 6.1 & 6.1.1 Hardened Verification Suite
 * Automated tests for Communication Foundation, Consent Event History,
 * DND Multi-Scope Suppression, Server-Side Policy Orchestration & Simulation Mocks.
 */

import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import {
  assertValidPhoneNumber,
  assertValidTimestamp,
  createConsentRecord,
  createDndRecord,
  createRevocationRecord,
  evaluateCommunicationPolicy,
  hasActiveConsent,
  InMemoryConsentRepository,
  InMemoryDndRepository,
  isChannelBlockedByDnd,
  isChannelBlockedByDndScopes,
  isConsentRevoked,
  isOptOutPhrase,
  isVoiceBookingEnabled,
  isWithinCallingHours,
  maskPhoneNumber,
  MockVoiceProvider,
  MockWhatsAppProvider,
  normalizePhoneNumber,
  orchestrateCommunicationPolicy,
  revokeConsentRecord,
} from "../src/lib/communication/index";

console.log("===============================================================");
console.log("📡 VERIFICATION SUITE: Phase 6.1.1 Communication Foundation Hardening");
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
  /* 1. Phone Number Normalization & Consent Event History                    */
  /* ======================================================================== */
  console.log("1. Consent Engine & Event History Semantics");

  await runTest("Normalizes standard 10-digit Indian numbers to E.164", () => {
    assert.equal(normalizePhoneNumber("9876543210"), "+919876543210");
    assert.equal(normalizePhoneNumber("09876543210"), "+919876543210");
    assert.equal(normalizePhoneNumber("919876543210"), "+919876543210");
    assert.equal(normalizePhoneNumber("+91 98765 43210"), "+919876543210");
    assert.equal(normalizePhoneNumber("+91-98765-43210"), "+919876543210");
    assert.equal(maskPhoneNumber("+919876543210"), "+91******3210");
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

  await runTest("Rejects invalid or unparseable timestamps", () => {
    assert.throws(() => assertValidTimestamp("not-a-date"), /cannot be parsed/);
    assert.throws(() => assertValidTimestamp(""), /Invalid timestamp format/);
  });

  await runTest("Creates validated, auditable ConsentRecord with E.164 phone and eventType='grant'", () => {
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
    assert.equal(record.eventType, "grant");
    assert.equal(record.granted, true);
    assert.ok(record.id.startsWith("consent_grant_"));
    assert.ok(record.timestamp);
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

  await runTest("Event Semantics: Grant (T1) -> Revoke (T2) results in inactive consent", () => {
    const grant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Initial voice consent.",
      timestamp: "2026-11-01T08:00:00.000Z",
    });

    const revoke = createRevocationRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      reason: "Customer requested stop",
      timestamp: "2026-11-01T09:00:00.000Z",
    });

    assert.equal(isConsentRevoked(revoke), true);
    assert.equal(hasActiveConsent([grant, revoke], "voice", "voice_booking"), false);
  });

  await runTest("Event Semantics: Grant (T1) -> Revoke (T2) -> Explicit New Grant (T3) restores consent", () => {
    const grant1 = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Initial voice consent.",
      timestamp: "2026-11-01T08:00:00.000Z",
    });

    const revoke1 = createRevocationRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      reason: "User opted out",
      timestamp: "2026-11-01T09:00:00.000Z",
    });

    const grant2 = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Explicit new booking re-opt-in.",
      timestamp: "2026-11-01T10:00:00.000Z",
    });

    const history = [grant1, revoke1, grant2];
    assert.equal(hasActiveConsent(history, "voice", "voice_booking"), true);
  });

  await runTest("Event Semantics: Older grant (T1) submitted after newer revocation (T2) remains inactive", () => {
    const grantOld = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Stale offline grant",
      timestamp: "2026-11-01T07:00:00.000Z",
    });

    const revokeNew = createRevocationRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      reason: "User opted out via web",
      timestamp: "2026-11-01T08:30:00.000Z",
    });

    // History contains both; newer revocation must prevail
    const history = [grantOld, revokeNew];
    assert.equal(hasActiveConsent(history, "voice", "voice_booking"), false);
  });

  await runTest("Event Semantics: Voice revocation does not affect active WhatsApp consent", () => {
    const voiceRevoke = createRevocationRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      reason: "Stop calls",
      timestamp: "2026-11-01T09:00:00.000Z",
    });

    const waGrant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "whatsapp",
      purpose: "transactional_update",
      consentText: "WhatsApp updates",
      timestamp: "2026-11-01T08:00:00.000Z",
    });

    const history = [voiceRevoke, waGrant];
    assert.equal(hasActiveConsent(history, "voice", "voice_booking"), false);
    assert.equal(hasActiveConsent(history, "whatsapp", "transactional_update"), true);
  });

  await runTest("Event Semantics: Equal timestamps resolved deterministically (Safety-First: Revoke beats Grant)", () => {
    const sameTimestamp = "2026-11-01T12:00:00.000Z";

    const grant = createConsentRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      consentText: "Simultaneous grant",
      timestamp: sameTimestamp,
    });

    const revoke = createRevocationRecord({
      phoneNumber: "9876543210",
      channel: "voice",
      purpose: "voice_booking",
      reason: "Simultaneous revoke",
      timestamp: sameTimestamp,
    });

    // Order in array shouldn't matter; tie-breaker must choose revoke
    assert.equal(hasActiveConsent([grant, revoke], "voice", "voice_booking"), false);
    assert.equal(hasActiveConsent([revoke, grant], "voice", "voice_booking"), false);
  });

  await runTest("InMemoryConsentRepository handles saving events, querying active grant, and revoking", async () => {
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
  /* 2. Do-Not-Contact (DND) Multi-Scope Engine & Audit History               */
  /* ======================================================================== */
  console.log("\n2. Do-Not-Contact (DND) Multi-Scope Engine & Audit Logging");

  await runTest("Global DND ('all') blocks all outbound channels", () => {
    const dnd = createDndRecord({
      phoneNumber: "9876543210",
      scope: "all",
      reason: "User sent STOP",
    });

    assert.equal(isChannelBlockedByDnd(dnd, "voice"), true);
    assert.equal(isChannelBlockedByDnd(dnd, "whatsapp"), true);
    assert.equal(isChannelBlockedByDndScopes([dnd], "voice"), true);
    assert.equal(isChannelBlockedByDndScopes([dnd], "whatsapp"), true);
  });

  await runTest("Multi-Scope: 'voice' and 'whatsapp' can coexist independently", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    const voiceDnd = createDndRecord({
      phoneNumber: phone,
      scope: "voice",
      reason: "No phone calls",
    });
    const waDnd = createDndRecord({
      phoneNumber: phone,
      scope: "whatsapp",
      reason: "No whatsapp messages",
    });

    await repo.save(voiceDnd);
    await repo.save(waDnd);

    const activeScopes = await repo.findActiveScopes(phone);
    assert.equal(activeScopes.length, 2);
    assert.ok(activeScopes.some((s) => s.scope === "voice"));
    assert.ok(activeScopes.some((s) => s.scope === "whatsapp"));

    assert.equal(isChannelBlockedByDndScopes(activeScopes, "voice"), true);
    assert.equal(isChannelBlockedByDndScopes(activeScopes, "whatsapp"), true);
  });

  await runTest("Multi-Scope: Removing 'voice' scope leaves 'whatsapp' active", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "Stop calls" }));
    await repo.save(createDndRecord({ phoneNumber: phone, scope: "whatsapp", reason: "Stop WA" }));

    // Remove only voice scope
    const removed = await repo.removeScope(phone, "voice", "Customer requested phone follow-up");
    assert.equal(removed, true);

    const remainingScopes = await repo.findActiveScopes(phone);
    assert.equal(remainingScopes.length, 1);
    assert.equal(remainingScopes[0].scope, "whatsapp");

    assert.equal(isChannelBlockedByDndScopes(remainingScopes, "voice"), false);
    assert.equal(isChannelBlockedByDndScopes(remainingScopes, "whatsapp"), true);
  });

  await runTest("Multi-Scope: Global 'all' coexists with 'voice' and cannot be downgraded", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "all", reason: "Global STOP" }));
    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "No calls" }));

    const activeScopes = await repo.findActiveScopes(phone);
    assert.equal(activeScopes.length, 2);

    // Global DND still blocks both channels
    assert.equal(isChannelBlockedByDndScopes(activeScopes, "voice"), true);
    assert.equal(isChannelBlockedByDndScopes(activeScopes, "whatsapp"), true);

    // Primary scope returns 'all'
    const primary = await repo.findByPhone(phone);
    assert.equal(primary?.scope, "all");
  });

  await runTest("Multi-Scope: Removing 'all' leaves independently active 'voice' scope intact", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "all", reason: "Global STOP" }));
    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "No calls" }));

    // Explicit administrative removal of 'all' scope
    const removed = await repo.removeScope(
      phone,
      "all",
      "Administrative override: customer re-opted in via verified support ticket",
      "admin_101"
    );
    assert.equal(removed, true);

    const remaining = await repo.findActiveScopes(phone);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].scope, "voice");

    // Voice remains blocked, WhatsApp is now unblocked
    assert.equal(isChannelBlockedByDndScopes(remaining, "voice"), true);
    assert.equal(isChannelBlockedByDndScopes(remaining, "whatsapp"), false);
  });

  await runTest("Repeated registrations are idempotent and do not corrupt storage", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "Stop" }));
    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "Stop duplicate" }));

    const scopes = await repo.findActiveScopes(phone);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].scope, "voice");
  });

  await runTest("DND removal strictly rejects invalid or insufficiently detailed justifications", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "9876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "Stop" }));

    // Empty justification rejected
    await assert.rejects(
      () => repo.removeScope(phone, "voice", ""),
      /minimum 5 characters/
    );

    // Less than 10 characters for 'all' scope rejected
    await repo.save(createDndRecord({ phoneNumber: phone, scope: "all", reason: "Stop" }));
    await assert.rejects(
      () => repo.removeScope(phone, "all", "short"),
      /minimum 10 characters/
    );
  });

  await runTest("DND audit history stores masked phone numbers and preserves full event trail", async () => {
    const repo = new InMemoryDndRepository();
    const phone = "+919876543210";

    await repo.save(createDndRecord({ phoneNumber: phone, scope: "voice", reason: "Customer opt-out" }));
    await repo.removeScope(phone, "voice", "Customer called support to remove DND");

    const auditHistory = repo.getAuditHistory();
    assert.equal(auditHistory.length, 2);

    const regEvent = auditHistory[0];
    assert.equal(regEvent.action, "REGISTER_DND");
    assert.equal(regEvent.phoneNumberMasked, "+91******3210");
    assert.equal(regEvent.phoneNumberMasked.includes("987654"), false); // No raw phone leak

    const remEvent = auditHistory[1];
    assert.equal(remEvent.action, "REMOVE_DND");
    assert.equal(remEvent.phoneNumberMasked, "+91******3210");
    assert.equal(remEvent.justification, "Customer called support to remove DND");
  });

  await runTest("Recognizes English, Hindi, and Telugu opt-out phrases deterministically", () => {
    const positiveCases = [
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
      "रोको",
      "बंद करो",
      "कॉल मत करो",
      "संदेश मत भेजो",
      "अनसब्सक्राइब",
      "फोन मत करना",
      "ఆపండి",
      "వద్దు",
      "కాల్ చేయవద్దు",
      "ఫోన్ చేయకండి",
      "మెసేజ్ చేయవద్దు",
      "రద్దు చేయండి",
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
  /* 3. Communication Policy & Server-Side Orchestration Boundary             */
  /* ======================================================================== */
  console.log("\n3. Communication Policy Engine & Server-Side Orchestration");

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
      { consentRecords: [grant], activeDndScopes: [dnd] },
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

  await runTest("Server-Side Orchestration: orchestrateCommunicationPolicy loads authoritative repository data", async () => {
    const consentRepo = new InMemoryConsentRepository();
    const dndRepo = new InMemoryDndRepository();
    const phone = "+919876543210";

    // Add active consent
    await consentRepo.save(
      createConsentRecord({
        phoneNumber: phone,
        channel: "voice",
        purpose: "voice_booking",
        consentText: "I consent to calls",
      })
    );

    const daytimeUtc = new Date("2026-11-01T06:00:00.000Z"); // 11:30 IST

    const decision = await orchestrateCommunicationPolicy(
      {
        phoneNumber: "9876543210",
        channel: "voice",
        purpose: "voice_booking",
        currentTime: daytimeUtc,
      },
      { consentRepository: consentRepo, dndRepository: dndRepo },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "allowed");
    assert.equal(decision.reason, "ALLOWED");
    assert.equal(decision.phoneNumberMasked, "+91******3210");
  });

  await runTest("Server-Side Orchestration: Blocks when repository returns mismatched phone number (Integrity Check)", async () => {
    // Malicious or buggy repository returning records for a different phone number
    const tamperedConsentRepo: InMemoryConsentRepository = {
      ...new InMemoryConsentRepository(),
      findByPhone: async () => [
        createConsentRecord({
          phoneNumber: "+911111111111", // Mismatched!
          channel: "voice",
          purpose: "voice_booking",
          consentText: "Other user consent",
        }),
      ],
    } as unknown as InMemoryConsentRepository;

    const dndRepo = new InMemoryDndRepository();

    const decision = await orchestrateCommunicationPolicy(
      {
        phoneNumber: "9876543210",
        channel: "voice",
        purpose: "voice_booking",
      },
      { consentRepository: tamperedConsentRepo, dndRepository: dndRepo },
      { checkFeatureFlag: false }
    );

    assert.equal(decision.status, "blocked");
    assert.equal(decision.reason, "REPOSITORY_INTEGRITY_MISMATCH");
  });

  /* ======================================================================== */
  /* 4. Provider Contracts & Deterministic Mocks                             */
  /* ======================================================================== */
  console.log("\n4. Provider Contracts & Simulation Mocks");

  await runTest("MockVoiceProvider clearly identifies as simulation with deterministic status and IDs", async () => {
    const voiceProvider = new MockVoiceProvider();
    assert.equal(voiceProvider.isSimulated, true);
    assert.equal(voiceProvider.providerMode, "mock");

    // Inject deterministic ID and timestamp
    voiceProvider.setNextCallId("call_det_001");
    voiceProvider.setNextTimestamp("2026-11-01T10:00:00.000Z");

    const startRes = await voiceProvider.startSession({
      sessionId: "sess_voice_101",
      phoneNumber: "+919876543210",
      language: "hi",
    });

    assert.equal(startRes.sessionId, "sess_voice_101");
    assert.equal(startRes.providerCallId, "call_det_001");
    assert.equal(startRes.status, "simulated_initiated");
    assert.equal(startRes.startedAt, "2026-11-01T10:00:00.000Z");
    assert.equal(startRes.isSimulated, true);
    assert.equal(startRes.providerMode, "mock");

    const statusRes = await voiceProvider.getStatus("sess_voice_101");
    assert.equal(statusRes.status, "simulated_in_progress");
    assert.equal(statusRes.isSimulated, true);

    const endRes = await voiceProvider.endSession("sess_voice_101");
    assert.equal(endRes.status, "simulated_ended");
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

  await runTest("MockWhatsAppProvider clearly identifies as simulation with deterministic message ID", async () => {
    const waProvider = new MockWhatsAppProvider();
    assert.equal(waProvider.isSimulated, true);
    assert.equal(waProvider.providerMode, "mock");

    // Inject deterministic message ID and timestamp
    waProvider.setNextMessageId("wa_det_789");
    waProvider.setNextTimestamp("2026-11-01T10:05:00.000Z");

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

    assert.equal(sendRes.messageId, "wa_det_789");
    assert.equal(sendRes.status, "simulated_accepted");
    assert.equal(sendRes.dispatchedAt, "2026-11-01T10:05:00.000Z");
    assert.equal(sendRes.isSimulated, true);
    assert.equal(sendRes.providerMode, "mock");
    assert.equal(waProvider.getDispatchedMessageCount(), 1);
    assert.equal(waProvider.getLastDispatchedTemplateName(), "brew_booking_quote_v1");

    const statusRes = await waProvider.getMessageStatus(sendRes.messageId);
    assert.equal(statusRes.status, "simulated_delivered");
    assert.equal(statusRes.isSimulated, true);
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
  console.log(`Phase 6.1.1 Results: ${passedCount} passed, ${failedCount} failed`);
  console.log("---------------------------------------------------------------");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Suite execution failure:", err);
  process.exit(1);
});
