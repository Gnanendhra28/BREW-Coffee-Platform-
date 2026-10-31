// ==============================================================================
// ☕ BREW — Phase 1: Data Persistence, Backend Reliability & Security Hotfix
// ==============================================================================

import assert from "node:assert/strict";
import http from "node:http";

const BASE_URL = "http://127.0.0.1:3000";

function request(path, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const dataString = postData ? (typeof postData === "string" ? postData : JSON.stringify(postData)) : null;
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || (postData ? "POST" : "GET"),
      headers: {
        ...(dataString
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(dataString),
            }
          : {}),
        ...options.headers,
      },
    };

    const req = http.request(reqOptions, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          data: parsed,
        });
      });
    });

    req.on("error", reject);
    if (dataString) {
      req.write(dataString);
    }
    req.end();
  });
}

async function runPhase1Verification() {
  console.log("===============================================================");
  console.log("🛡️  PHASE 1: DATA PERSISTENCE & SECURITY HOTFIX VERIFICATION");
  console.log("===============================================================\n");

  // --------------------------------------------------------------------------
  // 1. PRIVILEGE ESCALATION PREVENTION (SECURITY HOTFIX)
  // --------------------------------------------------------------------------
  console.log("1. Testing Privilege Escalation Prevention (/api/auth/session)...");
  
  // 1a. Attempt to self-assign fleet_admin
  const res1a = await request("/api/auth/session", { method: "POST" }, {
    role: "fleet_admin",
    user: { uid: "attacker-001", displayName: "Rogue User" },
  });
  assert.equal(res1a.statusCode, 403, `Expected 403 for unauthorized fleet_admin escalation, got ${res1a.statusCode}`);
  console.log("   ✓ Self-assigned fleet_admin role blocked with 403 Forbidden");

  // 1b. Attempt to self-assign barista via nested user object
  const res1b = await request("/api/auth/session", { method: "POST" }, {
    user: { uid: "attacker-002", displayName: "Rogue User", role: "barista" },
  });
  assert.equal(res1b.statusCode, 403, `Expected 403 for unauthorized barista escalation, got ${res1b.statusCode}`);
  console.log("   ✓ Self-assigned barista role via nested user blocked with 403 Forbidden");

  // 1c. Valid staff PIN login must still work
  const res1c = await request("/api/auth/session", { method: "POST" }, {
    action: "staff_pin",
    pin: "2026",
  });
  assert.equal(res1c.statusCode, 200);
  assert.equal(res1c.data.user.role, "barista");
  const baristaCookie = res1c.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(baristaCookie, "Session cookie must be issued on valid staff PIN login");
  console.log("   ✓ Valid Barista PIN (2026) authenticated successfully");

  // --------------------------------------------------------------------------
  // 2. INPUT VALIDATION & ATTACK DEFENSE (/api/request-van)
  // --------------------------------------------------------------------------
  console.log("\n2. Testing Strict Input Validation & Edge Protections (/api/request-van)...");

  // 2a. Empty contact
  const res2a = await request("/api/request-van", { method: "POST" }, {
    contact: "",
    organization: "Tech Park",
    location: "HITEC City",
  });
  assert.equal(res2a.statusCode, 400);
  assert.ok(res2a.data.error.includes("Validation Error"), "Must return validation error for empty contact");
  console.log("   ✓ Empty contact rejected with 400 Bad Request");

  // 2b. Invalid contact (not email, not phone)
  const res2b = await request("/api/request-van", { method: "POST" }, {
    contact: "not_an_email_or_phone",
    organization: "Tech Park",
    location: "HITEC City",
  });
  assert.equal(res2b.statusCode, 400);
  console.log("   ✓ Malformed contact string rejected with 400 Bad Request");

  // 2c. Malformed JSON payload
  const res2c = await request("/api/request-van", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, "{ broken_json: true, missing_closing_bracket");
  assert.equal(res2c.statusCode, 400);
  assert.ok(res2c.data.error.includes("Malformed JSON"));
  console.log("   ✓ Malformed JSON syntax caught gracefully with 400 Bad Request");

  // 2d. Oversized Request (> 100 KB payload)
  const largeBlob = "X".repeat(120 * 1024);
  const res2d = await request("/api/request-van", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify({ contact: "admin@corp.com", organization: "Corp", location: "City", notes: largeBlob }));
  assert.equal(res2d.statusCode, 413, `Expected 413 Payload Too Large, got ${res2d.statusCode}`);
  console.log("   ✓ Oversized request (>100KB) rejected with 413 Payload Too Large");

  // --------------------------------------------------------------------------
  // 3. SUCCESSFUL PERSISTENCE & FRONTEND CONTRACT
  // --------------------------------------------------------------------------
  console.log("\n3. Testing Successful Catering Enquiry Creation & Response Contract...");

  const testPayload = {
    contact: "events@microsoft.com",
    organization: "Microsoft Campus Hyderabad",
    location: "Gachibowli Financial District",
    eventDate: "2026-11-25",
    crowdSize: "150–300 People",
    notes: "Requires fast barista service during keynote",
  };

  const res3 = await request("/api/request-van", { method: "POST" }, testPayload);
  if (res3.statusCode !== 200) {
    console.log("   [DEBUG res3 response]:", res3.statusCode, res3.data);
  }
  assert.equal(res3.statusCode, 200);
  assert.equal(res3.data.success, true);
  assert.ok(res3.data.requestId, "Must return unique requestId");
  assert.ok(res3.data.quotation, "Must return Agent 4 quotation");
  assert.equal(res3.data.quotation.tiers.length, 3);
  assert.ok(res3.data.requestSummary);
  console.log("   ✓ Valid catering request accepted with complete 3-tier Agent 4 quote");

  // --------------------------------------------------------------------------
  // 4. IDEMPOTENCY & DUPLICATE SUBMISSION SAFEGUARDS
  // --------------------------------------------------------------------------
  console.log("\n4. Testing Idempotency & Safe Deduplication...");

  // 4a. Duplicate identical submission within window
  const res4a = await request("/api/request-van", { method: "POST" }, testPayload);
  assert.equal(res4a.statusCode, 200);
  assert.equal(res4a.data.idempotentReplay, true, "Duplicate submission must return idempotent replay");
  assert.equal(res4a.data.requestId, res3.data.requestId, "Replay must return original requestId");
  console.log("   ✓ Duplicate request recognized and safely returned as idempotent replay");

  // 4b. Idempotency Key collision with differing payload
  const clientKey = `idemp_key_${Date.now()}`;
  const res4b1 = await request("/api/request-van", { method: "POST" }, {
    ...testPayload,
    contact: "first.customer@domain.com",
    idempotencyKey: clientKey,
  });
  assert.equal(res4b1.statusCode, 200);

  // Attempt to reuse same key with DIFFERENT customer contact/details
  const res4b2 = await request("/api/request-van", { method: "POST" }, {
    ...testPayload,
    contact: "second.attacker@domain.com",
    idempotencyKey: clientKey,
  });
  assert.equal(res4b2.statusCode, 409, `Expected 409 Conflict for mismatched payload, got ${res4b2.statusCode}`);
  console.log("   ✓ Key collision with mismatched customer payload blocked with 409 Conflict");

  // 4c. Concurrent duplicate submissions
  console.log("\n5. Testing Concurrent Duplicate Submissions Handling...");
  const concurrentPayload = {
    contact: "concurrent@fest.org",
    organization: "Annual Tech Fest",
    location: "Auditorium Grounds",
    eventDate: "2026-12-01",
    crowdSize: "300–600 People",
    idempotencyKey: `conc_${Date.now()}`,
  };

  const [c1, c2] = await Promise.all([
    request("/api/request-van", { method: "POST" }, concurrentPayload),
    request("/api/request-van", { method: "POST" }, concurrentPayload),
  ]);

  // One must be 200 and the other either 200 (idempotent replay) or 409 (in-flight pending lock)
  const successCount = [c1, c2].filter((r) => r.statusCode === 200).length;
  assert.ok(successCount >= 1, "At least one concurrent request must succeed");
  console.log(`   ✓ Concurrent submissions handled safely without data race (Responses: ${c1.statusCode}, ${c2.statusCode})`);

  // --------------------------------------------------------------------------
  // 5. UNAUTHORIZED ACCESS PROTECTION (GET /api/request-van)
  // --------------------------------------------------------------------------
  console.log("\n6. Testing Access Control on Enquiry Records (GET /api/request-van)...");

  // 5a. Unauthenticated public request
  const res5a = await request("/api/request-van", { method: "GET" });
  assert.equal(res5a.statusCode, 401, `Expected 401 Unauthorized for public GET, got ${res5a.statusCode}`);
  console.log("   ✓ Unauthenticated GET /api/request-van blocked with 401 Unauthorized");

  // 5b. Authenticated customer request attempting to read all enquiries
  const customerAuth = await request("/api/auth/session", { method: "POST" }, {
    user: { uid: "guest-123", displayName: "Regular Guest" },
  });
  const customerCookie = customerAuth.headers["set-cookie"]?.[0]?.split(";")[0];
  const res5b = await request("/api/request-van", {
    method: "GET",
    headers: { Cookie: customerCookie },
  });
  assert.equal(res5b.statusCode, 403, `Expected 403 Forbidden for customer role, got ${res5b.statusCode}`);
  console.log("   ✓ Customer role blocked from reading enquiries with 403 Forbidden");

  // 5c. Authenticated Barista staff request
  const res5c = await request("/api/request-van", {
    method: "GET",
    headers: { Cookie: baristaCookie },
  });
  assert.equal(res5c.statusCode, 200, `Expected 200 OK for barista staff, got ${res5c.statusCode}`);
  assert.ok(Array.isArray(res5c.data), "Authorized staff response must be an array of enquiries");
  console.log(`   ✓ Barista staff authorized: retrieved ${res5c.data.length} enquiry record(s)`);

  // --------------------------------------------------------------------------
  // 6. DATABASE OUTAGE / STRICT PRODUCTION PERSISTENCE GATE
  // --------------------------------------------------------------------------
  console.log("\n7. Testing Database Outage / Strict Persistence Gate (503 Handling)...");
  const res6 = await request(
    "/api/request-van",
    {
      method: "POST",
      headers: { "x-simulate-db-failure": "true" },
    },
    {
      contact: "resilience.test@company.com",
      organization: "Resilience Corp",
      location: "Financial District",
    }
  );
  assert.equal(res6.statusCode, 503, `Expected 503 for failed database persistence, got ${res6.statusCode}`);
  assert.ok(
    res6.data.error.includes("Database persistence error"),
    "Must return clear database persistence error message"
  );
  console.log("   ✓ Database outage properly triggers HTTP 503 (no false success claims)");

  console.log("\n===============================================================");
  console.log("🎉 ALL PHASE 1 RELIABILITY & SECURITY TESTS PASSED (100%)!");
  console.log("===============================================================\n");
}

runPhase1Verification().catch((err) => {
  console.error("Verification suite failed:", err);
  process.exit(1);
});
