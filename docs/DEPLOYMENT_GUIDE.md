# BREW Mobile Coffee Platform — Deployment & Local Development Guide

**Document Version:** 1.0.0  
**Updated:** November 2026  
**Security Notice:** Never commit actual secret keys, private credentials, or staff PINs to source control.

---

## 1. Prerequisites

Before setting up or deploying the platform, ensure the following prerequisites are met:

- **Node.js:** Version `20.x` or `22.x` (LTS recommended; tested on Node `v20.19.4`).
- **NPM:** Version `10.x` or higher.
- **Git:** Installed and configured.
- **Google Cloud / Firebase Project:** A Firebase project with Cloud Firestore enabled (in native mode).
- **Upstash Redis Database:** A free serverless Redis instance on Upstash.
- **Razorpay Account:** A Razorpay account with Test Mode API keys (`rzp_test_*`).
- **Google AI Studio (Optional):** Gemini API key (`GEMINI_API_KEY`) for conversational features.

---

## 2. Environment Variables Reference

Configure environment variables in `.env.local` for local development, or in the Render Dashboard under **Environment**:

| Environment Variable | Category | Purpose | Scope |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | System | Specifies runtime mode (`development`, `production`, `test`) | Build & Server |
| `PORT` | System | Port on which the application listens (defaults to `3000` locally, `10000` on Render) | Server |
| `HOSTNAME` | System | Interface binding (Must be set to `0.0.0.0` for container hosting) | Server |
| `AUTH_SECRET` | Security | High-entropy HMAC signing key for JWT session cookies | Server |
| `BARISTA_PIN` | Security | 4-digit PIN for Barista Van KDS authentication | Server |
| `FLEET_ADMIN_PIN` | Security | 4-digit PIN for Fleet Management authentication | Server |
| `FIREBASE_PROJECT_ID` | Database | Google Cloud / Firebase project identifier (e.g. `brew-2621e`) | Server |
| `FIREBASE_SERVICE_ACCOUNT` | Database | JSON string (or Base64) of Firebase Admin service account key | Server |
| `UPSTASH_REDIS_REST_URL` | Cache | Upstash Redis HTTPS REST endpoint URL | Server |
| `UPSTASH_REDIS_REST_TOKEN` | Cache | Upstash Redis REST bearer token | Server |
| `RAZORPAY_KEY_ID` | Payments | Public test key ID (e.g. `rzp_test_*`) | Server |
| `RAZORPAY_KEY_SECRET` | Payments | Secret key used for cryptographic HMAC-SHA256 signature verification | Server |
| `RAZORPAY_WEBHOOK_SECRET` | Payments | Secret used to verify incoming asynchronous Razorpay webhooks | Server |
| `GEMINI_API_KEY` | AI | Google Gemini API key for GenAI coffee recommendations | Server |
| `BUSINESS_EMAIL` | Business | Destination email for corporate catering enquiries | Server |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Client Firebase | Firebase Web API key for client SDK initialization | Client Bundle |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Client Firebase | Auth domain (e.g. `brew-2621e.firebaseapp.com`) | Client Bundle |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Client Firebase | Project ID for client SDK | Client Bundle |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`| Client Firebase | Storage bucket for assets | Client Bundle |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Client Firebase | Firebase Web App ID | Client Bundle |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Client Payments | Public key ID provided to the checkout modal | Client Bundle |
| `ALLOW_LOCAL_FALLBACK` | Testing Only | Set to `true` during local offline testing to permit in-memory cache | Dev / Test |
| `VOICE_BOOKING_ENABLED` | Feature Flag | Enables Phase 6 Voice Booking & outbound communication (Defaults to `false`) | Server |

---

## 3. Local Development Setup

### Step 1: Clone Repository & Install Dependencies
```bash
git clone https://github.com/Gnanendhra28/BREW-Coffee-Platform-.git
cd BREW-Coffee-Platform-
npm ci
```

### Step 2: Configure Environment Variables
Create a `.env.local` file in the project root:
```bash
cp .env.example .env.local  # If available, or create manually with values above
```

### Step 3: Start the Next.js Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 4. Verification & Testing Commands

Execute automated test suites to verify system integrity:

```bash
# 1. Typecheck & Code Style Verification
npm run typecheck          # Strict TypeScript compilation without emitting files
npm run lint               # ESLint code style and unused variable verification

# 2. Master Production CI Suite (19 Test Suites)
npm test                   # Runs master verification across payments, rules, agents & observability

# 3. Playwright End-to-End (E2E) Test Suite
npm run test:e2e           # Executes headless browser tests across all 6 responsive viewports & a11y

# 4. Targeted Phase Regression Suites
npm run test:p49           # Phase 4.9: Customer-to-Staff Order Lifecycle
npm run test:p50           # Phase 5.0: Six Autonomous AI Domain Agents Audit
npm run test:p51           # Phase 5.1: Razorpay Test-Mode Payment Verification & Webhook Deduplication
npm run test:p52           # Phase 5.2: Final Security, Reliability & Readiness Audit
npm run test:p53           # Phase 5.3: Public Demo Hardening & Firestore Rules Audit
npm run test:p531          # Phase 5.3.1: Security Boundary Verification & Stream Body Bounds
```

---

## 5. Production Compilation & Standalone Hosting

### Step 1: Compile Optimized Production Build
```bash
npm run build
```
This triggers:
1. `NODE_OPTIONS='--max-old-space-size=1536' next build --webpack`
2. Next.js standalone output bundling into `.next/standalone`
3. Automatic postbuild copying of `public` and `.next/static` assets into the standalone directory.

### Step 2: Run Standalone Production Server
```bash
npm run start:standalone
```
This executes:
```bash
HOSTNAME=0.0.0.0 node --max-old-space-size=450 .next/standalone/server.js
```
The server will listen on port `10000` (or the configured `$PORT`).

---

## 6. Render Free Tier Deployment

The repository includes a declarative `render.yaml` specification configured for zero-downtime deployment on Render:

```yaml
services:
  - type: web
    name: brew-coffee-platform
    env: node
    plan: free
    region: singapore
    buildCommand: npm ci --include=dev --no-audit && npm run build
    startCommand: npm run start:standalone
    healthCheckPath: /api/health
    autoDeploy: true
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 10000
      - key: HOSTNAME
        value: 0.0.0.0
      - key: NEXT_TELEMETRY_DISABLED
        value: 1
      - key: AUTH_SECRET
        generateValue: true
```

### Render Deployment Steps:
1. Connect your GitHub repository to Render.
2. Select **Blueprint** and point to `render.yaml`, or create a **Web Service** with the build and start commands above.
3. In the Render Dashboard under **Environment**, configure the secret keys (`BARISTA_PIN`, `FLEET_ADMIN_PIN`, `FIREBASE_SERVICE_ACCOUNT`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RAZORPAY_KEY_SECRET`).
4. Trigger manual deploy or push a commit to `main`. Render will compile and start the standalone service.

---

## 7. Troubleshooting & Operational Guidance

### 7.1 HTTP 502 Bad Gateway on Container Startup
- **Root Cause:** Next.js by default binds to `localhost` (`127.0.0.1`), which is inaccessible to Render's reverse proxy router.
- **Fix:** Ensure `HOSTNAME=0.0.0.0` is set in the start command and environment variables.

### 7.2 Sensitive Endpoints Return HTTP 503 Service Unavailable
- **Root Cause:** The application enforces fail-closed semantics when Upstash Redis is unconfigured or unreachable.
- **Fix:** Verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the Render dashboard. Test Redis connectivity via `/api/health`.

### 7.3 Render Out-Of-Memory (OOM) Container Restarts
- **Root Cause:** Node's default garbage collection allows memory to climb toward 1.5GB, exceeding Render Free Tier's 512MB RAM cap.
- **Fix:** The start script enforces `--max-old-space-size=450`. Do not remove this flag.

### 7.4 Free Tier 15-Minute Inactivity Sleep
- **Behavior:** Render spins down free containers after 15 minutes of zero traffic. The next incoming request takes 30–50 seconds to initialize.
- **Guidance:** This is expected Render platform behavior. Once awake, performance returns to sub-millisecond local latency.
