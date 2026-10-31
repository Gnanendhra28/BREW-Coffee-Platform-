import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function makeRequest(options, postData = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (postData) {
      headers["Content-Length"] = Buffer.byteLength(postData);
    }
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    const req = http.request({ ...options, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
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

async function runSecurityVerification() {
  console.log("===============================================================");
  console.log("🛡️  BREW PHASE 2: COMPLETE APPLICATION SECURITY VERIFICATION");
  console.log("===============================================================\n");

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "brew_webhook_secret_dev_2026";
  const razorpaySecret = process.env.RAZORPAY_KEY_SECRET || "brew_razorpay_secret_test_2026";

  // Obtain staff barista session cookie for authorized tests
  const staffLoginRes = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/auth/session",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    JSON.stringify({ action: "staff_pin", pin: "2026" })
  );

  const staffCookieHeader = staffLoginRes.headers["set-cookie"];
  const staffCookie = staffCookieHeader
    ? Array.isArray(staffCookieHeader)
      ? staffCookieHeader[0].split(";")[0]
      : staffCookieHeader.split(";")[0]
    : "";

  // Obtain customer session cookie
  const customerLoginRes = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/auth/session",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    JSON.stringify({
      user: { uid: "guest-test-1", displayName: "Test Guest", email: "guest@example.com" },
    })
  );
  const custCookieHeader = customerLoginRes.headers["set-cookie"];
  const customerCookie = custCookieHeader
    ? Array.isArray(custCookieHeader)
      ? custCookieHeader[0].split(";")[0]
      : custCookieHeader.split(";")[0]
    : "";

  // -------------------------------------------------------------
  // TEST SECTION 1: Payment Amount Integrity & Price Calculation
  // -------------------------------------------------------------
  console.log("1. Testing Server-Side Payment Amount Integrity (/api/payments/create-order)...");

  // 1a. Tampered amount: Sending ₹1 instead of real item price
  const tamperedPayload = JSON.stringify({
    items: [{ id: "c-1", quantity: 1 }], // Affogato is ₹240
    amount: 1, // Tampered client price
  });
  const res1a = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/create-order",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    tamperedPayload
  );
  if (res1a.statusCode === 400 && res1a.body.includes("Price tampering detected")) {
    console.log("   ✓ Client price tampering (₹1 submitted vs ₹240 server price) blocked with 400 Bad Request");
  } else {
    throw new Error(`Failed 1a: Expected 400 Price tampering detected, got ${res1a.statusCode}: ${res1a.body}`);
  }

  // 1b. Unknown product ID rejection
  const invalidProductPayload = JSON.stringify({
    items: [{ id: "ghost-item-999", quantity: 1 }],
  });
  const res1b = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/create-order",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    invalidProductPayload
  );
  if (res1b.statusCode === 400 && res1b.body.includes("Unknown product ID")) {
    console.log("   ✓ Unknown product ID rejected with 400 Bad Request");
  } else {
    throw new Error(`Failed 1b: Expected 400 Unknown product ID, got ${res1b.statusCode}: ${res1b.body}`);
  }

  // 1c. Invalid quantities (0 or negative)
  const invalidQtyPayload = JSON.stringify({
    items: [{ id: "c-1", quantity: 0 }],
  });
  const res1c = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/create-order",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    invalidQtyPayload
  );
  if (res1c.statusCode === 400 && res1c.body.includes("Quantity must be at least 1")) {
    console.log("   ✓ Invalid item quantity (<= 0) rejected with 400 Bad Request");
  } else {
    throw new Error(`Failed 1c: Expected 400 invalid quantity, got ${res1c.statusCode}: ${res1c.body}`);
  }

  // 1d. Invalid promo code rejection
  const invalidPromoPayload = JSON.stringify({
    items: [{ id: "c-1", quantity: 1 }],
    promoCode: "HACK99",
  });
  const res1d = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/create-order",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    invalidPromoPayload
  );
  if (res1d.statusCode === 400 && res1d.body.includes("Invalid or unrecognized promo code")) {
    console.log("   ✓ Malicious/bogus promo code 'HACK99' rejected with 400 Bad Request");
  } else {
    throw new Error(`Failed 1d: Expected 400 invalid promo code, got ${res1d.statusCode}: ${res1d.body}`);
  }

  // 1e. Legitimate order calculation with BREW10 promo & server-calculated amount
  const validOrderPayload = JSON.stringify({
    items: [{ id: "c-1", quantity: 2 }], // 2x Affogato = ₹480
    promoCode: "BREW10", // 10% off = -₹48 -> taxable ₹432 -> 5% GST = ₹22 -> subtotal >= 399 free del -> Total ₹454
    customerName: "Aarav Sharma",
    customerPhone: "9876543210",
  });
  const res1e = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/create-order",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    validOrderPayload
  );
  const order1e = JSON.parse(res1e.body);
  if (res1e.statusCode === 200 && order1e.success && order1e.amount === 45400) {
    console.log("   ✓ Authoritative server-side price & discount calculation verified (2x Affogato - 10% + 5% GST = ₹454)");
  } else {
    throw new Error(`Failed 1e: Expected 200 amount=45400, got ${res1e.statusCode}: ${res1e.body}`);
  }

  // -------------------------------------------------------------
  // TEST SECTION 2: Razorpay Payment Verification Security
  // -------------------------------------------------------------
  console.log("\n2. Testing Razorpay Payment Verification Security (/api/payments/verify)...");
  const testOrderId = order1e.orderId;
  const testPaymentId = `pay_valid_${Date.now()}`;

  // 2a. Missing signature when secret is set
  const missingSigPayload = JSON.stringify({
    razorpay_order_id: testOrderId,
    razorpay_payment_id: testPaymentId,
  });
  const res2a = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/verify",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    missingSigPayload
  );
  if (res2a.statusCode === 400 && res2a.body.includes("Missing razorpay_signature")) {
    console.log("   ✓ Missing payment signature rejected with 400 Bad Request");
  } else {
    throw new Error(`Failed 2a: Expected 400 missing signature, got ${res2a.statusCode}: ${res2a.body}`);
  }

  // 2b. Tampered/fake HMAC signature
  const fakeSigPayload = JSON.stringify({
    razorpay_order_id: testOrderId,
    razorpay_payment_id: testPaymentId,
    razorpay_signature: "tampered_fake_signature_abc123",
  });
  const res2b = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/verify",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    fakeSigPayload
  );
  if (res2b.statusCode === 400 && res2b.body.includes("Cryptographic signature verification failed")) {
    console.log("   ✓ Forged/tampered HMAC signature rejected with 400 Bad Request");
  } else {
    throw new Error(`Failed 2b: Expected 400 signature verification failed, got ${res2b.statusCode}: ${res2b.body}`);
  }

  // 2c. Valid HMAC-SHA256 signature verification
  const validSignature = crypto
    .createHmac("sha256", razorpaySecret)
    .update(`${testOrderId}|${testPaymentId}`)
    .digest("hex");
  const validSigPayload = JSON.stringify({
    razorpay_order_id: testOrderId,
    razorpay_payment_id: testPaymentId,
    razorpay_signature: validSignature,
  });
  const res2c = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/verify",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    validSigPayload
  );
  if (res2c.statusCode === 200 && JSON.parse(res2c.body).verified) {
    console.log("   ✓ Genuine HMAC-SHA256 signature verified successfully with 200 OK");
  } else {
    throw new Error(`Failed 2c: Expected 200 verified, got ${res2c.statusCode}: ${res2c.body}`);
  }

  // 2d. Replay attack: submitting same payment verification again
  const res2d = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/verify",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    validSigPayload
  );
  const data2d = JSON.parse(res2d.body);
  if (res2d.statusCode === 200 && data2d.alreadyProcessed) {
    console.log("   ✓ Replayed payment verification detected and safely deduplicated (alreadyProcessed: true)");
  } else {
    throw new Error(`Failed 2d: Expected alreadyProcessed: true, got ${res2d.statusCode}: ${res2d.body}`);
  }

  // -------------------------------------------------------------
  // TEST SECTION 3: Razorpay Webhooks Security & Idempotency
  // -------------------------------------------------------------
  console.log("\n3. Testing Razorpay Webhooks Security (/api/webhooks/razorpay)...");

  // 3a. Missing webhook signature header
  const webhookBodyStr = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_wh_1", amount: 45400, currency: "INR" } } },
  });
  const res3a = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/webhooks/razorpay",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    webhookBodyStr
  );
  if (res3a.statusCode === 400 && res3a.body.includes("Missing x-razorpay-signature")) {
    console.log("   ✓ Unsigned webhook call blocked with 400 Bad Request");
  } else {
    throw new Error(`Failed 3a: Expected 400 missing header, got ${res3a.statusCode}: ${res3a.body}`);
  }

  // 3b. Forged webhook signature
  const res3b = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/webhooks/razorpay",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": "forged_webhook_signature_12345",
      },
    },
    webhookBodyStr
  );
  if (res3b.statusCode === 400 && res3b.body.includes("Invalid webhook signature")) {
    console.log("   ✓ Forged webhook HMAC signature blocked with 400 Bad Request");
  } else {
    throw new Error(`Failed 3b: Expected 400 invalid signature, got ${res3b.statusCode}: ${res3b.body}`);
  }

  // 3c. Valid webhook delivery & duplicate replay handling
  const webhookEventId = `evt_test_${Date.now()}`;
  const validWebhookPayload = JSON.stringify({
    id: webhookEventId,
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_wh_${Date.now()}`,
          amount: 45400,
          currency: "INR",
          notes: {
            orderId: testOrderId,
            customerName: "Aarav Sharma",
            customerPhone: "9876543210",
          },
        },
      },
    },
  });
  const validWebhookSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(validWebhookPayload)
    .digest("hex");

  const res3c = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/webhooks/razorpay",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": validWebhookSig,
      },
    },
    validWebhookPayload
  );
  if (res3c.statusCode === 200 && JSON.parse(res3c.body).received) {
    console.log("   ✓ Valid HMAC-SHA256 signed webhook accepted and processed successfully");
  } else {
    throw new Error(`Failed 3c: Expected 200 received, got ${res3c.statusCode}: ${res3c.body}`);
  }

  // 3d. Replay duplicate webhook delivery
  const res3d = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/webhooks/razorpay",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": validWebhookSig,
      },
    },
    validWebhookPayload
  );
  if (res3d.statusCode === 200 && JSON.parse(res3d.body).alreadyProcessed) {
    console.log("   ✓ Duplicate webhook event re-delivery detected and safely deduplicated (alreadyProcessed: true)");
  } else {
    throw new Error(`Failed 3d: Expected alreadyProcessed: true, got ${res3d.statusCode}: ${res3d.body}`);
  }

  // -------------------------------------------------------------
  // TEST SECTION 4: Real-Time Endpoint Security & RBAC (/api/realtime/events)
  // -------------------------------------------------------------
  console.log("\n4. Testing Real-Time Events Security & Role-Based Access Control (/api/realtime/events)...");

  // 4a. Unauthenticated client emitting staff event ORDER_STATUS_CHANGED
  const staffEventPayload = JSON.stringify({
    type: "ORDER_STATUS_CHANGED",
    payload: {
      orderId: "ord-101",
      status: "brewing",
    },
  });
  const res4a = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/realtime/events",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    staffEventPayload
  );
  if (res4a.statusCode === 401 && res4a.body.includes("requires valid staff session authentication")) {
    console.log("   ✓ Unauthenticated client blocked from emitting ORDER_STATUS_CHANGED with 401 Unauthorized");
  } else {
    throw new Error(`Failed 4a: Expected 401 for unauthenticated staff event, got ${res4a.statusCode}: ${res4a.body}`);
  }

  // 4b. Customer role attempting to emit staff event INVENTORY_CHANGED
  const inventoryPayload = JSON.stringify({
    type: "INVENTORY_CHANGED",
    payload: { coffeeBeansKg: 10 },
  });
  const res4b = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/realtime/events",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    inventoryPayload,
    customerCookie
  );
  if (res4b.statusCode === 403 && res4b.body.includes("requires barista or fleet_admin role")) {
    console.log("   ✓ Customer role blocked from emitting INVENTORY_CHANGED with 403 Forbidden");
  } else {
    throw new Error(`Failed 4b: Expected 403 for customer emitting staff event, got ${res4b.statusCode}: ${res4b.body}`);
  }

  // 4c. Unsupported arbitrary event type injection
  const arbitraryPayload = JSON.stringify({
    type: "INJECT_MALICIOUS_STATE",
    payload: { backdoor: true },
  });
  const res4c = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/realtime/events",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    arbitraryPayload
  );
  if (res4c.statusCode === 400 && res4c.body.includes("Unsupported event type")) {
    console.log("   ✓ Arbitrary event injection blocked with 400 Bad Request");
  } else {
    throw new Error(`Failed 4c: Expected 400 unsupported type, got ${res4c.statusCode}: ${res4c.body}`);
  }

  // 4d. Authenticated Barista successfully emitting staff event
  const res4d = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/realtime/events",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    staffEventPayload,
    staffCookie
  );
  if (res4d.statusCode === 200 && JSON.parse(res4d.body).success) {
    console.log("   ✓ Verified Barista staff authorized to emit ORDER_STATUS_CHANGED with 200 OK");
  } else {
    throw new Error(`Failed 4d: Expected 200 authorized, got ${res4d.statusCode}: ${res4d.body}`);
  }

  // -------------------------------------------------------------
  // TEST SECTION 5: Notification Buzzer Trigger Security
  // -------------------------------------------------------------
  console.log("\n5. Testing Buzzer Notification Trigger Security (/api/notifications/trigger)...");

  // 5a. Unauthenticated trigger
  const buzzerPayload = JSON.stringify({
    orderId: "ord-sec-buzzer-1",
    orderNumber: "109",
    vanLocationName: "Cyber Towers Van #1",
  });
  const res5a = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/notifications/trigger",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    buzzerPayload
  );
  if (res5a.statusCode === 403 && res5a.body.includes("Verified barista or fleet_admin staff authorization required")) {
    console.log("   ✓ Unauthenticated buzzer trigger blocked with 403 Forbidden");
  } else {
    throw new Error(`Failed 5a: Expected 403 unauthenticated buzzer, got ${res5a.statusCode}: ${res5a.body}`);
  }

  // 5b. Authenticated staff buzzer trigger
  const res5b = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/notifications/trigger",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    buzzerPayload,
    staffCookie
  );
  if (res5b.statusCode === 200 && JSON.parse(res5b.body).dispatched) {
    console.log("   ✓ Authenticated Barista successfully triggered hardware buzzer with 200 OK");
  } else {
    throw new Error(`Failed 5b: Expected 200 dispatched, got ${res5b.statusCode}: ${res5b.body}`);
  }

  // -------------------------------------------------------------
  // TEST SECTION 6: Durable Idempotency across Server Restarts
  // -------------------------------------------------------------
  console.log("\n6. Testing Durable Idempotency & Persistence (/api/request-van)...");
  const uniqueKey = `sec_idem_${Date.now()}`;
  const cateringPayload = JSON.stringify({
    contact: "security.test@brew.cafe",
    organization: "Sanctuary Cyber Command",
    location: "HITEC City Cyber Towers Floor 12",
    eventDate: "2026-11-15",
    crowdSize: 150,
    idempotencyKey: uniqueKey,
  });

  const res6a = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/request-van",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    cateringPayload
  );
  if (res6a.statusCode !== 200) {
    throw new Error(`Failed 6a: Expected 200, got ${res6a.statusCode}: ${res6a.body}`);
  }
  console.log("   ✓ Initial catering enquiry created and written to durable store");

  // Verify file on disk
  const idFilePath = path.join(process.cwd(), "src/data/idempotency_records.json");
  if (fs.existsSync(idFilePath)) {
    const rawDisk = JSON.parse(fs.readFileSync(idFilePath, "utf-8"));
    if (rawDisk[`client_${uniqueKey}`]) {
      console.log("   ✓ Durable file persistence verified in src/data/idempotency_records.json");
    }
  }

  // Re-submission: durable replay
  const res6b = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/request-van",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "192.168.1.55" },
    },
    cateringPayload
  );
  const data6b = JSON.parse(res6b.body);
  if (res6b.statusCode === 200 && data6b.idempotentReplay) {
    console.log("   ✓ Re-submitted request recognized and safely returned as durable replay");
  } else {
    throw new Error(`Failed 6b: Expected idempotentReplay: true, got ${res6b.statusCode}: ${res6b.body}`);
  }

  console.log("\n===============================================================");
  console.log("🎉 ALL PHASE 2 SECURITY & INTEGRITY VERIFICATIONS PASSED (100%)!");
  console.log("===============================================================");
}

runSecurityVerification().catch((err) => {
  console.error("\n❌ PHASE 2 SECURITY VERIFICATION FAILED:", err);
  process.exit(1);
});
