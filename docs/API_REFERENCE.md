# BREW Mobile Coffee Platform — API Reference Manual

**Document Version:** 1.0.0  
**Updated:** November 2026  
**Standard Response Format:** JSON (`application/json`)  
**Global Security Constraints:** Maximum request body size $\le 100\text{KB}$ (enforced via stream bounded reader). Exceeding requests return `HTTP 413 Payload Too Large`.

---

## Index of API Routes

1. [`GET /api/health`](#1-get-apihealth) — System observability and dependency telemetry
2. [`POST /api/auth/session`](#2-post-apiauthsession) — Staff PIN verification, demo customer login, and session revocation
3. [`POST /api/payments/create-order`](#3-post-apipaymentscreate-order) — Server-authoritative price calculation and Razorpay order creation
4. [`POST /api/payments/verify`](#4-post-apipaymentsverify) — Cryptographic HMAC-SHA256 payment signature verification and anti-replay
5. [`POST /api/webhooks/razorpay`](#5-post-apiwebhooksrazorpay) — Razorpay asynchronous webhook ingestion and deduplication
6. [`POST /api/request-van`](#6-post-apirequest-van) — Instant 3-tier catering quotation calculation and booking persistence
7. [`GET /api/request-van`](#7-get-apirequest-van) — Privileged staff enquiry ledger retrieval
8. [`GET /api/realtime/stream`](#8-get-apirealtimestream) — Server-Sent Events (SSE) live order and fleet event stream
9. [`POST /api/realtime/events`](#9-post-apirealtimeevents) — RBAC-guarded real-time event broadcaster
10. [`POST /api/barista-chat`](#10-post-apibarista-chat) — Grounded conversational coffee recommendation AI
11. [`POST /api/barista-ops-chat`](#11-post-apibarista-ops-chat) — Staff operational assistant for inventory, restock, and schedule
12. [`POST /api/notifications/subscribe`](#12-post-apinotificationssubscribe) — Web Push notification VAPID subscription registration
13. [`POST /api/notifications/trigger`](#13-post-apinotificationstrigger) — Digital buzzer hardware chime and vibration pager dispatcher

---

## Detailed Route Specifications

### 1. `GET /api/health`
- **Purpose:** Health check, latency monitoring, and dependency telemetry.
- **Authentication:** None (Public).
- **Authorization:** None.
- **Rate Limit:** None (Standard monitoring probe).
- **Response Format (`HTTP 200 OK`):**
  ```json
  {
    "status": "healthy",
    "service": "BREW-Autonomous-Coffee-Platform",
    "version": "1.0.0-production",
    "timestamp": "2026-11-01T04:17:55.190Z",
    "uptimeSeconds": 3600,
    "latencyMs": 2,
    "checks": {
      "realtimeStore": {
        "status": "healthy",
        "engine": "Dual-Engine SSE & Cloud Sync",
        "activeOrders": 4
      },
      "agentCache": {
        "status": "healthy",
        "memoryEntries": 12,
        "hits": 45,
        "misses": 12
      },
      "fleetOperations": {
        "status": "healthy",
        "activeVans": 3,
        "primaryStation": "HITEC City — Cyber Towers (Hyderabad)"
      },
      "firestore": {
        "status": "healthy",
        "latencyMs": 14
      },
      "redis": {
        "status": "healthy",
        "latencyMs": 6
      }
    }
  }
  ```

---

### 2. `POST /api/auth/session`
- **Purpose:** Authenticates staff via isolated PIN, creates customer demo sessions, and handles session token revocation.
- **Authentication:** Unauthenticated on login; Session cookie required for logout.
- **Authorization:** Role assigned based on verified PIN or guest identity.
- **Rate Limit:** **5 requests / 60 seconds** via Upstash Redis (Brute-force defense). Missing/down Redis triggers `HTTP 503`.
- **Request Schemas:**
  - *Staff PIN Login:*
    ```json
    { "action": "staff_pin", "pin": "string (4-6 digits)" }
    ```
  - *Customer Guest Login:*
    ```json
    { "action": "customer_guest", "name": "string (optional)" }
    ```
  - *Logout / Session Revocation:*
    ```json
    { "action": "logout" }
    ```
- **Responses:**
  - `HTTP 200 OK`: Sets `Set-Cookie: brew_session=...; HttpOnly; SameSite=Lax; Path=/`
    ```json
    { "success": true, "user": { "uid": "staff-barista-1", "displayName": "Barista Station 1", "role": "barista" } }
    ```
  - `HTTP 401 Unauthorized`: Invalid PIN or unauthenticated session.
  - `HTTP 403 Forbidden`: Client attempted direct role manipulation or self-escalation.
  - `HTTP 429 Too Many Requests`: Rate limit exceeded (includes `Retry-After` header).
  - `HTTP 503 Service Unavailable`: Upstash Redis unavailable in production.

---

### 3. `POST /api/payments/create-order`
- **Purpose:** Server-side price calculation, discount verification, and Razorpay test-order creation.
- **Authentication:** None (Public customer checkout).
- **Authorization:** Public.
- **Rate Limit:** **10 requests / 60 seconds** via Upstash Redis.
- **Request Schema (`application/json`, bounded $\le 100\text{KB}$):**
  ```json
  {
    "items": [
      { "id": "c-1", "quantity": 1 }
    ],
    "customerName": "string (1-100 chars)",
    "customerPhone": "string (optional, 10-15 chars)",
    "promoCode": "string (optional, e.g. 'BREW10')",
    "currency": "INR"
  }
  ```
- **Validation Rules:**
  - Item IDs must exist in official menu catalog (`MENU_ITEMS`).
  - Quantities must be integers between 1 and 20.
  - Client cannot submit prices; prices are authoritatively resolved on server.
- **Responses:**
  - `HTTP 200 OK`:
    ```json
    {
      "success": true,
      "orderId": "order_test_1793506728629_bjhto",
      "amount": 30100,
      "currency": "INR",
      "keyId": "rzp_test_brew_mobile_2026",
      "breakdown": {
        "subtotal": 240,
        "memberDiscount": 0,
        "promoDiscount": 0,
        "tax": 12,
        "deliveryFee": 49,
        "finalTotal": 301
      }
    }
    ```
  - `HTTP 400 Bad Request`: Unknown product ID, invalid quantity, or malformed JSON.
  - `HTTP 413 Payload Too Large`: Body size $> 100\text{KB}$.
  - `HTTP 429 Too Many Requests`: Exceeded 10 requests / min.

---

### 4. `POST /api/payments/verify`
- **Purpose:** Cryptographic HMAC-SHA256 payment signature verification and anti-replay protection.
- **Authentication:** Public client with signature tokens from Razorpay checkout.
- **Authorization:** Cryptographic proof of payment.
- **Rate Limit:** Standard application throughput.
- **Request Schema:**
  ```json
  {
    "razorpay_order_id": "order_test_...",
    "razorpay_payment_id": "pay_test_...",
    "razorpay_signature": "hex_string (64 chars HMAC-SHA256)"
  }
  ```
- **Responses:**
  - `HTTP 200 OK (First verification)`:
    ```json
    { "success": true, "verified": true, "paymentId": "pay_test_..." }
    ```
  - `HTTP 200 OK (Replay Attack / Duplicate)`:
    ```json
    { "success": true, "verified": true, "alreadyProcessed": true, "paymentId": "pay_test_..." }
    ```
  - `HTTP 400 Bad Request`: Signature mismatch, forged HMAC, or missing fields.

---

### 5. `POST /api/webhooks/razorpay`
- **Purpose:** Asynchronous payment notification processing and fulfillment guarantee.
- **Authentication:** Valid `x-razorpay-signature` header computed with `RAZORPAY_WEBHOOK_SECRET`.
- **Authorization:** Webhook cryptographic signature.
- **Rate Limit:** None (High availability for payment provider).
- **Request Schema:** Razorpay webhook payload format (`payment.captured`, `payment.failed`, `order.paid`).
- **Responses:**
  - `HTTP 200 OK`:
    ```json
    { "status": "ok", "event": "payment.captured", "alreadyProcessed": false }
    ```
  - `HTTP 400 Bad Request`: Missing or invalid `x-razorpay-signature` header, amount mismatch.
  - `HTTP 413 Payload Too Large`: Stream $> 100\text{KB}$.

---

### 6. `POST /api/request-van`
- **Purpose:** Calculates 3-tier catering quotation (<100ms) and persists corporate/campus enquiries.
- **Authentication:** Public.
- **Rate Limit:** **5 requests / 60 seconds** via Upstash Redis.
- **Request Schema:**
  ```json
  {
    "contact": "string (3-150 chars, email or phone)",
    "organization": "string (1-150 chars)",
    "location": "string (1-200 chars)",
    "eventDate": "string (optional)",
    "crowdSize": "string (e.g. '150–300 People')",
    "notes": "string (optional, <= 2000 chars)"
  }
  ```
- **Responses:**
  - `HTTP 200 OK`:
    ```json
    {
      "success": true,
      "requestId": "req_1793506728",
      "quotation": {
        "estimatedCrowd": 200,
        "baristasAssigned": 2,
        "recommendedTier": "Artisanal Signature",
        "tiers": [
          { "name": "Essential Roast", "pricePerGuest": 180, "totalAmount": 36000, "perks": [...] },
          { "name": "Artisanal Signature", "pricePerGuest": 270, "totalAmount": 54000, "perks": [...] },
          { "name": "Grand Reserve", "pricePerGuest": 390, "totalAmount": 78000, "perks": [...] }
        ]
      }
    }
    ```
  - `HTTP 400 Bad Request`: Empty contact or missing organization.
  - `HTTP 409 Conflict`: Identical contact submitted with conflicting organization/venue details.
  - `HTTP 413 Payload Too Large`: Request body $> 100\text{KB}$.

---

### 7. `GET /api/request-van`
- **Purpose:** Retrieves list of submitted catering enquiries.
- **Authentication:** Required (`brew_session` cookie).
- **Authorization:** Staff only (`barista` or `fleet_admin`). Customer role receives `HTTP 403`.
- **Responses:**
  - `HTTP 200 OK`: `{ "success": true, "requests": [ ... ] }`
  - `HTTP 401 Unauthorized`: Unauthenticated.
  - `HTTP 403 Forbidden`: Authenticated as `customer`.

---

### 8. `GET /api/realtime/stream`
- **Purpose:** Server-Sent Events (SSE) live order and fleet event stream.
- **Headers Returned:**
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
- **Initial Sync Event:** Emitted immediately upon connection with current active orders and van state.
- **Keep-Alive:** Periodic ping `: keep-alive\n\n` sent every 15 seconds.

---

### 9. `POST /api/realtime/events`
- **Purpose:** Broadcasts state transitions to kitchen displays and customer devices.
- **Authentication:** Required (`brew_session` cookie).
- **Authorization:** `barista` or `fleet_admin`.
- **Rate Limit:** **30 requests / 60 seconds** via Upstash Redis.
- **Request Schema:**
  ```json
  {
    "type": "ORDER_STATUS_CHANGED" | "INVENTORY_CHANGED" | "LOCATION_CHANGED",
    "payload": {
      "orderId": "string",
      "status": "brewing" | "ready" | "served"
    }
  }
  ```
- **Responses:**
  - `HTTP 200 OK`: `{ "success": true, "delivered": 4 }`
  - `HTTP 401 Unauthorized`: Missing session.
  - `HTTP 403 Forbidden`: Customer role attempting event emission.
  - `HTTP 400 Bad Request`: Unrecognized event type or invalid state transition.

---

### 10. `POST /api/barista-chat`
- **Purpose:** Conversational coffee recommendation agent grounded in catalog data.
- **Rate Limit:** **10 queries / min** with 30-minute LRU fallback cache.
- **Request Schema:**
  ```json
  {
    "message": "string (1-500 chars)",
    "history": [ { "sender": "user" | "barista", "text": "string" } ]
  }
  ```
- **Responses:**
  - `HTTP 200 OK`:
    ```json
    {
      "replyText": "Based on what you enjoy, our barista craft pick for you is the Affogato!",
      "recommendations": [ ... ],
      "quickReplies": [ "Suggest a dessert to pair", "Something iced" ],
      "cached": false
    }
    ```

---

### 11. `POST /api/barista-ops-chat`
- **Purpose:** Barista copilot for van operations, ingredient reorder points, and tour scheduling.
- **Authentication:** Required (`barista` or `fleet_admin`).
- **Responses:**
  - `HTTP 200 OK`: Operational answers grounded in real-time van telemetry.
  - `HTTP 401 Unauthorized`: Unauthenticated.

---

### 12. `POST /api/notifications/subscribe`
- **Purpose:** Registers Web Push VAPID subscription for the customer's device.
- **Request Schema:** `{ "subscription": { "endpoint": "string", "keys": { "p256dh": "...", "auth": "..." } } }`
- **Responses:**
  - `HTTP 200 OK`: `{ "success": true, "subscribed": true }`

---

### 13. `POST /api/notifications/trigger`
- **Purpose:** Emits digital buzzer notification and haptic vibration sequence to a customer's registered browser.
- **Authentication:** Staff (`barista` or `fleet_admin`).
- **Request Schema:**
  ```json
  {
    "orderId": "string",
    "orderNumber": "string",
    "vanLocationName": "string"
  }
  ```
- **Responses:**
  - `HTTP 200 OK`: `{ "success": true, "alerted": true }`
  - `HTTP 403 Forbidden`: Unauthenticated or customer role.
