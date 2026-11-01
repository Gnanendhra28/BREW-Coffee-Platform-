# BREW Coffee — Phase 6.2.2 Hardening Report
## Confirmation & Staff Authorization Hardening

**Date:** November 1, 2026  
**Status:** Complete & Verified  
**Branch:** `main`  
**Module:** `src/lib/voiceBooking/`  
**Dedicated Verification Script:** `scripts/verify-phase6-2-2-hardening.ts` (`npm run test:p622`)

---

## 1. Executive Summary & Security Review Findings

Following the Phase 6.2.1 hardening phase, an independent source-code security review uncovered several residual vulnerabilities in confirmation handling, staff authorization, and request lifecycle timeouts:

1. **Permissive Low-Confidence Confirmation**:
   - `conversationEngine.ts` evaluated confirmation intent without enforcing that the provider extraction succeeded with high confidence ($\ge 0.85$). An extraction returning `status: "low_confidence"` or provider errors (`api_failure`, `invalid_response`) could inadvertently accept a conversational affirmative.
2. **Implicit and Unilateral Confirmation Triggers**:
   - The engine previously lacked an explicit multi-gate confirmation policy. Gemini outputs setting `customerConfirmed: true` or `confirmationIntent: "positive_acceptance"` were not cross-validated against deterministic utterance classification and active quotation validity.
3. **Quotation Invalidation Gaps**:
   - Modifications made to guest counts or package tiers after a quotation was presented required strict invalidation. A confirmation turn submitted while requirements diverged from the presented quotation could have confirmed an obsolete price.
4. **Weak Administrative Approval Boundary**:
   - `approveBookingByStaff` accepted a simple `staffApprovalId: string` parameter without validating caller identity or enforcing staff role verification (`barista`, `fleet_admin`, `admin`). This conflated audit trail identifiers with authorization context and allowed unauthenticated callers to approve catering bookings.
5. **False-Positive Affirmative Classification**:
   - Conversational questions (*"Can you confirm if oat milk is included?"*), conditional clauses (*"If the price is 10000 then yes"*), and narrative statements (*"Yes, I went to Starbucks yesterday"*) triggered positive confirmation across English, Hindi, and Telugu dialects.
6. **Unrestricted Field Clearing**:
   - `applyRequirementsPatch` did not restrict which fields could be cleared by model extraction, theoretically exposing internal state, audit trails, and metadata (`staffApprovalId`, `customerConfirmed`, `id`, `corrections`) to accidental or adversarial clearing.
7. **Unbounded Response Body Timeout**:
   - In `GeminiExtractionProvider`, the `AbortController` timeout only protected the initial `fetch()` connection. If the HTTP response body stream stalled during `response.json()`, the worker would hang indefinitely.

All vulnerabilities have been resolved, strictly tested, and verified with 15 test groups (64 automated tests) in `scripts/verify-phase6-2-2-hardening.ts`.

---

## 2. Changes Made & Files Modified

| File | Changes Made |
|---|---|
| `src/lib/voiceBooking/types.ts` | Added `StaffAuthorizationContext` (`staffIdentity`, `staffRole`, `staffApprovalId`), `CUSTOMER_CLEARABLE_FIELDS`, `CustomerClearableField`, `ConfirmationSafetyEvaluation`, and updated `ConversationTurnResult`. |
| `src/lib/voiceBooking/schemas.ts` | Exported `CUSTOMER_CLEARABLE_FIELDS` and `CustomerClearableFieldSchema`. Created `StaffAuthorizationContextSchema` enforcing non-empty identity, valid staff roles (`barista`, `fleet_admin`, `admin`), and non-empty approval ID. Constrained `GeminiExtractionOutputSchema.clearedFields` to `CustomerClearableFieldSchema`. |
| `src/lib/voiceBooking/providers/extractionProvider.ts` | Hardened `classifyConfirmationIntent` with question, modification, and narrative shields for English, Hindi, Telugu, Hinglish, and Tenglish. Updated `GeminiExtractionProvider` to bound both `fetch()` and `response.json()` under `AbortController`, clearing the timer in a `finally` block. Added optional `apiKey` and `model` configuration to provider constructor. |
| `src/lib/voiceBooking/conversationEngine.ts` | Implemented `evaluateConfirmationSafetyGate` enforcing 5 fail-closed gates before confirmation. Updated `applyRequirementsPatch` to filter cleared fields against `CUSTOMER_CLEARABLE_FIELDS` and ignore model `customerConfirmed` flags. Hardened `approveBookingByStaff` to mandate authenticated `StaffAuthorizationContext` with role checking. |
| `package.json` | Registered `"test:p622": "npx tsx scripts/verify-phase6-2-2-hardening.ts"`. |
| `scripts/verify-phase6-2-voice-booking.ts` | Updated `approveBookingByStaff` calls to supply authenticated `StaffAuthorizationContext`. Maintained 88/88 test pass rate. |
| `scripts/verify-phase6-2-1-hardening.ts` | Updated `approveBookingByStaff` calls to supply authenticated `StaffAuthorizationContext`. Maintained 64/64 test pass rate. |
| `scripts/verify-phase6-2-2-hardening.ts` | Created dedicated 64-test verification suite covering all Phase 6.2.2 requirements. |

---

## 3. Detailed Hardening Specifications

### 3.1 Deterministic Confirmation Safety Gate
`evaluateConfirmationSafetyGate` replaces single-source trust with a multi-layered verification gate:
1. **Rejection Precedence**: If deterministic classification or provider extraction flags `rejection`, cancellation is honored immediately, even if a quotation was previously invalidated or absent.
2. **Active Quotation Requirement**: Confirmation strictly requires `hasValidQuotation: true`.
3. **Quotation Match Verification**: If requirements diverge from the quotation (e.g. `guestCount` changed from 100 to 150), confirmation is rejected, flagged as `modification_requested`, and re-quotation is required.
4. **Extraction Health & Confidence**: Rejects confirmation if `extractionResult.status !== "success"` or `confidenceScore < 0.85`. Provider failures (`api_failure`, `invalid_response`, `low_confidence`) fail closed.
5. **Deterministic Classifier Agreement**: The customer utterance must unambiguously match positive acceptance patterns across target languages. Both deterministic analysis and provider extraction must agree.

### 3.2 Staff Authorization Enforcement (`approveBookingByStaff`)
- Replaces raw `staffApprovalId: string` with strongly-typed `StaffAuthorizationContext`:
  ```typescript
  export interface StaffAuthorizationContext {
    staffIdentity: string;
    staffRole: "barista" | "fleet_admin" | "admin";
    staffApprovalId: string;
  }
  ```
- Rejects missing, empty, or unauthenticated contexts.
- Rejects unauthorized roles (e.g. `"customer"`, `"anonymous"`).
- Documents domain-level boundaries requiring HTTP route handlers to verify staff PIN/session cookies before dispatching approvals.

### 3.3 Confirmation False-Positive Shielding
`classifyConfirmationIntent` was expanded to prevent false positives:
- **Questions**: *"Can you confirm if oat milk is included?"*, *"Is that the final price?"*, *"क्या आप कन्फ़र्म कर सकते हैं कि दूध शामिल है?"* $\rightarrow$ `clarification_requested`.
- **Modifications**: *"Yes, but can we change the date to tomorrow?"* $\rightarrow$ `modification_requested`.
- **Narratives & Fillers**: *"Yes, I went to Starbucks yesterday"*, *"Yes, my brother loves coffee"* $\rightarrow$ `ambiguous`.
- **Conditionals**: *"If the price is 10000 then yes"* $\rightarrow$ `ambiguous`.
- **Negative Inclusions**: *"No, do not confirm yet"* $\rightarrow$ `rejection`.

### 3.4 Clearable Fields Allowlist
`CUSTOMER_CLEARABLE_FIELDS` defines the immutable allowlist of customer-clearable fields:
- `guestCount`
- `eventDate`
- `startTime`
- `durationHours`
- `venueAddress`
- `eventType`
- `beveragePreferences`
- `selectedTier`

Attempts to clear protected fields (`id`, `createdAt`, `updatedAt`, `state`, `customerConfirmed`, `staffApprovalId`, `metadata`, `corrections`, `language`, `phoneNumber`, `missingFields`) are safely rejected and ignored.

### 3.5 Bounded Timeout Lifecycle
In `GeminiExtractionProvider.extractRequirements`:
- The `AbortController` timeout signal remains active throughout the network request and the body parsing step (`await response.json()`).
- Hanging body streams abort promptly within the configured timeout window ($50\text{ms}$ in tests, $8000\text{ms}$ in production).
- Timeout handle cleanup is guaranteed via a `finally` block.

---

## 4. Verification & Test Matrix

The dedicated test suite `scripts/verify-phase6-2-2-hardening.ts` was executed with 15 comprehensive test groups:

| Test Group | Description | Status |
|---|---|---|
| Group 1 | Low-confidence extraction with positive acceptance does not confirm | **PASSED** (3/3) |
| Group 2 | API failure with positive acceptance does not confirm | **PASSED** (3/3) |
| Group 3 | Invalid model response with positive acceptance does not confirm | **PASSED** (2/2) |
| Group 4 | False-positive protection on unrelated sentences with "yes" | **PASSED** (9/9) |
| Group 5 | Uniform safety gate across Mock and Gemini providers | **PASSED** (3/3) |
| Group 6 | Confirmation without a valid active quotation is rejected | **PASSED** (2/2) |
| Group 7 | Confirmation after quotation invalidation is rejected | **PASSED** (2/2) |
| Group 8 | Missing staff role in approval is rejected | **PASSED** (2/2) |
| Group 9 | Missing staff identity in approval is rejected | **PASSED** (2/2) |
| Group 10 | Customer role cannot approve bookings (fail-closed) | **PASSED** (3/3) |
| Group 11 | Authorized staff roles (`barista`, `fleet_admin`, `admin`) can approve | **PASSED** (6/6) |
| Group 12 | Protected fields cannot be cleared via schema allowlist | **PASSED** (13/13) |
| Group 13 | Invalid clear-field patches are safely rejected at runtime | **PASSED** (2/2) |
| Group 14 | Timeout remains active while reading the response body | **PASSED** (4/4) |
| Group 15 | Regression check: Phase 6.1, 6.1.2, 6.2, and 6.2.1 behavior intact | **PASSED** (8/8) |

**Total Phase 6.2.2 Hardening Tests:** 64 Passed, 0 Failed.

---

## 5. Non-Negotiable Preservation Verification

- **Zero Website Redesign**: Homepage, menu, cart, order-status UI, and branding are 100% untouched.
- **Zero Payment Changes**: Razorpay payment lifecycle and webhooks remain untouched.
- **Zero Core Logic Changes**: Event Booking Concierge pricing formulas and Firestore security rules remain untouched.
- **Feature Flag Disabled**: `VOICE_BOOKING_ENABLED` remains false by default.
- **Offline & Isolated**: Zero external telephony, WhatsApp, or cloud billing activations.
