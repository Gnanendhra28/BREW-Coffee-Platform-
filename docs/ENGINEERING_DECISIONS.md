# BREW Mobile Coffee Platform — Engineering Decisions & Architectural Trade-offs

**Document Version:** 1.0.0  
**Updated:** November 2026  
**Scope:** Design rationale, rejected alternatives, and operational trade-offs supported by source code and project history.

---

## 1. Framework: Next.js 16 App Router vs. Separate SPA + Express Backend

### Decision:
Unify client presentation, serverless APIs, and edge routing within **Next.js 16 App Router** in a single TypeScript codebase.

### Rationale:
- **Type Safety Across Boundaries:** Frontend components and backend API handlers share TypeScript types (e.g. `MenuItem`, `VanOrder`, `InventoryStock`), eliminating API contract drift.
- **Standalone Production Packaging:** Compiles to a self-contained `.next/standalone` folder including necessary Node dependencies, perfect for minimal Docker images and Render deployment.
- **Unified Route Handling:** Co-locates API endpoints under `src/app/api/` with edge middleware for unified routing and authentication guards.

### Trade-offs & Rejected Alternatives:
- *Alternative (Vite React SPA + Express.js API):* Would have required managing two distinct deployment pipelines, CORS configurations, and duplicated data models.
- *Trade-off Accepted:* Next.js introduces larger build memory footprints during compilation (mitigated with `NODE_OPTIONS='--max-old-space-size=1536'`).

---

## 2. Database: Cloud Firestore Dual-SDK vs. Relational PostgreSQL

### Decision:
Adopt **Google Cloud Firestore** with strict dual-SDK separation (Client SDK for bounded public reads; Firebase Admin SDK for privileged state mutations).

### Rationale:
- **Real-Time Client Snapshots:** Firestore provides native `onSnapshot` subscriptions enabling customer devices and kitchen displays to listen to document changes without custom polling infrastructure.
- **Fine-Grained Declarative Security Rules:** `firestore.rules` enforces authorization and document structure directly at the storage engine level, preventing unauthorized writes even if an attacker acquires public Firebase API keys.
- **No Cold Connection Pools:** As a serverless document store, Firestore does not suffer from connection pool exhaustion during sudden spikes in traffic.

### Trade-offs & Rejected Alternatives:
- *Alternative (PostgreSQL with Prisma / Supabase):* Provides strong foreign-key constraints and ACID transactions, but requires connection pool management (e.g. PgBouncer) and custom WebSocket servers for real-time order tracking.
- *Trade-off Accepted:* Firestore lacks cross-collection JOIN queries. Handled by denormalizing essential customer and item data into order documents.

---

## 3. Rate Limiting: Upstash Redis with Fail-Closed Semantics vs. In-Memory Token Bucket

### Decision:
Implement distributed rate limiting via **Upstash Redis** utilizing an atomic Lua sliding-window script, with strict **fail-closed (HTTP 503)** semantics in production.

### Rationale:
- **Multi-Instance / Serverless Consistency:** In-memory rate limiting stores state in a local process dictionary (`Map`). In multi-container deployments or serverless functions, requests land on different workers, allowing an attacker to bypass rate limits by distributing requests.
- **Atomic Lua Scripting:** Upstash Redis executes the sliding window check, timestamp pruning, and counter increment atomically in a single network round-trip, preventing race conditions.
- **Fail-Closed Security Posture:** If Redis credentials are unconfigured or Redis experiences an outage, sensitive production endpoints intentionally return HTTP 503 rather than failing open.

### Trade-offs & Rejected Alternatives:
- *Alternative (In-Memory `lru-cache` Rate Limiter):* Zero network latency, but insecure across distributed nodes.
- *Trade-off Accepted:* Adds 10–25ms network round-trip latency to incoming sensitive API requests. Accepted because brute-force and flood defense take precedence.

---

## 4. Real-Time Protocol: Server-Sent Events (SSE) vs. WebSockets (Socket.io)

### Decision:
Deploy **Server-Sent Events (SSE)** via `GET /api/realtime/stream` for kitchen display and customer pager updates.

### Rationale:
- **Simpler Protocol over HTTP/2:** SSE is standard HTTP. It passes effortlessly through corporate firewalls, reverse proxies, and CDN edge networks without requiring HTTP `Upgrade` headers.
- **Unidirectional Server Push Fit:** Kitchen display boards and customer buzzers primarily require server-to-client notifications (`ORDER_STATUS_CHANGED`). Client-to-server mutations are clean REST requests.
- **Native Browser Auto-Reconnect:** The browser's native `EventSource` automatically handles reconnection and message ID tracking with zero external JavaScript dependencies.

### Trade-offs & Rejected Alternatives:
- *Alternative (WebSockets / Socket.io):* Supports bi-directional streaming, but requires stateful TCP connection brokers, sticky sessions on load balancers, and heartbeat maintenance.
- *Trade-off Accepted:* SSE is text-only (UTF-8). Perfectly suited for JSON event payloads.

---

## 5. Artificial Intelligence: Six Specialized Agents vs. Monolithic LLM Prompt

### Decision:
Partition operational AI into **six specialized domain agents** (`Inventory Sentinel`, `Curbside Expediter`, `Yield Optimizer`, `Event Booking Concierge`, `HyperLocal Hype Broadcaster`, `Guest Sentiment Guardian`) with deterministic mathematical cores and Zod output schemas.

### Rationale:
- **Mathematical Precision vs. Hallucination:** LLMs are notoriously unreliable at arithmetic (e.g. calculating reorder points, gross margins, or queue weights). BREW's agents execute all math deterministically in TypeScript, invoking Gemini only for natural language summarization and conversational dialogue.
- **Strict Boundary Control:** Each agent operates on a tiny, isolated context window rather than injecting the entire platform state into a giant prompt.
- **Testability & Deterministic Fallbacks:** If Gemini API keys are missing, quota is exhausted, or the network drops, agents gracefully execute deterministic mathematical fallbacks with zero crash.

### Trade-offs & Rejected Alternatives:
- *Alternative (Single "Master Manager" Agent):* One large prompt handling inventory, marketing, and queues. Highly prone to context bloat, hallucination, and unpredictable side effects.
- *Trade-off Accepted:* Requires maintaining six modular TypeScript packages under `src/lib/`. The reliability gains overwhelmingly justify this structure.

---

## 6. Operations: Human-in-the-Loop Approval Gates vs. Fully Autonomous Execution

### Decision:
Enforce **human confirmation gates** on commercial actions (activating flash deal discount banners and submitting vendor restock purchase orders).

### Rationale:
- **Financial Risk Mitigation:** Fully autonomous price discounting could inadvertently trigger margin compression or conflicts with in-person promotions.
- **Physical Operational Realities:** A barista inside the van knows physical space constraints that digital telemetry may miss (e.g. storage shelf already full).
- **Barista Empowerment:** Promotes staff agency by presenting the AI as a powerful copilot ("Recommended Flash Deal — Tap to Activate") rather than an opaque black box.

---

## 7. Hosting: Render Free Tier Topology & Memory Tuning

### Decision:
Host production on **Render Free Tier** using standalone Node.js compilation with explicit heap memory caps.

### Rationale:
- **Zero Financial Overhead:** Enables a fully functioning, public demonstration platform without cloud billing costs.
- **Memory Tuning (`--max-old-space-size=450`):** Render's free tier imposes a strict 512MB RAM ceiling. Exceeding it triggers immediate kernel OOM kill. Configuring Node's V8 engine to trigger garbage collection aggressively at 450MB guarantees uptime.
- **Hostname Binding (`0.0.0.0`):** Enforces global interface listening, resolving historical HTTP 502 Bad Gateway proxy errors on container startup.

### Trade-offs & Operational Limitations:
- *Free-Tier Inactivity Sleep:* Render spins down containers after 15 minutes of zero traffic. First requests experience a 30–50 second cold start.
- *Mitigation:* Health check endpoint (`/api/health`) provides instant observability when the service awakens.
