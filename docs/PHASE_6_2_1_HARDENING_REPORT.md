# BREW Coffee — Phase 6.2.1 Hardening Report
## Conversation Engine Safety & Reliability Hardening

**Date:** November 1, 2026  
**Status:** Complete & Verified  
**Branch:** `main`  
**Module:** `src/lib/voiceBooking/`  
**Dedicated Verification Script:** `scripts/verify-phase6-2-1-hardening.ts` (`npm run test:p621`)

---

## 1. Executive Summary & Review Findings

Following the code review of Phase 6.2, several critical reliability, validation, and security vulnerabilities were identified in the conversation engine:
1. **Unvalidated Gemini JSON Parsing**: Gemini output was previously parsed with `JSON.parse()` without Zod validation, leaving the engine vulnerable to hallucinated fields, unconstrained guest counts, impossible dates, and arbitrary values.
2. **Insecure API Key URL Transport**: The Gemini API key was passed as a URL query parameter (`?key=...`), exposing credentials to network proxy logs, referrers, and diagnostic telemetry.
3. **Hard-coded Model Identifier**: The provider hard-coded `gemini-1.5-flash` instead of dynamically referencing `process.env.VOICE_AGENT_MODEL`.
4. **Fabricated Quotation Defaults**: The quotation adapter silently supplied fallback defaults (`2026-12-15`, `4` hours, `10:00` start time) when customer inputs were missing, creating artificial bookings and masking incomplete collection.
5. **Silent Midnight Wrapping**: An event starting late in the evening (e.g. 22:00 for 4 hours) was silently wrapped to 02:00 the next day using modulo arithmetic, violating single-day mobile van operational rules.
6. **Naïve Nullish Coalescing Merge**: Requirement updates used `??`, making it impossible for customers to explicitly clear a previously stated slot or correct an existing value with an audit trail.
7. **Permissive Confirmation Matching**: `includes("yes")` caused unrelated conversational remarks (*"Yes, my colleague mentioned BREW last month, but what beans do you use?"*) to be misclassified as booking confirmations.
8. **Session Mutation & Identity Assumptions**: Caller session objects were directly mutated, and session IDs could be supplied without verifying phone ownership.

All 8 vulnerabilities have been systematically addressed and verified with a 64-test dedicated hardening suite.

---

## 2. Changes Made & Files Modified

| File | Changes Made |
|---|---|
| `src/lib/voiceBooking/schemas.ts` | Added `isValidCalendarDate` (leap-year and month boundary validator) and `isValidTime24`. Implemented `GeminiExtractionOutputSchema` with `.strict()` to reject unexpected model keys. Hardened `BookingRequirementsSchema` with calendar and time validation. |
| `src/lib/voiceBooking/types.ts` | Added `ConfirmationIntent`, `RequirementCorrectionRecord`, `FieldPatchAction`, `BookingRequirementsPatch`, `ExtractionStatus`, and `StructuredExtractionResult`. Extended `ExtractionProvider` contract. |
| `src/lib/voiceBooking/quotationAdapter.ts` | Completely eliminated fabricated defaults (`2026-12-15`, `4`, `10:00`, `"STANDARD"`). Added `validateQuotationRequirements`. Enforced strict operational window validation to reject service durations crossing midnight. |
| `src/lib/voiceBooking/providers/extractionProvider.ts` | Implemented `classifyConfirmationIntent` supporting English, Hindi, Hinglish, Telugu script, and Tenglish while rejecting false-positive "yes" triggers. Hardened `GeminiExtractionProvider` with `x-goog-api-key` header transport, `VOICE_AGENT_MODEL` env lookup, bounded timeout, and production fail-closed semantics. Added explicit field clearing and correction support in `MockExtractionProvider`. |
| `src/lib/voiceBooking/conversationEngine.ts` | Enforced strict session immutability via deep cloning. Added session and message schema validation before processing. Implemented `applyRequirementsPatch` distinguishing sets, updates, clears, and low-confidence ignores. Enforced material change quotation invalidation. Gated confirmation on `positive_acceptance`. Added RBAC role enforcement to `approveBookingByStaff`. |
| `src/lib/voiceBooking/repositories/sessionRepository.ts` | Added comprehensive architectural documentation detailing single-process memory limitations and distributed requirements for production clustering. |
| `package.json` | Added `"test:p621": "npx tsx scripts/verify-phase6-2-1-hardening.ts"`. |
| `scripts/verify-phase6-2-voice-booking.ts` | Updated linter warnings and maintained 100% pass rate (88/88 tests). |
| `scripts/verify-phase6-2-1-hardening.ts` | Created 64-test dedicated verification suite covering all Phase 6.2.1 hardening requirements. |

---

## 3. Detailed Hardening Specifications

### 3.1 Strict Gemini Response Validation
- **Zod Output Schema**: Model outputs are validated against `GeminiExtractionOutputSchema.strict()`. If the LLM generates any unexpected keys (such as `estimatedCost`, `fakeDiscount`), validation fails immediately.
- **Calendar Verification**: Rejects impossible dates (e.g. `2026-02-30`, `2026-04-31`, `2025-02-29`) while accepting valid leap year dates (`2024-02-29`).
- **Domain Boundaries**: Validates guest counts ($10 \le \text{guests} \le 1000$), 24-hour times (`00:00` - `23:59`), service durations ($1 \le \text{hours} \le 12$), and supported packages (`BASIC`, `STANDARD`, `PREMIUM`).
- **Structured Failure Reporting**: Providers return `StructuredExtractionResult` distinguishing:
  - `status: "success"`
  - `status: "invalid_response"`
  - `status: "api_failure"`
  - `status: "service_unavailable"`
  - `status: "low_confidence"`
  Mock fallbacks are never falsely reported as successful Gemini extractions.

### 3.2 Secure API Transport & Configuration
- **Header Authentication**: API key is passed exclusively via the `x-goog-api-key` HTTP header. URL query parameters (`?key=...`) are completely removed.
- **Environment Model**: Uses `process.env.VOICE_AGENT_MODEL` without hard-coding model identifiers.
- **Bounded Timeout**: Configured with an `AbortController` bounded to 8000ms.
- **Rate Limit Handling**: Explicitly catches HTTP 429 and returns `api_failure` with rate limit diagnostic.
- **Production Fail-Closed**: In `NODE_ENV === "production"`, missing credentials return `service_unavailable` and do NOT substitute mock extraction.

### 3.3 Quotation Integrity & Operational Windows
- **Zero Fabrication**: All mandatory slots (`guestCount`, `eventDate`, `startTime`, `durationHours`, `venueAddress`) must be populated by the customer. Missing slots throw a structured validation error.
- **Midnight Wrap Prevention**: An event starting at 22:00 for 4 hours ends at 02:00 the next day. Single-day mobile van operations must conclude by 23:59; crossings are rejected with:
  > *"Service duration (4h) starting at 22:00 crosses midnight into the next day. Single-day mobile van operations must conclude by 23:59."*

### 3.4 Structured Patch Model & Customer Corrections
- **Patch Actions**: Distinguishes `set` (initial value), `update` (customer modification), `clear` (customer explicitly clears slot), `keep` (unmentioned slot), and `uncertain` (low confidence).
- **Audit Trail**: Every modification or clear is recorded in `session.requirements.corrections` with `field`, `previousValue`, `newValue`, `action`, `timestamp`, and `source`.
- **Low-Confidence Shield**: Extractions with `confidenceScore < 0.70` cannot overwrite existing valid values.
- **Stale Quote Invalidation**: If any material field (`guestCount`, `eventDate`, `startTime`, `durationHours`, `venueAddress`, `selectedTier`) is updated or cleared after quote presentation, `session.quotation` is reset to `null`, `customerConfirmed` is reset to `false`, and state transitions back to `collecting_requirements` for recalculation.

### 3.5 Robust Confirmation Intent Classification
- **False-Positive Shield**: Classifies customer utterances into 5 distinct intents:
  1. `positive_acceptance`: Unambiguous booking confirmation.
  2. `rejection`: Explicit cancellation or decline.
  3. `clarification_requested`: Questions regarding beans, travel, pricing, or timing.
  4. `modification_requested`: Customer updates guest counts, times, or packages.
  5. `ambiguous`: Conversational filler or narrative containing "yes" (e.g. *"Yes, we held our event in Mumbai last year"*).
- **Safeguard**: Only `positive_acceptance` triggers transition to `customer_confirmed` $\rightarrow$ `awaiting_staff_approval`. Ambiguous responses generate a prompt asking for explicit clarification.

### 3.6 Session Immutability & Staff RBAC
- **Deep Clone Isolation**: `processConversationTurn` clones the validated session at entry, ensuring the caller's original reference is never mutated.
- **Caller Identity Check**: If `callerPhoneNumber` is supplied, it is verified against `session.phoneNumber`. Mismatches throw an explicit security violation.
- **Staff Approval RBAC**: `approveBookingByStaff` documents that raw `staffApprovalId` is an audit identifier, not authentication. When `authenticatedStaffRole` is provided, it validates membership in `["barista", "fleet_admin", "admin"]` and rejects unauthorized roles (e.g. `customer`).

---

## 4. Verification Suite Results

### 4.1 Dedicated Hardening Suite (`scripts/verify-phase6-2-1-hardening.ts`)

```
==================================================================
  BREW Coffee — Phase 6.2.1 Conversation Engine Hardening Suite
==================================================================

Suite 1: Strict Gemini Response Validation & Security
  ✓ Valid Gemini structured output passes strict schema validation
  ✓ Rejects guest count < 10
  ✓ Rejects guest count > 1000
  ✓ Calendar check: Feb 30 is impossible
  ✓ Calendar check: April 31 is impossible
  ✓ Calendar check: Feb 29 on non-leap year 2025 is impossible
  ✓ Calendar check: Feb 29 on leap year 2024 is valid
  ✓ Gemini schema strictly rejects impossible calendar date '2026-02-30'
  ✓ 25:00 rejected as invalid time
  ✓ 12:60 rejected as invalid time
  ✓ Valid 24h boundaries accepted
  ✓ Gemini schema rejects invalid start time
  ✓ Rejects duration < 1 hour
  ✓ Rejects duration > 12 hours
  ✓ Rejects unrecognized tier 'SUPER_VIP'
  ✓ Strict schema rejects unexpected hallucinated model fields
  ✓ Production Gemini provider returns 'service_unavailable' when credentials missing
  ✓ Does not falsely claim mock fallback as successful gemini extraction

Suite 2: Quotation Input Validation Without Fabricated Defaults
  ✓ Rejects missing event date without applying fabricated default
  ✓ Rejects missing duration without applying fabricated default
  ✓ Rejects missing start time without applying fabricated default
  ✓ Rejects impossible calendar date in quotation validation
  ✓ Rejects service durations crossing midnight into the next day
  ✓ Deterministic pricing produces identical numbers without variance

Suite 3: Requirement Merging, Customer Corrections & Quote Invalidation
  ✓ Session reached awaiting_customer_confirmation with initial quote
  ✓ Quotation generated for 60 guests
  ✓ Guest count corrected to 120
  ✓ Recorded correction in audit trail
  ✓ Audit trail identifies 'guestCount' as corrected field
  ✓ Audit trail records previous value 60
  ✓ Audit trail records new value 120
  ✓ Previous quotation was invalidated and recalculated with new guest count
  ✓ Event date explicitly cleared to null
  ✓ Quotation invalidated when mandatory date cleared
  ✓ Transitioned back to collecting_requirements
  ✓ eventDate re-added to missingFields
  ✓ Valid guestCount (120) preserved against low-confidence overwrite (30)

Suite 4: Strengthened Confirmation Intent Classification
  ✓ Unrelated sentence with 'yes' classified as clarification question, NOT acceptance
  ✓ Conversational 'yes' in narrative context classified as ambiguous, NOT acceptance
  ✓ 'Yeah ok' before a question classified as clarification, NOT acceptance
  ✓ English explicit confirmation classified as positive_acceptance
  ✓ English 'I confirm' classified as positive_acceptance
  ✓ Hinglish explicit confirmation classified as positive_acceptance
  ✓ Hindi script explicit confirmation classified as positive_acceptance
  ✓ Tenglish explicit confirmation classified as positive_acceptance
  ✓ Telugu script explicit confirmation classified as positive_acceptance
  ✓ English cancellation classified as rejection
  ✓ Hindi rejection classified as rejection
  ✓ Telugu rejection classified as rejection
  ✓ Ambiguous response DOES NOT transition to staff approval
  ✓ Customer confirmation remains false
  ✓ Prompts customer for explicit clarification
  ✓ Explicit acceptance transitions to awaiting_staff_approval
  ✓ Customer confirmation recorded true

Suite 5: Session Boundaries, Immutability & RBAC Staff Approval
  ✓ Caller's original session state was NOT mutated
  ✓ Caller's original history was NOT mutated
  ✓ Malformed session object rejected by schema guard
  ✓ Session boundary rejects malformed input safely
  ✓ Rejects caller phone number mismatch
  ✓ Caller phone authorization check enforced
  ✓ Rejects approval when caller role is not staff
  ✓ Staff RBAC enforced: customer role blocked from approving booking
  ✓ Authorized barista role successfully approves booking
  ✓ Recorded authorized staff approval ID

==================================================================
  Phase 6.2.1 Hardening Complete: 64 passed, 0 failed
==================================================================
```

### 4.2 Full Regression Verification

| Command | Result | Notes |
|---|:---:|---|
| `npm run test:p61` | **39 / 39 PASSED** | Communication foundation, event-history consent, DND multi-scope |
| `npm run test:p62` | **88 / 88 PASSED** | Phase 6.2 multilingual conversation engine verification |
| `npm run test:p621` | **64 / 64 PASSED** | Phase 6.2.1 dedicated hardening verification |
| `npm run typecheck` | **0 ERRORS** | TypeScript strict compilation passed |
| `npm run lint` | **0 ERRORS** | ESLint clean across all modules |
| `npm test` | **19 / 19 PASSED** | Master verification suite across Phases 1–7 passed in 12.1s |
| `npm run test:e2e` | **18 / 18 PASSED** | Full Playwright E2E suite passed in 7.8s |
| `npm run build` | **PASSED** | Next.js production build and standalone output compiled |

---

## 5. Remaining Limitations

1. **In-Memory Session Storage**: Sessions are stored in `InMemoryVoiceSessionRepository`. Multi-instance serverless deployments will require distributed storage (Cloud Firestore with atomic transactions) in Phase 6.3.
2. **Feature Flag Isolation**: `VOICE_BOOKING_ENABLED` remains `false` by default. No public routes or external telephony webhooks have been deployed.
3. **Audio / Speech Deferred**: Speech-to-text (STT) and text-to-speech (TTS) integration remain scoped for subsequent phases.
