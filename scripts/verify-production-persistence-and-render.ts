#!/usr/bin/env tsx
/**
 * BREW Coffee Platform — Production Persistence & Render Configuration Verification Suite
 *
 * Verifies:
 * 1. Production repository selection (strictly selects FirestoreVoiceSessionRepository).
 * 2. In-memory fallback prohibition in production.
 * 3. Fail-closed behavior on missing Firestore configuration.
 * 4. Concurrent update protection and transaction atomicity.
 * 5. Demo isolation (seeding disabled, aliases disabled, demo PINs rejected in production).
 * 6. Email configuration protection (personal/institutional fallbacks rejected).
 * 7. Telephony isolation ($0.00 guaranteed, paid services blocked).
 * 8. Environment variable validation (fail-closed, zero secret exposure).
 * 9. Health check behavior in production vs development.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import {
  getVoiceSessionRepository,
  setVoiceSessionRepository,
  createVoiceBookingSession,
} from "../src/lib/voiceBooking/conversationEngine";
import {
  FirestoreVoiceSessionRepository,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import {
  getConsentRepository,
  getDndRepository,
} from "../src/lib/communication/repositories/repositorySelector";
import { ensureDemoSessions } from "../src/lib/voiceBooking/demoData";
import {
  isVoicePrototypeMode,
  assertPrototypeSafetyGuard,
} from "../src/lib/voiceBooking/prototypeConfig";
import { getStaffPins, verifyStaffPin } from "../src/lib/authTokens";
import {
  createVanRequestRecordFromSession,
  computeOfficialVanRequestId,
} from "../src/lib/voiceBooking/vanRequestBridge";
import {
  generateVoiceBookingQuotation,
  createQuotationSnapshot,
} from "../src/lib/voiceBooking/quotationAdapter";
import {
  validateProductionEnvironment,
} from "../src/lib/envValidation";
import { GET as healthCheckGet } from "../src/app/api/health/route";
import { POST as vanRequestPost } from "../src/app/api/request-van/route";
import {
  StaffAuthorizationContext,
  VoiceBookingSession,
  VoiceSessionRepository,
} from "../src/lib/voiceBooking/types";

console.log("===============================================================================");
console.log("   BREW Coffee — Production Persistence & Render Verification Suite");
console.log("===============================================================================\n");

let passed = 0;
function recordPass(testName: string) {
  passed++;
  console.log(`  ✓ ${testName}`);
}

function setNodeEnv(val?: string) {
  const env = process.env as Record<string, string | undefined>;
  if (val === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = val;
  }
}

async function runVerification() {
  const originalEnv = { ...process.env };

  try {
    // -------------------------------------------------------------------------
    console.log("SUITE 1: Production Repository Selection & In-Memory Fallback Prohibition");
    // -------------------------------------------------------------------------
    {
      // 1.1 Non-production defaults to InMemoryVoiceSessionRepository
      setNodeEnv(undefined);
      delete process.env.VOICE_BOOKING_STORAGE;
      setVoiceSessionRepository(null);
      const devRepo = getVoiceSessionRepository();
      assert(
        devRepo instanceof InMemoryVoiceSessionRepository,
        "Dev environment without storage override must return InMemoryVoiceSessionRepository"
      );
      recordPass("1.1 Dev environment defaults to InMemoryVoiceSessionRepository");

      // 1.2 Production environment strictly selects FirestoreVoiceSessionRepository
      setNodeEnv("production");
      setVoiceSessionRepository(null);
      const prodRepo = getVoiceSessionRepository();
      assert(
        prodRepo instanceof FirestoreVoiceSessionRepository,
        "Production environment must strictly return FirestoreVoiceSessionRepository"
      );
      recordPass("1.2 Production environment strictly instantiates FirestoreVoiceSessionRepository");

      // 1.3 In-memory override attempt in production throws security error
      let inMemOverrideCaught = false;
      try {
        setVoiceSessionRepository(new InMemoryVoiceSessionRepository());
      } catch (err: unknown) {
        inMemOverrideCaught = true;
        assert(
          err instanceof Error && err.message.includes("In-memory repository override is strictly prohibited"),
          "Must throw explicit security violation when attempting to set InMemory repository in production"
        );
      }
      assert(inMemOverrideCaught, "In-memory repository override must be blocked in production");
      recordPass("1.3 Setting in-memory repository override in production throws Security Violation");

      // 1.4 Setting VOICE_BOOKING_STORAGE='memory' in production throws Configuration Error
      let memStorageCaught = false;
      try {
        process.env.VOICE_BOOKING_STORAGE = "memory";
        setVoiceSessionRepository(null);
        getVoiceSessionRepository();
      } catch (err: unknown) {
        memStorageCaught = true;
        assert(
          err instanceof Error && err.message.includes("VOICE_BOOKING_STORAGE cannot be set to 'memory' in production"),
          "Must throw configuration error when VOICE_BOOKING_STORAGE=memory in production"
        );
      }
      assert(memStorageCaught, "VOICE_BOOKING_STORAGE='memory' must be rejected in production");
      delete process.env.VOICE_BOOKING_STORAGE;
      recordPass("1.4 VOICE_BOOKING_STORAGE='memory' is strictly rejected in production");

      // 1.5 Communication repositories (Consent & DND) strictly select Firestore in production
      const consentRepo = getConsentRepository("auto");
      assert(
        consentRepo.constructor.name.includes("Firestore"),
        "Consent repository must select Firestore in production"
      );
      const dndRepo = getDndRepository("auto");
      assert(
        dndRepo.constructor.name.includes("Firestore"),
        "DND repository must select Firestore in production"
      );
      recordPass("1.5 Consent and DND repositories strictly select Firestore in production");

      // 1.6 Passing 'memory' mode to getConsentRepository in production throws Error
      let consentMemCaught = false;
      try {
        getConsentRepository("memory");
      } catch (err: unknown) {
        consentMemCaught = true;
        assert(
          err instanceof Error && err.message.includes("InMemoryConsentRepository is strictly prohibited in production"),
          "Must throw when requesting memory consent repo in production"
        );
      }
      assert(consentMemCaught, "InMemoryConsentRepository must be prohibited in production");
      recordPass("1.6 getConsentRepository('memory') throws error in production");

      // 1.7 Capability contract compliance
      const memRepoInstance = new InMemoryVoiceSessionRepository();
      assert.strictEqual(memRepoInstance.isDurable, false, "InMemoryVoiceSessionRepository must have isDurable === false");
      assert.strictEqual(memRepoInstance.storageType, "memory", "InMemoryVoiceSessionRepository must have storageType === 'memory'");
      const firestoreRepoInstance = new FirestoreVoiceSessionRepository(null);
      assert.strictEqual(firestoreRepoInstance.isDurable, true, "FirestoreVoiceSessionRepository must have isDurable === true");
      assert.strictEqual(firestoreRepoInstance.storageType, "firestore", "FirestoreVoiceSessionRepository must have storageType === 'firestore'");
      recordPass("1.7 Repository capability contracts verified (isDurable, storageType)");

      // 1.8 Subclass bypass attempt blocked in production
      setNodeEnv("production");
      class SubclassedInMemoryRepo extends InMemoryVoiceSessionRepository {}
      let subclassCaught = false;
      try {
        setVoiceSessionRepository(new SubclassedInMemoryRepo());
      } catch (err: unknown) {
        subclassCaught = true;
        assert(
          err instanceof Error && err.message.includes("In-memory repository override is strictly prohibited"),
          "Subclassed in-memory repo must be blocked by security check in production"
        );
      }
      assert(subclassCaught, "Subclassed in-memory repo must be blocked in production");
      recordPass("1.8 Subclass bypass attempt blocked in production");

      // 1.9 Duck-typed / wrapper bypass attempt blocked in production
      const fakeWrapper: VoiceSessionRepository = {
        isDurable: false,
        storageType: "memory",
        getById: async () => null,
        save: async () => {},
        saveWithOutbox: async () => {},
        getByPhoneNumber: async () => null,
        atomicApproveBooking: async () => ({ success: false, error: "invalid_state" }),
      };
      let wrapperCaught = false;
      try {
        setVoiceSessionRepository(fakeWrapper);
      } catch (err: unknown) {
        wrapperCaught = true;
        assert(
          err instanceof Error && err.message.includes("In-memory repository override is strictly prohibited"),
          "Duck-typed in-memory repo must be blocked by security check in production"
        );
      }
      assert(wrapperCaught, "Duck-typed in-memory wrapper must be blocked in production");
      recordPass("1.9 Duck-typed wrapper bypass attempt blocked in production");

      // 1.10 Pre-set in-memory repo blocked on retrieval in production
      setNodeEnv(undefined); // dev
      setVoiceSessionRepository(memRepoInstance); // allowed in dev
      setNodeEnv("production"); // switched to prod
      let retrievalCaught = false;
      try {
        getVoiceSessionRepository();
      } catch (err: unknown) {
        retrievalCaught = true;
        assert(
          err instanceof Error && err.message.includes("In-memory repository override is strictly prohibited"),
          "getVoiceSessionRepository must reject in-memory override when active in production"
        );
      }
      assert(retrievalCaught, "Pre-set in-memory repo must be rejected on retrieval in production");
      setVoiceSessionRepository(null);
      recordPass("1.10 Pre-set in-memory repository rejected on getVoiceSessionRepository() in production");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 2: Fail-Closed Firestore Operations on Missing Configuration");
    // -------------------------------------------------------------------------
    {
      // 2.1 Unconfigured Firestore database access fails closed without silent in-memory fallback
      const unconfiguredRepo = new FirestoreVoiceSessionRepository(null);
      let caughtUnconfigured = false;
      try {
        await unconfiguredRepo.getById("vbs_prod_test_01");
      } catch (err: unknown) {
        caughtUnconfigured = true;
        assert(
          err instanceof Error && err.message.includes("In-memory fallback is prohibited"),
          "Must explicitly throw that in-memory fallback is prohibited"
        );
      }
      assert(caughtUnconfigured, "Unconfigured Firestore must fail closed");
      recordPass("2.1 Unconfigured Firestore access fails closed with explicit error");

      // 2.2 Unconfigured save operation fails closed
      let caughtSave = false;
      try {
        const dummySession = createVoiceBookingSession("+919876543210", "en");
        await unconfiguredRepo.save(dummySession);
      } catch (err: unknown) {
        caughtSave = true;
        assert(
          err instanceof Error && err.message.includes("In-memory fallback is prohibited"),
          "Save must fail closed when Firestore is unconfigured"
        );
      }
      assert(caughtSave, "Unconfigured save must fail closed");
      recordPass("2.2 Unconfigured Firestore save fails closed");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 3: Demo Data Isolation in Production");
    // -------------------------------------------------------------------------
    {
      // 3.1 ensureDemoSessions returns [] immediately when NODE_ENV === 'production'
      setNodeEnv("production");
      const dummyMemoryRepo = new InMemoryVoiceSessionRepository();
      const seeded = await ensureDemoSessions(dummyMemoryRepo);
      assert.strictEqual(seeded.length, 0, "ensureDemoSessions must return empty array in production");
      assert.strictEqual(
        (await dummyMemoryRepo.getAllSessions()).length,
        0,
        "No sessions should be seeded into repository in production"
      );
      recordPass("3.1 ensureDemoSessions returns empty array and skips seeding in production");

      // 3.2 Staff demo PINs ('2026', '7788') are blocked in production
      delete process.env.BREW_TEST_SUITE;
      delete process.env.PLAYWRIGHT_TEST;
      delete process.env.BARISTA_PIN;
      delete process.env.FLEET_ADMIN_PIN;

      const prodPins = getStaffPins();
      assert.strictEqual(prodPins.baristaPin, "", "Barista PIN must be blanked out in prod if unrotated");
      assert.strictEqual(prodPins.fleetAdminPin, "", "Fleet Admin PIN must be blanked out in prod if unrotated");
      assert.strictEqual(verifyStaffPin("2026", prodPins.baristaPin), false, "PIN '2026' must be rejected");
      assert.strictEqual(verifyStaffPin("7788", prodPins.fleetAdminPin), false, "PIN '7788' must be rejected");
      recordPass("3.2 Demo PINs '2026' and '7788' are rejected in production");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 4: Email Configuration & Fallback Protection");
    // -------------------------------------------------------------------------
    {
      // 4.1 vanRequestBridge rejects personal/institutional email fallbacks in production
      setNodeEnv("production");
      delete process.env.BUSINESS_EMAIL;
      delete process.env.NEXT_PUBLIC_BUSINESS_EMAIL;

      const testSession = createVoiceBookingSession("+919876543210", "en");
      testSession.requirements = {
        guestCount: 50,
        eventDate: "2026-12-20",
        startTime: "10:00",
        durationHours: 3,
        venueAddress: "Jubilee Hills, Hyderabad",
        eventType: "corporate",
        beveragePreferences: [],
        selectedTier: "BASIC",
        customerConfirmed: true,
        handoffRequested: false,
        confidenceScore: 0.95,
        missingFields: [],
        unresolvedQuestions: [],
      };
      testSession.quotation = generateVoiceBookingQuotation(testSession.requirements);

      let emailCaught = false;
      try {
        createVanRequestRecordFromSession(testSession, "pending");
      } catch (err: unknown) {
        emailCaught = true;
        assert(
          err instanceof Error && err.message.includes("BUSINESS_EMAIL environment variable is required"),
          "Must reject missing BUSINESS_EMAIL in production without silent prototype fallback"
        );
      }
      assert(emailCaught, "vanRequestBridge must fail closed if BUSINESS_EMAIL is missing in production");
      recordPass("4.1 Missing BUSINESS_EMAIL in production fails closed without fallback");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 5: Telephony & External Paid Service Isolation");
    // -------------------------------------------------------------------------
    {
      // 5.1 isVoicePrototypeMode() is active with VOICE_BOOKING_ENABLED='false'
      process.env.VOICE_BOOKING_ENABLED = "false";
      assert.strictEqual(isVoicePrototypeMode(), true, "isVoicePrototypeMode must be true when telephony is disabled");
      recordPass("5.1 isVoicePrototypeMode() remains true when real telephony is disabled");

      // 5.2 assertPrototypeSafetyGuard throws on paid service invocation
      let exotelCaught = false;
      try {
        assertPrototypeSafetyGuard("exotel");
      } catch (err: unknown) {
        exotelCaught = true;
        assert(
          err instanceof Error && err.message.includes("paid service 'exotel'"),
          "Must throw when attempting to invoke exotel in prototype mode"
        );
      }
      assert(exotelCaught, "Exotel call must be blocked by safety guard");

      let azureCaught = false;
      try {
        assertPrototypeSafetyGuard("azure_speech");
      } catch (err: unknown) {
        azureCaught = true;
        assert(
          err instanceof Error && err.message.includes("paid service 'azure_speech'"),
          "Must throw when attempting to invoke azure_speech in prototype mode"
        );
      }
      assert(azureCaught, "Azure speech call must be blocked by safety guard");
      recordPass("5.2 Prototype safety guards block Exotel carrier dialing and Azure speech");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 6: Production Environment Validator & Zero Secret Leakage");
    // -------------------------------------------------------------------------
    {
      // 6.1 Missing required variables in production are accurately detected
      setNodeEnv("production");
      delete process.env.AUTH_SECRET;
      delete process.env.QUOTATION_SNAPSHOT_SECRET;
      delete process.env.BARISTA_PIN;
      delete process.env.FLEET_ADMIN_PIN;
      delete process.env.OUTBOX_WORKER_SECRET;
      delete process.env.FIREBASE_SERVICE_ACCOUNT;
      delete process.env.FIREBASE_PROJECT_ID;
      delete process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PRIVATE_KEY;
      delete process.env.BUSINESS_EMAIL;
      delete process.env.NEXT_PUBLIC_BUSINESS_EMAIL;

      const report = validateProductionEnvironment();
      assert.strictEqual(report.valid, false, "Validation must report invalid when vars are missing");
      assert.strictEqual(report.isProduction, true, "isProduction must be true");
      assert(report.missingVariables.includes("AUTH_SECRET"), "AUTH_SECRET should be reported missing");
      assert(report.missingVariables.includes("QUOTATION_SNAPSHOT_SECRET"), "QUOTATION_SNAPSHOT_SECRET should be missing");
      assert(report.missingVariables.includes("BARISTA_PIN"), "BARISTA_PIN should be missing");
      assert(report.missingVariables.includes("FLEET_ADMIN_PIN"), "FLEET_ADMIN_PIN should be missing");
      assert(report.missingVariables.includes("OUTBOX_WORKER_SECRET"), "OUTBOX_WORKER_SECRET should be missing");
      assert(report.missingVariables.includes("BUSINESS_EMAIL"), "BUSINESS_EMAIL should be missing");
      recordPass("6.1 Production validator detects missing variables");

      // 6.2 Validator detects insecure default passwords/PINs
      process.env.AUTH_SECRET = "brew-platform-secure-jwt-hmac-secret-key-2026";
      process.env.QUOTATION_SNAPSHOT_SECRET = "brew-test-quotation-secret-32-chars-long!";
      process.env.BARISTA_PIN = "2026";
      process.env.FLEET_ADMIN_PIN = "7788";
      process.env.OUTBOX_WORKER_SECRET = "short"; // < 16 chars
      process.env.BUSINESS_EMAIL = "invalid-email-format";
      process.env.NEXT_PUBLIC_BUSINESS_EMAIL = "catering@brewcoffee.in";

      const insecureReport = validateProductionEnvironment();
      assert.strictEqual(insecureReport.valid, false, "Insecure defaults must fail validation");
      const reasons = insecureReport.invalidVariables.map((v) => `${v.name}:${v.reason}`);
      assert(reasons.includes("AUTH_SECRET:prohibited_default"), "AUTH_SECRET prohibited default detected");
      assert(reasons.includes("QUOTATION_SNAPSHOT_SECRET:prohibited_default"), "QUOTATION_SNAPSHOT_SECRET prohibited default detected");
      assert(reasons.includes("BARISTA_PIN:prohibited_default"), "BARISTA_PIN prohibited default detected");
      assert(reasons.includes("FLEET_ADMIN_PIN:prohibited_default"), "FLEET_ADMIN_PIN prohibited default detected");
      assert(reasons.includes("OUTBOX_WORKER_SECRET:insufficient_length"), "OUTBOX_WORKER_SECRET insufficient length detected");
      assert(reasons.includes("BUSINESS_EMAIL:invalid_format"), "BUSINESS_EMAIL invalid format detected");
      recordPass("6.2 Production validator detects prohibited defaults, short secrets, and invalid emails");

      // 6.3 Zero Secret Exposure Guarantee: Error messages NEVER contain secret strings
      const errorDump = insecureReport.errors.join("\n");
      assert(!errorDump.includes("2026"), "Secret PIN '2026' must not appear in error messages");
      assert(!errorDump.includes("7788"), "Secret PIN '7788' must not appear in error messages");
      assert(!errorDump.includes("brew-platform-secure"), "Auth secret text must not appear in error messages");
      assert(!errorDump.includes("brew-test-quotation"), "Quotation secret text must not appear in error messages");
      recordPass("6.3 Zero-Secret Exposure: Error messages refer only to variable names, never secret values");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 7: Health Endpoint Behavior in Production vs Development");
    // -------------------------------------------------------------------------
    {
      // 7.1 In production with missing Firestore, /api/health returns status 503
      setNodeEnv("production");
      delete process.env.FIREBASE_SERVICE_ACCOUNT;
      delete process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PRIVATE_KEY;

      const prodRes = await healthCheckGet(new NextRequest("http://localhost/api/health?strict=true"));
      assert.strictEqual(prodRes.status, 503, "Production healthcheck without Firestore must return 503");
      const prodJson = await prodRes.json();
      assert.strictEqual(prodJson.status, "degraded", "Status must be degraded");
      assert.strictEqual(prodJson.checks.configuration.status, "unhealthy", "Configuration check must be unhealthy");
      recordPass("7.1 Production /api/health returns 503 degraded when Firestore is unconfigured");

      // 7.2 In development environment, /api/health returns status 200
      setNodeEnv(undefined);
      const devRes = await healthCheckGet();
      assert.strictEqual(devRes.status, 200, "Development healthcheck must return 200");
      const devJson = await devRes.json();
      assert.strictEqual(devJson.status, "healthy", "Status must be healthy in dev");
      recordPass("7.2 Development /api/health returns 200 healthy");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 8: Production Filesystem Write Prohibition");
    // -------------------------------------------------------------------------
    {
      setNodeEnv("production");
      process.env.BUSINESS_EMAIL = "catering@brewcoffee.in";
      process.env.NEXT_PUBLIC_BUSINESS_EMAIL = "catering@brewcoffee.in";
      delete process.env.ALLOW_LOCAL_FALLBACK;
      // Ensure Firestore admin is unconfigured so cloud write fails
      delete process.env.FIREBASE_SERVICE_ACCOUNT;
      delete process.env.FIREBASE_PROJECT_ID;
      delete process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PRIVATE_KEY;

      const vanRequestsPath = path.join(process.cwd(), "src/data/van_requests.json");
      const idempotencyPath = path.join(process.cwd(), "src/data/idempotency_records.json");
      const vanReqMtimeBefore = fs.existsSync(vanRequestsPath) ? fs.statSync(vanRequestsPath).mtimeMs : null;
      const idempMtimeBefore = fs.existsSync(idempotencyPath) ? fs.statSync(idempotencyPath).mtimeMs : null;

      const fakeReq = new NextRequest("http://localhost:3000/api/request-van", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact: "test@brewcoffee.in",
          organization: "Prod Test Corp",
          location: "Banjara Hills, Hyderabad",
          eventDate: "2026-12-25",
          crowdSize: 50,
          idempotencyKey: "prod_fs_test_key_001",
        }),
      });

      const res = await vanRequestPost(fakeReq);
      assert.strictEqual(res.status, 503, "Production van request without cloud persistence must return 503");

      const vanReqMtimeAfter = fs.existsSync(vanRequestsPath) ? fs.statSync(vanRequestsPath).mtimeMs : null;
      const idempMtimeAfter = fs.existsSync(idempotencyPath) ? fs.statSync(idempotencyPath).mtimeMs : null;

      assert.strictEqual(vanReqMtimeAfter, vanReqMtimeBefore, "van_requests.json must not be modified in production");
      assert.strictEqual(idempMtimeAfter, idempMtimeBefore, "idempotency_records.json must not be modified in production");
      recordPass("8.1 Production request-van fails closed (503) without touching local filesystem");
    }

    // -------------------------------------------------------------------------
    console.log("\nSUITE 9: Atomic Booking Concurrency & Transaction Integrity");
    // -------------------------------------------------------------------------
    {
      const memRepo = new InMemoryVoiceSessionRepository();
      const testSession = createVoiceBookingSession("+919876543210", "en");
      testSession.requirements = {
        guestCount: 60,
        eventDate: "2026-12-28",
        startTime: "11:00",
        durationHours: 3,
        venueAddress: "HITEC City, Hyderabad",
        eventType: "corporate",
        beveragePreferences: [],
        selectedTier: "PREMIUM",
        customerConfirmed: true,
        handoffRequested: false,
        confidenceScore: 0.95,
        missingFields: [],
        unresolvedQuestions: [],
      };
      testSession.quotation = generateVoiceBookingQuotation(testSession.requirements, testSession.id);
      testSession.quotationSnapshot = createQuotationSnapshot(testSession.requirements);
      const expectedVanId = computeOfficialVanRequestId(testSession.id);
      testSession.officialBookingId = expectedVanId;
      testSession.metadata = { ...(testSession.metadata || {}), officialBookingId: expectedVanId };
      testSession.state = "awaiting_staff_approval";
      await memRepo.save(testSession);

      const validAuth: StaffAuthorizationContext = {
        staffIdentity: "Barista Lead Arjun",
        staffRole: "barista",
        staffApprovalId: "appr_test_001",
      };

      const sampleTransition = (session: VoiceBookingSession, auth: StaffAuthorizationContext) => {
        session.state = "booking_confirmed";
        session.staffApprovalId = auth.staffApprovalId;
        session.staffApprovalAudit = {
          staffIdentity: auth.staffIdentity,
          staffRole: auth.staffRole as "barista" | "fleet_admin" | "admin",
          staffApprovalId: auth.staffApprovalId,
          approvedAt: new Date().toISOString(),
          sessionId: session.id,
        };
        return session;
      };

      // 9.1 Test concurrent approval race condition: 10 concurrent calls
      const approvalPromises = Array.from({ length: 10 }, () =>
        memRepo.atomicApproveBooking(testSession.id, validAuth, sampleTransition)
      );

      const results = await Promise.all(approvalPromises);
      const successes = results.filter((r) => r.success);
      const conflicts = results.filter((r) => !r.success && r.error === "already_approved");

      assert.strictEqual(successes.length, 1, "Exactly one approval must succeed out of 10 concurrent attempts");
      assert.strictEqual(conflicts.length, 9, "Remaining 9 concurrent attempts must be rejected with already_approved");
      recordPass("9.1 Concurrency mutex: Exactly 1 of 10 concurrent approvals succeeds, 9 fail with already_approved");

      // 9.2 Verify atomic multi-document persistence
      const officialBooking = await memRepo.getOfficialBooking?.(computeOfficialVanRequestId(testSession.id));
      assert(officialBooking !== undefined && officialBooking !== null, "Official van request record must be created atomically");
      assert.strictEqual(officialBooking?.status, "confirmed", "Official van request must be confirmed");

      const outbox = (await memRepo.getOutboxDeliveries?.(testSession.id)) || [];
      assert(outbox.length > 0, "Communication outbox records must be staged atomically");
      recordPass("9.2 Atomic multi-document persistence verified (session + official van request + outbox)");
    }

    console.log("\n===============================================================================");
    console.log(`   Verification Complete: All ${passed} checks passed successfully!`);
    console.log("===============================================================================\n");
  } finally {
    // Restore original environment
    process.env = originalEnv;
    setVoiceSessionRepository(null);
  }
}

runVerification().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
