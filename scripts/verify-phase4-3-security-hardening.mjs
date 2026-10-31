// ==============================================================================
// BREW PLATFORM — PHASE 4.6.5: FINAL TEST ISOLATION & LIVE REDIS VERIFICATION
// ==============================================================================

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

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

function waitForServer(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200 || res.statusCode === 503) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on("error", () => retry());
      req.end();
    }
    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server on port ${port} did not respond within ${timeoutMs}ms`));
      } else {
        setTimeout(ping, 200);
      }
    }
    ping();
  });
}

async function runSecurityHardeningVerification() {
  console.log("===============================================================");
  console.log("🛡️  BREW PHASE 4.6.5: FINAL TEST ISOLATION & LIVE REDIS VERIFICATION");
  console.log("===============================================================");

  // Mandatory Test Variable Isolation Gate (Requirement: Fail immediately if missing)
  const activeTestBaristaPin = process.env.TEST_BARISTA_PIN;
  if (!activeTestBaristaPin) {
    throw new Error(
      "[TEST ISOLATION CRITICAL] Missing mandatory TEST_BARISTA_PIN environment variable! " +
      "Automated tests must never fall back to development defaults (2026) or use production PINs."
    );
  }
  assert(
    activeTestBaristaPin !== "2026" && activeTestBaristaPin !== "7788",
    "[SECURITY INTEGRITY CRITICAL] TEST_BARISTA_PIN cannot be development PINs (2026, 7788). " +
    "A dedicated, unique test credential must be injected into the test environment."
  );

  const mainPort = process.env.PORT || 3000;
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
  console.log("   ✓ Verified package.json start:standalone binds 0.0.0.0 without fallback override");

  const renderYamlContent = fs.readFileSync("render.yaml", "utf-8");
  assert(
    !renderYamlContent.includes("key: ALLOW_LOCAL_FALLBACK"),
    "render.yaml MUST NOT enable ALLOW_LOCAL_FALLBACK in production"
  );
  assert(
    renderYamlContent.includes("key: BARISTA_PIN\n        sync: false"),
    "render.yaml MUST require BARISTA_PIN to be set securely via dashboard (sync: false)"
  );
  assert(
    renderYamlContent.includes("key: FLEET_ADMIN_PIN\n        sync: false"),
    "render.yaml MUST require FLEET_ADMIN_PIN to be set securely via dashboard (sync: false)"
  );
  console.log("   ✓ Verified render.yaml enforces secret isolation and dashboard entry for staff PINs");

  // --------------------------------------------------------------------------
  // TEST 3: Health Endpoint Accuracy, Fleet Labeling & Secret Leaks
  // --------------------------------------------------------------------------
  console.log("\n[Test 3] Testing /api/health Accuracy, Fleet Labeling & Secret Leaks...");
  const healthRes = await makeRequest({
    hostname: baseUrl,
    port: mainPort,
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

  // Verify fleet operations data is explicitly labeled as configuration baseline
  assert.equal(
    healthData.checks.fleetOperations?.mode,
    "demonstration_baseline",
    "fleetOperations must be explicitly labeled as demonstration_baseline"
  );
  assert.equal(
    healthData.checks.fleetOperations?.dataSource,
    "configuration_baseline",
    "fleetOperations must specify dataSource: configuration_baseline"
  );
  assert.equal(
    healthData.checks.fleetOperations?.activeVans,
    3,
    "fleetOperations maintains activeVans: 3 baseline"
  );

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
  console.log("   ✓ Health endpoint accurately discriminates dependencies and labels fleet baseline");
  console.log("   ✓ Zero credentials or internal secrets exposed in health payload");

  // --------------------------------------------------------------------------
  // TEST 4: Staff Authentication Security & Test Credential Isolation
  // --------------------------------------------------------------------------
  console.log("\n[Test 4] Testing Staff Authentication with Isolated Test Credentials...");
  
  // 4a. Invalid PIN rejected with HTTP 401
  const invalidPinRes = await makeRequest(
    { hostname: baseUrl, port: mainPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.4.10" } },
    JSON.stringify({ action: "staff_pin", pin: "0000" })
  );
  assert.equal(invalidPinRes.statusCode, 401, "Invalid staff PIN must be rejected with 401");
  assert(!invalidPinRes.body.includes("0000"), "Submitted PIN must never be echoed in response");
  console.log("   ✓ Invalid staff PIN rejected with 401 and not echoed in response");

  // 4b. Privilege escalation: Client trying to self-assign role barista without staff PIN
  const privEscRes = await makeRequest(
    { hostname: baseUrl, port: mainPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.4.11" } },
    JSON.stringify({ role: "barista", user: { uid: "hacker", role: "barista" } })
  );
  assert.equal(privEscRes.statusCode, 403, "Self-assigned staff role must be rejected with 403");
  console.log("   ✓ Privilege escalation strictly blocked with 403 Forbidden");

  // 4c. Valid staff authentication using mandatory isolated test credential
  const validBaristaRes = await makeRequest(
    { hostname: baseUrl, port: mainPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.4.12" } },
    JSON.stringify({ action: "staff_pin", pin: activeTestBaristaPin })
  );
  assert.equal(validBaristaRes.statusCode, 200, "Valid test barista PIN must authenticate with 200");
  assert.equal(validBaristaRes.data?.user?.role, "barista", "Authenticated role must be barista");
  assert(!validBaristaRes.body.includes(activeTestBaristaPin), "PIN must never be returned in session payload");
  console.log("   ✓ Valid staff PIN authenticated role=barista without leaking PIN in payload");

  // 4d. Verify Logout Revocation
  const sessionCookie = validBaristaRes.headers["set-cookie"]?.[0]?.split(";")[0];
  assert(sessionCookie, "Must set session cookie");

  const logoutRes = await makeRequest(
    { hostname: baseUrl, port: mainPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.4.13" } },
    JSON.stringify({ action: "logout" }),
    sessionCookie
  );
  assert.equal(logoutRes.statusCode, 200, "Logout must succeed with 200");

  // Check session is cleared
  const checkRes = await makeRequest(
    { hostname: baseUrl, port: mainPort, path: "/api/auth/session", method: "GET", headers: { "x-forwarded-for": "10.46.4.14" } },
    null,
    sessionCookie
  );
  assert.equal(checkRes.data?.authenticated, false, "Revoked session cookie must report authenticated: false");
  console.log("   ✓ Staff logout revokes session and clears authenticated cookie");

  // --------------------------------------------------------------------------
  // TEST 5: Production Fail-Closed Rate Limiting via Isolated Standalone Server
  // --------------------------------------------------------------------------
  console.log("\n[Test 5] Testing Production Fail-Closed on Missing & Unavailable Redis...");

  const prodPort = 3015;
  console.log(`   -> Spawning isolated production server on port ${prodPort} (Missing Redis Credentials)...`);
  
  // Clean environment for production test: no BREW_TEST_SUITE, no PLAYWRIGHT_TEST, no Redis env vars
  const cleanProdEnv = { ...process.env };
  delete cleanProdEnv.BREW_TEST_SUITE;
  delete cleanProdEnv.PLAYWRIGHT_TEST;
  delete cleanProdEnv.UPSTASH_REDIS_REST_URL;
  delete cleanProdEnv.UPSTASH_REDIS_REST_TOKEN;
  cleanProdEnv.NODE_ENV = "production";
  cleanProdEnv.ALLOW_LOCAL_FALLBACK = "true"; // Deliberately set to test that production blocks bypass!
  cleanProdEnv.PORT = String(prodPort);
  cleanProdEnv.HOSTNAME = "127.0.0.1";

  const prodServer = spawn("node", [".next/standalone/server.js"], {
    env: cleanProdEnv,
    stdio: "pipe",
  });

  try {
    await waitForServer(prodPort, 8000);

    // Test all 4 sensitive endpoints on the isolated production instance (Missing Credentials):
    // 1. /api/auth/session
    const authRes = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/auth/session", method: "POST" },
      JSON.stringify({ action: "staff_pin", pin: "test" })
    );
    assert.equal(authRes.statusCode, 503, "/api/auth/session must fail-closed with 503 when Redis is unconfigured in production");
    assert(authRes.data?.error?.includes("temporarily unavailable"), "Expected 503 rate limiter unavailable error");

    // 2. /api/payments/create-order
    const orderRes = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/payments/create-order", method: "POST" },
      JSON.stringify({ items: [{ id: "c-1", quantity: 1 }] })
    );
    assert.equal(orderRes.statusCode, 503, "/api/payments/create-order must fail-closed with 503 in production without Redis");

    // 3. /api/request-van
    const vanRes = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/request-van", method: "POST" },
      JSON.stringify({ contact: "test@corp.in" })
    );
    assert.equal(vanRes.statusCode, 503, "/api/request-van must fail-closed with 503 in production without Redis");

    // 4. /api/realtime/events
    const eventRes = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/realtime/events", method: "POST" },
      JSON.stringify({ type: "ORDER_CREATED", payload: {} })
    );
    assert.equal(eventRes.statusCode, 503, "/api/realtime/events must fail-closed with 503 in production without Redis");

    console.log("   ✓ Verified all 4 sensitive endpoints fail-closed with HTTP 503 when Redis credentials missing");
    console.log("   ✓ Verified ALLOW_LOCAL_FALLBACK=true is strictly ignored in production (zero bypass)");
  } finally {
    prodServer.kill();
  }

  // --------------------------------------------------------------------------
  // TEST 5b: Production Fail-Closed on Redis OUTAGE (Unreachable Host / Port)
  // --------------------------------------------------------------------------
  console.log(`\n   -> Spawning isolated production server on port ${prodPort} (Redis OUTAGE simulation)...`);
  const outageProdEnv = { ...cleanProdEnv };
  // Port 1 on 127.0.0.1 will immediately trigger ECONNREFUSED
  outageProdEnv.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  outageProdEnv.UPSTASH_REDIS_REST_TOKEN = "unreachable_token";

  const outageServer = spawn("node", [".next/standalone/server.js"], {
    env: outageProdEnv,
    stdio: "pipe",
  });

  try {
    await waitForServer(prodPort, 8000);

    const outageAuth = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/auth/session", method: "POST" },
      JSON.stringify({ action: "staff_pin", pin: "test" })
    );
    assert.equal(outageAuth.statusCode, 503, "/api/auth/session must return 503 during Redis outage");

    const outageOrder = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/payments/create-order", method: "POST" },
      JSON.stringify({ items: [{ id: "c-1", quantity: 1 }] })
    );
    assert.equal(outageOrder.statusCode, 503, "/api/payments/create-order must return 503 during Redis outage");

    const outageVan = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/request-van", method: "POST" },
      JSON.stringify({ contact: "test@corp.in" })
    );
    assert.equal(outageVan.statusCode, 503, "/api/request-van must return 503 during Redis outage");

    const outageEvent = await makeRequest(
      { hostname: baseUrl, port: prodPort, path: "/api/realtime/events", method: "POST" },
      JSON.stringify({ type: "ORDER_CREATED", payload: {} })
    );
    assert.equal(outageEvent.statusCode, 503, "/api/realtime/events must return 503 during Redis outage");

    console.log("   ✓ Verified all 4 sensitive endpoints fail-closed with HTTP 503 during simulated Redis outage");
  } finally {
    outageServer.kill();
  }

  // --------------------------------------------------------------------------
  // TEST 6: Atomic Upstash Redis Rate Limiting & Lua Contract (Mock Integration)
  // --------------------------------------------------------------------------
  console.log("\n[Test 6] Testing Atomic Upstash Redis Rate Limiting (Mock Integration)...");

  let serverReceivedScript = "";
  const keyCounters = new Map();

  const mockRedisServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/eval") {
        const payload = JSON.parse(body);
        serverReceivedScript = payload.script;
        const key = payload.keys?.[0] || "default_key";
        const current = (keyCounters.get(key) || 0) + 1;
        keyCounters.set(key, current);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: [current, 60] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise((resolve) => mockRedisServer.listen(0, "127.0.0.1", resolve));
  const mockPort = mockRedisServer.address().port;

  const redisProdPort = 3016;
  const redisProdEnv = { ...cleanProdEnv };
  redisProdEnv.PORT = String(redisProdPort);
  redisProdEnv.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${mockPort}`;
  redisProdEnv.UPSTASH_REDIS_REST_TOKEN = "test-token-active";

  const redisServer = spawn("node", [".next/standalone/server.js"], {
    env: redisProdEnv,
    stdio: "pipe",
  });

  try {
    await waitForServer(redisProdPort, 8000);

    // Call 1: verify operational Redis allows request through to auth validation
    const activeRedisRes = await makeRequest(
      { hostname: baseUrl, port: redisProdPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.5.1" } },
      JSON.stringify({ action: "staff_pin", pin: "0000" })
    );

    assert.equal(activeRedisRes.statusCode, 401, "Rate limiter permitted request through operational Redis to auth validation");
    assert(serverReceivedScript.includes("redis.call('INCR'"), "Must execute atomic INCR in Lua script");
    assert(serverReceivedScript.includes("redis.call('EXPIRE'"), "Must execute conditional EXPIRE in Lua script");
    assert(serverReceivedScript.includes("redis.call('TTL'"), "Must execute atomic TTL in Lua script");
    console.log("   ✓ Verified operational Redis permits sensitive requests without 503");
    console.log("   ✓ Verified atomic Lua script contract (/eval with INCR, conditional EXPIRE, TTL)");

    // Multiple requests sharing the same Redis counter:
    // Make 3 additional requests from the same IP (10.46.5.1) and verify the Redis counter increases
    const clientKey = "ratelimit:auth-session:10.46.5.1";
    for (let i = 0; i < 3; i++) {
      await makeRequest(
        { hostname: baseUrl, port: redisProdPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.5.1" } },
        JSON.stringify({ action: "staff_pin", pin: "0000" })
      );
    }
    const finalCount = keyCounters.get(clientKey);
    assert(finalCount >= 4, `Redis shared counter must be >= 4, actual: ${finalCount}`);
    console.log(`   ✓ Verified multiple requests share the same Redis counter (current count: ${finalCount})`);

    // Verify rate limit enforcement when counter exceeds limit:
    // Set counter to 16 (> limit of 15 for /api/auth/session)
    keyCounters.set("ratelimit:auth-session:10.46.5.99", 16);
    const blockedRes = await makeRequest(
      { hostname: baseUrl, port: redisProdPort, path: "/api/auth/session", method: "POST", headers: { "x-forwarded-for": "10.46.5.99" } },
      JSON.stringify({ action: "staff_pin", pin: "0000" })
    );
    assert.equal(blockedRes.statusCode, 429, "Exceeded rate limit must return HTTP 429 Too Many Requests");
    console.log("   ✓ Verified rate-limit enforcement across independent requests (HTTP 429 returned)");
  } finally {
    redisServer.kill();
    mockRedisServer.close();
  }

  // --------------------------------------------------------------------------
  // TEST 7: Real Cloud Upstash Redis Verification (Live Network Audit)
  // --------------------------------------------------------------------------
  console.log("\n[Test 7] Testing Real Cloud Upstash Connectivity & REST Verification...");
  const realCloudUrl = process.env.UPSTASH_REDIS_REST_URL;
  const realCloudToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (realCloudUrl && realCloudToken && !realCloudUrl.includes("127.0.0.1") && !realCloudUrl.includes("localhost")) {
    console.log("   -> Real cloud Upstash credentials detected in environment. Performing live cloud audit...");
    try {
      const pingRes = await fetch(`${realCloudUrl}/ping`, {
        method: "GET",
        headers: { Authorization: `Bearer ${realCloudToken}` },
        signal: AbortSignal.timeout(5000),
      });
      assert(pingRes.ok, `Real Upstash REST /ping returned HTTP ${pingRes.status}`);
      const pingData = await pingRes.json();
      assert.equal(pingData.result, "PONG", "Real Upstash REST must respond with PONG");
      console.log("   ✓ [Real Cloud Upstash] Direct REST connectivity confirmed (PONG received)");

      // Test atomic Lua execution on an ephemeral test key
      const testKey = `brew:qa:test:${Date.now()}`;
      const evalRes = await fetch(`${realCloudUrl}/eval`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${realCloudToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          script: "local c = redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 10); return c;",
          keys: [testKey],
          args: [],
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert(evalRes.ok, `Real Upstash /eval returned HTTP ${evalRes.status}`);
      const evalData = await evalRes.json();
      assert.equal(evalData.result, 1, "Real Upstash atomic Lua execution returned expected counter");
      console.log("   ✓ [Real Cloud Upstash] Atomic Lua execution verified on cloud database");

      // Cleanup test key
      await fetch(`${realCloudUrl}/del/${testKey}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${realCloudToken}` },
      });
    } catch (cloudErr) {
      console.error("   ✖ [Real Cloud Upstash] Live cloud verification failed:", cloudErr.message);
      throw cloudErr;
    }
  } else {
    console.log("   ℹ [Real Cloud Upstash] UPSTASH_REDIS_REST_URL not configured in local environment.");
    console.log("     (Note: Production Render deployment must configure UPSTASH_REDIS_REST_URL via dashboard)");
  }

  console.log("\n===============================================================");
  console.log("🎉 ALL PHASE 4.6.5 SECURITY TEST INTEGRITY CHECKS PASSED!");
  console.log("===============================================================\n");
}

runSecurityHardeningVerification().catch((err) => {
  console.error("\n❌ PHASE 4.6.5 VERIFICATION FAILED:", err);
  process.exit(1);
});
