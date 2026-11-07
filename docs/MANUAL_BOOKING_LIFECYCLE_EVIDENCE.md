# BREW Coffee Platform — Manual Booking Lifecycle Evidence
## Route Inventory, Status Mutation Audit & Confirmation Workflow Findings

**Audit Timestamp**: 2026-11-02T15:51:00+05:30  
**Audit Scope**: Entire BREW Codebase (`src/app/`, `src/lib/`, `src/data/`)  
**Objective**: Establish definitive evidence regarding whether a manual booking confirmation workflow exists in the application.

---

## 1. Executive Summary & Definitive Finding

An exhaustive source audit of all API routes, server actions, route handlers, and UI pages across the BREW platform was performed.

### Definitive Finding:
1. **Manual Catering Submissions are Purely Enquiries**:
   - When a customer submits the catering request form at `/location`, the payload is sent via `POST /api/request-van`.
   - The record is initialized and permanently saved to the `van_requests` collection with `status: "pending"`.
2. **No Manual Confirmation Route or Workflow Exists**:
   - Authenticated staff can view pending catering enquiries via `GET /api/request-van`.
   - There is **no HTTP route** (`PATCH`, `PUT`, or `POST`), **no Server Action**, and **no UI control** in either `/admin` or `/barista` to confirm or update the status of a manual catering enquiry.
3. **The Only Confirmation Path is Voice Booking**:
   - The only booking approval endpoint in the application is `POST /api/voice-booking/approve` (aliased at `src/app/api/admin/voice-bookings/approve/route.ts`).
   - This endpoint accepts a `sessionId` (voice session ID) and exclusively invokes `approveBookingByStaff()` from `src/lib/voiceBooking/`.
4. **Verified Limitation**:
   - In accordance with architecture guidelines, **no synthetic confirmation route was created**.
   - `reserveManualBookingSlot()` in `src/lib/voiceBooking/vanRequestBridge.ts` is a verified shared helper providing distributed slot reservation capability, but is currently **not connected to any production confirmation route**.

---

## 2. Route & Action Inventory

The table below catalogs every API endpoint within `src/app/api/` and its role:

| Endpoint | Method(s) | Auth / Role | Documented Action |
|---|---|---|---|
| `/api/request-van` | `POST` | Public (Rate-limited) | Creates a new catering enquiry in `van_requests` with `status: "pending"`. Computes 3-tier Agent 4 quote. |
| `/api/request-van` | `GET` | Staff (`barista`, `fleet_admin`) | Reads catering enquiries from `van_requests` ordered by `createdAt desc`. |
| `/api/voice-booking/approve` | `POST` | Staff (`barista`, `fleet_admin`, `admin`) | Atomically approves a **voice booking session** (`sessionId`) via `FirestoreVoiceSessionRepository.atomicApproveBooking()`. |
| `/api/admin/voice-bookings/approve` | `POST` | Staff (`barista`, `fleet_admin`, `admin`) | Alias re-exporting `POST` from `/api/voice-booking/approve`. |
| `/api/auth/session` | `POST`, `GET`, `DELETE` | Public / Staff | Authenticates staff PIN, issues edge session cookie, returns/clears session. |
| `/api/barista-chat` | `POST` | Public (Rate-limited) | Conversational barista AI recommendations. |
| `/api/barista-ops-chat` | `POST` | Staff | Barista operational assistant AI. |
| `/api/health` | `GET` | Public | System health, Redis status, Firestore status, fleet operational metrics. |
| `/api/notifications/subscribe` | `POST` | Customer | Web Push notification subscription. |
| `/api/notifications/trigger` | `POST` | Staff (`barista`, `fleet_admin`) | Hardware buzzer notification trigger for ready orders. |
| `/api/payments/create-order` | `POST` | Customer | Server-side price calculation and Razorpay order creation. |
| `/api/payments/verify` | `POST` | Customer | Razorpay payment signature HMAC-SHA256 verification and order status update. |
| `/api/realtime/events` | `POST` | Staff | Emits real-time SSE events (`ORDER_STATUS_CHANGED`). |
| `/api/realtime/stream` | `GET` | Public / Customer | Server-Sent Events (SSE) order status stream. |
| `/api/webhooks/razorpay` | `POST` | Razorpay Webhook HMAC | Webhook ingestion and deduplication for payment events. |

---

## 3. UI Page & Server Action Audit

Every page directory within `src/app/` was inspected:

### 3.1 `src/app/admin/page.tsx`
- **Role**: Fleet management and administrative operations.
- **Actions**: Displays van location map, barista roster, active shift metrics, and operational controls.
- **Catering Integration**: **Zero references** to `van_requests`, `/api/request-van`, or catering approval.

### 3.2 `src/app/barista/page.tsx`
- **Role**: In-store barista tablet workflow.
- **Actions**: Real-time order queue management (`brewing`, `ready`, `completed`), inventory stock management, and buzzer triggers.
- **Catering Integration**: **Zero references** to `van_requests` or catering enquiry approvals.

### 3.3 `src/app/location/page.tsx`
- **Role**: Customer-facing mobile van tracking and private catering request form.
- **Actions**:
  - Submits catering enquiry via `fetch("/api/request-van", { method: "POST", body: JSON.stringify(formData) })`.
  - Displays instant Agent 4 quotation tier cards (`Standard`, `Premium`, `Executive`).
- **Confirmation Integration**: Customer receives confirmation that their enquiry has been submitted (`status: "pending"`). There is no customer confirmation step that converts it to `confirmed`.

---

## 4. Status Mutation Audit for `van_requests`

Every location across the entire codebase that reads, writes, or mutates `van_requests` was cataloged:

| Source File | Line(s) | Operation | Resulting Status | Context |
|---|---|---|---|---|
| `src/app/api/request-van/route.ts` | 459, 477 | `transaction.set(docRef, requestRecord)` | `"pending"` | Manual customer submission from `/location`. |
| `src/app/api/request-van/route.ts` | 638–641 | `collection("van_requests").orderBy(...).get()` | *Read-only* | Staff viewing catering enquiries. |
| `src/lib/voiceBooking/vanRequestBridge.ts` | 280–310 | `createVanRequestRecordFromSession()` | `"pending"` or `"confirmed"` | Bridge factory constructing official record from voice session. |
| `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts` | 308 | `transaction.set(vanRequestRef, pendingRecord)` | `"pending"` | Customer confirms voice quote; held awaiting staff approval. |
| `src/lib/voiceBooking/repositories/firestoreSessionRepository.ts` | 867 | `transaction.set(vanRequestRef, confirmedVanRequest)` | `"confirmed"` | Staff approves voice booking (`atomicApproveBooking`). |
| `src/lib/voiceBooking/repositories/sessionRepository.ts` | 242 | `this.officialVanRequests.set(vanRequestId, vanRecord)` | `"pending"` | In-memory repository voice bridge. |
| `src/lib/voiceBooking/repositories/sessionRepository.ts` | 625 | `this.officialVanRequests.set(vanRequestId, confirmedVanRecord)` | `"confirmed"` | In-memory repository staff approval. |

**Conclusion**: Outside the voice booking bridge (`src/lib/voiceBooking/`), **no code in the application ever updates a `van_requests` record to `"confirmed"`**.

---

## 5. Architectural Implications & Conclusion

1. **Manual Enquiries are Asynchronous Leads**:
   - In the current production architecture, manual catering submissions represent sales leads/enquiries. Staff contact the organizer offline or review details manually.
2. **Voice Bookings are Full-Lifecycle Reservations**:
   - Voice bookings capture structured requirements, compute an authoritative HMAC-signed quote, obtain customer confirmation, and undergo atomic staff approval with durable schedule slot reservations.
3. **Role of `reserveManualBookingSlot()`**:
   - The helper function `reserveManualBookingSlot()` in `src/lib/voiceBooking/vanRequestBridge.ts` was engineered to enable manual bookings to participate in the exact same durable schedule reservation mechanism as voice bookings.
   - It is verified against the Firestore daily schedule contract in `scripts/verify-phase6-3-2-3-hardening.ts`.
   - **Verified Limitation**: It is not currently wired to any HTTP route handler or UI button in the production app because no manual confirmation route exists.
