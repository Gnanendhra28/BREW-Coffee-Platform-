# BREW Coffee Platform — Phase P4 Implementation Report
## Booking Extraction & Quotation Presentation Experience

**Date:** November 7, 2026  
**Environment:** Zero-Cost Free Voice Prototype Mode (`VOICE_BOOKING_ENABLED=false`)  
**Deployment Cost:** $0.00 (Zero paid APIs, zero Exotel telephony calls, zero Azure Speech requests)

---

### 1. Executive Summary

Phase P4 completes the **Booking Extraction and Quotation Presentation Experience** for BREW Coffee's free AI voice concierge prototype. Building directly upon the P1 prototype foundation, P2 interactive browser voice interface, and P3 multilingual multi-turn conversational loop, Phase P4 provides:
1. **Authoritative Field Extraction & Validation:** Real-time extraction and boundary validation of all 5 mandatory catering requirements (`guestCount`, `eventDate`, `startTime`, `durationHours`, `venueAddress`).
2. **Progressive Multi-Turn Collection & Modification:** Retention of previously supplied information across conversation turns, targeted follow-ups for missing fields, and automatic recalculation upon customer corrections.
3. **Deterministic 3-Tier Quotation Presentation:** Instant presentation of all three catering packages (*Classic Brew*, *Artisanal Signature*, *VIP Unlimited Bar*) with mathematically derived totals, barista allocations, equipment summaries, and authentic inclusions (eliminating invented prices or perks).
4. **Server-Side Quotation Integrity Snapshot:** Cryptographic tamper-proofing via keyed HMAC-SHA256 (`QUOTATION_SNAPSHOT_SECRET`) with dual-key rotation support, ensuring submitted quotations cannot be altered or replayed out of band.
5. **Multilingual Speech & Text Selection:** Seamless package selection across English (`en`), Hindi (`hi`), and Telugu (`te`) with spoken voice confirmation prompts.
6. **Strict Staff Approval Boundary:** Submission transitions to `awaiting_staff_approval` with an official enquiry identifier (`enq_voice_${sessionId}`), strictly prohibiting automatic self-confirmation.

---

### 2. Mandatory Booking Field Extraction & Validation

The extraction system strictly enforces real operational constraints without fabricating default dates or assumptions:

| Field | Mandatory | Operational Boundary | Validation Rule | Invalid Handling |
|---|---|---|---|---|
| **`guestCount`** | Yes | 10 to 1,000 guests | Integer within `[10, 1000]` | Prompt for clarification; reject values <10 or >1000 |
| **`eventDate`** | Yes | Future calendar dates | Valid `YYYY-MM-DD` date matching real calendar days | Rejects invalid dates (e.g. Feb 30/31, past dates) |
| **`startTime`** | Yes | 06:00 to 23:00 (24h) | Strict 24-hour `HH:mm` format | Rejects early morning or late night van mobilization |
| **`durationHours`** | Yes | 1 to 12 hours | Integer/float within `[1, 12]` | Rejects durations <1h or >12h |
| **Operational Window** | Yes | Single-day mobile van window | `startTime` + `durationHours` must not cross 23:59 | Fails validation if service crosses midnight |
| **`venueAddress`** | Yes | Hyderabad service region | Non-empty string $\ge 3$ characters | Matches Hyderabad hubs or extracts location phrase |

#### Progressive Collection & Customer In-Flight Modification
- When a customer provides partial details (e.g. "Party for 60 guests on Dec 20"), the engine preserves those details and only prompts for the missing fields (`startTime`, `durationHours`, `venueAddress`).
- If a customer modifies any material field during the dialogue (e.g. "Actually make it 120 guests"), the engine dynamically invalidates the prior quote, recalculates all 3 tiers with the updated guest count, recomputes the HMAC-SHA256 snapshot, and confirms the new price.

---

### 3. Deterministic Quotation & Cryptographic Snapshot Integrity

#### Authoritative 3-Tier Comparison
Quotation calculations reuse the platform's core `quoteEngine` via `generateVoiceBookingQuotation`:
1. **Tier 1 — Classic Brew (`BASIC`):** Essential espresso bar setup, certified baristas, commercial machine, batch grinder, standard syrups.
2. **Tier 2 — Artisanal Signature (`STANDARD` — Recommended):** Full specialty espresso bar + manual brew bar (pour-over/Aeropress), latte art, signature cold brews, organic milk/oat milk options.
3. **Tier 3 — VIP Unlimited Bar (`PREMIUM`):** Unlimited pours, dedicated nitro cold brew tap, custom event branding on cups, senior lead baristas, priority setup and teardown.

#### Server-Side HMAC-SHA256 Quotation Integrity
To prevent client-side price tampering or stale quote submissions, the quotation adapter generates a canonical signed snapshot:
- **Canonical Payload (`buildCanonicalSnapshotPayload`):** Deterministic JSON object with alphabetically sorted keys capturing `guestCount`, `eventDate`, `startTime`, `durationHours`, `venueAddress`, `selectedTier`, and `eventType`.
- **Keyed HMAC-SHA256:** Computed using `QUOTATION_SNAPSHOT_SECRET`.
- **Zero-Downtime Key Rotation:** Supported via `QUOTATION_SNAPSHOT_SECRET_PREVIOUS`. When rotation is active, signatures signed with the previous key remain valid.
- **Fail-Closed Verification (`verifyQuotationIntegrity`):** Rejects any session where material parameters deviate from the signed snapshot, where the snapshot signature is invalid, or where an active quotation is missing.

---

### 4. Interactive Browser UI & Multilingual Integration

The client interface (`src/app/voice-booking/[id]/page.tsx`) incorporates the complete extraction and quotation experience:
- **Event Summary Bar:** Real-time visual display of collected date, time, duration, location, and guest count.
- **Inline Correction Controls:** Each item on the requirements checklist features an inline edit button that pre-fills the chat input for rapid corrections.
- **3-Tier Interactive Comparison Grid:** Cards showing per-guest pricing, total package cost, barista staff assigned, commercial equipment summary, and specific perks.
- **Multilingual Package Selection:**
  - **English:** "I want the Classic Brew package" / "Select VIP Unlimited".
  - **Hindi:** "हम दूसरा पैकेज Artisanal Signature चुनना चाहते हैं" / "पहला पैकेज".
  - **Telugu:** "మాకు మూడవ ప్యాకేజీ VIP Unlimited కావాలి" / "రెండవ ప్యాకేజీ".
- **Dynamic Quick Action Bar:** Displays contextual confirmation buttons referencing the active selected tier and formatted total (e.g. `Confirm Artisanal Signature (₹26,000)`).

---

### 5. Booking Lifecycle & Staff Approval Boundary

1. **State Machine Flow:**
   `created` $\rightarrow$ `language_selected` $\rightarrow$ `collecting_requirements` $\rightarrow$ `awaiting_customer_confirmation` $\rightarrow$ `awaiting_staff_approval`.
2. **Enquiry Identity:**
   Upon customer confirmation, the session receives an official identifier (`officialBookingId = "enq_voice_" + sessionId`) linked with the mobile van booking repository.
3. **No Auto-Approval:**
   The AI dialogue engine cannot transition a session to `booking_confirmed`. Only authenticated staff interacting through the barista / operations dashboard or approval endpoint (`/api/voice-booking/approve`) can approve a quotation after verifying schedule feasibility.

---

### 6. Zero-Cost Isolation Audit

- **Telephony Invariant:** `VOICE_BOOKING_ENABLED=false` remains unconditionally active. Zero HTTP requests to Exotel.
- **Speech API Invariant:** Azure Speech SDK is bypassed; speech recognition and synthesis run entirely client-side via the browser Web Speech API.
- **Safety Assertion:** Invoking `assertPrototypeSafetyGuard("exotel")` or `assertPrototypeSafetyGuard("azure_speech")` throws a safety violation error, ensuring prototype mode remains strictly zero-cost ($0.00).

---

### 7. Verification Suite Results

| Test ID | Test Category | Description | Status |
|---|---|---|---|
| **1.1** | Validation | Validates all 5 mandatory fields within operational limits | **PASSED** |
| **1.2** | Validation | Identifies missing fields with descriptive error messages | **PASSED** |
| **1.3** | Boundary | Rejects guest counts below 10 or above 1000 | **PASSED** |
| **1.4** | Boundary | Rejects invalid dates (e.g. Feb 31, non-date strings) | **PASSED** |
| **1.5** | Operational | Rejects service durations that cross midnight into next day | **PASSED** |
| **1.6** | Boundary | Rejects empty or sub-3-character venue address | **PASSED** |
| **2.1** | Extraction | Extracts partial fields in Turn 1 and prompts only for missing | **PASSED** |
| **2.2** | Multi-Turn | Collects remaining fields sequentially and transitions to quote | **PASSED** |
| **3.1** | Correction | Customer updates guest count; recalculates quote and HMAC | **PASSED** |
| **4.1** | Quotation | Deterministically generates 3 tiers with price and inclusions | **PASSED** |
| **5.1** | Integrity | Generates signed HMAC-SHA256 snapshot and verifies clean quote | **PASSED** |
| **5.2** | Anti-Tamper | Fails closed when material fields are tampered with | **PASSED** |
| **5.3** | Anti-Tamper | Fails closed when snapshot HMAC signature is forged/corrupted | **PASSED** |
| **5.4** | Key Rotation | Dual-key rotation via `QUOTATION_SNAPSHOT_SECRET_PREVIOUS` | **PASSED** |
| **6.1** | Multilingual | English: selects Classic Brew and confirms verbally | **PASSED** |
| **6.2** | Multilingual | Hindi: selects Artisanal Signature with Hindi readout | **PASSED** |
| **6.3** | Multilingual | Telugu: selects VIP Unlimited with Telugu readout | **PASSED** |
| **7.1** | Lifecycle | Explicit confirmation moves to `awaiting_staff_approval` | **PASSED** |
| **8.1** | Security | Prompts/tricks cannot bypass staff review to `booking_confirmed` | **PASSED** |
| **9.1** | Zero-Cost | Safety guard invariants verified ($0.00 cost) | **PASSED** |

**Summary:** 20/20 checks passed in `scripts/verify-phase-p4-booking-extraction-quotation.ts`.  
**Typecheck:** `tsc --noEmit` passed with 0 errors.  
**Linter:** `npm run lint` passed with 0 errors.  
**Regression:** P1, P2, P3, 6.6.5.1, 6.6.4.1, and 6.6.2 test suites all passed with 0 regressions.
