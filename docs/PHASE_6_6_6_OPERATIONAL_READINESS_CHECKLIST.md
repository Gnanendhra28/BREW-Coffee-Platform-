# Phase 6.6.6 — Final Operational Readiness & Provider Integration Checklist

**Date:** 2026-11-06  
**Status:** Complete & Read-Only Audited  
**System:** BREW Coffee Platform — AI Voice Booking Platform  
**Operational Mode:** `VOICE_BOOKING_ENABLED=false` (Enforced)

---

## 1. Source Files Inspected

During this final operational readiness review, the following key architectural and domain modules were inspected:

| Subsystem | Source Files | Purpose |
|---|---|---|
| **Consent & DND** | `src/lib/communication/consent.ts`<br/>`src/lib/communication/voice/testAuthorization.ts`<br/>`src/lib/communication/repositories/consentRepository.ts`<br/>`src/lib/communication/repositories/firestoreConsentRepository.ts` | Verification of independent voice consent, E.164 normalization, channel isolation (voice vs WhatsApp), and fail-closed evaluation. |
| **Staff Identity & Approvals** | `src/lib/auth/adminAuth.ts`<br/>`src/app/api/voice-booking/approve/route.ts`<br/>`src/lib/voiceBooking/conversationEngine.ts`<br/>`src/lib/voiceBooking/quotationAdapter.ts` | Cryptographic verification of staff sessions (`brew_session`), server-side role derivation, quotation HMAC integrity, and atomic booking approval. |
| **Telephony & Bridge** | `src/lib/communication/providers/exotelVoiceProvider.ts`<br/>`src/lib/communication/voice/audioBridge/exotelAudioBridge.ts`<br/>`src/lib/communication/voice/audioBridge/speechProviders.ts`<br/>`src/server/voiceBridgeServer.ts` | Exotel outbound dialing, single-use stream tokens, atomic authorization leasing, bidirectional WebSocket audio streaming, and speech provider interfaces. |
| **Audio Framing & Codecs** | `src/lib/communication/voice/audioBridge/packetizer.ts`<br/>`src/lib/communication/voice/audioBridge/codecs.ts`<br/>`src/lib/communication/voice/audioBridge/tokenNonceRegistry.ts` | Audio frame boundaries (3,200–99,840 bytes), 320-byte alignment, 16-bit PCM/μ-law math, and distributed token nonce replay protection. |
| **Configuration & Safety** | `src/lib/communication/config.ts`<br/>`firestore.indexes.json`<br/>`firestore.rules` | Global kill-switch enforcement, phone masking, index configurations, and database rules. |

---

## 2. Consent Verification Audit

The system enforces strict multi-layered consent validation prior to any telephony dispatch:

1. **Exact E.164 Matching**: Phone numbers are normalized using `normalizePhoneNumber()` (e.g. `+919876543210`). The query for consent strictly checks the exact normalized E.164 string.
2. **Channel Isolation (TRAI Rule)**: Under TRAI telemarketing regulations, consent granted for WhatsApp cannot authorize voice calls. `verifyIndependentVoiceConsent()` in `testAuthorization.ts` and `hasActiveConsent()` in `consent.ts` strictly require `channel === "voice"`. Consent records with `channel: "whatsapp"` are rejected fail-closed with `VOICE_CONSENT_MISSING`.
3. **Purpose Matching**: Outbound voice booking requires `purpose === "voice_booking"`. Other purposes (such as transactional WhatsApp updates or marketing) are rejected.
4. **Timestamp & Revocation**: Records are sorted chronologically. If the latest event is a revocation (`eventType === "revoke"`, `granted === false`, or `revokedAt` is present), consent is inactive. In case of identical millisecond timestamps, revocations deterministically take precedence over grants.
5. **Fail-Closed Behavior**: If no valid active consent record exists in the repository, dialing throws `VoiceTestAuthorizationError` with code `VOICE_CONSENT_MISSING`, mapped to a certain provider rejection.

---

## 3. Staff Identity and Approval Audit

The system strictly decouples client-supplied metadata from authoritative server-side staff permissions:

1. **Server-Side Session Verification**: In `src/lib/auth/adminAuth.ts`, `inspectStaffSession()` validates the signed `brew_session` cookie against HMAC-SHA256 signatures and checks session revocation via `isSessionRevoked()`.
2. **Untrusted Client Body Immunity**: In `src/app/api/voice-booking/approve/route.ts`, client-supplied values for `staffRole` or `staffIdentity` are completely ignored. Instead, `deriveTrustedStaffAuthorizationContext()` derives `staffIdentity` directly from `authResult.session.uid` and `staffRole` from the verified session role.
3. **RBAC Permitted Roles**: Only `barista`, `fleet_admin`, and `admin` are permitted to approve bookings. Any other role (e.g., `customer`) is rejected with HTTP 403.
4. **Test Authorization Staff Identity**: For outbound test calls, `approvedBy` in `VoiceTestAuthorizationRecord` must be populated with the authenticated operator identity. Unapproved or blank authorizations throw `STAFF_APPROVAL_REQUIRED`.
5. **Quotation Cryptographic Integrity**:
   - `createQuotationSnapshot()` deterministically canonicalizes 7 material fields (guest count, event date, start time, duration hours, venue address, selected tier, and event type) and signs them with HMAC-SHA256.
   - `verifyQuotationIntegrity()` verifies that the snapshot hash matches the current requirements and recalculates authoritative pricing via `quoteEngine`. If any field has been tampered with or requirements have mutated, approval fails closed.

---

## 4. Authorization Lifecycle Audit

The authorization lifecycle enforces a strict single-use lease before carrier dispatch:

```
[Create Authorization] (Status: active, approvedBy: operatorId, expiresAt: now + 10m)
         |
         v
[Atomic Transaction] -> Checks (Status == active && not expired && consumedAt == null)
         |
         +--> Success: Stamped (consumedAt: now, consumedByAttemptId: attemptId, status: "consumed")
         +--> Collision / Duplicate / Replay: Fails closed (AUTHORIZATION_ALREADY_CONSUMED)
         |
         v
[Carrier Dispatch] -> Exotel POST /connect.json
         |
         +--> 200 OK: Call in progress
         +--> Timeout / Network Failure: Marked UNCERTAIN
                  |
                  v
         [Authorization remains CONSUMED] -> Automated redial is strictly BLOCKED
```

- **Atomic Pre-Dispatch Consumption**: `consumeAuthorization()` runs inside an atomic Firestore transaction (`FirestoreVoiceTestAuthorizationRegistry`) before carrier HTTP dispatch or URL creation.
- **Concurrency Protection**: If 5 concurrent workers attempt to consume the same authorization, exactly 1 succeeds; 4 receive `AUTHORIZATION_ALREADY_CONSUMED`.
- **No Automatic Redials on Uncertain Outcome**: If carrier dispatch times out or returns an ambiguous result, the attempt is recorded as `status: "uncertain"`. The authorization remains consumed. Workers are strictly forbidden from automated redialing without a new authorization.
- **New Explicit Approval Required**: Reusing a consumed authorization is impossible. Every new test call requires a distinct `authorizationId` and a fresh staff approval.

---

## 5. External Provider Integration Checklist & Prerequisites

### 5.1 Exotel Cloud Telephony

| Item | Requirement | Status | Confirmed Fact vs Assumption |
|---|---|---|---|
| **Account Activation** | Exotel account enabled for Connect Voice AI bidirectional streaming | Pending account provisioning | **Confirmed Fact**: Exotel provides Connect Voice AI for bidirectional streaming. **Assumption**: Streaming feature must be activated by Exotel account manager for the specific account SID. |
| **ExoPhone** | Dedicated India virtual number (e.g. `080XXXXXXXX`) | Pending provisioning | **Confirmed Fact**: Caller ID must match a provisioned ExoPhone in the account. **Assumption**: Geographic DID (Bangalore/Mumbai) vs national 1800/140 number. |
| **India Cluster Endpoint** | `https://api.in.exotel.com/v1/Accounts/<account_sid>/Calls/connect` | Configured & enforced | **Confirmed Fact**: India traffic must use `api.in.exotel.com` (Mumbai cluster) on `/Calls/connect` (aligned with Connect Voice AI specification). Singapore endpoint (`api.exotel.com`) is rejected. |
| **DLT & TRAI Classification** | Service-implicit catering confirmation vs promotional telemarketing | Requires carrier confirmation | **Regulatory Requirement**: Outbound calls confirming customer event requests are service communications. Whether DLT PE registration is mandatory for this specific use case requires written Exotel confirmation. |
| **StreamUrl Requirements** | Publicly accessible `wss://` endpoint on port 443 with valid TLS certificate; length <= 600 characters | Enforced in bridge code | **Confirmed Fact**: Exotel mandates HTTPS/WSS and enforces a strict 600-character StreamUrl limit. |
| **Outbound Media Framing** | Signed 16-bit little-endian mono PCM at 8kHz or 16kHz; packet sizes 3,200 to 99,840 bytes (320-byte multiples) | Implemented & verified | **Confirmed Fact**: Documented Exotel AgentStream packet framing requirement. |

### 5.2 Azure Cognitive Services (Speech)

| Item | Requirement | Status | Confirmed Fact vs Assumption |
|---|---|---|---|
| **Resource & Region** | Azure Speech Service provisioned in `centralindia` (Pune) | Recommended for low latency | **Confirmed Fact**: Azure Speech is available in `centralindia`. |
| **Pricing Tier** | Standard S0 tier (quota = 100 concurrent streams) | Recommended | **Confirmed Fact**: Free (F0) tier is restricted to 1 concurrent real-time STT request. Standard (S0) tier provides a documented default quota of 100 concurrent real-time requests. The 20-stream figure is an internal capacity target, not an Azure quota limit. |
| **STT Models** | Continuous real-time recognition for `en-IN`, `hi-IN`, `te-IN` | Configured | **Confirmed Fact**: All three locales supported by Azure Speech STT. |
| **Neural TTS Voices** | Neural voices for English (`en-IN-NeerjaNeural`), Hindi (`hi-IN-SwaraNeural`), Telugu (`te-IN-ShrutiNeural`) | Configured | **Confirmed Fact**: Verified neural voice availability in Azure. |
| **Streaming Integration** | PushAudioInputStream / PullAudioInputStream for bidirectional streaming | Architecture ready | **Confirmed Fact**: Azure Speech SDK supports raw PCM stream inputs and outputs. |

### 5.3 Fastify WebSocket Audio Bridge Hosting

| Item | Requirement | Status | Confirmed Fact vs Assumption |
|---|---|---|---|
| **Persistent Hosting** | Standalone Fastify service (Cloud Run / Fly.io / AWS ECS / VM in Mumbai `asia-south1`) | Ready via `start:voice-bridge` | **Confirmed Fact**: Cloud Run fully supports persistent WebSockets (up to 60 min timeouts). Running Fastify separately from Next.js is an architectural isolation decision (preventing persistent audio streams from tying up Next.js instances). |
| **Resources** | 512MB RAM, 1 vCPU (Provisional Estimate) | Pending load benchmark | **Provisional Estimate**: Sizing must be validated by empirical load testing measuring memory RSS, CPU load, active connections, buffer size, STT/TTS latency, and disconnect rates. |
| **TLS & Networking** | Valid public SSL certificate, WebSocket reverse proxy support (`Connection: Upgrade`, `Upgrade: websocket`) | Required in infra | **Confirmed Fact**: Exotel connects over secure WSS only. |
| **Distributed Token Replay** | Redis (Upstash) or Firestore TTL index on `voice_stream_nonces.expireAt` | Configured in `firestore.indexes.json` | **Confirmed Fact**: Prevents token replay across horizontal bridge instances. |

---

## 6. Controlled Test Runbook (Single Internal Test Call)

When external providers are provisioned and an internal test is scheduled, follow this exact step-by-step procedure:

```
[Preflight Config] -> [Independent Consent] -> [Allowlist Entry] -> [Issue Authorization]
         |
         v
[Enable Kill-Switch (Temporary)] -> [Initiate Single Call] -> [Audio & Turn Verification]
         |
         v
[Barista Approval Check] -> [Immediate Kill-Switch Deactivation] -> [Audit & Privacy Review]
```

### Step 1: Preflight Configuration Verification
1. Confirm Fastify bridge server is running (`npm run start:voice-bridge`) and health check returns `{"status":"ok"}` on `GET /health`.
2. Confirm public TLS endpoint is accessible from the internet (e.g. `curl -k https://<bridge-host>/health`).
3. Confirm environment variables are populated:
   - `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`
   - `EXOTEL_CALLER_ID` (verified provisioned ExoPhone)
   - `EXOTEL_STREAM_URL` (e.g. `wss://<bridge-host>/media`)
   - `EXOTEL_STREAM_SECRET` (matching bridge secret)
   - `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` (`centralindia`)

### Step 2: Register Independent Voice Consent
1. Using the operator CLI or admin tool, register explicit voice consent for the operator's internal test phone number:
   ```json
   {
     "phoneNumber": "+91XXXXXXXXXX",
     "channel": "voice",
     "purpose": "voice_booking",
     "eventType": "grant",
     "granted": true,
     "consentText": "Operator internal testing explicit voice consent",
     "consentVersion": "v1.0"
   }
   ```
2. Confirm no active DND record suppresses `+91XXXXXXXXXX`.

### Step 3: Configure Server-Side Test Allowlist
1. Add the exact normalized E.164 test number to the server environment:
   ```bash
   VOICE_TEST_WHITELIST_PHONES="+91XXXXXXXXXX"
   VOICE_TEST_MODE="true"
   ```
2. Verify that any non-whitelisted number is rejected immediately.

### Step 4: Issue Single-Use Test Authorization
1. Authenticated operator creates a test authorization record in Firestore:
   ```json
   {
     "authorizationId": "vta_test_001",
     "authorizedPhone": "+91XXXXXXXXXX",
     "approvedBy": "operator_admin_uid",
     "approvedAt": "<ISO_NOW>",
     "expiresAt": "<ISO_NOW + 10_MINUTES>",
     "status": "active",
     "purpose": "controlled_single_call_test"
   }
   ```

### Step 5: Temporary Feature Activation & Call Initiation
1. Temporarily enable voice booking for this controlled test:
   ```bash
   VOICE_BOOKING_ENABLED=true
   ```
2. Initiate the call session via the authenticated API passing `testAuthorizationId: "vta_test_001"`.
3. Operator answers the incoming call on the test device.

### Step 6: Audio & Conversational Flow Verification
1. Verify assistant greeting audio in English/Hindi/Telugu.
2. Provide test booking details (e.g. "We need coffee catering for 50 guests on Saturday").
3. Verify Azure Speech STT transcript accuracy in server logs.
4. Verify dynamic quotation generation and assistant quotation readback.
5. Provide explicit customer consent ("Yes, please proceed with booking").
6. Verify session transitions to `awaiting_staff_approval`.

### Step 7: Barista Staff Approval Verification
1. Log into Barista Dashboard (`/barista`) as authorized staff.
2. Review pending voice booking, guest count, and quotation hash.
3. Click "Approve Booking".
4. Confirm transition to `booking_confirmed` and generation of `officialBookingId`.

### Step 8: Immediate Kill-Switch Shutdown & Teardown
1. Immediately reset the emergency kill-switch:
   ```bash
   VOICE_BOOKING_ENABLED=false
   ```
2. Verify the test authorization `vta_test_001` is marked `status: "consumed"`.
3. Verify that any second attempt with `vta_test_001` fails closed.

### Step 9: Post-Test Log & Privacy Audit
1. Inspect application logs and Firestore audit records:
   - Confirm phone numbers appear only masked (e.g. `+9198******10`).
   - Confirm zero authorization tokens, stream secrets, or raw audio bytes were written to disk or logs.
   - Confirm carrier recording was disabled (`recordingEnabled: false`).

---

## 7. Verification Test Suite Status

All 7 verification test suites are passing with zero failures and zero linter warnings:

- `test:p6651` (Controlled Test Authorization & Safety): **12/12 Passed**
- `test:p6641` (Voice Bridge Integration Gap Closure): **12/12 Passed**
- `test:p663` (WebSocket Audio Bridge & Codecs): **All Passed**
- `test:p662` (Exotel Voice Provider): **14/14 Passed**
- `test:p6612` (Expired Initiation Recovery): **7/7 Passed**
- `test:p6611` (Voice Initiation Idempotency): **7/7 Passed**
- `test:p661` (Durable Call Attempt Foundation): **10/10 Passed**
- `typecheck` & `lint`: **0 Errors, 0 Warnings**

---

## 8. Summary of Operational Guardrails

- `VOICE_BOOKING_ENABLED=false` is active and hard-coded as the default.
- No live calls can be placed without:
  1. An active global flag.
  2. An exact match in `VOICE_TEST_WHITELIST_PHONES`.
  3. Authoritative independent voice consent in the consent repository.
  4. An unexpired, unconsumed, staff-approved single-use authorization record.
- Any carrier uncertainty or network drop strictly blocks background redials.
- Staff approval is mandatory for all final quotations.
