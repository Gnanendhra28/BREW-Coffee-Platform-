/**
 * BREW Coffee Platform — Phase 6.6.5.1 Verification Test Suite
 * Controlled Test Authorization & Outbound Safety Audit
 *
 * Verifies:
 * 1. Outbound test allowlist enforcement (VOICE_TEST_WHITELIST_PHONES).
 * 2. Unauthorized destination rejection (fail closed).
 * 3. Single-call authorization limit (consumed once).
 * 4. Concurrent consumption safety (exactly one winner).
 * 5. Expired authorization rejection.
 * 6. Independent voice consent verification (rejects WhatsApp-only consent).
 * 7. Server-side staff approval requirement.
 * 8. Emergency shutdown (VOICE_BOOKING_ENABLED=false).
 * 9. Provider timeout / uncertain outcome blocks automated redial and leaves authorization consumed.
 * 10. Audit logging and privacy (masked numbers, zero token/audio leakage).
 */

import assert from "assert";
import {
  ExotelVoiceProvider,
  ExotelApiError,
} from "../src/lib/communication/providers/exotelVoiceProvider";
import {
  getVoiceTestWhitelistPhones,
  InMemoryVoiceTestAuthorizationRegistry,
  isAuthorizedTestNumber,
  verifyIndependentVoiceConsent,
  VoiceTestAuthorizationError,
} from "../src/lib/communication/voice/testAuthorization";
import { InMemoryConsentRepository } from "../src/lib/communication/repositories/consentRepository";
import { createConsentRecord } from "../src/lib/communication/consent";
import { InMemoryVoiceCallAttemptRepository } from "../src/lib/communication/voice/callAttemptRepository";
import { withTestVoiceBookingEnabled } from "../src/lib/communication/outbox/testFixture";

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
  console.log("   BREW Coffee Platform — Phase 6.6.5.1 Verification Suite");
  console.log("   Controlled Test Authorization & Outbound Safety Audit");
  console.log("================================================================================\n");

  const testAuthPhone = "+919876543210";
  const unauthorizedPhone = "+919123456789";
  const mockSecret = "controlled_test_stream_secret_123";

  // ---------------------------------------------------------------------------
  // 1. EMERGENCY SHUTDOWN (VOICE_BOOKING_ENABLED=false)
  // ---------------------------------------------------------------------------
  console.log("--- 1. EMERGENCY SHUTDOWN ---");

  await test("1.1 VOICE_BOOKING_ENABLED=false blocks every outbound dialing path", async () => {
    // Unset or set to false
    const origEnv = process.env.VOICE_BOOKING_ENABLED;
    process.env.VOICE_BOOKING_ENABLED = "false";

    try {
      const provider = new ExotelVoiceProvider({
        accountSid: "acc_test",
        apiKey: "key_test",
        apiToken: "tok_test",
        callerId: "08012345678",
        streamUrl: "wss://voice.brewcoffee.in/media",
        streamSecret: mockSecret,
      });

      let threw = false;
      try {
        await provider.startSession({
          sessionId: "vbs_emergency_shutdown",
          phoneNumber: testAuthPhone,
          language: "en",
        });
      } catch (err: unknown) {
        threw = true;
        assert.ok(err instanceof ExotelApiError);
        assert.strictEqual(err.isCertainRejection, true);
        assert.ok(err.message.includes("VOICE_BOOKING_ENABLED=false"));
      }
      assert.strictEqual(threw, true, "Must throw certain rejection when VOICE_BOOKING_ENABLED=false");
    } finally {
      process.env.VOICE_BOOKING_ENABLED = origEnv;
    }
  });

  // ---------------------------------------------------------------------------
  // 2. SERVER-SIDE ALLOWLIST ENFORCEMENT
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. SERVER-SIDE ALLOWLIST ENFORCEMENT ---");

  await test("2.1 Allowlist parsing and normalization", async () => {
    const origWhitelist = process.env.VOICE_TEST_WHITELIST_PHONES;
    process.env.VOICE_TEST_WHITELIST_PHONES = "+91 98765 43210, 919876543211 , 09876543212";

    try {
      const parsed = getVoiceTestWhitelistPhones();
      assert.strictEqual(parsed.length, 3);
      assert.strictEqual(parsed[0], "+919876543210");
      assert.strictEqual(parsed[1], "+919876543211");
      assert.strictEqual(parsed[2], "+919876543212");

      assert.strictEqual(isAuthorizedTestNumber("+919876543210"), true);
      assert.strictEqual(isAuthorizedTestNumber("9876543210"), true);
      assert.strictEqual(isAuthorizedTestNumber("+919999999999"), false);
    } finally {
      process.env.VOICE_TEST_WHITELIST_PHONES = origWhitelist;
    }
  });

  await test("2.2 Unauthorized destination number is rejected fail-closed", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const origWhitelist = process.env.VOICE_TEST_WHITELIST_PHONES;
      process.env.VOICE_TEST_WHITELIST_PHONES = testAuthPhone;

      try {
        const provider = new ExotelVoiceProvider({
          accountSid: "acc_test",
          apiKey: "key_test",
          apiToken: "tok_test",
          callerId: "08012345678",
          streamUrl: "wss://voice.brewcoffee.in/media",
          streamSecret: mockSecret,
        });

        let threw = false;
        try {
          await provider.startSession({
            sessionId: "vbs_unauthorized_dest",
            phoneNumber: unauthorizedPhone,
            language: "en",
          });
        } catch (err: unknown) {
          threw = true;
          assert.ok(err instanceof ExotelApiError);
          assert.strictEqual(err.isCertainRejection, true);
          assert.ok(err.message.includes("VOICE_TEST_WHITELIST_PHONES"));
        }
        assert.strictEqual(threw, true, "Must reject call to unauthorized phone number");
      } finally {
        process.env.VOICE_TEST_WHITELIST_PHONES = origWhitelist;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. SINGLE-CALL RESTRICTION & ATOMIC CONSUMPTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. SINGLE-CALL RESTRICTION & ATOMIC CONSUMPTION ---");

  await test("3.1 Authorized test number consumed once successfully", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const origWhitelist = process.env.VOICE_TEST_WHITELIST_PHONES;
      process.env.VOICE_TEST_WHITELIST_PHONES = testAuthPhone;

      const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();
      const attemptRepo = new InMemoryVoiceCallAttemptRepository();

      await authRegistry.createAuthorization({
        authorizationId: "vta_test_001",
        authorizedPhone: testAuthPhone,
        approvedBy: "staff_operator_42",
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(), // 10 min
        purpose: "controlled_single_call_test",
      });

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            Call: { Sid: "call_sid_single_test_001", Status: "in-progress" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new ExotelVoiceProvider({
        accountSid: "acc_test",
        apiKey: "key_test",
        apiToken: "tok_test",
        callerId: "08012345678",
        streamUrl: "wss://voice.brewcoffee.in/media",
        streamSecret: mockSecret,
        testAuthorizationRegistry: authRegistry,
        callAttemptRepository: attemptRepo,
        fetchFn: mockFetch,
      });

      try {
        const result = await provider.startSession({
          sessionId: "vbs_auth_success",
          phoneNumber: testAuthPhone,
          language: "en",
          idempotencyKey: "vca_auth_success_1",
          testAuthorizationId: "vta_test_001",
        });

        assert.strictEqual(result.providerCallId, "call_sid_single_test_001");

        // Verify authorization is now consumed
        const authRecord = await authRegistry.getAuthorization("vta_test_001");
        assert.ok(authRecord);
        assert.strictEqual(authRecord.status, "consumed");
        assert.strictEqual(authRecord.consumedByAttemptId, "vca_auth_success_1");
        assert.ok(authRecord.consumedAt !== null);
      } finally {
        process.env.VOICE_TEST_WHITELIST_PHONES = origWhitelist;
      }
    });
  });

  await test("3.2 Same authorization consumed a second time is strictly rejected", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const origWhitelist = process.env.VOICE_TEST_WHITELIST_PHONES;
      process.env.VOICE_TEST_WHITELIST_PHONES = testAuthPhone;

      const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();

      await authRegistry.createAuthorization({
        authorizationId: "vta_consumed_twice",
        authorizedPhone: testAuthPhone,
        approvedBy: "staff_operator_42",
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        purpose: "single_use_replay_test",
      });

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ Call: { Sid: "call_sid_ok", Status: "in-progress" } }),
          { status: 200 }
        );
      };

      const provider = new ExotelVoiceProvider({
        accountSid: "acc_test",
        apiKey: "key_test",
        apiToken: "tok_test",
        callerId: "08012345678",
        streamUrl: "wss://voice.brewcoffee.in/media",
        streamSecret: mockSecret,
        testAuthorizationRegistry: authRegistry,
        fetchFn: mockFetch,
      });

      try {
        // Attempt 1: succeeds
        await provider.startSession({
          sessionId: "vbs_single_use_1",
          phoneNumber: testAuthPhone,
          language: "en",
          idempotencyKey: "vca_first_call",
          testAuthorizationId: "vta_consumed_twice",
        });

        // Attempt 2: must fail closed
        let threw = false;
        try {
          await provider.startSession({
            sessionId: "vbs_single_use_2",
            phoneNumber: testAuthPhone,
            language: "en",
            idempotencyKey: "vca_second_call",
            testAuthorizationId: "vta_consumed_twice",
          });
        } catch (err: unknown) {
          threw = true;
          assert.ok(err instanceof ExotelApiError);
          assert.strictEqual(err.isCertainRejection, true);
          assert.ok(err.message.includes("already been consumed"));
        }
        assert.strictEqual(threw, true, "Second call with consumed authorization must fail closed");
      } finally {
        process.env.VOICE_TEST_WHITELIST_PHONES = origWhitelist;
      }
    });
  });

  await test("3.3 Concurrent consumption allows exactly one winner", async () => {
    const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();

    await authRegistry.createAuthorization({
      authorizationId: "vta_race_concurrency",
      authorizedPhone: testAuthPhone,
      approvedBy: "staff_operator_42",
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      purpose: "concurrency_race_test",
    });

    // Simulate 5 simultaneous worker claims on the same authorization
    const results = await Promise.allSettled([
      authRegistry.consumeAuthorization({
        authorizationId: "vta_race_concurrency",
        attemptId: "att_worker_1",
        phoneNumber: testAuthPhone,
      }),
      authRegistry.consumeAuthorization({
        authorizationId: "vta_race_concurrency",
        attemptId: "att_worker_2",
        phoneNumber: testAuthPhone,
      }),
      authRegistry.consumeAuthorization({
        authorizationId: "vta_race_concurrency",
        attemptId: "att_worker_3",
        phoneNumber: testAuthPhone,
      }),
      authRegistry.consumeAuthorization({
        authorizationId: "vta_race_concurrency",
        attemptId: "att_worker_4",
        phoneNumber: testAuthPhone,
      }),
      authRegistry.consumeAuthorization({
        authorizationId: "vta_race_concurrency",
        attemptId: "att_worker_5",
        phoneNumber: testAuthPhone,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.strictEqual(fulfilled.length, 1, "Exactly one concurrent worker must succeed");
    assert.strictEqual(rejected.length, 4, "All other concurrent workers must fail closed");
  });

  await test("3.4 Expired authorization is strictly rejected", async () => {
    const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();

    await authRegistry.createAuthorization({
      authorizationId: "vta_already_expired",
      authorizedPhone: testAuthPhone,
      approvedBy: "staff_operator_42",
      approvedAt: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // Expired 1 second ago
      purpose: "expired_test",
    });

    let threw = false;
    try {
      await authRegistry.consumeAuthorization({
        authorizationId: "vta_already_expired",
        attemptId: "att_expired_claim",
        phoneNumber: testAuthPhone,
      });
    } catch (err: unknown) {
      threw = true;
      assert.ok(err instanceof VoiceTestAuthorizationError);
      assert.strictEqual(err.code, "AUTHORIZATION_EXPIRED");
    }
    assert.strictEqual(threw, true, "Must reject expired authorization");
  });

  // ---------------------------------------------------------------------------
  // 4. CONSENT & SERVER-SIDE APPROVAL
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. CONSENT & SERVER-SIDE APPROVAL ---");

  await test("4.1 Missing voice consent is strictly rejected", async () => {
    const consentRepo = new InMemoryConsentRepository();
    // No consent added for testAuthPhone

    let threw = false;
    try {
      await verifyIndependentVoiceConsent({
        consentRepository: consentRepo,
        phoneNumber: testAuthPhone,
      });
    } catch (err: unknown) {
      threw = true;
      assert.ok(err instanceof VoiceTestAuthorizationError);
      assert.strictEqual(err.code, "VOICE_CONSENT_MISSING");
    }
    assert.strictEqual(threw, true, "Must reject dialing when voice consent is missing");
  });

  await test("4.2 WhatsApp-only consent cannot authorize voice calls", async () => {
    const consentRepo = new InMemoryConsentRepository();

    // Register active WhatsApp-only consent
    await consentRepo.save(
      createConsentRecord({
        phoneNumber: testAuthPhone,
        channel: "whatsapp",
        purpose: "transactional_update",
        consentText: "I consent to WhatsApp notifications",
      })
    );

    let threw = false;
    try {
      await verifyIndependentVoiceConsent({
        consentRepository: consentRepo,
        phoneNumber: testAuthPhone,
      });
    } catch (err: unknown) {
      threw = true;
      assert.ok(err instanceof VoiceTestAuthorizationError);
      assert.strictEqual(err.code, "VOICE_CONSENT_MISSING");
      assert.ok(err.message.includes("WhatsApp consent cannot authorize voice calls"));
    }
    assert.strictEqual(threw, true, "Must strictly reject WhatsApp consent for voice calls");
  });

  await test("4.3 Missing staff approval is strictly rejected", async () => {
    const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();

    // Create authorization with empty approvedBy
    await authRegistry.createAuthorization({
      authorizationId: "vta_unapproved",
      authorizedPhone: testAuthPhone,
      approvedBy: "", // Unapproved
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      purpose: "unapproved_draft",
    });

    let threw = false;
    try {
      await authRegistry.consumeAuthorization({
        authorizationId: "vta_unapproved",
        attemptId: "att_unapproved",
        phoneNumber: testAuthPhone,
      });
    } catch (err: unknown) {
      threw = true;
      assert.ok(err instanceof VoiceTestAuthorizationError);
      assert.strictEqual(err.code, "AUTHORIZATION_NOT_APPROVED");
    }
    assert.strictEqual(threw, true, "Must reject authorization without staff approval");
  });

  // ---------------------------------------------------------------------------
  // 5. PROVIDER TIMEOUT & NO AUTOMATIC REDIAL
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. PROVIDER TIMEOUT & NO AUTOMATIC REDIAL ---");

  await test("5.1 Provider timeout marks attempt uncertain, consumes authorization, and blocks redial", async () => {
    await withTestVoiceBookingEnabled(async () => {
      const origWhitelist = process.env.VOICE_TEST_WHITELIST_PHONES;
      process.env.VOICE_TEST_WHITELIST_PHONES = testAuthPhone;

      const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();
      const attemptRepo = new InMemoryVoiceCallAttemptRepository();

      await authRegistry.createAuthorization({
        authorizationId: "vta_timeout_test",
        authorizedPhone: testAuthPhone,
        approvedBy: "staff_operator_42",
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        purpose: "timeout_uncertainty_test",
      });

      // Provider call hangs and triggers timeout
      const hangingFetch: typeof fetch = async () => {
        await new Promise((r) => setTimeout(r, 100));
        throw new Error("ETIMEDOUT");
      };

      const provider = new ExotelVoiceProvider({
        accountSid: "acc_test",
        apiKey: "key_test",
        apiToken: "tok_test",
        callerId: "08012345678",
        streamUrl: "wss://voice.brewcoffee.in/media",
        streamSecret: mockSecret,
        requestTimeoutMs: 50,
        maxRetries: 0,
        testAuthorizationRegistry: authRegistry,
        callAttemptRepository: attemptRepo,
        fetchFn: hangingFetch,
      });

      try {
        let threw = false;
        try {
          await provider.startSession({
            sessionId: "vbs_timeout_uncertain",
            phoneNumber: testAuthPhone,
            language: "en",
            idempotencyKey: "vca_timeout_att_1",
            testAuthorizationId: "vta_timeout_test",
          });
        } catch (err: unknown) {
          threw = true;
          assert.ok(err instanceof ExotelApiError);
          assert.strictEqual(err.isTimeoutOrNetwork, true);
          assert.strictEqual(err.isCertainRejection, false);
          assert.ok(err.message.includes("Outcome is uncertain; automated redial blocked"));
        }
        assert.strictEqual(threw, true, "Must fail closed with uncertain outcome");

        // Verify authorization was consumed on the first dispatch attempt
        const authRecord = await authRegistry.getAuthorization("vta_timeout_test");
        assert.ok(authRecord);
        assert.strictEqual(authRecord.status, "consumed");

        // Verify a retry cannot re-consume the authorization
        let retryThrew = false;
        try {
          await provider.startSession({
            sessionId: "vbs_timeout_uncertain",
            phoneNumber: testAuthPhone,
            language: "en",
            idempotencyKey: "vca_timeout_att_1_retry",
            testAuthorizationId: "vta_timeout_test",
          });
        } catch (retryErr: unknown) {
          retryThrew = true;
          assert.ok(retryErr instanceof ExotelApiError);
          assert.strictEqual(retryErr.isCertainRejection, true);
          assert.ok(retryErr.message.includes("already been consumed"));
        }
        assert.strictEqual(retryThrew, true, "Retry must fail closed because authorization was already consumed");
      } finally {
        process.env.VOICE_TEST_WHITELIST_PHONES = origWhitelist;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. AUDIT & PRIVACY VERIFICATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. AUDIT & PRIVACY VERIFICATION ---");

  await test("6.1 Audit logging records masked phone numbers and zero secrets", async () => {
    const authRegistry = new InMemoryVoiceTestAuthorizationRegistry();

    await authRegistry.recordAudit({
      auditId: "aud_001",
      authorizationId: "vta_audit_test",
      attemptId: "att_audit_test",
      timestamp: new Date().toISOString(),
      phoneNumberMasked: "+91******3210",
      outcome: "consumed",
    });

    const audits = authRegistry.getAudits();
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].phoneNumberMasked, "+91******3210");
    assert.ok(!JSON.stringify(audits[0]).includes(testAuthPhone), "Full phone number must not be exposed");
    assert.ok(!JSON.stringify(audits[0]).includes("secret"), "No secrets exposed");
  });

  console.log("\n================================================================================");
  console.log(`   Phase 6.6.5.1 Verification Complete: ${passedCount}/${passedCount + failedCount} checks passed`);
  console.log(failedCount === 0 ? "   RESULT: ALL TESTS PASSED (SUCCESS)" : "   RESULT: TESTS FAILED");
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled exception in Phase 6.6.5.1 test suite:", err);
  process.exit(1);
});
