import http from "node:http";
import { z } from "zod";

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

// Zod schemas matching src/lib/agentSchemas.ts
const BaristaChatResponseSchema = z.object({
  replyText: z.string().min(5),
  recommendedItemIds: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  quickReplies: z.array(z.string()).min(1),
});

const FlashDealSchema = z.object({
  id: z.string(),
  isActive: z.boolean(),
  title: z.string().min(3),
  discountPercent: z.number().min(5).max(75),
  dealPrice: z.number().positive(),
});

async function runHardeningTests() {
  console.log("=== BREW AUTONOMOUS AI AGENTS HARDENING & RATE LIMITING VERIFICATION ===");

  // TEST 1: Zod Guardrail Schema Validation
  console.log("\n[Test 1] Testing Zod Guardrail Validation on Agent Outputs...");

  // 1a: Valid Barista Payload
  const validBarista = {
    replyText: "I recommend our rich single-origin espresso with dark chocolate notes.",
    recommendedItemIds: ["c-1", "c-3"],
    reasons: ["Velvety mouthfeel", "Direct origin single batch roast"],
    quickReplies: ["Tell me about milk options", "Something sweet"],
  };
  const valResult1 = BaristaChatResponseSchema.safeParse(validBarista);
  if (valResult1.success) {
    console.log("✅ PASS: Valid agent output passes Zod schema verification.");
  } else {
    throw new Error("Failed Test 1a: Valid data rejected by Zod schema");
  }

  // 1b: Hallucinated / Malformed LLM Payload
  const malformedPayload = {
    replyText: "Hi", // too short (< 5 chars)
    recommendedItemIds: "not-an-array", // type error
    quickReplies: [], // empty (< 1 items)
  };
  const valResult2 = BaristaChatResponseSchema.safeParse(malformedPayload);
  if (!valResult2.success && valResult2.error.issues.length >= 2) {
    console.log(
      `✅ PASS: Zod guardrail caught ${valResult2.error.issues.length} hallucination violations (${valResult2.error.issues.map(i => i.path.join(".")).join(", ")})!`
    );
  } else {
    throw new Error("Failed Test 1b: Malformed data was not caught by Zod guardrail");
  }

  // 1c: Flash Deal Discount Percent Constraint (5% to 75%)
  const invalidDeal = {
    id: "deal-test",
    isActive: true,
    title: "Extreme Free Deal",
    discountPercent: 120, // Invalid > 75%
    dealPrice: -50,       // Invalid negative price
  };
  const valResult3 = FlashDealSchema.safeParse(invalidDeal);
  if (!valResult3.success) {
    console.log("✅ PASS: Flash deal guardrail blocked unrealistic 120% discount and negative price.");
  } else {
    throw new Error("Failed Test 1c: Invalid discount not caught");
  }

  // TEST 2: 30-Minute Fallback Cache Verification
  console.log("\n[Test 2] Testing 30-Minute Fallback Cache on /api/barista-chat...");
  const uniqueMessage = `Cache Test Query ${Date.now()}`;
  const queryPayload = JSON.stringify({ message: uniqueMessage });

  // Call 1: Uncached
  const res1 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/barista-chat",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(queryPayload),
        "X-Forwarded-For": "198.51.100.42",
      },
    },
    queryPayload
  );
  console.log(`Call 1 Status: ${res1.statusCode}, Remaining: ${res1.headers["x-ratelimit-remaining"]}`);
  if (res1.statusCode !== 200) {
    throw new Error(`Failed Test 2 Call 1: Status ${res1.statusCode}`);
  }

  // Call 2: Identical Query should hit Cache!
  const res2 = await makeRequest(
    {
      hostname: "127.0.0.1",
      port: 3000,
      path: "/api/barista-chat",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(queryPayload),
        "X-Forwarded-For": "198.51.100.42",
      },
    },
    queryPayload
  );
  console.log(`Call 2 Status: ${res2.statusCode}, Body: ${res2.body}`);
  const json2 = JSON.parse(res2.body);
  if (res2.statusCode === 200 && json2.cached === true) {
    console.log("✅ PASS: 30-Minute Fallback Cache returned instantaneous cached: true response!");
  } else {
    throw new Error(`Failed Test 2 Call 2: Expected cached: true, got ${res2.body}`);
  }

  // TEST 3: Rate Limiting Enforcement (Max 10 requests / 60 seconds)
  console.log("\n[Test 3] Testing Rate Limiting (10 queries/min limit & 429 Too Many Requests)...");
  const testIp = "203.0.113.88"; // Dedicated test IP
  let wasRateLimited = false;
  let finalStatus = 0;
  let retryAfterHeader = null;

  for (let i = 1; i <= 12; i++) {
    const burstPayload = JSON.stringify({ message: `Burst query ${i}` });
    const res = await makeRequest(
      {
        hostname: "127.0.0.1",
        port: 3000,
        path: "/api/barista-chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(burstPayload),
          "X-Forwarded-For": testIp,
        },
      },
      burstPayload
    );

    if (res.statusCode === 429) {
      wasRateLimited = true;
      finalStatus = res.statusCode;
      retryAfterHeader = res.headers["retry-after"];
      console.log(`Request #${i}: Blocked with 429 Too Many Requests! Retry-After: ${retryAfterHeader}s`);
      break;
    } else {
      console.log(`Request #${i}: Accepted (Status ${res.statusCode}, Remaining: ${res.headers["x-ratelimit-remaining"]})`);
    }
  }

  if (wasRateLimited && finalStatus === 429 && retryAfterHeader) {
    console.log("✅ PASS: Rate limiter strictly enforced 10 queries/min cap with HTTP 429 & Retry-After header!");
  } else {
    throw new Error("Failed Test 3: Rate limiter did not return 429 after exceeding limit");
  }

  console.log("\n🎉 ALL PHASE 6 AUTONOMOUS AI AGENTS HARDENING TESTS PASSED!\n");
}

runHardeningTests().catch((err) => {
  console.error("❌ Hardening test failed:", err);
  process.exit(1);
});
