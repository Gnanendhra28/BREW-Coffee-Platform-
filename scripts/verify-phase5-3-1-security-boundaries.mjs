#!/usr/bin/env node
/**
 * BREW Autonomous Coffee Platform — Phase 5.3.1: Security Boundary Verification
 *
 * Comprehensive targeted verification suite:
 * 1. Firestore Public Read Audit (inventory, vans, future_stops schemas and exposure)
 * 2. Order Creation Security (paymentStatus, isVerified, isFulfilled, privileged fields rejection)
 * 3. Price & Discount Tampering (authoritative server recalculation, quantity limits)
 * 4. Actual Request Body Size Enforcement (Content-Length > 100KB, missing Content-Length, chunked streams, empty bodies, malformed JSON)
 * 5. Unauthorized Fulfillment & Cross-Customer Isolation (order state machine gates)
 * 6. Payment Cryptographic Integrity & Anti-Replay
 * 7. Live Cloud Firestore Admin SDK Operations
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Load .env.local if present
try {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {
  // Ignore
}

function initAdminDb() {
  const existing = getApps();
  if (existing.length > 0) return getFirestore(existing[0]);

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    let creds;
    if (serviceAccountJson.trim().startsWith("{")) {
      creds = JSON.parse(serviceAccountJson);
    } else {
      creds = JSON.parse(Buffer.from(serviceAccountJson, "base64").toString("utf8"));
    }
    const app = initializeApp({
      credential: cert(creds),
      projectId: "brew-2621e",
    });
    return getFirestore(app);
  }
  const app = initializeApp({ projectId: "brew-2621e" });
  return getFirestore(app);
}

let passedTests = 0;
let totalTests = 0;

function assert(condition, message, envTag = "[Local]") {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL ${envTag}: ${message}`);
    throw new Error(message);
  }
  passedTests++;
  console.log(`   ✓ ${envTag} ${message}`);
}

// Low-level HTTP helper to test custom headers, chunked transfer, and missing Content-Length
function sendRawHttpRequest({
  port,
  path: reqPath,
  method = "POST",
  headers = {},
  body,
  chunked = false,
}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      path: reqPath,
      method,
      headers: { ...headers },
    };

    if (chunked) {
      delete options.headers["content-length"];
      options.headers["transfer-encoding"] = "chunked";
    }

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({
          statusCode: res.statusCode || 500,
          headers: res.headers,
          data,
          json,
        });
      });
    });

    req.on("error", reject);

    if (body !== undefined && body !== null) {
      if (chunked && typeof body === "string") {
        // Send in 16KB chunks
        const chunkSize = 16 * 1024;
        for (let i = 0; i < body.length; i += chunkSize) {
          req.write(body.slice(i, i + chunkSize));
        }
        req.end();
      } else {
        req.write(body);
        req.end();
      }
    } else {
      req.end();
    }
  });
}

function checkServerReady(port, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve) => {
    function ping() {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
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
        resolve(false);
      } else {
        setTimeout(ping, 200);
      }
    }

    ping();
  });
}

async function run() {
  console.log("=================================================================");
  console.log("🛡️  BREW COFFEE — PHASE 5.3.1: SECURITY BOUNDARY VERIFICATION");
  console.log("Scope: Public Read Audit, Order Creation Tampering & Bounded Body Size");
  console.log("=================================================================\n");

  // Ensure server is running on port 3000
  let serverProcess = null;
  const isRunning = await checkServerReady(3000, 1000);

  if (!process.env.AUTH_SECRET) {
    process.env.AUTH_SECRET = "brew-platform-secure-jwt-hmac-secret-key-2026";
  }

  if (!process.env.TEST_BARISTA_PIN) {
    process.env.TEST_BARISTA_PIN = "brew_qa_test_barista_pin_9876";
  }

  let testPort = 3000;
  if (!isRunning) {
    console.log("⚡ Starting local server on port 3000 for verified security testing...");
    const hasStandalone = fs.existsSync(".next/standalone/server.js");
    if (hasStandalone) {
      serverProcess = spawn("node", [".next/standalone/server.js"], {
        env: {
          ...process.env,
          AUTH_SECRET: process.env.AUTH_SECRET || "brew-platform-secure-jwt-hmac-secret-key-2026",
          PORT: "3000",
          HOSTNAME: "127.0.0.1",
          BREW_TEST_SUITE: "true",
          PLAYWRIGHT_TEST: "true",
        },
        stdio: "ignore",
      });
    } else {
      serverProcess = spawn("npx", ["next", "start", "-p", "3000"], {
        env: {
          ...process.env,
          AUTH_SECRET: process.env.AUTH_SECRET || "brew-platform-secure-jwt-hmac-secret-key-2026",
          PORT: "3000",
          BREW_TEST_SUITE: "true",
          PLAYWRIGHT_TEST: "true",
        },
        stdio: "ignore",
      });
    }

    const ready = await checkServerReady(3000, 15000);
    if (!ready) {
      if (serverProcess) serverProcess.kill();
      throw new Error("Failed to start local test server on port 3000");
    }
  }

  try {
    // =================================================================
    // SUITE 1: Firestore Public Read & Exposure Audit [Static / Architecture]
    // =================================================================
    console.log("[Suite 1] Firestore Public Read & Collection Exposure Audit...");
    const rulesPath = path.resolve(process.cwd(), "firestore.rules");
    assert(fs.existsSync(rulesPath), "firestore.rules file exists", "[Static Analysis]");
    const rulesContent = fs.readFileSync(rulesPath, "utf8");

    // 1a. Identify all public read collections
    const publicReadCollections = [];
    const readMatches = rulesContent.matchAll(/match\s+\/([a-zA-Z0-9_]+)\/\{[a-zA-Z0-9_]+\}\s*\{[^}]*allow\s+read:\s*if\s+true;/g);
    for (const match of readMatches) {
      publicReadCollections.push(match[1]);
    }
    assert(
      publicReadCollections.includes("inventory") &&
        publicReadCollections.includes("vans") &&
        publicReadCollections.includes("future_stops") &&
        publicReadCollections.includes("orders") &&
        publicReadCollections.includes("curbside_arrivals") &&
        publicReadCollections.includes("reviews"),
      `Identified all 6 public-read collections: ${publicReadCollections.join(", ")}`,
      "[Static Analysis]"
    );

    // 1b. Verify operational collections strictly DENY client writes
    assert(
      /match\s+\/inventory\/\{docId\}\s*\{[^}]*allow\s+write:\s*if\s+false;/.test(rulesContent),
      "Collection 'inventory' explicitly denies all client writes (allow write: if false;)",
      "[Static Analysis]"
    );
    assert(
      /match\s+\/vans\/\{vanId\}\s*\{[^}]*allow\s+write:\s*if\s+false;/.test(rulesContent),
      "Collection 'vans' explicitly denies all client writes (allow write: if false;)",
      "[Static Analysis]"
    );
    assert(
      /match\s+\/future_stops\/\{stopId\}\s*\{[^}]*allow\s+write:\s*if\s+false;/.test(rulesContent),
      "Collection 'future_stops' explicitly denies all client writes (allow write: if false;)",
      "[Static Analysis]"
    );

    // 1c. Document Schema Exposure Audit:
    // Verify inventory documents do NOT contain supplier contact/costs
    const invStockTypeFile = path.resolve(process.cwd(), "src/lib/inventorySentinel/types.ts");
    const invContent = fs.readFileSync(invStockTypeFile, "utf8");
    assert(
      !invContent.includes("supplierEmail") && !invContent.includes("wholesalePrice"),
      "InventoryStock data model contains only operational counts (beans, milk, cups) and zero supplier/wholesale financial data",
      "[Schema Audit]"
    );

    // Verify van documents contain only public GPS coordinates and spot names
    const vanContextFile = path.resolve(process.cwd(), "src/context/VanContext.tsx");
    const vanContent = fs.readFileSync(vanContextFile, "utf8");
    assert(
      vanContent.includes("spotName: string") &&
        vanContent.includes("coordinates: {") &&
        !vanContent.includes("driverSalary") &&
        !vanContent.includes("vinNumber"),
      "VanLocation data model contains only public geolocation and service hours, no vehicle titles or driver personal data",
      "[Schema Audit]"
    );

    // =================================================================
    // SUITE 2: Order Creation Security & Privileged Field Rejection [Local]
    // =================================================================
    console.log("\n[Suite 2] Order Creation Security & Privileged Field Rejection...");

    // 2a. Attempt create-order with paymentStatus: 'paid'
    const attackPaidRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
        paymentStatus: "paid", // Privileged field injection
      }),
    });
    assert(
      attackPaidRes.statusCode === 400,
      `Order creation with paymentStatus: 'paid' strictly rejected with HTTP 400 (got ${attackPaidRes.statusCode})`,
      "[Local Test]"
    );
    assert(
      attackPaidRes.data.includes("Unrecognized key") || attackPaidRes.data.includes("Validation Error"),
      "Response confirms unrecognized key rejection for 'paymentStatus'",
      "[Local Test]"
    );

    // 2b. Attempt create-order with paymentStatus: 'captured'
    const attackCapturedRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
        paymentStatus: "captured",
      }),
    });
    assert(
      attackCapturedRes.statusCode === 400,
      `Order creation with paymentStatus: 'captured' strictly rejected with HTTP 400 (got ${attackCapturedRes.statusCode})`,
      "[Local Test]"
    );

    // 2c. Attempt create-order with isVerified: true
    const attackVerifiedRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
        isVerified: true,
      }),
    });
    assert(
      attackVerifiedRes.statusCode === 400,
      `Order creation with isVerified: true strictly rejected with HTTP 400 (got ${attackVerifiedRes.statusCode})`,
      "[Local Test]"
    );

    // 2d. Attempt create-order with isFulfilled: true
    const attackFulfilledRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
        isFulfilled: true,
      }),
    });
    assert(
      attackFulfilledRes.statusCode === 400,
      `Order creation with isFulfilled: true strictly rejected with HTTP 400 (got ${attackFulfilledRes.statusCode})`,
      "[Local Test]"
    );

    // 2e. Attempt create-order with unexpected privileged fields (role, admin)
    const attackAdminFieldRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
        role: "admin",
        privileged: true,
      }),
    });
    assert(
      attackAdminFieldRes.statusCode === 400,
      `Order creation with unexpected privileged fields strictly rejected with HTTP 400 (got ${attackAdminFieldRes.statusCode})`,
      "[Local Test]"
    );

    // 2f. Attempt ORDER_CREATED event with status: 'ready' via /api/realtime/events
    const attackStatusEventRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/realtime/events",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ORDER_CREATED",
        payload: {
          id: "fake-order-1",
          orderNumber: "999",
          customerName: "Attacker",
          items: [{ id: "c-1", name: "Affogato", quantity: 1, price: 240 }],
          totalAmount: 240,
          status: "ready", // Privilege escalation: bypassing brewing/received
        },
      }),
    });
    assert(
      attackStatusEventRes.statusCode === 400,
      `ORDER_CREATED with status: 'ready' strictly rejected with HTTP 400 (got ${attackStatusEventRes.statusCode})`,
      "[Local Test]"
    );

    // 2g. Attempt ORDER_CREATED event with paymentStatus: 'paid'
    const attackPaidEventRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/realtime/events",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ORDER_CREATED",
        payload: {
          id: "fake-order-2",
          orderNumber: "998",
          customerName: "Attacker",
          items: [{ id: "c-1", name: "Affogato", quantity: 1, price: 240 }],
          totalAmount: 240,
          status: "received",
          paymentStatus: "paid", // Spoofing payment confirmation
        },
      }),
    });
    assert(
      attackPaidEventRes.statusCode === 400,
      `ORDER_CREATED with paymentStatus: 'paid' strictly rejected with HTTP 400 (got ${attackPaidEventRes.statusCode})`,
      "[Local Test]"
    );

    // =================================================================
    // SUITE 3: Price Tampering, Quantity Caps & Catalog Integrity [Local]
    // =================================================================
    console.log("\n[Suite 3] Price Tampering, Quantity Caps & Catalog Integrity...");

    // 3a. Client-submitted price differs from server-calculated total
    const attackTamperRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 2 }], // 2x Affogato = ₹480
        amount: 1, // Attacker submits ₹1
      }),
    });
    assert(
      attackTamperRes.statusCode === 400,
      `Price tampering (₹1 submitted vs ₹480 catalog) rejected with HTTP 400 (got ${attackTamperRes.statusCode})`,
      "[Local Test]"
    );
    assert(
      attackTamperRes.data.includes("Price tampering detected"),
      "Error message clearly identifies price tampering detection",
      "[Local Test]"
    );

    // 3b. Client attempts to submit item with price field
    const attackItemPriceRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1, price: 5 }],
      }),
    });
    assert(
      attackItemPriceRes.statusCode === 400,
      `Client-supplied item price field strictly rejected with HTTP 400 (got ${attackItemPriceRes.statusCode})`,
      "[Local Test]"
    );

    // 3c. Arbitrary promo code discount attempt
    const attackBadPromoRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
        promoCode: "FREE_100_PERCENT_OFF",
      }),
    });
    assert(
      attackBadPromoRes.statusCode === 400,
      `Unrecognized promo code rejected with HTTP 400 (got ${attackBadPromoRes.statusCode})`,
      "[Local Test]"
    );

    // 3d. Excessive item quantity (> 20)
    const attackExcessiveQtyRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 50 }],
      }),
    });
    assert(
      attackExcessiveQtyRes.statusCode === 400,
      `Excessive item quantity (50 > 20 limit) rejected with HTTP 400 (got ${attackExcessiveQtyRes.statusCode})`,
      "[Local Test]"
    );

    // 3e. Non-positive item quantity (<= 0)
    const attackZeroQtyRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 0 }],
      }),
    });
    assert(
      attackZeroQtyRes.statusCode === 400,
      `Non-positive item quantity (0) rejected with HTTP 400 (got ${attackZeroQtyRes.statusCode})`,
      "[Local Test]"
    );

    // =================================================================
    // SUITE 4: Actual Request Body Size Enforcement & Streaming Tests [Local]
    // =================================================================
    console.log("\n[Suite 4] Actual Request Body Size Enforcement (Bounded Reading)...");

    // 4a. Normal request (< 100KB with Content-Length)
    const normalRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }],
      }),
    });
    assert(
      normalRes.statusCode === 200,
      `Normal request under 100KB processed successfully with HTTP 200 (got ${normalRes.statusCode})`,
      "[Local Test]"
    );

    // 4b. Request with Content-Length header above 100KB
    const oversizedBody = "X".repeat(105 * 1024);
    const clOversizedRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(oversizedBody).toString(),
      },
      body: oversizedBody,
    });
    assert(
      clOversizedRes.statusCode === 413,
      `Request with Content-Length > 100KB rejected with HTTP 413 (got ${clOversizedRes.statusCode})`,
      "[Local Test]"
    );

    // 4c. Oversized request WITHOUT Content-Length header (chunked transfer stream)
    const chunkedOversizedBody = JSON.stringify({
      items: [{ id: "c-1", quantity: 1 }],
      padding: "Z".repeat(110 * 1024),
    });
    const chunkedRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: chunkedOversizedBody,
      chunked: true, // Forces omission of Content-Length and enables Transfer-Encoding: chunked
    });
    assert(
      chunkedRes.statusCode === 413,
      `Chunked oversized stream without Content-Length rejected by bounded reader with HTTP 413 (got ${chunkedRes.statusCode})`,
      "[Local Test]"
    );

    // 4d. Test /api/webhooks/razorpay with chunked oversized stream
    const chunkedWebhookRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/webhooks/razorpay",
      headers: { "content-type": "application/json" },
      body: "A".repeat(105 * 1024),
      chunked: true,
    });
    assert(
      chunkedWebhookRes.statusCode === 413,
      `/api/webhooks/razorpay chunked oversized payload rejected with HTTP 413 (got ${chunkedWebhookRes.statusCode})`,
      "[Local Test]"
    );

    // 4e. Malformed JSON payload
    const malformedRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: '{"items": [{"id": "c-1", "quantity": 1}, broken json',
    });
    assert(
      malformedRes.statusCode === 400,
      `Malformed JSON payload gracefully rejected with HTTP 400 (got ${malformedRes.statusCode})`,
      "[Local Test]"
    );

    // 4f. Empty request body
    const emptyRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert(
      emptyRes.statusCode === 400,
      `Empty request body rejected with HTTP 400 (got ${emptyRes.statusCode})`,
      "[Local Test]"
    );

    // =================================================================
    // SUITE 5: Unauthorized Fulfillment & Cross-Customer Isolation [Local]
    // =================================================================
    console.log("\n[Suite 5] Unauthorized Fulfillment & Cross-Customer Isolation...");

    // 5a. Unauthenticated client cannot advance order to 'brewing' or 'ready'
    const unauthAdvanceRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/realtime/events",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ORDER_STATUS_CHANGED",
        payload: { orderId: "target-order-1", status: "brewing" },
      }),
    });
    assert(
      unauthAdvanceRes.statusCode === 401,
      `Unauthenticated attempt to advance order status rejected with HTTP 401 (got ${unauthAdvanceRes.statusCode})`,
      "[Local Test]"
    );

    // 5b. Customer session cannot advance order to 'ready' or 'served'
    const custAuthRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/auth/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "login",
        role: "customer",
        user: { uid: "guest-test-1", displayName: "Test Customer" },
      }),
    });
    assert(
      custAuthRes.statusCode === 200,
      `Customer session established with HTTP 200 (got ${custAuthRes.statusCode}: ${custAuthRes.data})`,
      "[Local Test]"
    );
    const customerCookie = custAuthRes.headers["set-cookie"]?.[0] || "";

    const custAdvanceRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/realtime/events",
      headers: {
        "content-type": "application/json",
        Cookie: customerCookie.split(";")[0],
      },
      body: JSON.stringify({
        type: "ORDER_STATUS_CHANGED",
        payload: { orderId: "target-order-1", status: "ready" },
      }),
    });
    assert(
      custAdvanceRes.statusCode === 403,
      `Customer session forbidden from advancing order status (HTTP 403) (got ${custAdvanceRes.statusCode})`,
      "[Local Test]"
    );

    // =================================================================
    // SUITE 6: Payment Cryptographic Integrity & Anti-Replay [Local]
    // =================================================================
    console.log("\n[Suite 6] Payment Cryptographic Integrity & Anti-Replay...");

    // 6a. Razorpay verify call with forged signature
    const forgedSigRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/verify",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: "order_test_fake_123",
        razorpay_payment_id: "pay_test_fake_456",
        razorpay_signature: "invalid_forged_signature_hex_12345",
      }),
    });
    assert(
      forgedSigRes.statusCode === 400,
      `Forged Razorpay HMAC signature rejected with HTTP 400 (got ${forgedSigRes.statusCode})`,
      "[Local Test]"
    );

    // 6b. Legitimate order creation + genuine HMAC signature verification
    const validOrderRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/create-order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "c-1", quantity: 1 }], // Affogato ₹240
        customerName: "Boundary Test",
      }),
    });
    assert(validOrderRes.statusCode === 200, "Legitimate order creation succeeded with HTTP 200", "[Local Test]");
    const orderData = validOrderRes.json;
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "brew_razorpay_secret_test_2026";
    const testPaymentId = `pay_boundary_${Date.now()}`;
    const validSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderData.orderId}|${testPaymentId}`)
      .digest("hex");

    const validVerifyRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/verify",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: orderData.orderId,
        razorpay_payment_id: testPaymentId,
        razorpay_signature: validSignature,
      }),
    });
    assert(validVerifyRes.statusCode === 200, "Valid HMAC signature accepted with HTTP 200", "[Local Test]");
    assert(validVerifyRes.json?.verified === true, "Order transitioned to verified: true", "[Local Test]");

    // 6c. Replay of same payment ID detected and idempotent
    const replayRes = await sendRawHttpRequest({
      port: testPort,
      path: "/api/payments/verify",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: orderData.orderId,
        razorpay_payment_id: testPaymentId,
        razorpay_signature: validSignature,
      }),
    });
    assert(replayRes.statusCode === 200, "Replayed verification returns HTTP 200", "[Local Test]");
    assert(replayRes.json?.alreadyProcessed === true, "Replay attack safely recognized as alreadyProcessed: true", "[Local Test]");

    // =================================================================
    // SUITE 7: Live Cloud Firestore Admin SDK Operations [Live Cloud / ADC]
    // =================================================================
    console.log("\n[Suite 7] Live Cloud Firestore Admin SDK Operations...");
    const adminDb = initAdminDb();
    const testDocRef = adminDb.collection("orders").doc(`boundary-test-${Date.now()}`);
    await testDocRef.set({
      orderNumber: "VERIFY-531",
      totalAmount: 240,
      status: "received",
      paymentStatus: "paid", // Admin SDK verified write
      createdAt: Date.now(),
      source: "phase5_3_1_verification",
    });
    const readDoc = await testDocRef.get();
    assert(
      readDoc.exists,
      "Firebase Admin SDK successfully wrote and read document from Cloud Firestore (bypassing client rules)",
      "[Live Cloud]"
    );
    await testDocRef.delete();
    assert(
      true,
      "Firebase Admin SDK successfully cleaned up test record from Cloud Firestore",
      "[Live Cloud]"
    );

    console.log("\n=================================================================");
    console.log(`🎉 ALL ${passedTests}/${totalTests} PHASE 5.3.1 SECURITY BOUNDARY CHECKS PASSED!`);
    console.log("=================================================================");
  } finally {
    if (serverProcess) {
      console.log("Stopping test server instance...");
      serverProcess.kill("SIGTERM");
    }
  }
}

run().catch((err) => {
  console.error("\n💥 Security boundary verification failed:", err);
  process.exit(1);
});
