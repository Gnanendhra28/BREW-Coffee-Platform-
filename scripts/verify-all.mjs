// Master Test Runner for All 7 BREW Production Subsystems
// Runs in CI/CD pipeline and local pre-commit checks.

import { execSync, spawn } from "node:child_process";
import http from "node:http";

const testSuites = [
  { name: "Phase 1: Real-Time Cloud Database & SSE", script: "scripts/verify-realtime.mjs" },
  { name: "Phase 2: Authentication & RBAC Edge Security", script: "scripts/verify-auth.mjs" },
  { name: "Phase 3: Payments Gateway & WhatsApp Receipts", script: "scripts/verify-payments.mjs" },
  { name: "Phase 4: Web Push Notifications & Hardware Buzzer", script: "scripts/verify-buzzer.mjs" },
  { name: "Phase 5: Asset Optimization & Global Edge CDN", script: "scripts/verify-assets-cdn.mjs" },
  { name: "Phase 6: AI Agents Hardening, Rate Limiting & Zod", script: "scripts/verify-agents-hardening.mjs" },
  { name: "Phase 7: Observability, Sentry & System Health", script: "scripts/verify-observability.mjs" },
];

function checkServerReady(port = 3000, timeoutMs = 15000) {
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
        setTimeout(ping, 500);
      }
    }

    ping();
  });
}

async function runAll() {
  console.log("===============================================================");
  console.log("🚀 BREW PLATFORM — MASTER PRODUCTION TEST & CI VERIFICATION");
  console.log("===============================================================\n");

  let serverProcess = null;
  const isRunning = await checkServerReady(3000, 1000);

  if (!isRunning) {
    console.log("⚡ Starting BREW local server instance on port 3000 for verification...");
    const hasStandalone = (await import("node:fs")).existsSync(".next/standalone/server.js");
    serverProcess = hasStandalone
      ? spawn("node", [".next/standalone/server.js"], {
          stdio: "pipe",
          env: { ...process.env, PORT: "3000" },
        })
      : spawn("npm", ["run", "start"], {
          stdio: "pipe",
          env: { ...process.env, PORT: "3000" },
        });

    const ready = await checkServerReady(3000, 30000);
    if (!ready) {
      console.error("✖ Failed to start BREW application server on port 3000 within timeout.");
      if (serverProcess) serverProcess.kill("SIGTERM");
      process.exit(1);
    }
    console.log("✔ BREW server ready and responding on http://127.0.0.1:3000\n");
  } else {
    console.log("✔ Existing BREW server detected on http://127.0.0.1:3000\n");
  }

  let passedCount = 0;
  const startTime = Date.now();

  try {
    for (const suite of testSuites) {
      console.log(`▶ Running [${suite.name}]...`);
      try {
        execSync(`node ${suite.script}`, { stdio: "inherit" });
        passedCount++;
        console.log(`✔ [${suite.name}] PASSED\n`);
      } catch (err) {
        console.error(`✖ [${suite.name}] FAILED!`);
        throw err;
      }
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("===============================================================");
    console.log(`🎉 ALL ${passedCount}/${testSuites.length} PRODUCTION TEST SUITES PASSED IN ${durationSec}s!`);
    console.log("===============================================================\n");
  } finally {
    if (serverProcess) {
      console.log("Stopping background BREW server instance...");
      serverProcess.kill("SIGTERM");
    }
  }
}

runAll().catch(() => {
  process.exit(1);
});
