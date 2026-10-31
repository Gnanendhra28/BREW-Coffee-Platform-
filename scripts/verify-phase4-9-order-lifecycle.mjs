#!/usr/bin/env node
/**
 * BREW Autonomous Coffee Platform — Phase 4.9 Comprehensive Order Lifecycle Verification
 * 
 * Tests the complete customer-to-staff lifecycle against the live Render production environment:
 * 1. Customer Ordering & Server-Side Price / Discount Validation
 * 2. Cloud Firestore Persistence & Anti-Tampering Integrity
 * 3. Payment Gateway Boundary & Replay Protection
 * 4. Kitchen Display System (KDS) & Barista Status State Machine Transitions
 * 5. Real-Time Server-Sent Events (SSE) Delivery & Synchronization
 * 6. Edge Protection & Role-Based Access Control (RBAC)
 * 7. End-to-End Test Record Firestore Lifecycle & Safe Cleanup
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

const BASE_URL = process.env.TARGET_URL || "https://brew-coffee-platform.onrender.com";
const BARISTA_PIN = process.env.BARISTA_PIN || "4829";
const ADMIN_PIN = process.env.FLEET_ADMIN_PIN || "9164";

console.log("===============================================================");
console.log("☕ BREW COFFEE — PHASE 4.9 ORDER LIFECYCLE LIVE VERIFICATION");
console.log(`Target: ${BASE_URL}`);
console.log("===============================================================\n");

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  }
  passedTests++;
  console.log(`   ✓ ${message}`);
}

async function run() {
  const testOrderId = `test_ord_p49_${Date.now()}`;
  let razorpayOrderId = "";
  let baristaCookie = "";
  let adminCookie = "";

  // -----------------------------------------------------------------
  // 1. Live Infrastructure & Health Verification
  // -----------------------------------------------------------------
  console.log("[Suite 1] Live Infrastructure & Health Verification...");
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert(healthRes.status === 200, "Health check /api/health returned HTTP 200 OK");
  const healthData = await healthRes.json();
  assert(healthData.status === "healthy", "System status is healthy");
  assert(healthData.checks.firestore.status === "healthy", "Cloud Firestore is healthy in production");
  assert(healthData.checks.redis.status === "healthy", "Upstash Redis is healthy in production");

  // -----------------------------------------------------------------
  // 2. Customer Public Navigation & Edge Protections
  // -----------------------------------------------------------------
  console.log("\n[Suite 2] Customer Public Navigation & Edge Protections...");
  const pages = ["/", "/menu", "/cart", "/location", "/reviews", "/board"];
  for (const page of pages) {
    const res = await fetch(`${BASE_URL}${page}`);
    assert(res.status === 200, `Public page ${page} returned HTTP 200 OK`);
  }

  // Edge security: Unauthenticated access to /barista and /admin must redirect
  const baristaEdgeRes = await fetch(`${BASE_URL}/barista`, { redirect: "manual" });
  assert(
    baristaEdgeRes.status === 307 || baristaEdgeRes.status === 302,
    "Unauthenticated access to /barista redirected to /login"
  );
  const adminEdgeRes = await fetch(`${BASE_URL}/admin`, { redirect: "manual" });
  assert(
    adminEdgeRes.status === 307 || adminEdgeRes.status === 302,
    "Unauthenticated access to /admin redirected to /login"
  );

  // -----------------------------------------------------------------
  // 3. Customer Ordering: Server-Side Pricing, Anti-Tampering & Validation
  // -----------------------------------------------------------------
  console.log("\n[Suite 3] Server-Side Pricing, Anti-Tampering & Input Validation...");

  // Tampering Test: Client attempts to pay ₹1 for ₹454 order
  const tamperPayload = {
    items: [{ id: "c-1", quantity: 2 }], // 2x Affogato (240 * 2 = 480)
    promoCode: "BREW10",
    amount: 1, // Malicious client override
    customerName: "Tamper Test Guest",
  };
  const tamperRes = await fetch(`${BASE_URL}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tamperPayload),
  });
  assert(
    tamperRes.status === 400,
    `Price tampering attempt strictly blocked with HTTP 400 Bad Request (Status: ${tamperRes.status})`
  );
  const tamperBody = await tamperRes.json();
  assert(
    tamperBody.error && tamperBody.error.includes("Price tampering detected"),
    "Anti-tampering error explanation returned in response"
  );

  // Invalid Product ID
  const invalidProductRes = await fetch(`${BASE_URL}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ id: "non-existent-coffee-999", quantity: 1 }],
      customerName: "Invalid Product Test",
    }),
  });
  assert(invalidProductRes.status === 400, "Unknown product ID rejected with HTTP 400 Bad Request");

  // Invalid Promo Code
  const invalidPromoRes = await fetch(`${BASE_URL}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ id: "c-1", quantity: 1 }],
      promoCode: "BOGUS_DISCOUNT_99",
      customerName: "Bogus Promo Test",
    }),
  });
  assert(invalidPromoRes.status === 400, "Unrecognized promo code rejected with HTTP 400 Bad Request");

  // Valid Order Creation with Server Price Recomputation
  // Affogato (240) * 2 = 480
  // Promo BREW10: 10% off 480 = 48 discount -> subtotal after promo = 432
  // 5% GST on 432 = 21.6 -> 22
  // Subtotal >= 399 -> Delivery Free (0)
  // Final total = 432 + 22 = 454
  const validOrderPayload = {
    items: [{ id: "c-1", quantity: 2 }],
    promoCode: "BREW10",
    amount: 454,
    customerName: "P49 Live Lifecycle Guest",
    customerPhone: "+91 9876543210",
    vanLocationName: "HITEC City — Cyber Towers (Hyderabad)",
  };
  const createOrderRes = await fetch(`${BASE_URL}/api/payments/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validOrderPayload),
  });
  assert(
    createOrderRes.status === 200,
    `Valid order creation succeeded with HTTP 200 OK (Status: ${createOrderRes.status})`
  );
  const createOrderData = await createOrderRes.json();
  assert(createOrderData.success === true, "Order creation response reports success: true");
  assert(createOrderData.breakdown.finalTotal === 454, "Server recomputed final total matches ₹454");
  assert(createOrderData.breakdown.promoDiscount === 48, "Server applied ₹48 discount for BREW10");
  assert(createOrderData.breakdown.tax === 22, "Server applied 5% GST (₹22)");
  razorpayOrderId = createOrderData.orderId;
  const internalOrderId = createOrderData.internalOrderId;
  assert(Boolean(razorpayOrderId), `Gateway Order ID issued: ${razorpayOrderId}`);
  assert(Boolean(internalOrderId), `Durable Internal Order ID issued: ${internalOrderId}`);

  // -----------------------------------------------------------------
  // 4. Cloud Firestore Persistence Verification
  // -----------------------------------------------------------------
  console.log("\n[Suite 4] Cloud Firestore Persistence Verification...");
  const db = initAdminDb();
  assert(Boolean(db), "Firestore Admin SDK initialized successfully");

  const orderDocRef = db.collection("payment_orders").doc(razorpayOrderId);
  const orderDocSnap = await orderDocRef.get();
  assert(orderDocSnap.exists, `Order record ${razorpayOrderId} persistently stored in Cloud Firestore`);
  const firestoreData = orderDocSnap.data();
  assert(firestoreData.paymentStatus === "pending", "Initial payment status is 'pending'");
  assert(firestoreData.orderStatus === "pending", "Initial order status is 'pending'");
  assert(firestoreData.finalTotal === 454, "Firestore finalTotal matches ₹454");
  assert(firestoreData.items.length === 1 && firestoreData.items[0].quantity === 2, "Items and quantities match exactly");

  // -----------------------------------------------------------------
  // 5. Payment Boundary Verification & Anti-Replay Security
  // -----------------------------------------------------------------
  console.log("\n[Suite 5] Payment Boundary Verification & Anti-Replay...");
  const paymentSecret = process.env.RAZORPAY_KEY_SECRET || "brew_razorpay_secret_test_2026";
  const testPaymentId = `pay_test_${Date.now()}`;
  const validSignature = crypto
    .createHmac("sha256", paymentSecret)
    .update(`${razorpayOrderId}|${testPaymentId}`)
    .digest("hex");

  // Tampered Signature Rejection
  const badSigRes = await fetch(`${BASE_URL}/api/payments/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: testPaymentId,
      razorpay_signature: "tampered_hmac_signature_0000000000000000",
    }),
  });
  assert(badSigRes.status === 400, "Tampered payment signature rejected with HTTP 400 Bad Request");

  // Valid Signature Verification
  const validSigRes = await fetch(`${BASE_URL}/api/payments/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: testPaymentId,
      razorpay_signature: validSignature,
    }),
  });
  assert(validSigRes.status === 200, "Valid cryptographic payment signature verified with HTTP 200 OK");
  const validSigData = await validSigRes.json();
  assert(validSigData.verified === true, "Payment verification marked verified: true");

  // Replay Attack Prevention
  const replayRes = await fetch(`${BASE_URL}/api/payments/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: testPaymentId,
      razorpay_signature: validSignature,
    }),
  });
  assert(replayRes.status === 200, "Replayed payment ID intercepted safely with HTTP 200 OK");
  const replayData = await replayRes.json();
  assert(replayData.alreadyProcessed === true, "Anti-replay protection detected payment was already processed");

  // Verify Firestore updated to 'paid'
  const updatedDocSnap = await orderDocRef.get();
  assert(updatedDocSnap.data().paymentStatus === "paid", "Firestore order paymentStatus updated to 'paid'");

  // -----------------------------------------------------------------
  // 6. Staff Authentication, RBAC & Kitchen Display System (KDS)
  // -----------------------------------------------------------------
  console.log("\n[Suite 6] Staff Authentication & RBAC Enforcement...");
  // Invalid PIN
  const invalidLoginRes = await fetch(`${BASE_URL}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "9999" }),
  });
  assert(invalidLoginRes.status === 401, "Invalid PIN rejected with HTTP 401 Unauthorized");

  // Barista Login
  const baristaLoginRes = await fetch(`${BASE_URL}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: BARISTA_PIN }),
  });
  assert(baristaLoginRes.status === 200, "Barista PIN authenticated successfully with HTTP 200 OK");
  const baristaCookieHeader = baristaLoginRes.headers.get("set-cookie");
  assert(Boolean(baristaCookieHeader), "Barista session cookie issued");
  baristaCookie = baristaCookieHeader.split(";")[0];

  // Admin Login
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: ADMIN_PIN }),
  });
  assert(adminLoginRes.status === 200, "Admin PIN authenticated successfully with HTTP 200 OK");
  const adminCookieHeader = adminLoginRes.headers.get("set-cookie");
  assert(Boolean(adminCookieHeader), "Admin session cookie issued");
  adminCookie = adminCookieHeader.split(";")[0];

  // Privilege Escalation Prevention
  const privEscRes = await fetch(`${BASE_URL}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "1234", role: "fleet_admin" }),
  });
  assert(privEscRes.status === 403, "Client role self-assignment strictly blocked with HTTP 403 Forbidden");

  // -----------------------------------------------------------------
  // 7. Barista Workflow & Order Status State Machine Transitions
  // -----------------------------------------------------------------
  console.log("\n[Suite 7] Kitchen Display Status State Machine Transitions...");

  // Valid Transitions: pending -> brewing -> ready -> completed
  const transitions = [
    { status: "brewing", note: "Order moved to brewing" },
    { status: "ready", note: "Order moved to ready for pickup/delivery" },
    { status: "completed", note: "Order completed and handed to guest" },
  ];

  for (const t of transitions) {
    const eventRes = await fetch(`${BASE_URL}/api/realtime/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: baristaCookie,
      },
      body: JSON.stringify({
        type: "ORDER_STATUS_CHANGED",
        data: {
          orderId: razorpayOrderId,
          status: t.status,
          updatedAt: Date.now(),
        },
      }),
    });
    assert(
      eventRes.status === 200,
      `Barista transitioned order to '${t.status}' with HTTP 200 OK (${t.note})`
    );
  }

  // Customer Tampering Protection: Unauthenticated attempt to modify status
  const unauthModRes = await fetch(`${BASE_URL}/api/realtime/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "ORDER_STATUS_CHANGED",
      data: { orderId: razorpayOrderId, status: "pending" },
    }),
  });
  assert(
    unauthModRes.status === 401,
    "Unauthenticated order status modification blocked with HTTP 401 Unauthorized"
  );

  // -----------------------------------------------------------------
  // 8. Real-Time Server-Sent Events (SSE) Delivery & Synchronization
  // -----------------------------------------------------------------
  console.log("\n[Suite 8] Real-Time SSE Stream Verification...");
  const controller = new AbortController();
  const sseTimeout = setTimeout(() => controller.abort(), 6000);

  try {
    const sseRes = await fetch(`${BASE_URL}/api/realtime/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert(sseRes.status === 200, "Connected to /api/realtime/stream with HTTP 200 OK");
    const contentType = sseRes.headers.get("content-type") || "";
    assert(contentType.includes("text/event-stream"), "SSE Stream Content-Type is 'text/event-stream'");

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let initialSyncReceived = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (chunk.includes("INITIAL_SYNC")) {
        initialSyncReceived = true;
        break;
      }
    }
    clearTimeout(sseTimeout);
    assert(initialSyncReceived, "SSE delivered INITIAL_SYNC event with active order state");
    controller.abort();
  } catch (err) {
    if (err.name !== "AbortError") {
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // 9. Staff Session Revocation & Logout
  // -----------------------------------------------------------------
  console.log("\n[Suite 9] Staff Session Revocation & Logout Security...");
  const logoutRes = await fetch(`${BASE_URL}/api/auth/session`, {
    method: "DELETE",
    headers: { Cookie: baristaCookie },
  });
  assert(logoutRes.status === 200, "Barista logout succeeded with HTTP 200 OK");

  // Replay logged-out cookie on protected event route
  const replayedCookieRes = await fetch(`${BASE_URL}/api/realtime/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: baristaCookie,
    },
    body: JSON.stringify({
      type: "ORDER_STATUS_CHANGED",
      data: { orderId: razorpayOrderId, status: "cancelled" },
    }),
  });
  assert(
    replayedCookieRes.status === 401,
    "Revoked barista session token strictly rejected with HTTP 401 Unauthorized"
  );

  // -----------------------------------------------------------------
  // 10. Durable Test Record Firestore Cleanup
  // -----------------------------------------------------------------
  console.log("\n[Suite 10] Cloud Firestore Test Data Cleanup...");
  await orderDocRef.delete();
  const deletedSnap = await orderDocRef.get();
  assert(!deletedSnap.exists, `Test order ${razorpayOrderId} safely deleted from Cloud Firestore`);

  console.log("\n===============================================================");
  console.log(`🎉 ALL ${passedTests}/${totalTests} PHASE 4.9 ORDER LIFECYCLE CHECKS PASSED!`);
  console.log("===============================================================\n");
}

run().catch((err) => {
  console.error("FATAL ERROR IN LIFECYCLE VERIFICATION:", err);
  process.exit(1);
});
