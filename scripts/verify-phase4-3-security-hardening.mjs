// ==============================================================================
// BREW PLATFORM — PHASE 4.6.3: SECURITY HARDENING & INFRASTRUCTURE INTEGRITY
// ==============================================================================

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";

function makeRequest(options, postData = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (postData) {
      headers["Content-Length"] = Buffer.byteLength(postData);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    const req = http.request({ ...options, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed,
          body,
        });
      });
    });
    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runSecurityHardeningVerification() {
  console.log("===============================================================");
  console.log("🛡️  BREW PHASE 4.6.3: POST-INCIDENT SECURITY HARDENING SUITE");
  console.log("===============================================================");

  const port = process.env.PORT || 3000;
  const baseUrl = "127.0.0.1";

  // --------------------------------------------------------------------------
  // TEST 1: TypeScript Mandatory Build & Typecheck Gate
  // --------------------------------------------------------------------------
  console.log("\n[Test 1] Verifying Mandatory TypeScript Correctness in next.config.ts...");
  const nextConfigContent = fs.readFileSync("next.config.ts", "utf-8");
  assert(
    nextConfigContent.includes("ignoreBuildErrors: false"),
    "next.config.ts MUST enforce ignoreBuildErrors: false to guarantee type safety in production"
  );
  console.log("   ✓ Verified next.config.ts enforces ignoreBuildErrors: false");

  // --------------------------------------------------------------------------
  // TEST 2: Standalone Startup & Environment Security Configuration
  // --------------------------------------------------------------------------
  console.log("\n[Test 2] Verifying package.json and render.yaml Security Hardening...");
  const pkgJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  assert(
    !pkgJson.scripts["start:standalone"].includes("ALLOW_LOCAL_FALLBACK=true"),
    "Production standalone start script MUST NOT force ALLOW_LOCAL_FALLBACK=true"
  );
  assert(
    pkgJson.scripts["start:standalone"].includes("HOSTNAME=0.0.0.0"),
    "Production standalone start script MUST bind HOSTNAME=0.0.0.0"
  );
  console.log("   ✓ Verified package.json start:standalone does not force local fallback");

  const renderYamlContent = fs.readFileSync("render.yaml", "utf-8");
  assert(
    !renderYamlContent.includes('key: ALLOW_LOCAL_FALLBACK'),
    "render.yaml MUST NOT enable ALLOW_LOCAL_FALLBACK in production"
  );
  assert(
    renderYamlContent.includes('key: BARISTA_PIN\n        sync: false'),
    "render.yaml MUST require BARISTA_PIN to be set securely via dashboard (sync: false)"
  );
  assert(
    renderYamlContent.includes('key: FLEET_ADMIN_PIN\n        sync: false'),
    "render.yaml MUST require FLEET_ADMIN_PIN to be set securely via dashboard (sync: false)"
  );
  console.log("   ✓ Verified render.yaml enforces secret isolation and dashboard entry for staff PINs");

  // --------------------------------------------------------------------------
  // TEST 3: Health Endpoint Dependency Discrimination & Accuracy
  // --------------------------------------------------------------------------
  console.log("\n[Test 3] Testing /api/health Dependency Discrimination & Secret Leaks...");
  const healthRes = await makeRequest({
    hostname: baseUrl,
    port,
    path: "/api/health",
    method: "GET",
  });

  assert.equal(healthRes.statusCode, 200, "/api/health must return HTTP 200");
  const healthData = healthRes.data;
  assert(healthData.checks, "Health response must contain checks object");
  assert(healthData.checks.firestore, "Must contain firestore dependency check");
  assert(healthData.checks.redis, "Must contain redis dependency check");
  assert(healthData.checks.realtimeStore, "Must contain realtimeStore check");
  assert(healthData.checks.processMetrics, "Must contain processMetrics check");

  // Verify external dependencies are accurately labeled (unconfigured or healthy, not falsely hardcoded)
  assert(
    ["healthy", "unconfigured", "unhealthy"].includes(healthData.checks.firestore.status),
    "Firestore check must accurately reflect real connectivity status"
  );
  assert(
    ["healthy", "unconfigured", "unhealthy"].includes(healthData.checks.redis.status),
    "Redis check must accurately reflect real connectivity status"
  );

  // Verify zero secrets leaked
  const healthStr = healthRes.body;
  assert(!healthStr.includes("password"), "Must not leak password");
  assert(!healthStr.includes("secret"), "Must not leak secrets");
  assert(!healthStr.includes("token"), "Must not leak tokens");
  assert(!healthStr.includes("private_key"), "Must not leak private keys");
  console.log("   ✓ Health endpoint accurately discriminates process, realtime, firestore, and redis");
  console.log("   ✓ Zero credentials or internal secrets exposed in health payload");

  // --------------------------------------------------------------------------
  // TEST 4: Staff Authentication Protection & Failed-Login Guardrails
  // --------------------------------------------------------------------------
  console.log("\n[Test 4] Testing Staff Authentication, Failed PIN Protection & Privilege Escalation...");
  
  // 4a. Invalid PIN rejected with HTTP 401
  const invalidPinRes = await makeRequest(
    { hostname: baseUrl, port, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.3.10" } },
    JSON.stringify({ action: "staff_pin", pin: "0000" })
  );
  assert.equal(invalidPinRes.statusCode, 401, "Invalid staff PIN must be rejected with 401");
  assert(!invalidPinRes.body.includes("0000"), "Submitted PIN must never be echoed in response");
  console.log("   ✓ Invalid staff PIN rejected with 401 and not echoed in response");

  // 4b. Privilege escalation: Client trying to self-assign role barista without staff PIN
  const privEscRes = await makeRequest(
    { hostname: baseUrl, port, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.3.11" } },
    JSON.stringify({ role: "barista", user: { uid: "hacker", role: "barista" } })
  );
  assert.equal(privEscRes.statusCode, 403, "Self-assigned staff role must be rejected with 403");
  console.log("   ✓ Privilege escalation strictly blocked with 403 Forbidden");

  // 4c. Valid staff PIN login (in test environment)
  const validBaristaRes = await makeRequest(
    { hostname: baseUrl, port, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.3.12" } },
    JSON.stringify({ action: "staff_pin", pin: "2026" })
  );
  assert.equal(validBaristaRes.statusCode, 200, "Valid test barista PIN must authenticate with 200");
  assert.equal(validBaristaRes.data?.user?.role, "barista", "Authenticated role must be barista");
  assert(!validBaristaRes.body.includes("2026"), "PIN must never be returned in session payload");
  console.log("   ✓ Valid staff PIN authenticated role=barista without leaking PIN in payload");

  // 4d. Verify Logout Revocation
  const sessionCookie = validBaristaRes.headers["set-cookie"]?.[0]?.split(";")[0];
  assert(sessionCookie, "Must set session cookie");

  const logoutRes = await makeRequest(
    { hostname: baseUrl, port, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.3.13" } },
    JSON.stringify({ action: "logout" }),
    sessionCookie
  );
  assert.equal(logoutRes.statusCode, 200, "Logout must succeed with 200");

  // Check session is cleared
  const checkRes = await makeRequest(
    { hostname: baseUrl, port, path: "/api/auth/session", method: "GET", headers: { "x-forwarded-for": "10.46.3.14" } },
    null,
    sessionCookie
  );
  assert.equal(checkRes.data?.authenticated, false, "Revoked session cookie must report authenticated: false");
  console.log("   ✓ Staff logout revokes session and clears authenticated cookie");

  // --------------------------------------------------------------------------
  // TEST 5: Rate Limiting & Sensitive Endpoint Protection Contract
  // --------------------------------------------------------------------------
  console.log("\n[Test 5] Testing Rate Limiting & Sensitive Endpoint Protection...");
  const chatPings = [];
  for (let i = 0; i < 12; i++) {
    chatPings.push(
      makeRequest(
        {
          hostname: baseUrl,
          port,
          path: "/api/barista-chat",
          method: "POST",
          headers: { "x-forwarded-for": "10.46.3.1" },
        },
        JSON.stringify({ message: `Security ping ${i}` })
      )
    );
  }
  const chatResults = await Promise.all(chatPings);
  const accepted = chatResults.filter((r) => r.statusCode === 200).length;
  const limited = chatResults.filter((r) => r.statusCode === 429).length;

  assert.equal(accepted, 10, "Exactly 10 requests accepted under 10/min rate limit");
  assert.equal(limited, 2, "Overflow requests correctly rejected with HTTP 429");
  console.log("   ✓ Rate limiter strictly enforced 10/min threshold with 429 Too Many Requests");

  console.log("\n===============================================================");
  console.log("🎉 ALL PHASE 4.6.3 POST-INCIDENT SECURITY CHECKS PASSED!");
  console.log("===============================================================\n");
}

runSecurityHardeningVerification().catch((err) => {
  console.error("\n❌ PHASE 4.6.3 VERIFICATION FAILED:", err);
  process.exit(1);
});
