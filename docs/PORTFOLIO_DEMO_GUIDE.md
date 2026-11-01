# BREW Mobile Coffee Platform — Portfolio & Live Demonstration Guide

**Live Production URL:** [https://brew-coffee-platform.onrender.com](https://brew-coffee-platform.onrender.com)  
**GitHub Repository:** [https://github.com/Gnanendhra28/BREW-Coffee-Platform-](https://github.com/Gnanendhra28/BREW-Coffee-Platform-)  
**Audited Commit:** [`7f61a2f`](https://github.com/Gnanendhra28/BREW-Coffee-Platform-/commit/7f61a2f6c8775d8991e8169bd36dac86b4731328)  
**Status:** **`PRODUCTION READY & VERIFIED`**

---

## 1. Executive Portfolio Case Study

### The Vision
Specialty coffee culture often clashes with the operational realities of mobile street retail: fluctuating locations, unstable cellular connectivity, drive-by curbside traffic, and high ingredient spoilage risks. 

**BREW** solves this by uniting a luxury consumer storefront (`#140D08` espresso dark, `#DFAB6C` amber gold) with an enterprise operational backbone featuring:
- **Zero-Trust Client Pricing:** Server-side authoritative catalog pricing preventing client price tampering.
- **Dual-Engine Real-Time Kitchen Display:** Server-Sent Events (SSE) synchronizing ticket state to outdoor display boards and barista screens.
- **Fail-Closed Distributed Rate Limiting:** Upstash Redis atomic Lua scripts protecting sensitive endpoints against brute force and DDoS.
- **Six Specialized AI Domain Agents:** Decoupled algorithmic loops managing inventory depletion, drive-thru queue priority, pastry yield discounting, instant catering quotes, hyperlocal social copy, and customer review sentiment recovery.

---

## 2. Live Demo Script (3 to 5 Minutes)

Use this structured walkthrough when presenting BREW to recruiters, engineering leadership, or technical interviewers.

```
0:00 ── 1. Brand Discovery & 3D Hero Canvas (/)
1:00 ── 2. Artisanal Catalog, Search & Filtering (/menu)
2:00 ── 3. Cart, Promo Codes & Test-Mode Checkout (/cart)
3:00 ── 4. Live Digital Buzzer Pager (/order-status/[id])
4:00 ── 5. Staff Barista Kitchen Display System (/barista)
5:00 ── 6. Six Autonomous AI Agents & Cloud Telemetry (/api/health)
```

---

### Step 1: Brand Discovery & 3D Hero (0:00 – 1:00)
1. Navigate to [https://brew-coffee-platform.onrender.com](https://brew-coffee-platform.onrender.com).
2. **Talking Point:** *"Notice the `#140D08` luxury dark espresso palette and Three.js 3D splash interaction. Everything is built using Next.js 16 App Router and React 19."*
3. Highlight the glassmorphic navigation pill and click **Order Now** or **Menu**.

---

### Step 2: Catalog Browsing, Search & Accessible Filters (1:00 – 2:00)
1. On `/menu`, demonstrate the instant substring search by typing `"Affogato"`.
2. Demonstrate the accessible category tabs (`Coffee`, `Tea`, `Shakes`, `Desserts`).
3. Click the `+` button on an **Affogato** and a **Cinnamon Roll**.
4. **Talking Point:** *"Notice the celebratory feedback and the dynamic cart badge counter. For accessibility, the action announces via an `aria-live='polite'` live region for screen-readers and respects `prefers-reduced-motion`."*
5. Click **View Cart** in the header.

---

### Step 3: Cart, Anti-Tampering & Test-Mode Checkout (2:00 – 3:00)
1. On `/cart`, demonstrate the quantity steppers and promo code engine:
   - Enter promo code `BREW10` to apply an instant 10% discount.
2. Select **Curbside Delivery** and enter vehicle description: `"Silver Honda City, hazard lights on"`.
3. Choose payment method:
   - **Option A (Pay at Outlet):** Click *"Place Order & Pay at Outlet"*. Order is generated immediately with internal token `#101`.
   - **Option B (Razorpay Test Mode):** Select *"Pay Online"*. The Razorpay sandboxed modal opens with server-calculated price (zero client-side price tampering).
   - In the modal, enter test card `4111 1111 1111 1111` or simulated UPI `success@razorpay`.
4. **Talking Point:** *"The server recomputes catalog prices, GST (5%), and delivery fees server-side. Even if a user alters the client bundle, the server strictly validates amounts and checks the cryptographic HMAC-SHA256 signature."*

---

### Step 4: Digital Buzzer Pager & Outdoor Board (3:00 – 4:00)
1. Upon confirmation, click **Open Live Digital Buzzer Tracker** (`/order-status/[id]`).
2. Demonstrate the **Mobile Vibrating Pager**:
   - Click *"Tap to Enable"* or *"Test Digital Buzzer"* to trigger the hardware vibration pattern and audio chime.
3. Open a second browser tab to `/board`.
4. **Talking Point:** *"The outdoor display board runs on high-contrast typography for direct sunlight legibility and stays synchronized in real time via Server-Sent Events without manual page refreshes."*

---

### Step 5: Barista Kitchen Display System (4:00 – 4:45)
1. In a new tab, navigate to `/barista`.
2. If prompted for login, enter the staff PIN:
   - **Barista PIN:** `2026`
   - **Fleet Admin PIN:** `7788`
3. In the KDS:
   - Demonstrate the active tickets queue.
   - Notice the order placed in Step 3 is highlighted with its curbside urgency badge.
   - Click **Start Brewing** $\to$ the ticket moves to `brewing`. Check the `/board` and `/order-status/[id]` tabs to see the state transition reflected instantly.
   - Click **Mark Ready** $\to$ triggers the customer buzzer chime and confetti!
4. Demonstrate **AI Ops & Dispatch** tab to showcase Agent #1 (Inventory Sentinel) stockout projections and Agent #3 (Yield Optimizer) flash deals.

---

### Step 6: System Telemetry & AI Architecture (4:45 – 5:00)
1. Open `/api/health` in a browser.
2. Show live dependency telemetry:
   - `firestore: { status: "healthy", latencyMs: ~75ms }`
   - `redis: { status: "healthy", latencyMs: ~15ms }`
   - `realtimeStore: { activeOrders: N }`
3. **Closing Point:** *"BREW demonstrates clean architecture, dual-SDK cloud separation, fail-closed distributed rate limiting, and 100% automated test verification across 321 checks."*

---

## 3. Evaluator Credentials Reference

| Role | Access URL | Credentials | Permissions & Scope |
| :--- | :--- | :--- | :--- |
| **Customer Guest** | `/` | Instant anonymous session or email signup | Menu browsing, cart, test payments, digital buzzer tracking, reviews. |
| **Van Barista** | `/barista` | **PIN: `2026`** | Active KDS tickets, order state transitions (`brewing`/`ready`/`served`), stock deductions, audio chimes. |
| **Fleet Admin** | `/admin` | **PIN: `7788`** | Fleet van telemetry, van schedule editing, catering inquiry reviews, autonomous agent logs. |

---

## 4. Security & Configuration Boundaries

To maintain full transparency with technical evaluators, the following distinction is drawn between code-enforced controls and deployment-dependent configurations:

### Code-Enforced Controls (Hard Invariants in Repository):
- **Stream-Bounded Request Reader (`boundedBody.ts`):** 100KB ceiling hardcoded on all API payloads.
- **Catalog Pricing Authority (`create-order/route.ts`):** Server computes prices directly from `MENU_ITEMS`; client-supplied prices are discarded.
- **Cryptographic Signature Verification (`verify/route.ts`):** HMAC-SHA256 signature recomputation using constant-time comparison.
- **Zod Schema Guardrails:** Rejects ungrounded AI agent recommendations and negative flash deal prices.
- **Edge Middleware Route Protection:** `/barista` and `/admin` redirect unauthenticated traffic to `/login` before routes render.

### Deployment-Dependent Controls (Render & Firebase Settings):
- **Upstash Redis Rate Limiting:** Active when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are populated in Render. If missing, sensitive endpoints fail-closed with HTTP 503.
- **Firestore Security Rules:** Must be deployed to the Firebase Console (`firebase deploy --only firestore:rules`) to enforce client read/write restrictions in cloud production.
- **HTTPS Redirection:** Handled at Render's TLS termination layer.

---

## 5. Explicit Disclosure of Known Limitations

Technical evaluators should be aware of the following platform realities:

1. **Render Free Tier Cold Starts:** Free instances spin down after 15 minutes of zero traffic. The initial wakeup request may take 30–50 seconds. Once awake, performance responds in <100ms.
2. **Razorpay Test Mode:** All payments operate with sandbox keys (`rzp_test_*`). No real bank transfers or monetary settlements take place.
3. **Simulated External Integrations:**
   - *Agent 1 (Restock PO):* Generates structured PO records; physical distributor truck dispatch is logged and simulated.
   - *Agent 5 (Hype Marketing):* Generates multi-channel copy; actual Instagram Graph and Twilio SMS dispatches are simulated.
   - *Catering SMTP:* When SMTP host credentials are not configured, `/location` defaults to pre-filled `mailto:` and webmail deep-links.
