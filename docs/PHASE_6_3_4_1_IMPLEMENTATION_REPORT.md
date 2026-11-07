# BREW Coffee Platform — Phase 6.3.4.1 Implementation Report
## Web Booking Contact, Consent & Voice Session Foundation

**Date:** November 2, 2026  
**Status:** Complete & Authoritatively Verified (33 / 33 Tests Passing, 100% Green Across All 19 Master Suites)  
**Security & Guardrails:** `VOICE_BOOKING_ENABLED=false` Strictly Preserved; Zero Real Telephony / Meta Dispatches; Zero Direct Client Rules Escalation

---

## 1. Executive Summary

Phase 6.3.4.1 implements the minimal additive foundation connecting the existing catering enquiry form (`POST /api/request-van` & `src/app/location/page.tsx`) to the Phase 6 communication and voice-booking architecture.

Prior to Phase 6.3.4.1:
1. The web catering form collected contact information without distinct phone number validation or customer consent options.
2. `POST /api/request-van` persisted enquiries only to `van_requests` and triggered email notifications, with no durable link to voice sessions, consent ledgers, or outbox dispatch.
3. Consent and DND suppression records lacked server-authoritative Cloud Firestore repositories.
4. Voice booking sessions were unlinked from web catering enquiries.

Phase 6.3.4.1 reconciles and completes these boundaries:
- **Contact & Consent Form**: Extended with an explicit phone number field and two independent, unbundled checkboxes for voice calls and WhatsApp messages (both defaulting to `false`).
- **Strict Schema Validation**: Extended `VanRequestInputSchema` with conditional phone validation: if either consent is selected, a valid phone number normalizing to E.164 (`+91...`) is mandatory.
- **Server-Authoritative Repositories**: Implemented `FirestoreConsentRepository` (`customer_consent_records`) and `FirestoreDndRepository` (`dnd_suppression_records` & `dnd_audit_events`), alongside `repositorySelector.ts` to switch cleanly between Firestore and in-memory test mocks.
- **Initial Voice Session Invariants**: When voice consent is granted, an initial `VoiceBookingSession` in strict `created` state (`vbs_${requestId}`) is generated with `revision: 1`, `quotation: null`, `quotationSnapshot: null`, `customerConfirmed: false`, and `guestCount: null` (preventing premature fabrication of quotes or transition skipping).
- **Atomic Firestore Multi-Document Transaction**: Committed in a single transaction across `van_requests/{requestId}`, `voice_booking_sessions/{sessionId}`, `booking_communication_outbox/{deliveryId}`, and `customer_consent_records/{consentId}`.
- **Privacy Preservation**: Outbox documents store masked phone numbers only (`phoneNumberMasked`). Raw E.164 phone numbers remain confined to server-authoritative `voice_booking_sessions`.
- **Firestore Security Rules**: Strict client read and write denial (`allow read, write: if false;`) enforced across all new communication collections.

---

## 2. Source Modifications & Additions

### 2.1 Schema & Form Extension
- `src/lib/agentSchemas.ts`:
  - Added `phoneNumber: z.string().trim().optional()`.
  - Added `voiceConsent: z.boolean().default(false)`.
  - Added `whatsappConsent: z.boolean().default(false)`.
  - Added `.refine()`: When `voiceConsent: true` or `whatsappConsent: true`, requires a non-empty phone candidate that normalizes to a valid E.164 Indian mobile number (`+91...`).
- `src/app/location/page.tsx`:
  - Added Phone Number input field with Indian mobile formatting guidelines.
  - Added two unbundled, independent checkboxes:
    1. Outbound voice calls for catering enquiry requirements.
    2. WhatsApp notifications for catering quotations and status updates.
  - Bound states and reset logic upon successful form submission.

### 2.2 Communication Outbox & Lifecycle Models
- `src/lib/communication/types.ts`:
  - Added `"booking_created"` to `BookingLifecycleEventType`.
- `src/lib/communication/schemas.ts`:
  - Added `"booking_created"` to `BookingLifecycleEventTypeSchema`.
- `src/lib/communication/outbox/outboxModel.ts`:
  - Updated `mapSessionStateToOutboxEvent` to map `created` -> `"booking_created"`.
  - Updated `createOutboxDeliveriesForTransition`: routes `"booking_created"` to `["voice"]` channel, setting status to `"pending"` and storing masked phone numbers only.

### 2.3 Durable Repositories & Atomic DND Registration
- `src/lib/communication/repositories/firestoreConsentRepository.ts`:
  - Implements `ConsentRepository` against Firestore collection `customer_consent_records`.
  - Supports `save()`, `findByPhone()`, `getActiveConsent()`, and `revoke()`.
  - Validates all records via `ConsentRecordSchema`. Fails closed if Firestore is unavailable.
- `src/lib/communication/repositories/firestoreDndRepository.ts`:
  - Implements `DndRepository` against Firestore collections `dnd_suppression_records` and `dnd_audit_events`.
  - Atomic Registration: `save()` commits both the suppression record and the `REGISTER_DND` audit event together in a single atomic Firestore batch (`db.batch()`), ensuring a failure cannot leave an orphaned suppression record without its audit trail.
  - Server-Side UTC Timestamps: Audit event timestamps are deterministically generated on the server via `new Date().toISOString()`.
  - In-Memory Audit Integrity: `this.auditHistory` is updated strictly after the durable batch commit succeeds.
  - Atomic Removal: `removeScope()` similarly executes deletions and `REMOVE_DND` audit record creation in an atomic batch.
  - Supports `save()`, `findByPhone()`, `findActiveScopes()`, `removeScope()`, `remove()`, and `getAuditHistory()`.
  - Validates all records via `DndRecordSchema` and `DndAuditEventSchema`. Fails closed if Firestore is unavailable.
- `src/lib/communication/repositories/repositorySelector.ts`:
  - Provides `getConsentRepository(mode)` and `getDndRepository(mode)` supporting `"auto"`, `"firestore"`, and `"memory"`.
- `src/lib/communication/index.ts`:
  - Re-exports all new repositories and selector utilities.

### 2.4 Atomic Persistence & Phone Data Minimization in API Route
- `src/app/api/request-van/route.ts`:
  - Extracts `phoneNumber`, `voiceConsent`, `whatsappConsent`, and normalized E.164 phone.
  - Updates payload fingerprint and idempotency key to include phone and consent parameters.
  - Phone Data Minimization: Eliminates redundant raw vs normalized duplicate fields. Stores the single authoritative normalized E.164 string in `phoneNumber` (`normalizedPhone || null`) and avoids persisting an unnormalized phone or duplicate `normalizedPhone` field.
  - Contact Resolution for WhatsApp: Preserves `phoneNumber` in `van_requests` so that future consent-authorized WhatsApp notifications can resolve the customer's phone number even for WhatsApp-only enquiries where no voice session is created (`voiceSessionId: null`).
  - Public API Response Protection: `POST /api/request-van` returns `requestSummary: { contact, organization, location, timestamp }` and `consents: { voice, whatsapp }`; phone numbers are strictly never returned in public JSON responses.
  - Protected Staff Access: Only authenticated staff (`barista` / `fleet_admin`) can view enquiries via `GET /api/request-van`.
  - Inside `adminDb.runTransaction()`:
    1. Read phase: reads `docRef` (`van_requests/{requestId}`), and if consents are granted, reads `sessionRef`, `outboxRefs`, and `consentRefs`.
    2. Write phase: atomically commits:
       - `van_requests/{requestId}` with contact, consents, authoritative `phoneNumber`, and linked `voiceSessionId`.
       - `customer_consent_records` for voice and/or WhatsApp grants.
       - `voice_booking_sessions/{sessionId}` in state `"created"` with `revision: 1`, `guestCount: null`, `quotation: null`.
       - `booking_communication_outbox/{deliveryId}` with `eventType: "booking_created"`, `channel: "voice"`, `status: "pending"`, and masked phone only.
    3. Idempotent replay: if `van_requests/{requestId}` already exists, returns existing quotation and avoids duplicate document creation.

### 2.5 Comprehensive Server-Side Phone Persistence Audit & Privacy Model

The following table provides an exhaustive, authoritative inventory of every server-side datastore location where phone numbers are persisted:

| Datastore Collection / Record | Phone Field Stored | Phone Format | Accessibility & Privacy Controls |
| :--- | :--- | :--- | :--- |
| `van_requests/{requestId}` | `phoneNumber` | Normalized E.164 (`+91...`) or `null` | Denied to clients in `firestore.rules`. Accessible only to authenticated staff via `GET /api/request-van`. Serves as the authoritative phone contact. Allows WhatsApp contact resolution for WhatsApp-only enquiries without voice sessions. |
| `van_requests/{requestId}` | `contact` | Email address (preserved exactly) OR normalized E.164 (`+91...`) | Denied to clients in `firestore.rules`. When `contact` is a phone number, it is normalized to E.164 before persistence, eliminating duplicate raw phone strings. Used for staff notifications and manual replies. |
| `voice_booking_sessions/{sessionId}` | `phoneNumber` | Normalized E.164 (`+91...`) | Server-authoritative only (`allow read, write: if false;`). Created only when `voiceConsent: true`. Used by worker for voice dispatch. |
| `customer_consent_records/{consentId}` | `phoneNumber` | Normalized E.164 (`+91...`) | Server-authoritative only (`allow read, write: if false;`). Tracks legal consent grants and revocations. |
| `dnd_suppression_records/{dndId}` | `phoneNumber` | Normalized E.164 (`+91...`) | Server-authoritative only (`allow read, write: if false;`). Used by policy engine to block calls/messages. |
| `dnd_audit_events/{auditId}` | `phoneNumberMasked` | Masked only (`+91******3210`) | Server-authoritative only (`allow read, write: if false;`). Raw phone number is strictly absent. |
| `booking_communication_outbox/{deliveryId}` | `phoneNumberMasked` | Masked only (`+91******3210`) | Server-authoritative only (`allow read, write: if false;`). Raw phone number is strictly absent; worker resolves phone at runtime from session or van request. |

**Zero Public Exposure:**
- Public API responses (`POST /api/request-van`) strictly omit `phoneNumber`.
- `requestSummary.contact` preserves email contacts but strictly masks phone numbers (`+91****210`), ensuring zero unmasked phone exposure in public JSON.

### 2.6 Phase 6.3.4.1.2 Legacy Contact Normalization
- **Legacy Phone Input Normalization**: When `contact` contains a phone number without an `@` sign, it is normalized to E.164 via `normalizePhoneNumber(contact)` before persistence in `van_requests.contact`.
- **Authoritative `phoneNumber` Priority**: When a separate `phoneNumber` field is supplied, it is authoritative and normalized to E.164. If `phoneNumber` is omitted, the normalized phone from `contact` populates `phoneNumber`.
- **Elimination of Raw Phone Duplication**: Unnormalized raw phone strings with arbitrary spaces or prefixes are never persisted in the database.
- **Email Notification Protection**:
  - For email contacts: generates `mailto:` link and sets SMTP `replyTo`.
  - For phone contacts: generates `tel:` link, omits `replyTo`, and never creates invalid `mailto:` links with phone numbers.
- **Protected Staff Retrieval (`GET /api/request-van`)**:
  - Strictly requires authenticated staff credentials (`barista` or `fleet_admin`).
  - Returns clean, normalized records with valid E.164 or email formats. Rejects unauthenticated (401) or customer-role (403) callers.

### 2.7 Phase 6.3.4.1.3 Public Response Phone Privacy & Strict Normalization
- **Removal of Indirect Phone Exposure in Public Responses**:
  - Decoupled internal staff email body (`textContent`) from public client compose links (`publicTextContent`).
  - Internal SMTP email (`sendMail`) preserves the full authoritative phone number (`persistedContact` / `authoritativePhone`) and `<a href="tel:...">` for staff operations.
  - In public JSON responses (`POST /api/request-van`), `gmailUrl` and `mailtoUrl` query strings use `publicTextContent`, masking phone numbers (`+91****210`) while preserving compose link functionality.
  - Email-valued contacts remain completely unchanged, preserving direct customer email addressing in `gmailUrl` and `mailtoUrl`.
  - Confirmed zero full phone numbers across all public response fields, strings, URLs, and idempotent replay responses.
- **Fail-Closed Phone Normalization**:
  - `VanRequestInputSchema` rejects phone-shaped `contact` inputs that cannot be normalized to E.164 via `normalizePhoneNumber()` (even when no consent is selected).
  - `phoneNumber` field refines non-empty inputs, rejecting unnormalizable phone strings.
  - `POST /api/request-van` route handler enforces fail-closed checks returning 400 Bad Request if phone normalization fails, never falling back to persisting unnormalized strings.
  - When both `contact` and `phoneNumber` are phone numbers, both are normalized independently before persistence.

### 2.8 Security Rules & Firebase Admin
- `firestore.rules`:
  - Updated by `firestore-rules-author` subagent.
  - Implemented client read/write denial (`allow read, write: if false;`) for `customer_consent_records/{consentId}`, `dnd_suppression_records/{dndId}`, and `dnd_audit_events/{auditId}`.
- `src/lib/firebaseAdmin.ts`:
  - Added `setAdminFirestoreForTesting(db)` enabling transactional integration testing without external daemons.

---

## 3. Verification Suite Execution

The verification test suite `scripts/verify-phase6-3-4-1-booking-foundation.ts` (`npm run test:p6341`) executes 33 comprehensive test cases (mock-based Firestore isolation):

```
===============================================================================
   BREW Coffee — Phase 6.3.4.1 Booking Foundation & Consent Verification
===============================================================================

SECTION 1: Form Schema & Phone Normalization (agentSchemas.ts)
  ✓ Test 1: Baseline enquiry without phone or consents is valid (defaults false)
  ✓ Test 2: Voice consent = true without phone number is rejected by schema
  ✓ Test 3: WhatsApp consent = true without phone number is rejected by schema
  ✓ Test 4: Voice consent with malformed phone number is rejected (invalid E.164)
  ✓ Test 5: Voice consent with valid 10-digit phone succeeds and normalizes E.164
  ✓ Test 6: WhatsApp consent with valid +91 phone succeeds and normalizes E.164
  ✓ Test 7: Both consents with valid phone succeed

SECTION 2: API Route Atomic Persistence (POST /api/request-van)
  ✓ Test 8: No-consent baseline: van_request saved, no consent, no session, no outbox
  ✓ Test 9: Voice consent only: persists van_request, 1 consent, 1 session (created), 1 outbox delivery
  ✓ Test 10: WhatsApp consent only: persists van_request, 1 WhatsApp consent; 0 sessions, 0 outbox
  ✓ Test 11: Both consents: persists van_request, 2 consents (voice+wa), 1 session, 1 outbox
  ✓ Test 12: Idempotent replay: duplicate submission returns existing quote and creates NO duplicate records
  ✓ Test 13: Simulated DB failure: returns 503 and rolls back cleanly without persisting

SECTION 2B: Phase 6.3.4.1.3 Public Response Phone Privacy & Strict Normalization
  ✓ Test 14: Legacy phone-only contact: normalized persistence and zero indirect phone exposure in public response
  ✓ Test 15: Email contact: unchanged behavior, email preserved in public URLs and response
  ✓ Test 16: Separate phoneNumber with email contact: email preserved, separate phone authoritative, zero phone in public response
  ✓ Test 17: Both fields supplied as phone numbers: contact normalized, separate phone authoritative
  ✓ Test 18: Idempotent replay of legacy phone request masks contact, compose links, and creates no duplicates
  ✓ Test 19: Malformed phone-shaped contact with no consent: rejected (400) and no raw phone persisted
  ✓ Test 20: Malformed separate phoneNumber with email contact: rejected (400) and no raw phone persisted
  ✓ Test 21: Staff retrieval (GET /api/request-van): full normalized phone remains available to authorized staff

SECTION 3: Durable Consent Repository (FirestoreConsentRepository)
  ✓ Test 22: Save and query consent grants by phone
  ✓ Test 23: Revoke consent takes effect immediately
  ✓ Test 24: Re-granting consent after revocation restores active consent
  ✓ Test 25: Consent repository fails closed when DB is unavailable

SECTION 4: Durable DND Repository & Scope Suppression (FirestoreDndRepository)
  ✓ Test 26: Register DND suppression record and audit log atomically via batch
  ✓ Test 27: Simulated DND batch failure: leaves no partial suppression or audit doc, in-memory history untouched
  ✓ Test 28: DND suppression blocks communication policy approval even with active consent
  ✓ Test 29: Removing DND scope restores policy approval
  ✓ Test 30: DND repository fails closed when DB is unavailable

SECTION 5: Repository Selector (repositorySelector.ts)
  ✓ Test 31: getConsentRepository and getDndRepository correctly instantiate requested modes

SECTION 6: Worker & Feature Flag Invariants
  ✓ Test 32: OutboxWorker strictly preserves VOICE_BOOKING_ENABLED=false guardrail

SECTION 7: Firestore Security Rules Denial Coverage
  ✓ Test 33: firestore.rules strictly denies direct client reads and writes to Phase 6 collections

===============================================================================
   Phase 6.3.4.1 Verification Complete: All 33 tests passed successfully!
===============================================================================
```

### Full Regression Suite Results
1. `npm run typecheck`: **0 errors (Pass)**
2. `npm run lint`: **0 errors (Pass)**
3. `npm run test:p6341`: **33 / 33 passed (100%)**
4. `npm run test:p63323`: **14 / 14 passed (100%)**
5. `npm run test:p63322`: **12 / 12 passed (100%)**
6. `npm run test:p63321`: **11 / 11 passed (100%)**
7. `npm run test:p6331`: **10 / 10 passed (100%)**
8. `npm run test:p633`: **21 / 21 passed (100%)**
9. `npm run test:p631`: **24 / 24 passed (100%)**
10. `npm run test` (Master `verify-all.mjs`): **All 19/19 suites passed in 12.7s (100%)**

---

## 4. Git and Guardrail Compliance

- `VOICE_BOOKING_ENABLED=false` was strictly preserved in production configuration.
- Zero outbound real PSTN calls or Meta WhatsApp API calls were dispatched.
- Zero Git staging (`git add`), commits, pushes, or releases were performed.
