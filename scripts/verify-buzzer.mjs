import http from "node:http";

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

async function runBuzzerTests() {
  console.log("=== BREW PUSH NOTIFICATIONS & HARDWARE BUZZER VERIFICATION ===");

  // TEST 1: Register Push Subscription for Order
  console.log("\n[Test 1] Testing /api/notifications/subscribe (Device Pager Registration)...");
  const subPayload = JSON.stringify({
    orderId: "ord-test-buzzer-101",
    orderNumber: "105",
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-device-token",
      keys: {
        p256dh: "BNcR6S9M...demoP256dhKey...",
        auth: "tBHIt...demoAuth...",
      },
    },
    device: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  });

  const res1 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/notifications/subscribe",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(subPayload),
      },
    },
    subPayload
  );

  console.log(`Status: ${res1.statusCode}`);
  console.log(`Response: ${res1.body}`);
  const json1 = JSON.parse(res1.body);
  if (res1.statusCode === 200 && json1.success && json1.count >= 1) {
    console.log("✅ PASS: Successfully registered client device push subscription for Order #105.");
  } else {
    throw new Error(`Failed Test 1: ${res1.body}`);
  }

  // TEST 2: Trigger Hardware Buzzer & Web Push via /api/notifications/trigger
  console.log("\n[Test 2] Testing /api/notifications/trigger (Barista Mark Ready Dispatch)...");
  const triggerPayload = JSON.stringify({
    orderId: "ord-test-buzzer-101",
    orderNumber: "105",
    vanLocationName: "HITEC City — Cyber Towers (Van #1)",
  });

  const res2 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/notifications/trigger",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(triggerPayload),
      },
    },
    triggerPayload
  );

  console.log(`Status: ${res2.statusCode}`);
  console.log(`Response: ${res2.body}`);
  const json2 = JSON.parse(res2.body);
  const expectedVibration = [300, 100, 300, 100, 600];
  const vibrationMatches =
    JSON.stringify(json2.vibrationPattern) === JSON.stringify(expectedVibration);

  if (res2.statusCode === 200 && json2.dispatched && vibrationMatches && json2.subscribersCount >= 1) {
    console.log("✅ PASS: Buzzer triggered with verified [300, 100, 300, 100, 600] haptic vibration pattern and dispatched to registered device.");
  } else {
    throw new Error(`Failed Test 2: ${res2.body}`);
  }

  // TEST 3: Validation Error Handling on Missing orderId
  console.log("\n[Test 3] Testing Missing orderId validation...");
  const invalidPayload = JSON.stringify({
    orderNumber: "999",
  });

  const res3 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/notifications/trigger",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(invalidPayload),
      },
    },
    invalidPayload
  );

  console.log(`Status: ${res3.statusCode}`);
  if (res3.statusCode === 400) {
    console.log("✅ PASS: Correctly rejected request missing orderId with status 400.");
  } else {
    throw new Error(`Failed Test 3: Expected 400, got ${res3.statusCode}`);
  }

  console.log("\n🎉 ALL PHASE 4 PUSH NOTIFICATIONS & HARDWARE BUZZER TESTS PASSED SUCCESSFULLY!\n");
}

runBuzzerTests().catch((err) => {
  console.error("❌ Buzzer verification failed:", err);
  process.exit(1);
});
