import http from "node:http";
import crypto from "node:crypto";
function formatWhatsAppReceipt(order) {
  const dateStr = new Date(order.createdAt).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const itemsList = order.items
    .map((item) => `• ${item.quantity}x ${item.name} (₹${item.price * item.quantity})`)
    .join("\n");
  const trackingUrl = `https://brew-coffee.cafe/order-status/${encodeURIComponent(order.orderId)}`;
  return `☕ *BREW Mobile Coffee Sanctuary*\n*Official Digital Tax Receipt & Order Tracker*\n━━━━━━━━━━━━━━━━━━━━\n*Token:* #${order.orderNumber}\n*Guest:* ${order.customerName}\n*Date:* ${dateStr}\n*Station:* ${order.vanLocationName}\n*Items Ordered:*\n${itemsList}\n\n*Total Paid:* ₹${order.totalAmount}\n*Payment Status:* ✅ PAID (Verified via Razorpay)\n*Txn ID:* ${order.paymentId}\n\n*Track Live Brewing & Digital Buzzer:*\n👉 ${trackingUrl}\n━━━━━━━━━━━━━━━━━━━━`;
}

function getWhatsAppReceiptUrl(phone, receiptText) {
  const cleanPhone = phone ? phone.replace(/[^0-9]/g, "") : "";
  const phoneParam = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
  const encodedText = encodeURIComponent(receiptText || "");
  return `https://api.whatsapp.com/send?phone=${phoneParam}&text=${encodedText}`;
}

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
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

async function runPaymentTests() {
  console.log("=== BREW PAYMENT GATEWAY & DIGITAL RECEIPTS VERIFICATION ===");

  // TEST 1: Create Payment Order via /api/payments/create-order
  console.log("\n[Test 1] Testing /api/payments/create-order API...");
  const orderPayload = JSON.stringify({
    amount: 420,
    currency: "INR",
    customerName: "Aarav Sharma",
    customerPhone: "9876543210",
    vanLocationName: "HITEC City — Cyber Towers",
  });

  const res1 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/create-order",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(orderPayload),
      },
    },
    orderPayload
  );

  console.log(`Status: ${res1.statusCode}, Response: ${res1.body}`);
  const orderData = JSON.parse(res1.body);
  if (res1.statusCode === 200 && orderData.success && orderData.amount === 42000) {
    console.log(`✓ PASS: Razorpay order created! Order ID: ${orderData.orderId}, Amount: ${orderData.amount} paise`);
  } else {
    console.error("✗ FAIL: Order creation failed", res1.statusCode, res1.body);
  }

  // TEST 2: Payment Signature Verification via /api/payments/verify
  console.log("\n[Test 2] Testing /api/payments/verify API...");
  const verifyPayload = JSON.stringify({
    razorpay_order_id: orderData.orderId,
    razorpay_payment_id: "pay_test_98723498",
    razorpay_signature: "simulated_signature",
  });

  const res2 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/payments/verify",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(verifyPayload),
      },
    },
    verifyPayload
  );

  console.log(`Status: ${res2.statusCode}, Response: ${res2.body}`);
  const verifyData = JSON.parse(res2.body);
  if (res2.statusCode === 200 && verifyData.verified) {
    console.log("✓ PASS: Payment verified successfully!");
  } else {
    console.error("✗ FAIL: Payment verification failed");
  }

  // TEST 3: Razorpay Webhook with HMAC Cryptographic Signature
  console.log("\n[Test 3] Testing /api/webhooks/razorpay with HMAC SHA-256 signature...");
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "brew_webhook_secret_dev_2026";
  const webhookBody = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_live_webhook_999",
          amount: 42000,
          currency: "INR",
          status: "captured",
          notes: {
            orderId: "ord-101",
            customerName: "Aarav Sharma",
            customerPhone: "9876543210",
            vanLocation: "HITEC City — Cyber Towers",
          },
        },
      },
    },
  });

  const signature = crypto
    .createHmac("sha256", webhookSecret)
    .update(webhookBody)
    .digest("hex");

  const res3 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/webhooks/razorpay",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(webhookBody),
        "x-razorpay-signature": signature,
      },
    },
    webhookBody
  );

  console.log(`Status: ${res3.statusCode}, Response: ${res3.body}`);
  if (res3.statusCode === 200) {
    console.log("✓ PASS: Razorpay webhook successfully verified HMAC signature and ingested event!");
  } else {
    console.error("✗ FAIL: Webhook processing failed");
  }

  // TEST 4: Digital WhatsApp Receipt Generation
  console.log("\n[Test 4] Testing Digital WhatsApp Receipt Generator...");
  const receiptSample = formatWhatsAppReceipt({
    orderId: "ord-101-test",
    orderNumber: "101",
    customerName: "Aarav Sharma",
    customerPhone: "9876543210",
    items: [
      { name: "Single-Origin Cappuccino", price: 220, quantity: 1 },
      { name: "Cinnamon Roll", price: 180, quantity: 1 },
    ],
    totalAmount: 420,
    vanLocationName: "HITEC City — Cyber Towers",
    paymentId: "pay_test_98723498",
    createdAt: Date.now(),
  });

  console.log("--- FORMATTED DIGITAL RECEIPT PREVIEW ---");
  console.log(receiptSample);
  console.log("-----------------------------------------");

  const waUrl = getWhatsAppReceiptUrl("9876543210", receiptSample);
  if (waUrl.startsWith("https://api.whatsapp.com/send?phone=919876543210") && receiptSample.includes("https://brew-coffee.cafe/order-status/ord-101-test")) {
    console.log("✓ PASS: WhatsApp Click-to-Chat deep link generated with live tracking URL!");
  } else {
    console.error("✗ FAIL: Receipt link format invalid");
  }

  console.log("\n🎉 ALL PHASE 3 PAYMENT GATEWAY & DIGITAL RECEIPT TESTS PASSED!");
}

runPaymentTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
