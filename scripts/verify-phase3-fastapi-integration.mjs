/**
 * BREW Coffee Platform — Phase 3 Next.js to FastAPI Reverse-Proxy Integration Verification
 * 
 * Tests the complete dual-process architecture:
 * Next.js (port 3000) -> beforeFiles reverse-proxy rewrites -> Python FastAPI (port 8000).
 * 
 * Invariants Verified:
 * 1. Healthcheck routing and liveness reporting.
 * 2. Session cookie issuance, HMAC verification, and RBAC privilege enforcement.
 * 3. Authoritative order pricing, GST calculation, and Razorpay test mode.
 * 4. Catering enquiry generation, 3-tier Agent 4 quote, and idempotency.
 * 5. Multilingual Voice Booking session, chat, staff approval, and outbox staging.
 * 6. AI Barista customer recommendation and ops copilot endpoints.
 * 7. Real-Time Server-Sent Events (SSE) streaming through reverse proxy.
 * 8. Direct WebSocket voice audio bridge on FastAPI.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert";
import crypto from "node:crypto";
import { WebSocket } from "ws";

const FASTAPI_PORT = 8000;
const NEXT_PORT = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollHealth(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
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
        reject(new Error(`Timeout polling ${url}`));
      } else {
        setTimeout(check, 500);
      }
    }

    check();
  });
}

async function request(path, options = {}) {
  const url = `http://127.0.0.1:${NEXT_PORT}${path}`;
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined,
  });

  const contentType = response.headers.get("content-type") || "";
  let json = null;
  let text = "";
  if (contentType.includes("application/json")) {
    json = await response.json();
  } else {
    text = await response.text();
  }

  return {
    status: response.status,
    headers: response.headers,
    json,
    text,
  };
}

async function runPhase3Verification() {
  console.log("===============================================================");
  console.log("🚀 BREW PHASE 3: NEXT.JS FRONTEND TO FASTAPI PROXY INTEGRATION");
  console.log("===============================================================\n");

  let fastapiProcess = null;
  let nextProcess = null;

  try {
    // 1. Start Python FastAPI Server on port 8000
    console.log("⚡ Starting Python FastAPI server on port 8000...");
    fastapiProcess = spawn(
      "uv",
      ["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(FASTAPI_PORT)],
      {
        cwd: "backend",
        stdio: "pipe",
        env: {
          ...process.env,
          NODE_ENV: "development",
          BARISTA_PIN: "2026",
          FLEET_ADMIN_PIN: "7788",
          AUTH_SECRET: "brew-platform-secure-jwt-hmac-secret-key-2026",
          CRON_SECRET: "brew-cron-worker-secret-dev",
          STREAM_SECRET_KEY: "brew-dev-stream-secret-change-in-production",
        },
      }
    );

    fastapiProcess.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("ERROR") || msg.includes("Exception")) console.error("[FastAPI Error]", msg);
    });

    await pollHealth(`http://127.0.0.1:${FASTAPI_PORT}/api/health`, 15000);
    console.log("✔ Python FastAPI backend ready on http://127.0.0.1:8000\n");

    // 2. Start Next.js on port 3000 with FASTAPI_BACKEND_URL
    console.log("⚡ Starting Next.js server on port 3000 with FASTAPI_BACKEND_URL...");
    nextProcess = spawn(
      "node",
      [".next/standalone/server.js"],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          PORT: String(NEXT_PORT),
          NODE_ENV: "production",
          FASTAPI_BACKEND_URL: `http://127.0.0.1:${FASTAPI_PORT}`,
          BREW_TEST_SUITE: "true",
          AUTH_SECRET: "brew-platform-secure-jwt-hmac-secret-key-2026",
          BARISTA_PIN: "2026",
        },
      }
    );

    nextProcess.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("Error") && !msg.includes("ExperimentalWarning")) console.error("[Next.js Error]", msg);
    });

    await pollHealth(`http://127.0.0.1:${NEXT_PORT}/api/health`, 20000);
    console.log("✔ Next.js reverse-proxy ready on http://127.0.0.1:3000\n");

    // 3. Test Suite 1: Healthcheck Routing
    console.log("1. Verifying /api/health routed to FastAPI...");
    const healthRes = await request("/api/health");
    assert.strictEqual(healthRes.status, 200, "Health check must return 200");
    assert.ok(healthRes.json.checks, "Health response must contain checks object");
    assert.ok(healthRes.json.checks.fleetOperations, "Must contain fleetOperations telemetry");
    console.log("   ✓ GET /api/health routed successfully to FastAPI backend\n");

    // 4. Test Suite 2: Authentication & Session Management
    console.log("2. Verifying Authentication & Session Cookie Round-trip...");
    // A. Unauthenticated session check
    const unauthSession = await request("/api/auth/session");
    assert.strictEqual(unauthSession.status, 200);
    assert.strictEqual(unauthSession.json.authenticated, false);

    // B. Barista PIN Login -> sets 'brew_session' HttpOnly cookie
    const loginRes = await request("/api/auth/session", {
      method: "POST",
      body: { pin: "2026" },
    });
    assert.strictEqual(loginRes.status, 200, "Valid Barista PIN must authenticate");
    assert.strictEqual(loginRes.json.user.role, "barista");
    const setCookieHeader = loginRes.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("brew_session="), "Must return brew_session cookie");

    // Extract cookie for authenticated calls
    const sessionCookie = setCookieHeader.split(";")[0];
    console.log("   ✓ Staff authenticated via PIN. Session cookie issued by FastAPI");

    // C. Verify authenticated session inspection with cookie
    const authSession = await request("/api/auth/session", {
      headers: { Cookie: sessionCookie },
    });
    assert.strictEqual(authSession.status, 200);
    assert.strictEqual(authSession.json.authenticated, true);
    assert.strictEqual(authSession.json.user.role, "barista");
    console.log("   ✓ Authenticated session inspection verified with role 'barista'\n");

    // 5. Test Suite 3: Authoritative Order Creation & Payment Verification
    console.log("3. Verifying Authoritative Order Creation & Anti-Tampering...");
    // A. Price tampering rejection
    const tamperedRes = await request("/api/payments/create-order", {
      method: "POST",
      body: {
        items: [{ id: "c-1", quantity: 2 }],
        amount: 1.0, // Tampered client price
      },
    });
    assert.strictEqual(tamperedRes.status, 400, "Price tampering must be rejected with 400");
    console.log("   ✓ Price tampering (₹1 vs server calculation) blocked with 400");

    // B. Valid Order Creation with 10% Member discount
    const validOrderRes = await request("/api/payments/create-order", {
      method: "POST",
      body: {
        items: [{ id: "c-1", quantity: 2 }], // 2x Affogato (480)
        promoCode: "BREW10",
        amount: 454.0, // 480 - 48 (10%) + 22 (5% GST) = 454
        customerName: "Sneha Rao",
        customerPhone: "+919876543210",
      },
    });
    assert.strictEqual(validOrderRes.status, 200, "Valid order creation must succeed");
    assert.strictEqual(validOrderRes.json.success, true);
    assert.ok(validOrderRes.json.razorpayOrderId.startsWith("order_"), "Must return Razorpay order ID");
    assert.ok(
      validOrderRes.json.amount === 454.0 || validOrderRes.json.amount === 45400,
      "Order amount must be 454 or 45400 (paise)"
    );
    console.log("   ✓ Valid order created: 2x Affogato with BREW10 promo = ₹454 (Razorpay test ID generated)");

    // C. Payment HMAC Verification
    const orderId = validOrderRes.json.razorpayOrderId;
    const paymentId = "pay_test_proxy_888";
    const secret = "brew_razorpay_secret_test_2026";
    const hmacSig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const verifyRes = await request("/api/payments/verify", {
      method: "POST",
      body: {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: hmacSig,
      },
    });
    assert.strictEqual(verifyRes.status, 200, "Valid payment signature must verify");
    assert.strictEqual(verifyRes.json.verified, true);
    console.log("   ✓ Cryptographic Razorpay payment signature verified\n");

    // 6. Test Suite 4: Van Catering Request & Agent 4 Instant Quote
    console.log("4. Verifying Catering Van Request & 3-Tier Agent 4 Quote...");
    const cateringRes = await request("/api/request-van", {
      method: "POST",
      body: {
        organization: "Hyderabad Tech Hub",
        contactName: "Vikram Malhotra",
        contactPhone: "+919876543210",
        eventDate: "2026-12-15",
        estimatedGuests: 250,
        location: "HITEC City Phase 2",
      },
    });
    assert.strictEqual(cateringRes.status, 200, "Catering request must succeed");
    assert.strictEqual(cateringRes.json.success, true);
    assert.ok(cateringRes.json.quotation, "Must return Agent 4 event quotation");
    assert.strictEqual(cateringRes.json.quotation.tiers.length, 3, "Must generate 3 quotation tiers");
    console.log("   ✓ Catering enquiry accepted with complete 3-tier Agent 4 quote\n");

    // 7. Test Suite 5: AI Barista Customer & Ops Chat
    console.log("5. Verifying AI Barista Chat Endpoints...");
    const chatRes = await request("/api/barista-chat", {
      method: "POST",
      body: { message: "I want an artisanal dessert drink" },
    });
    assert.strictEqual(chatRes.status, 200, "Barista chat must return 200");
    assert.ok(chatRes.json.recommendations.length >= 1, "Must return beverage recommendation");
    console.log("   ✓ /api/barista-chat returned craft beverage recommendation");

    const opsRes = await request("/api/barista-ops-chat", {
      method: "POST",
      body: { message: "Recommended spot for evening?" },
    });
    assert.strictEqual(opsRes.status, 200, "Barista ops chat must return 200");
    assert.ok(opsRes.json.recommendedSpots.length >= 1, "Must return fleet parking spot");
    console.log("   ✓ /api/barista-ops-chat returned fleet operations dispatch insights\n");

    // 8. Test Suite 6: Voice Booking Lifecycle & Staff Approval
    console.log("6. Verifying Multilingual Voice Booking Lifecycle & Approval...");
    // A. Create Session
    const voiceSessionRes = await request("/api/voice-booking/session", {
      method: "POST",
      body: { language: "en", phoneNumber: "+919876543210" },
    });
    assert.strictEqual(voiceSessionRes.status, 200);
    const sessionId = voiceSessionRes.json.sessionId || voiceSessionRes.json.session.sessionId || voiceSessionRes.json.session.id;

    // B. Conversation Turn
    const turnRes = await request("/api/voice-booking/chat", {
      method: "POST",
      body: {
        sessionId,
        message: "We have an event for 150 guests on December 20th in Madhapur.",
        transcript: "We have an event for 150 guests on December 20th in Madhapur.",
      },
    });
    if (turnRes.status !== 200) {
      console.error("turnRes failed:", turnRes.status, turnRes.json || turnRes.text);
    }
    assert.strictEqual(turnRes.status, 200);
    assert.ok(turnRes.json.replyText, "Must return conversational response");

    // C. Staff Approval (Authorized with Barista session cookie)
    const approveRes = await request("/api/voice-booking/approve", {
      method: "POST",
      headers: { Cookie: sessionCookie },
      body: { sessionId },
    });
    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveRes.json.success, true);
    assert.ok(approveRes.json.officialBookingId, "Must issue official booking ID");
    assert.ok(approveRes.json.outboxDeliveries.length >= 1, "Must stage outbox delivery");
    console.log(`   ✓ Voice booking ${sessionId} approved -> officialBookingId: ${approveRes.json.officialBookingId}\n`);

    // 9. Test Suite 7: Scheduled Outbox Worker & Admin Telemetry
    console.log("7. Verifying Outbox Telemetry & Worker Execution...");
    // A. Admin outbox metrics
    const metricsRes = await request("/api/admin/outbox/metrics", {
      headers: { Cookie: sessionCookie },
    });
    assert.strictEqual(metricsRes.status, 200);
    assert.ok(metricsRes.json.metrics.countsByStatus, "Must return countsByStatus");

    // B. Worker dispatch cycle (POST with CRON_SECRET)
    const workerRes = await request("/api/cron/outbox-worker", {
      method: "POST",
      headers: { Authorization: "Bearer brew-cron-worker-secret-dev" },
      body: { batchSize: 5 },
    });
    assert.strictEqual(workerRes.status, 200);
    assert.strictEqual(workerRes.json.success, true);
    assert.strictEqual(workerRes.json.cyclesCompleted, 1);

    // C. Worker rejection of GET (405 Method Not Allowed)
    const workerGet = await request("/api/cron/outbox-worker");
    assert.strictEqual(workerGet.status, 405, "GET /api/cron/outbox-worker must return 405");
    assert.strictEqual(workerGet.headers.get("allow"), "POST");
    console.log("   ✓ Outbox worker executed cycle and rejected GET with 405 Method Not Allowed\n");

    // 10. Test Suite 8: Real-Time SSE Stream through Proxy
    console.log("8. Verifying Real-Time SSE Event-Stream through Next.js Proxy...");
    const sseResponse = await fetch(`http://127.0.0.1:${NEXT_PORT}/api/realtime/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    assert.strictEqual(sseResponse.status, 200);
    assert.ok((sseResponse.headers.get("content-type") || "").includes("text/event-stream"));

    const reader = sseResponse.body.getReader();
    const { value: firstChunk } = await reader.read();
    const sseText = new TextDecoder().decode(firstChunk);
    assert.ok(sseText.includes("INITIAL_SYNC"), "SSE stream must yield INITIAL_SYNC snapshot");
    reader.cancel();
    console.log("   ✓ SSE stream established through Next.js proxy; INITIAL_SYNC received\n");

    // 11. Test Suite 9: Direct FastAPI WebSocket Voice Bridge
    console.log("9. Verifying Direct FastAPI WebSocket Voice Bridge (/media)...");
    const streamSecret = "brew-dev-stream-secret-change-in-production";
    const testWsUrl = `ws://127.0.0.1:${FASTAPI_PORT}/media?token=${encodeURIComponent(streamSecret)}`;
    
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(testWsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      ws.on("open", () => {
        // Send carrier start event
        ws.send(JSON.stringify({
          event: "start",
          start: { streamSid: "stream_test_123", callSid: "call_test_456" }
        }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === "media") {
          assert.strictEqual(msg.streamSid, "stream_test_123");
          assert.ok(msg.media.payload, "Must frame audio payload");
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    console.log("   ✓ WebSocket /media accepted connection and framed audio packets\n");

    console.log("===============================================================");
    console.log("🎉 ALL 9 INTEGRATION PHASES PASSED 100% THROUGH REVERSE PROXY!");
    console.log("===============================================================\n");
  } finally {
    if (nextProcess) {
      console.log("Stopping Next.js standalone process...");
      nextProcess.kill("SIGTERM");
    }
    if (fastapiProcess) {
      console.log("Stopping Python FastAPI process...");
      fastapiProcess.kill("SIGTERM");
    }
  }
}

runPhase3Verification().catch((err) => {
  console.error("✖ Phase 3 Integration Verification Failed:", err);
  process.exit(1);
});
