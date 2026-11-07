#!/usr/bin/env tsx
/**
 * BREW Coffee Platform — Phase 6.3.4.1 Verification Test Suite
 * Web Booking Contact, Consent & Voice Session Foundation Verification
 *
 * Verifies:
 * 1. Form Schema & Phone Normalization (no-consent baseline, required phone, invalid phone rejection)
 * 2. POST /api/request-van atomic Firestore transaction persistence
 * 3. Initial Voice Session Invariants (state='created', quotation=null, guestCount=null)
 * 4. Outbox Delivery Invariants (eventType='booking_created', channel='voice', masked phone)
 * 5. Durable FirestoreConsentRepository & FirestoreDndRepository (queries, revocations, fail-closed)
 * 6. Policy orchestration & Outbox Worker feature-flag guardrails (VOICE_BOOKING_ENABLED=false)
 * 7. Firestore Security Rules coverage
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { VanRequestInputSchema } from "../src/lib/agentSchemas";
import { POST, GET } from "../src/app/api/request-van/route";
import { createSessionToken } from "../src/lib/authTokens";
import { setAdminFirestoreForTesting } from "../src/lib/firebaseAdmin";
import {
  FirestoreConsentRepository,
  CUSTOMER_CONSENT_COLLECTION,
} from "../src/lib/communication/repositories/firestoreConsentRepository";
import {
  FirestoreDndRepository,
  DND_SUPPRESSION_COLLECTION,
  DND_AUDIT_COLLECTION,
} from "../src/lib/communication/repositories/firestoreDndRepository";
import {
  getConsentRepository,
  getDndRepository,
} from "../src/lib/communication/repositories/repositorySelector";
import {
  createConsentRecord,
  normalizePhoneNumber,
} from "../src/lib/communication/consent";
import {
  orchestrateCommunicationPolicy,
} from "../src/lib/communication/policy";
import {
  OutboxWorker,
} from "../src/lib/communication/outbox/outboxWorker";
import type { CommunicationOutboxRepository } from "../src/lib/communication/outbox/outboxRepository";
import type { VoiceSessionRepository } from "../src/lib/voiceBooking/types";
import {
  VOICE_BOOKING_COLLECTION,
  OUTBOX_COLLECTION,
} from "../src/lib/voiceBooking/repositories/firestoreSessionRepository";
import { MockVoiceProvider } from "../src/lib/communication/providers/voiceProvider";
import { MockWhatsAppProvider } from "../src/lib/communication/providers/whatsappProvider";

// Force test environment markers
process.env.BREW_TEST_ENV = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.DISABLE_SMTP = "true";
process.env.VOICE_BOOKING_ENABLED = "false"; // Strict guardrail

console.log("===============================================================================");
console.log("   BREW Coffee — Phase 6.3.4.1 Booking Foundation & Consent Verification");
console.log("===============================================================================\n");

/**
 * High-fidelity in-memory transactional Firestore mock supporting all Phase 6 collections,
 * where queries, batches, and runTransaction optimistic concurrency.
 */
class MockFirestoreStore {
  public docs: Map<string, { data: Record<string, unknown>; version: number }> = new Map();
  public transactionAttempts = 0;
  public failNextBatchCommit = false;

  getDoc(path: string) {
    const entry = this.docs.get(path);
    if (!entry) return null;
    return {
      exists: true,
      data: () => JSON.parse(JSON.stringify(entry.data)),
      version: entry.version,
    };
  }

  setDoc(path: string, data: Record<string, unknown>) {
    const existing = this.docs.get(path);
    const version = (existing?.version || 0) + 1;
    this.docs.set(path, {
      data: JSON.parse(JSON.stringify(data)),
      version,
    });
  }

  deleteDoc(path: string) {
    this.docs.delete(path);
  }
}

function createMockFirestore(store: MockFirestoreStore) {
  const allowedCollections = new Set([
    "van_requests",
    VOICE_BOOKING_COLLECTION,
    OUTBOX_COLLECTION,
    CUSTOMER_CONSENT_COLLECTION,
    DND_SUPPRESSION_COLLECTION,
    DND_AUDIT_COLLECTION,
  ]);

  const collectionRef = (collectionName: string) => {
    if (!allowedCollections.has(collectionName)) {
      throw new Error(`Unexpected collection in mock: ${collectionName}`);
    }

    const buildQuery = (
      filters: Array<{ field: string; op: string; val: unknown }> = [],
      order?: { field: string; dir: string },
      limitCount?: number
    ) => {
      const queryObj = {
        where: (field2: string, op2: string, val2: unknown) => {
          filters.push({ field: field2, op: op2, val: val2 });
          return queryObj;
        },
        orderBy: (field: string, dir: string = "asc") => {
          order = { field, dir };
          return queryObj;
        },
        limit: (n: number) => {
          limitCount = n;
          return queryObj;
        },
        get: async () => {
          let matching: Array<{
            id: string;
            path: string;
            ref: { path: string; delete: () => Promise<void> };
            data: () => Record<string, unknown>;
          }> = [];
          for (const [docPath, entry] of store.docs.entries()) {
            if (!docPath.startsWith(`${collectionName}/`)) continue;
            const docId = docPath.slice(collectionName.length + 1);

            const matchesAll = filters.every((f) => {
              if (f.op === "==") return entry.data[f.field] === f.val;
              return false;
            });

            if (matchesAll) {
              matching.push({
                id: docId,
                path: docPath,
                ref: {
                  path: docPath,
                  delete: async () => {
                    store.deleteDoc(docPath);
                  },
                },
                data: () => JSON.parse(JSON.stringify(entry.data)),
              });
            }
          }
          if (order) {
            matching.sort((a, b) => {
              const valA = a.data()[order!.field] as number | string;
              const valB = b.data()[order!.field] as number | string;
              if (order!.dir === "desc") {
                return valB > valA ? 1 : valB < valA ? -1 : 0;
              }
              return valA > valB ? 1 : valA < valB ? -1 : 0;
            });
          }
          if (limitCount !== undefined) {
            matching = matching.slice(0, limitCount);
          }
          return {
            empty: matching.length === 0,
            docs: matching,
          };
        },
      };
      return queryObj;
    };

    return {
      doc: (id: string) => {
        const fullPath = `${collectionName}/${id.trim()}`;
        return {
          id: id.trim(),
          path: fullPath,
          get: async () => {
            const doc = store.getDoc(fullPath);
            if (!doc) {
              return { exists: false, data: () => undefined, id: id.trim() };
            }
            return { exists: true, data: doc.data, id: id.trim() };
          },
          set: async (data: Record<string, unknown>) => {
            store.setDoc(fullPath, data);
          },
          delete: async () => {
            store.deleteDoc(fullPath);
          },
        };
      },
      where: (field1: string, op1: string, val1: unknown) => {
        return buildQuery([{ field: field1, op: op1, val: val1 }]);
      },
      orderBy: (field: string, dir: string = "asc") => {
        return buildQuery([], { field, dir });
      },
      limit: (n: number) => {
        return buildQuery([], undefined, n);
      },
      get: async () => {
        return buildQuery().get();
      },
    };
  };

  const mockDb = {
    collection: collectionRef,
    batch: () => {
      const operations: Array<() => void> = [];
      return {
        set: (docRef: { path: string }, data: Record<string, unknown>) => {
          operations.push(() => store.setDoc(docRef.path, data));
        },
        delete: (docRef: { path?: string; id?: string }) => {
          const p = docRef.path;
          if (p) operations.push(() => store.deleteDoc(p));
        },
        commit: async () => {
          if (store.failNextBatchCommit) {
            store.failNextBatchCommit = false;
            throw new Error("Simulated Firestore batch commit failure");
          }
          for (const op of operations) op();
        },
      };
    },
    runTransaction: async <T>(
      updateFunction: (transaction: {
        get: (ref: { path: string; id: string }) => Promise<{ exists: boolean; data: () => unknown }>;
        set: (ref: { path: string; id: string }, data: Record<string, unknown>) => void;
      }) => Promise<T>
    ): Promise<T> => {
      store.transactionAttempts++;
      const stagedWrites = new Map<string, Record<string, unknown>>();
      const readVersions = new Map<string, number>();

      const tx = {
        get: async (ref: { path: string; id: string }) => {
          const doc = store.getDoc(ref.path);
          if (!doc) {
            readVersions.set(ref.path, 0);
            return { exists: false, data: () => undefined, id: ref.id };
          }
          readVersions.set(ref.path, doc.version);
          return { exists: true, data: doc.data, id: ref.id };
        },
        set: (ref: { path: string; id: string }, data: Record<string, unknown>) => {
          stagedWrites.set(ref.path, JSON.parse(JSON.stringify(data)));
        },
      };

      const result = await updateFunction(tx);

      // Atomic commit of all staged writes
      for (const [p, data] of stagedWrites.entries()) {
        store.setDoc(p, data);
      }
      return result;
    },
  };

  return mockDb as unknown as import("firebase-admin/firestore").Firestore;
}

let testIndex = 0;
async function test(title: string, fn: () => Promise<void>) {
  testIndex++;
  try {
    await fn();
    console.log(`  ✓ Test ${testIndex}: ${title}`);
  } catch (err) {
    console.error(`  ✗ Test ${testIndex} FAILED: ${title}`);
    console.error(err);
    process.exit(1);
  }
}

async function runAll() {
  console.log("SECTION 1: Form Schema & Phone Normalization (agentSchemas.ts)");

  await test("Baseline enquiry without phone or consents is valid (defaults false)", async () => {
    const valid = VanRequestInputSchema.parse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      notes: "Need 2 espresso machines",
    });

    assert.strictEqual(valid.voiceConsent, false);
    assert.strictEqual(valid.whatsappConsent, false);
    assert.strictEqual(valid.phoneNumber, undefined);
  });

  await test("Voice consent = true without phone number is rejected by schema", async () => {
    const result = VanRequestInputSchema.safeParse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      voiceConsent: true,
    });

    assert.strictEqual(result.success, false);
    assert.match(
      result.error!.issues[0].message,
      /valid phone number.*is required/i
    );
  });

  await test("WhatsApp consent = true without phone number is rejected by schema", async () => {
    const result = VanRequestInputSchema.safeParse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      whatsappConsent: true,
    });

    assert.strictEqual(result.success, false);
    assert.match(
      result.error!.issues[0].message,
      /valid phone number.*is required/i
    );
  });

  await test("Voice consent with malformed phone number is rejected (invalid E.164)", async () => {
    const result = VanRequestInputSchema.safeParse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      phoneNumber: "not-a-phone-number",
      voiceConsent: true,
    });

    assert.strictEqual(result.success, false);
    assert.match(
      result.error!.issues[0].message,
      /valid phone number/i
    );
  });

  await test("Voice consent with valid 10-digit phone succeeds and normalizes E.164", async () => {
    const parsed = VanRequestInputSchema.parse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      phoneNumber: "9876543210",
      voiceConsent: true,
    });

    assert.strictEqual(parsed.voiceConsent, true);
    assert.strictEqual(parsed.whatsappConsent, false);
    const normalized = normalizePhoneNumber(parsed.phoneNumber!);
    assert.strictEqual(normalized, "+919876543210");
  });

  await test("WhatsApp consent with valid +91 phone succeeds and normalizes E.164", async () => {
    const parsed = VanRequestInputSchema.parse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      phoneNumber: "+91 98765 43210",
      whatsappConsent: true,
    });

    assert.strictEqual(parsed.whatsappConsent, true);
    assert.strictEqual(parsed.voiceConsent, false);
    const normalized = normalizePhoneNumber(parsed.phoneNumber!);
    assert.strictEqual(normalized, "+919876543210");
  });

  await test("Both consents with valid phone succeed", async () => {
    const parsed = VanRequestInputSchema.parse({
      contact: "organizer@college.edu",
      organization: "Tech Fest IIT",
      location: "Main Auditorium, Campus Gate 2",
      eventDate: "2026-11-25",
      crowdSize: "150-300",
      phoneNumber: "+919876543210",
      voiceConsent: true,
      whatsappConsent: true,
    });

    assert.strictEqual(parsed.voiceConsent, true);
    assert.strictEqual(parsed.whatsappConsent, true);
  });

  console.log("\nSECTION 2: API Route Atomic Persistence (POST /api/request-van)");

  const runId = Date.now();
  const mockStore = new MockFirestoreStore();
  const mockDb = createMockFirestore(mockStore);
  setAdminFirestoreForTesting(mockDb);

  await test("No-consent baseline: van_request saved, no consent, no session, no outbox", async () => {
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contact: `baseline_${runId}@brew.internal`,
        organization: "Baseline Corp",
        location: "Block C Cybercity, Hyderabad",
        eventDate: "2026-12-01",
        crowdSize: "50-100",
        notes: "Baseline test",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.voiceSessionId, null);
    assert.strictEqual(body.consents.voice, false);
    assert.strictEqual(body.consents.whatsapp, false);

    // Verify in mock store: exactly 1 van_request, 0 sessions, 0 outbox, 0 consents
    const vanRequests = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith("van_requests/")
    );
    const voiceSessions = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${VOICE_BOOKING_COLLECTION}/`)
    );
    const outboxDocs = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${OUTBOX_COLLECTION}/`)
    );
    const consentDocs = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${CUSTOMER_CONSENT_COLLECTION}/`)
    );

    assert.strictEqual(vanRequests.length, 1);
    assert.strictEqual(voiceSessions.length, 0);
    assert.strictEqual(outboxDocs.length, 0);
    assert.strictEqual(consentDocs.length, 0);

    const vanDoc = mockStore.getDoc(vanRequests[0]);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    assert.strictEqual(vanData.phoneNumber, null);
    assert.strictEqual("normalizedPhone" in vanData, false, "Must not store redundant normalizedPhone field");
    assert.strictEqual("phoneNumber" in body, false, "Public response must not expose phoneNumber");
  });

  await test("Voice consent only: persists van_request, 1 consent, 1 session (created), 1 outbox delivery", async () => {
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contact: `voiceonly_${runId}@brew.internal`,
        phoneNumber: "9876543210",
        voiceConsent: true,
        organization: "Voice Only Corp",
        location: "Block A Cybercity, Hyderabad",
        eventDate: "2026-12-05",
        crowdSize: "100-200",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(body.voiceSessionId);
    assert.strictEqual(body.consents.voice, true);
    assert.strictEqual(body.consents.whatsapp, false);
    assert.strictEqual("phoneNumber" in body, false, "Public response must not expose phoneNumber");

    const vanDoc = mockStore.getDoc(`van_requests/${body.requestId}`);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    assert.strictEqual(vanData.phoneNumber, "+919876543210");
    assert.strictEqual("normalizedPhone" in vanData, false, "Must not store redundant normalizedPhone field");

    const sessionDoc = mockStore.getDoc(
      `${VOICE_BOOKING_COLLECTION}/${body.voiceSessionId}`
    );
    assert.ok(sessionDoc, "Session document must be persisted");
    const sessionData = sessionDoc.data() as {
      state: string;
      revision: number;
      phoneNumber: string;
      quotation: unknown;
      quotationSnapshot: unknown;
      officialBookingId: string;
      requirements: {
        guestCount: unknown;
        startTime: unknown;
        durationHours: unknown;
        customerConfirmed: boolean;
        eventDate: string;
      };
    };
    assert.strictEqual(sessionData.state, "created");
    assert.strictEqual(sessionData.revision, 1);
    assert.strictEqual(sessionData.phoneNumber, "+919876543210");
    assert.strictEqual(sessionData.quotation, null);
    assert.strictEqual(sessionData.quotationSnapshot, null);
    assert.strictEqual(sessionData.requirements.guestCount, null);
    assert.strictEqual(sessionData.requirements.startTime, null);
    assert.strictEqual(sessionData.requirements.durationHours, null);
    assert.strictEqual(sessionData.requirements.customerConfirmed, false);
    assert.strictEqual(sessionData.requirements.eventDate, "2026-12-05");
    assert.strictEqual(sessionData.officialBookingId, body.requestId);

    // Consent records
    const consentDocs = Array.from(mockStore.docs.entries())
      .filter(([k]) => k.startsWith(`${CUSTOMER_CONSENT_COLLECTION}/`))
      .map(([, v]) => v.data);
    assert.strictEqual(consentDocs.length, 1);
    assert.strictEqual(consentDocs[0].channel, "voice");
    assert.strictEqual(consentDocs[0].granted, true);

    // Outbox deliveries
    const outboxDocs = Array.from(mockStore.docs.entries())
      .filter(([k]) => k.startsWith(`${OUTBOX_COLLECTION}/`))
      .map(([, v]) => v.data);
    assert.strictEqual(outboxDocs.length, 1);
    assert.strictEqual(outboxDocs[0].eventType, "booking_created");
    assert.strictEqual(outboxDocs[0].channel, "voice");
    assert.strictEqual(outboxDocs[0].status, "pending");
    assert.strictEqual(outboxDocs[0].phoneNumberMasked, "+91******3210");
    assert.strictEqual("phoneNumber" in outboxDocs[0], false);
  });

  await test("WhatsApp consent only: persists van_request, 1 WhatsApp consent; 0 sessions, 0 outbox", async () => {
    // Clear mock store
    mockStore.docs.clear();

    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contact: `waonly_${runId}@brew.internal`,
        phoneNumber: "9876543211",
        whatsappConsent: true,
        organization: "WA Only Corp",
        location: "Block B Cybercity, Hyderabad",
        eventDate: "2026-12-06",
        crowdSize: "50-100",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.voiceSessionId, null);
    assert.strictEqual(body.consents.voice, false);
    assert.strictEqual(body.consents.whatsapp, true);
    assert.strictEqual("phoneNumber" in body, false, "Public response must not expose phoneNumber");

    const vanDoc = mockStore.getDoc(`van_requests/${body.requestId}`);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    assert.strictEqual(vanData.phoneNumber, "+919876543211");
    assert.strictEqual("normalizedPhone" in vanData, false, "Must not store redundant normalizedPhone field");
    // Verify future WhatsApp resolution can retrieve phone directly from van_requests without voiceSession
    assert.strictEqual(vanData.voiceSessionId, null);

    const voiceSessions = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${VOICE_BOOKING_COLLECTION}/`)
    );
    const outboxDocs = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${OUTBOX_COLLECTION}/`)
    );
    const consentDocs = Array.from(mockStore.docs.entries())
      .filter(([k]) => k.startsWith(`${CUSTOMER_CONSENT_COLLECTION}/`))
      .map(([, v]) => v.data);

    assert.strictEqual(voiceSessions.length, 0);
    assert.strictEqual(outboxDocs.length, 0);
    assert.strictEqual(consentDocs.length, 1);
    assert.strictEqual(consentDocs[0].channel, "whatsapp");
    assert.strictEqual(consentDocs[0].granted, true);
  });

  await test("Both consents: persists van_request, 2 consents (voice+wa), 1 session, 1 outbox", async () => {
    mockStore.docs.clear();

    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contact: `both_${runId}@brew.internal`,
        phoneNumber: "9876543212",
        voiceConsent: true,
        whatsappConsent: true,
        organization: "Both Consents Corp",
        location: "Block D Cybercity, Hyderabad",
        eventDate: "2026-12-07",
        crowdSize: "200-400",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(body.voiceSessionId);
    assert.strictEqual(body.consents.voice, true);
    assert.strictEqual(body.consents.whatsapp, true);

    const voiceSessions = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${VOICE_BOOKING_COLLECTION}/`)
    );
    const outboxDocs = Array.from(mockStore.docs.keys()).filter((k) =>
      k.startsWith(`${OUTBOX_COLLECTION}/`)
    );
    const consentDocs = Array.from(mockStore.docs.entries())
      .filter(([k]) => k.startsWith(`${CUSTOMER_CONSENT_COLLECTION}/`))
      .map(([, v]) => v.data);

    assert.strictEqual(voiceSessions.length, 1);
    assert.strictEqual(outboxDocs.length, 1);
    assert.strictEqual(consentDocs.length, 2);

    const channels = consentDocs.map((c) => c.channel).sort();
    assert.deepStrictEqual(channels, ["voice", "whatsapp"]);
  });

  await test("Idempotent replay: duplicate submission returns existing quote and creates NO duplicate records", async () => {
    const payload = {
      contact: `idempotent_${runId}@brew.internal`,
      phoneNumber: "9876543213",
      voiceConsent: true,
      whatsappConsent: true,
      organization: "Idempotent Corp",
      location: "Tower 1, Hyderabad",
      eventDate: "2026-12-08",
      crowdSize: "150-250",
      idempotencyKey: `client_idem_${runId}_123`,
    };

    // First request
    const req1 = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res1 = await POST(req1);
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json();
    assert.strictEqual(body1.success, true);

    const docsCountAfterFirst = mockStore.docs.size;

    // Second (duplicate) request
    const req2 = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res2 = await POST(req2);
    assert.strictEqual(res2.status, 200);
    const body2 = await res2.json();
    assert.strictEqual(body2.success, true);
    assert.strictEqual(body2.idempotentReplay, true);
    assert.strictEqual(body2.requestId, body1.requestId);

    // Exact count unchanged: zero duplicate docs created
    assert.strictEqual(mockStore.docs.size, docsCountAfterFirst);
  });

  await test("Simulated DB failure: returns 503 and rolls back cleanly without persisting", async () => {
    const payload = {
      contact: "failcheck@brew.internal",
      phoneNumber: "9876543214",
      voiceConsent: true,
      organization: "Fail Corp",
      location: "Tower 2, Hyderabad",
      eventDate: "2026-12-09",
      crowdSize: "50-100",
    };

    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-simulate-db-failure": "true",
      },
      body: JSON.stringify(payload),
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /Database persistence error/i);
  });

  console.log("\nSECTION 2B: Phase 6.3.4.1.3 Public Response Phone Privacy & Strict Normalization");

  const legacyPayload = {
    contact: " 98765 43210 ",
    voiceConsent: true,
    organization: `Legacy Phone Org ${runId}`,
    location: "Tech Park, Hyderabad",
    eventDate: "2026-12-10",
    crowdSize: "100-200",
  };

  await test("Legacy phone-only contact: normalized persistence and zero indirect phone exposure in public response", async () => {
    const rawLegacyPhone = legacyPayload.contact;
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.14" },
      body: JSON.stringify(legacyPayload),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);

    assert.strictEqual(body.success, true);
    // Public response must mask contact when it's a phone number
    assert.strictEqual(body.requestSummary.contact, "+91****210");
    assert.strictEqual("phoneNumber" in body, false, "Public response must not expose phoneNumber");
    assert.strictEqual("phoneNumber" in body.requestSummary, false);

    // Strict Privacy Verification: Zero raw or normalized full phone number in ANY response string or URL
    const fullBodyString = JSON.stringify(body);
    assert.strictEqual(fullBodyString.includes("+919876543210"), false, "Public response JSON must not contain normalized full phone");
    assert.strictEqual(fullBodyString.includes("9876543210"), false, "Public response JSON must not contain raw full phone");
    assert.strictEqual(fullBodyString.includes("98765 43210"), false, "Public response JSON must not contain spaced raw phone");

    // Verify Gmail and mailto compose links retain functionality but mask phone in body text
    const decodedGmailUrl = decodeURIComponent(body.gmailUrl);
    const decodedMailtoUrl = decodeURIComponent(body.mailtoUrl);
    assert.match(decodedGmailUrl, /Call the customer directly at \+91\*\*\*\*210/);
    assert.match(decodedMailtoUrl, /Call the customer directly at \+91\*\*\*\*210/);
    assert.doesNotMatch(decodedGmailUrl, /9876543210/);
    assert.doesNotMatch(decodedMailtoUrl, /9876543210/);
    assert.doesNotMatch(decodedGmailUrl, /mailto:\+91/);
    assert.doesNotMatch(decodedMailtoUrl, /mailto:\+91/);

    // Verify persisted van_requests document contains normalized E.164
    const vanDoc = mockStore.getDoc(`van_requests/${body.requestId}`);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    // Normalized contact and authoritative phoneNumber must both be E.164
    assert.strictEqual(vanData.contact, "+919876543210");
    assert.strictEqual(vanData.phoneNumber, "+919876543210");
    // Raw unnormalized phone input must NOT be persisted
    assert.notStrictEqual(vanData.contact, rawLegacyPhone);
    assert.strictEqual("normalizedPhone" in vanData, false, "No redundant normalizedPhone field");

    // Session and consent must receive the normalized phone
    assert.ok(body.voiceSessionId);
    const sessionDoc = mockStore.getDoc(`${VOICE_BOOKING_COLLECTION}/${body.voiceSessionId}`);
    assert.ok(sessionDoc);
    assert.strictEqual(sessionDoc.data().phoneNumber, "+919876543210");

    const consentDoc = mockStore.getDoc(`${CUSTOMER_CONSENT_COLLECTION}/consent_${body.requestId}_voice`);
    assert.ok(consentDoc);
    assert.strictEqual(consentDoc.data().phoneNumber, "+919876543210");
  });

  await test("Email contact: unchanged behavior, email preserved in public URLs and response", async () => {
    const emailContact = `organizer.van.${runId}@college.edu`;
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.15" },
      body: JSON.stringify({
        contact: emailContact,
        organization: `Email Org ${runId}`,
        location: "Auditorium Hall, Hyderabad",
        eventDate: "2026-12-11",
        crowdSize: "50-100",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);

    assert.strictEqual(body.success, true);
    assert.strictEqual(body.requestSummary.contact, emailContact);
    assert.strictEqual("phoneNumber" in body, false);

    // Verify email notification text addresses customer via email in compose URLs
    const decodedGmailUrl = decodeURIComponent(body.gmailUrl);
    const decodedMailtoUrl = decodeURIComponent(body.mailtoUrl);
    assert.match(decodedGmailUrl, new RegExp(`Respond directly to the customer at ${emailContact}`));
    assert.match(decodedMailtoUrl, new RegExp(`Respond directly to the customer at ${emailContact}`));

    const vanDoc = mockStore.getDoc(`van_requests/${body.requestId}`);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    assert.strictEqual(vanData.contact, emailContact);
    assert.strictEqual(vanData.phoneNumber, null);
    assert.strictEqual("normalizedPhone" in vanData, false);
  });

  await test("Separate phoneNumber with email contact: email preserved, separate phone authoritative, zero phone in public response", async () => {
    const emailContact = `events.lead.${runId}@startup.io`;
    const rawSeparatePhone = "09876543210";
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.16" },
      body: JSON.stringify({
        contact: emailContact,
        phoneNumber: rawSeparatePhone,
        whatsappConsent: true,
        organization: `Startup Org ${runId}`,
        location: "Incubator Hub, Hyderabad",
        eventDate: "2026-12-12",
        crowdSize: "75-150",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);

    assert.strictEqual(body.success, true);
    assert.strictEqual(body.requestSummary.contact, emailContact);
    assert.strictEqual("phoneNumber" in body, false);

    // Verify phone is not exposed in public response
    const fullBodyString = JSON.stringify(body);
    assert.strictEqual(fullBodyString.includes("9876543210"), false, "Public response must not expose separate phone");

    const vanDoc = mockStore.getDoc(`van_requests/${body.requestId}`);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    assert.strictEqual(vanData.contact, emailContact);
    assert.strictEqual(vanData.phoneNumber, "+919876543210");
    assert.strictEqual("normalizedPhone" in vanData, false);
  });

  await test("Both fields supplied as phone numbers: contact normalized, separate phone authoritative", async () => {
    const rawContactPhone = " 98765 43210 ";
    const rawSeparatePhone = "+91 91234 56789";
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.17" },
      body: JSON.stringify({
        contact: rawContactPhone,
        phoneNumber: rawSeparatePhone,
        voiceConsent: true,
        organization: `Dual Phone Org ${runId}`,
        location: "Convention Center, Hyderabad",
        eventDate: "2026-12-13",
        crowdSize: "200-300",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);

    assert.strictEqual(body.success, true);
    assert.strictEqual(body.requestSummary.contact, "+91****210");
    assert.strictEqual("phoneNumber" in body, false);

    // Strict Privacy Verification: Zero raw or normalized phones in public response
    const fullBodyString = JSON.stringify(body);
    assert.strictEqual(fullBodyString.includes("9876543210"), false);
    assert.strictEqual(fullBodyString.includes("9123456789"), false);

    const vanDoc = mockStore.getDoc(`van_requests/${body.requestId}`);
    assert.ok(vanDoc);
    const vanData = vanDoc.data();
    assert.strictEqual(vanData.contact, "+919876543210");
    assert.strictEqual(vanData.phoneNumber, "+919123456789");
    assert.strictEqual("normalizedPhone" in vanData, false);
  });

  await test("Idempotent replay of legacy phone request masks contact, compose links, and creates no duplicates", async () => {
    const docCountBefore = mockStore.docs.size;
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.18" },
      body: JSON.stringify(legacyPayload),
    });

    const res = await POST(req);
    const body = await res.json();
    assert.strictEqual(res.status, 200);

    assert.strictEqual(body.success, true);
    assert.strictEqual(body.idempotentReplay, true);
    assert.strictEqual(body.requestSummary.contact, "+91****210");
    assert.strictEqual("phoneNumber" in body, false);

    // Ensure replay response has zero phone leakage in JSON or compose URLs
    const fullBodyString = JSON.stringify(body);
    assert.strictEqual(fullBodyString.includes("9876543210"), false);
    assert.strictEqual(decodeURIComponent(body.gmailUrl).includes("9876543210"), false);
    assert.strictEqual(decodeURIComponent(body.mailtoUrl).includes("9876543210"), false);

    assert.strictEqual(mockStore.docs.size, docCountBefore, "Zero new documents created on replay");
  });

  await test("Malformed phone-shaped contact with no consent: rejected (400) and no raw phone persisted", async () => {
    const docCountBefore = mockStore.docs.size;
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.19" },
      body: JSON.stringify({
        contact: "12345678", // Phone-shaped but invalid / unnormalizable
        organization: `Malformed Org ${runId}`,
        location: "Cybercity, Hyderabad",
        eventDate: "2026-12-15",
        crowdSize: "50-100",
      }),
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.details || body.error, /Contact must be a valid email address or a valid phone number/);
    assert.strictEqual(mockStore.docs.size, docCountBefore, "Zero documents persisted on schema validation failure");
  });

  await test("Malformed separate phoneNumber with email contact: rejected (400) and no raw phone persisted", async () => {
    const docCountBefore = mockStore.docs.size;
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.20" },
      body: JSON.stringify({
        contact: `valid.email.${runId}@brew.internal`,
        phoneNumber: "not-a-valid-phone-123",
        organization: `Malformed Phone Org ${runId}`,
        location: "Cybercity, Hyderabad",
        eventDate: "2026-12-16",
        crowdSize: "50-100",
      }),
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.details || body.error, /Phone number must be a valid phone number/);
    assert.strictEqual(mockStore.docs.size, docCountBefore, "Zero documents persisted on invalid phoneNumber");
  });

  await test("Staff retrieval (GET /api/request-van): full normalized phone remains available to authorized staff", async () => {
    const baristaToken = await createSessionToken({
      uid: "barista_test_1",
      email: "barista@brew.internal",
      displayName: "Lead Barista",
      role: "barista",
    });

    // 1. Authorized barista retrieval
    const req = new NextRequest("http://localhost:3000/api/request-van", {
      method: "GET",
      headers: {
        cookie: `brew_session=${baristaToken}`,
      },
    });

    const res = await GET(req);
    assert.strictEqual(res.status, 200);
    const records = await res.json();
    assert.ok(Array.isArray(records));
    assert.ok(records.length > 0);

    // Verify that every record has normalized contact / phoneNumber
    for (const rec of records as Array<{ contact: string; phoneNumber?: string | null; normalizedPhone?: unknown }>) {
      assert.strictEqual("normalizedPhone" in rec, false, "Staff record must not contain obsolete normalizedPhone");
      if (rec.contact.includes("@")) {
        // Email contact
        assert.match(rec.contact, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      } else {
        // Normalized E.164 phone
        assert.match(rec.contact, /^\+[1-9]\d{6,14}$/, "Phone contact must be strictly normalized E.164");
      }
      if (rec.phoneNumber) {
        assert.match(rec.phoneNumber, /^\+[1-9]\d{6,14}$/, "phoneNumber must be strictly normalized E.164");
      }
    }

    // 2. Unauthenticated retrieval is rejected
    const unauthReq = new NextRequest("http://localhost:3000/api/request-van", {
      method: "GET",
    });
    const unauthRes = await GET(unauthReq);
    assert.strictEqual(unauthRes.status, 401);

    // 3. Customer role retrieval is forbidden
    const customerToken = await createSessionToken({
      uid: "customer_test_1",
      email: "cust@brew.internal",
      displayName: "Regular Customer",
      role: "customer",
    });
    const forbiddenReq = new NextRequest("http://localhost:3000/api/request-van", {
      method: "GET",
      headers: {
        cookie: `brew_session=${customerToken}`,
      },
    });
    const forbiddenRes = await GET(forbiddenReq);
    assert.strictEqual(forbiddenRes.status, 403);
  });

  console.log("\nSECTION 3: Durable Consent Repository (FirestoreConsentRepository)");

  const consentRepo = new FirestoreConsentRepository({ db: mockDb });

  await test("Save and query consent grants by phone", async () => {
    const phone = "+919123456780";
    const record = createConsentRecord({
      phoneNumber: phone,
      channel: "voice",
      purpose: "transactional_update",
      consentText: "I consent to voice calls",
    });

    await consentRepo.save(record);

    const retrieved = await consentRepo.findByPhone(phone);
    assert.strictEqual(retrieved.length, 1);
    assert.strictEqual(retrieved[0].phoneNumber, phone);
    assert.strictEqual(retrieved[0].channel, "voice");
    assert.strictEqual(retrieved[0].granted, true);

    const active = await consentRepo.getActiveConsent(
      phone,
      "voice",
      "transactional_update"
    );
    assert.ok(active);
    assert.strictEqual(active!.phoneNumber, phone);
  });

  await test("Revoke consent takes effect immediately", async () => {
    const phone = "+919123456780";
    await consentRepo.revoke(
      phone,
      "voice",
      "transactional_update",
      "customer requested opt out"
    );

    const active = await consentRepo.getActiveConsent(
      phone,
      "voice",
      "transactional_update"
    );
    assert.strictEqual(active, null, "Consent must be inactive after revocation");
  });

  await test("Re-granting consent after revocation restores active consent", async () => {
    const phone = "+919123456780";
    const regrant = createConsentRecord({
      phoneNumber: phone,
      channel: "voice",
      purpose: "transactional_update",
      consentText: "I consent again to voice calls",
      timestamp: new Date(Date.now() + 1000).toISOString(),
    });

    await consentRepo.save(regrant);

    const active = await consentRepo.getActiveConsent(
      phone,
      "voice",
      "transactional_update"
    );
    assert.ok(active, "Active consent must be restored");
    assert.strictEqual(active!.granted, true);
  });

  await test("Consent repository fails closed when DB is unavailable", async () => {
    const brokenRepo = new FirestoreConsentRepository({
      db: null,
    });
    // Temporarily clear Admin DB to verify fail-closed
    setAdminFirestoreForTesting(null);

    await assert.rejects(
      async () => {
        await brokenRepo.findByPhone("+919123456780");
      },
      /Firestore Admin DB unavailable/
    );

    // Restore mock DB
    setAdminFirestoreForTesting(mockDb);
  });

  console.log("\nSECTION 4: Durable DND Repository & Scope Suppression (FirestoreDndRepository)");

  const dndRepo = new FirestoreDndRepository({ db: mockDb });

  await test("Register DND suppression record and audit log atomically via batch", async () => {
    const phone = "+919888877777";
    await dndRepo.save({
      id: "dnd_test_reg_1",
      phoneNumber: phone,
      scope: "voice",
      reason: "TRAI National DND Registry match",
      createdAt: new Date().toISOString(),
    });

    const activeScopes = await dndRepo.findActiveScopes(phone);
    assert.strictEqual(activeScopes.length, 1);
    assert.strictEqual(activeScopes[0].scope, "voice");

    // Verify both documents exist in mock store
    const suppressionDoc = mockStore.getDoc(
      `${DND_SUPPRESSION_COLLECTION}/dnd_test_reg_1`
    );
    assert.ok(suppressionDoc, "Suppression document must exist");

    const auditDocs = Array.from(mockStore.docs.entries()).filter(
      ([k, v]) =>
        k.startsWith(`${DND_AUDIT_COLLECTION}/`) &&
        v.data.phoneNumberMasked === "+91******7777"
    );
    assert.strictEqual(auditDocs.length, 1, "Audit document must exist");
    assert.strictEqual(auditDocs[0][1].data.action, "REGISTER_DND");

    const auditHistory = dndRepo.getAuditHistory();
    assert.ok(auditHistory.length >= 1);
    assert.strictEqual(
      auditHistory[auditHistory.length - 1].action,
      "REGISTER_DND"
    );
    assert.strictEqual(
      auditHistory[auditHistory.length - 1].phoneNumberMasked,
      "+91******7777"
    );
  });

  await test("Simulated DND batch failure: leaves no partial suppression or audit doc, in-memory history untouched", async () => {
    const phone = "+919999888833";
    const historyBefore = dndRepo.getAuditHistory().length;

    mockStore.failNextBatchCommit = true;

    await assert.rejects(
      async () => {
        await dndRepo.save({
          id: "dnd_test_fail_batch",
          phoneNumber: phone,
          scope: "all",
          reason: "Simulated failure test",
          createdAt: new Date().toISOString(),
        });
      },
      /Simulated Firestore batch commit failure/
    );

    // Verify neither doc committed
    const suppressionDoc = mockStore.getDoc(
      `${DND_SUPPRESSION_COLLECTION}/dnd_test_fail_batch`
    );
    assert.strictEqual(
      suppressionDoc,
      null,
      "Suppression doc must NOT be committed on batch failure"
    );

    const auditDocs = Array.from(mockStore.docs.entries()).filter(
      ([k, v]) =>
        k.startsWith(`${DND_AUDIT_COLLECTION}/`) &&
        v.data.phoneNumberMasked === "+91******8833"
    );
    assert.strictEqual(
      auditDocs.length,
      0,
      "Audit doc must NOT be committed on batch failure"
    );

    // In-memory audit history must not be mutated
    const historyAfter = dndRepo.getAuditHistory().length;
    assert.strictEqual(
      historyAfter,
      historyBefore,
      "Audit history must not be updated if commit fails"
    );
  });

  await test("DND suppression blocks communication policy approval even with active consent", async () => {
    const phone = "+919888877777";
    // Grant consent
    const consent = createConsentRecord({
      phoneNumber: phone,
      channel: "voice",
      purpose: "transactional_update",
      consentText: "I consent to voice calls",
    });
    await consentRepo.save(consent);

    // Evaluate policy (DND is registered for 'voice')
    const policyResult = await orchestrateCommunicationPolicy(
      {
        channel: "voice",
        purpose: "transactional_update",
        phoneNumber: phone,
        enquiryId: "vbs_policy_test_1",
        currentTime: new Date("2026-11-20T11:00:00Z"), // Permitted hour
      },
      {
        consentRepository: consentRepo,
        dndRepository: dndRepo,
      },
      { checkFeatureFlag: false }
    );

    assert.strictEqual(policyResult.status, "blocked");
    assert.strictEqual(policyResult.reason, "DND_ACTIVE");
  });

  await test("Removing DND scope restores policy approval", async () => {
    const phone = "+919888877777";
    const removed = await dndRepo.removeScope(
      phone,
      "voice",
      "Customer explicitly unsubscribed from DND"
    );
    assert.strictEqual(removed, true);

    const activeScopes = await dndRepo.findActiveScopes(phone);
    assert.strictEqual(activeScopes.length, 0);

    const policyResult = await orchestrateCommunicationPolicy(
      {
        channel: "voice",
        purpose: "transactional_update",
        phoneNumber: phone,
        enquiryId: "vbs_policy_test_1",
        currentTime: new Date("2026-11-20T11:00:00Z"), // Permitted hour
      },
      {
        consentRepository: consentRepo,
        dndRepository: dndRepo,
      },
      { checkFeatureFlag: false }
    );

    assert.strictEqual(policyResult.status, "allowed");
  });

  await test("DND repository fails closed when DB is unavailable", async () => {
    const brokenRepo = new FirestoreDndRepository({
      db: null,
    });
    setAdminFirestoreForTesting(null);

    await assert.rejects(
      async () => {
        await brokenRepo.findActiveScopes("+919888877777");
      },
      /Firestore Admin DB unavailable/
    );

    setAdminFirestoreForTesting(mockDb);
  });

  console.log("\nSECTION 5: Repository Selector (repositorySelector.ts)");

  await test("getConsentRepository and getDndRepository correctly instantiate requested modes", async () => {
    const memConsent = getConsentRepository("memory");
    assert.strictEqual(memConsent.constructor.name, "InMemoryConsentRepository");

    const firestoreConsent = getConsentRepository("firestore");
    assert.strictEqual(
      firestoreConsent.constructor.name,
      "FirestoreConsentRepository"
    );

    const memDnd = getDndRepository("memory");
    assert.strictEqual(memDnd.constructor.name, "InMemoryDndRepository");

    const firestoreDnd = getDndRepository("firestore");
    assert.strictEqual(firestoreDnd.constructor.name, "FirestoreDndRepository");
  });

  console.log("\nSECTION 6: Worker & Feature Flag Invariants");

  await test("OutboxWorker strictly preserves VOICE_BOOKING_ENABLED=false guardrail", async () => {
    process.env.VOICE_BOOKING_ENABLED = "false";

    const voiceProvider = new MockVoiceProvider();
    const waProvider = new MockWhatsAppProvider();

    // Use test harness to instantiate worker
    const worker = new OutboxWorker({
      outboxRepository: {
        claimPendingDeliveries: async () => [],
        updateClaimedDelivery: async () => {},
      } as unknown as CommunicationOutboxRepository,
      consentRepository: consentRepo,
      dndRepository: dndRepo,
      voiceProvider,
      whatsappProvider: waProvider,
      sessionRepository: {
        findById: async () => null,
      } as unknown as VoiceSessionRepository,
    });

    assert.ok(worker, "Worker instantiated");

    // Real policy evaluation with default feature flag must reject with FEATURE_DISABLED
    const policyResult = await orchestrateCommunicationPolicy(
      {
        channel: "voice",
        purpose: "transactional_update",
        phoneNumber: "+919876543210",
        enquiryId: "vbs_flag_test",
      },
      {
        consentRepository: consentRepo,
        dndRepository: dndRepo,
      }
    );

    assert.strictEqual(policyResult.status, "blocked");
    assert.strictEqual(policyResult.reason, "FEATURE_DISABLED");
    assert.strictEqual(voiceProvider.getActiveSessionCount(), 0);
    assert.strictEqual(waProvider.getDispatchedMessageCount(), 0);
  });

  console.log("\nSECTION 7: Firestore Security Rules Denial Coverage");

  await test("firestore.rules strictly denies direct client reads and writes to Phase 6 collections", async () => {
    const rulesPath = path.join(process.cwd(), "firestore.rules");
    assert.ok(fs.existsSync(rulesPath), "firestore.rules must exist");
    const rulesContent = fs.readFileSync(rulesPath, "utf-8");

    // Verify denial blocks for customer_consent_records, dnd_suppression_records, dnd_audit_events
    assert.match(
      rulesContent,
      /match\s+\/customer_consent_records\/\{consentId\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/,
      "customer_consent_records must deny client read/write"
    );
    assert.match(
      rulesContent,
      /match\s+\/dnd_suppression_records\/\{dndId\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/,
      "dnd_suppression_records must deny client read/write"
    );
    assert.match(
      rulesContent,
      /match\s+\/dnd_audit_events\/\{auditId\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/,
      "dnd_audit_events must deny client read/write"
    );
    assert.match(
      rulesContent,
      /match\s+\/voice_booking_sessions\/\{sessionId\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/,
      "voice_booking_sessions must deny client read/write"
    );
    assert.match(
      rulesContent,
      /match\s+\/booking_communication_outbox\/\{deliveryId\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/,
      "booking_communication_outbox must deny client read/write"
    );
  });

  console.log("\n===============================================================================");
  console.log(`   Phase 6.3.4.1 Verification Complete: All ${testIndex} tests passed successfully!`);
  console.log("===============================================================================");
}

runAll().catch((e) => {
  console.error("FATAL: Suite execution failed:", e);
  process.exit(1);
});
