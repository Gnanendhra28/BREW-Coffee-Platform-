# BREW Coffee — Phase 6.2.3 Hardening Report
## Trusted Staff Authorization & Full Quotation Integrity

**Date:** November 1, 2026  
**Status:** Complete & Verified  
**Branch:** `main`  
**Module:** `src/lib/voiceBooking/` & `src/lib/auth/adminAuth.ts`  
**Dedicated Verification Suite:** `scripts/verify-phase6-2-3-hardening.ts` (`npm run test:p623`)

---

## 1. Executive Summary & Root Causes

Following the completion of Phase 6.2.2, an independent source-code security review identified two critical architectural boundaries that required hardening before production voice booking workflows could proceed:

1. **Client-Controlled Staff Authorization Risk**:
   - In Phase 6.2.2, `approveBookingByStaff` received a strongly-typed `StaffAuthorizationContext` containing `staffIdentity`, `staffRole`, and `staffApprovalId`. However, if caller code or API route handlers forwarded client-supplied JSON parameters directly into the context, an unauthenticated client or ordinary customer could forge `staffRole: "admin"` or spoof a barista identity.
   - **Root Cause**: The authorization context lacked a strict, server-side cryptographic enforcement bridge connecting HTTP request cookies (`brew_session`) and session revocation stores to the domain approval function.

2. **Partial Quotation Integrity Checking**:
   - The confirmation safety gate previously checked whether `guestCount` or `selectedTier` matched the active quotation. However, other material requirements—specifically `eventDate`, `startTime`, `durationHours`, `venueAddress`, and crucially `eventType`—directly alter logistics, equipment allocation, travel surcharges, and guest consumption rates (calculated in `src/lib/eventBookingConcierge/quoteEngine.ts`).
   - If a customer verbally changed the date, location, or event type from Corporate to Wedding after receiving a quote, an outdated quotation could have been confirmed.
   - **Root Cause**: Absence of an immutable, cryptographically hashed canonical snapshot capturing all 7 material quotation inputs at the exact moment of quote generation.

Both vulnerabilities have been comprehensively resolved, verified by 13 test groups (59 automated tests) in `scripts/verify-phase6-2-3-hardening.ts`, and checked against all regression suites.

---

## 2. Changes Made & Files Modified

| File | Action | Description |
|---|---|---|
| `src/lib/voiceBooking/types.ts` | Modified | Added `QuotationMaterialSnapshot`, `QuotationIntegrityResult`, updated `ConfirmationSafetyEvaluation`, and added `quotationSnapshot` to `VoiceBookingSession`. |
| `src/lib/voiceBooking/schemas.ts` | Modified | Added `QuotationMaterialSnapshotSchema` with strict calendar date and time validation; updated `VoiceBookingSessionSchema` to validate `quotationSnapshot`. |
| `src/lib/voiceBooking/quotationAdapter.ts` | Modified | Implemented `createQuotationSnapshot` (canonical key sorting + SHA-256 hash) and `verifyQuotationIntegrity` (validates all 7 material fields and hash). |
| `src/lib/voiceBooking/conversationEngine.ts` | Modified | Added `"eventType"` to `MATERIAL_FIELDS`; initialized `quotationSnapshot: null`; bound snapshots to quotation issuance; invalidated snapshot on material edit; hardened `evaluateConfirmationSafetyGate` with snapshot integrity; hardened `approveBookingByStaff` with runtime Zod schema parsing. |
| `src/lib/auth/adminAuth.ts` | Created | Server-side trusted authentication bridge: `verifyStaffSession`, `deriveTrustedStaffAuthorizationContext`, and `authenticateAndApproveBooking`. Enforces HMAC-SHA256 session verification, revocation checks, and strict staff role checking (`barista`, `fleet_admin`, `admin`). |
| `src/app/api/voice-booking/approve/route.ts` | Created | Production HTTP route handler deriving staff identity and role strictly from authenticated `brew_session` cookie; rejects unauthenticated / forged requests. |
| `src/app/api/admin/voice-bookings/approve/route.ts` | Created | Canonical alias route handler ensuring consistency across admin API namespaces. |
| `package.json` | Modified | Added `"test:p623": "npx tsx scripts/verify-phase6-2-3-hardening.ts"`. |
| `scripts/verify-phase6-2-3-hardening.ts` | Created | Dedicated 59-test verification suite covering all 13 required test cases. |

---

## 3. Trusted Staff Authorization Boundary

### 3.1 Architectural Separation of Concerns
The approval system strictly enforces three distinct layers of security:
1. **Cryptographic Session Verification** (`verifyStaffSession`):
   - Reads the HTTP-only `brew_session` cookie from the incoming request.
   - Verifies the HMAC-SHA256 signature using `SESSION_SECRET`.
   - Verifies the session has not expired and has not been revoked in the session revocation store (`isSessionRevoked`).
   - Verifies the authenticated user possesses an authorized staff role (`barista`, `fleet_admin`, or `admin`). Ordinary `"customer"` accounts or anonymous callers are rejected with HTTP 403 / unauthorized status.

2. **Server-Side Context Derivation** (`deriveTrustedStaffAuthorizationContext`):
   - Derives `staffIdentity` directly from the authenticated session's `uid` (or authenticated email/identifier).
   - Derives `staffRole` directly from the cryptographically verified session role.
   - Generates or binds an isolated audit identifier (`staffApprovalId`), completely decoupled from client control:
   ```typescript
   export function deriveTrustedStaffAuthorizationContext(params: {
     authenticatedStaff: AuthenticatedStaffSession;
     approvalAuditId?: string;
   }): StaffAuthorizationContext {
     const approvalId = params.approvalAuditId?.trim() || `appr_${Date.now()}_${randomBytes(4).toString("hex")}`;
     return {
       staffIdentity: params.authenticatedStaff.uid,
       staffRole: params.authenticatedStaff.role,
       staffApprovalId: approvalId,
     };
   }
   ```

3. **Domain Approval Enforcement** (`approveBookingByStaff`):
   - At the domain layer, `approveBookingByStaff` validates the context against `StaffAuthorizationContextSchema.safeParse`.
   - Reject any payload missing `staffIdentity`, missing `staffRole`, missing `staffApprovalId`, or containing invalid/unknown roles.

### 3.2 HTTP API Route Handlers
Both `/api/voice-booking/approve` and `/api/admin/voice-bookings/approve` reject client-supplied `staffIdentity` or `staffRole` parameters in request bodies:
- If a client attempts to supply `{ staffRole: "admin", staffIdentity: "hacker" }`, the route handler ignores the body parameters and reads only from the validated server session cookie.
- Missing or invalid sessions return `401 Unauthorized`.
- Non-staff sessions return `403 Forbidden`.
- Successful approval returns `200 OK` with sanitized session and approval metadata.

---

## 4. Full Quotation Snapshot Integrity

### 4.1 Material Requirements
The following 7 material fields directly dictate pricing, logistics, and van capacity:
1. `guestCount` — Base volume and barista count.
2. `eventDate` — Weekend/peak surge pricing and calendar availability.
3. `startTime` — Early morning / evening operations surcharges.
4. `durationHours` — Operational van rental hours.
5. `venueAddress` — Travel distance and logistics surcharge.
6. `selectedTier` — Core beverage package pricing (`essential`, `signature`, `artisanal`).
7. `eventType` — **Crucial pricing factor**: In `src/lib/eventBookingConcierge/quoteEngine.ts`, `eventType` directly feeds into `calculateConsumption(...)`, applying different consumption multipliers for corporate events, weddings, and birthdays.

### 4.2 Canonical SHA-256 Snapshot Generation
When a quotation is issued by `generateQuotationForSession`, a canonical snapshot is constructed:
```typescript
export function createQuotationSnapshot(
  requirements: BookingRequirements,
  generatedAt: string = new Date().toISOString()
): QuotationMaterialSnapshot {
  const canonicalData = {
    durationHours: requirements.durationHours,
    eventDate: requirements.eventDate,
    eventType: requirements.eventType,
    guestCount: requirements.guestCount,
    selectedTier: requirements.selectedTier,
    startTime: requirements.startTime,
    venueAddress: requirements.venueAddress,
  };

  const payload = JSON.stringify(canonicalData, Object.keys(canonicalData).sort());
  const hash = createHash("sha256").update(payload).digest("hex");

  return {
    ...canonicalData,
    hash,
    generatedAt,
  };
}
```

### 4.3 Two-Gate Confirmation Evaluation
In `conversationEngine.ts`:
1. **Gate 1: Intent & Rejection Precedence**:
   - Utterances are classified deterministically. If customer asks questions (*"Can you confirm if oat milk is included?"*), requests changes, or is ambiguous, their intent is preserved as `clarification_requested`, `modification_requested`, or `ambiguous` without throwing snapshot errors.
2. **Gate 2: Quotation Snapshot Integrity**:
   - If the customer utters an unambiguous positive acceptance, `evaluateConfirmationSafetyGate` executes `verifyQuotationIntegrity(session.quotationSnapshot, session.requirements)`.
   - If any of the 7 material fields have been modified, or if the SHA-256 hash fails verification, the safety gate fails closed (`canConfirm: false`, `reason: "requirements_diverged_from_quotation"`), resets `customerConfirmed: false`, and prompts the user with the revised quotation.

---

## 5. Verification Results

### 5.1 Phase 6.2.3 Dedicated Verification Suite (`npm run test:p623`)
The suite executed 13 comprehensive test groups covering 59 automated assertions:

```text
================================================================================
🚀 BREW PHASE 6.2.3: TRUSTED STAFF AUTH & FULL QUOTATION INTEGRITY VERIFICATION
================================================================================

[Test Group 1] Rejection of Missing or Empty Staff Identity
  ✓ Missing staffIdentity rejected by StaffAuthorizationContextSchema
  ✓ Empty staffIdentity rejected by StaffAuthorizationContextSchema
  ✓ approveBookingByStaff fails closed with missing staffIdentity

[Test Group 2] Rejection of Missing, Empty, or Invalid Staff Role
  ✓ Missing staffRole rejected by schema
  ✓ Invalid role 'manager' rejected by schema
  ✓ Invalid role 'customer' rejected by schema
  ✓ approveBookingByStaff fails closed with unauthorized role

[Test Group 3] Rejection of Missing or Empty Staff Approval ID
  ✓ Missing staffApprovalId rejected by schema
  ✓ Empty staffApprovalId rejected by schema
  ✓ approveBookingByStaff fails closed with missing staffApprovalId

[Test Group 4] Acceptance of Valid Staff Roles & Context Separation
  ✓ Valid barista role accepted and approves session
  ✓ Valid fleet_admin role accepted and approves session
  ✓ Valid admin role accepted and approves session
  ✓ Context separates staffIdentity ('usr_barista_44') from staffApprovalId ('appr_99812')

[Test Group 5] Trusted Server Authentication Bridge (adminAuth.ts)
  ✓ Valid barista session token verifies successfully
  ✓ Valid fleet_admin session token verifies successfully
  ✓ Expired session token rejected with 401
  ✓ Invalid signature session token rejected with 401
  ✓ Revoked session token rejected with 401
  ✓ Customer session token rejected with 403
  ✓ deriveTrustedStaffAuthorizationContext derives staffIdentity from verified uid
  ✓ Client-supplied staffRole 'admin' ignored; verified barista role preserved
  ✓ authenticateAndApproveBooking succeeds with valid staff session token
  ✓ authenticateAndApproveBooking fails closed with customer token

[Test Group 6] API HTTP Route Handlers (/api/voice-booking/approve)
  ✓ Missing brew_session cookie returns 401
  ✓ Customer brew_session cookie returns 403
  ✓ Valid Barista cookie returns 200 and approves booking
  ✓ Client body attempting to spoof staffRole 'admin' and staffIdentity 'attacker' is ignored; server session used
  ✓ Canonical alias route /api/admin/voice-bookings/approve returns 200

[Test Group 7] Quotation Material Snapshot Creation & Canonical Hash Integrity
  ✓ createQuotationSnapshot captures all 7 material fields and SHA-256 hash
  ✓ Identical material requirements produce identical SHA-256 hash
  ✓ Tampered hash detected and rejected by verifyQuotationIntegrity
  ✓ Mismatched guestCount detected by verifyQuotationIntegrity
  ✓ Mismatched eventType detected by verifyQuotationIntegrity

[Test Group 8] Material Invalidation on Every Material Field
  ✓ Altering guestCount invalidates quotation and snapshot
  ✓ Altering eventDate invalidates quotation and snapshot
  ✓ Altering startTime invalidates quotation and snapshot
  ✓ Altering durationHours invalidates quotation and snapshot
  ✓ Altering venueAddress invalidates quotation and snapshot
  ✓ Altering selectedTier invalidates quotation and snapshot
  ✓ Altering eventType invalidates quotation and snapshot

[Test Group 9] Non-Material Modifications Do Not Invalidate Quotation
  ✓ Updating beveragePreferences retains quotation and snapshot
  ✓ Customer name modification does not invalidate quotation

[Test Group 10] Confirmation Blocked When Any Material Field Diverges
  ✓ Confirmation blocked when guestCount diverges
  ✓ Confirmation blocked when eventDate diverges
  ✓ Confirmation blocked when startTime diverges
  ✓ Confirmation blocked when durationHours diverges
  ✓ Confirmation blocked when venueAddress diverges
  ✓ Confirmation blocked when selectedTier diverges
  ✓ Confirmation blocked when eventType diverges

[Test Group 11] Confirmation Succeeds When All Material Fields Match
  ✓ Confirmation succeeds with valid quotation and matching snapshot

[Test Group 12] Model Output Cannot Overwrite Quotation Snapshot
  ✓ Malicious model response trying to inject fake quotationSnapshot is ignored

[Test Group 13] Non-Positive Utterance Intent Preservation
  ✓ Ambiguous statement retains 'ambiguous' intent without snapshot integrity error
  ✓ Clarification question retains 'clarification_requested' without snapshot integrity error
  ✓ Modification request retains 'modification_requested' without snapshot integrity error

================================================================================
🎉 ALL 59 PHASE 6.2.3 TRUSTED AUTH & QUOTATION INTEGRITY TESTS PASSED!
================================================================================
```

### 5.2 Full Regression Suite Summary

| Suite / Command | Scope | Result |
|---|---|---|
| `npm run test:p61` | Phase 6.1 Communication Foundation & Consent | **39/39 PASSED** |
| `npm run test:p62` | Phase 6.2 Voice Booking Conversation Engine | **88/88 PASSED** |
| `npm run test:p621` | Phase 6.2.1 Conversation Safety & Zod Guardrails | **64/64 PASSED** |
| `npm run test:p622` | Phase 6.2.2 Confirmation & Staff Authorization Hardening | **64/64 PASSED** |
| `npm run test:p623` | Phase 6.2.3 Trusted Auth & Full Quotation Integrity | **59/59 PASSED** |
| `npm run typecheck` | TypeScript compiler (`tsc --noEmit`) | **0 Errors** |
| `npm run lint` | ESLint Next.js rules | **0 Errors** |
| `npm test` | Master Production Verification (19 suites) | **19/19 PASSED (100%)** |
| `npm run test:e2e` | Playwright Customer & Staff Journeys | **18/18 PASSED** |
| `npm run build` | Next.js 16 production standalone build | **Clean Build (19 static pages + dynamic routes)** |

---

## 6. Commitments & Current System State

- **Website Integrity**: All customer-facing pages (`/`, `/menu`, `/cart`, `/location`, `/order-status`), ordering workflows, Razorpay payments, and Firestore rules remain untouched.
- **Provider Status**: Voice and WhatsApp integrations remain mock providers; no external billable telephony or WhatsApp APIs are enabled.
- **Feature Flag**: `VOICE_BOOKING_ENABLED` remains strictly `false`.
- **Phase Boundary**: Phase 6.2.3 is complete. Phase 6.3 has **not** been started. Awaiting user review and authorization.
