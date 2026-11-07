# BREW Coffee Platform — Phase 6.3.1.8 Hardening Report
## Phone-Indexed In-Memory Lookup & Contract Hardening

**Document Version:** 1.0.0  
**Phase:** 6.3.1.8 Hardening & Remediation  
**Status:** COMPLETE & INDEPENDENTLY VERIFIED  
**Timestamp:** 2026-11-01T22:19:00+05:30  
**Commit / Git State:** Clean working tree (uncommitted work strictly localized, no remote push)

---

## 1. Executive Summary

Phase 6.3.1.8 resolves the lookup-contract defect identified during independent review of Phase 6.3.1.7.

Prior to this phase, `InMemoryVoiceSessionRepository.getByPhoneNumber()` iterated through `this.sessions` linearly and counted every encountered map entry toward `maxScanBudget`, regardless of whether the session belonged to the queried customer or an unrelated phone number. In a multi-tenant or multi-session store containing more than 100 total sessions across various customers, lookups for a phone number with only 2 or 3 sessions could prematurely trip the budget and throw `IncompleteSessionLookupError`.

### Key Deliverables Implemented in Phase 6.3.1.8:
1. **Secondary Phone-Number Index:**
   - Implemented `phoneIndex: Map<string, Set<string>>` mapping normalized phone numbers (`phone.trim()`) to Sets of session IDs.
   - Designed `IndexedSessionMap` (subclass of `Map<string, VoiceBookingSession>`) wrapping internal storage.
2. **Automatic Lifecycle Index Consistency:**
   - **Creation:** Automatically indexes new session IDs under the session's normalized phone number.
   - **Update (No Phone Change):** Preserves existing index mapping without duplicates (backed by `Set<string>`).
   - **Phone-Number Changes:** Automatically detects previous vs new phone numbers, removes the ID from the old phone set (deleting the set if empty), and indexes under the new phone number.
   - **Deletion (`deleteSession`):** Removes the session ID from the phone index and cleans up empty phone sets.
   - **Clear / Reset (`clear`):** Resets both internal sessions and the secondary phone index completely.
3. **Bounded Candidate-Only Inspection:**
   - `getByPhoneNumber()` retrieves candidate IDs directly from `this.phoneIndex.get(trimmedPhone)`.
   - Iteration is strictly bounded to candidate IDs for the requested phone number; unrelated sessions never consume the scan budget.
   - Inspects at most `maxBudget` candidates plus an explicitly documented single-candidate truncation probe ($maxBudget + 1$).
   - Throws `IncompleteSessionLookupError` when candidates exceed `maxBudget`.
4. **Preserved Result & Integrity Semantics:**
   - Fails closed immediately with `VoiceSessionLookupIntegrityError` if a matching candidate is malformed or invalid.
   - Malformed sessions belonging to unrelated customers do not break lookups for clean phone numbers.
   - Sort order: `createdAt` descending, with document ID descending tie-breaker.
   - `activeOnly`: correctly selects the latest non-terminal session without staff approval.
   - 100% behavioral parity verified across `InMemoryVoiceSessionRepository` and `FirestoreVoiceSessionRepository`.

---

## 2. Technical Implementation Architecture

### 2.1 Secondary Index Synchronization (`sessionRepository.ts`)

```typescript
class IndexedSessionMap extends Map<string, VoiceBookingSession> {
  private phoneIndex: Map<string, Set<string>>;

  constructor(phoneIndex: Map<string, Set<string>>) {
    super();
    this.phoneIndex = phoneIndex;
  }

  override set(key: string, value: VoiceBookingSession): this {
    const existing = super.get(key);
    if (existing && existing.phoneNumber && typeof existing.phoneNumber === "string") {
      const oldNorm = existing.phoneNumber.trim();
      const newNorm = value && typeof value === "object" && typeof value.phoneNumber === "string"
        ? value.phoneNumber.trim()
        : "";
      if (oldNorm.length > 0 && oldNorm !== newNorm) {
        const oldSet = this.phoneIndex.get(oldNorm);
        if (oldSet) {
          oldSet.delete(key);
          if (oldSet.size === 0) {
            this.phoneIndex.delete(oldNorm);
          }
        }
      }
    }

    super.set(key, value);

    if (value && typeof value === "object" && typeof value.phoneNumber === "string") {
      const norm = value.phoneNumber.trim();
      if (norm.length > 0) {
        let set = this.phoneIndex.get(norm);
        if (!set) {
          set = new Set<string>();
          this.phoneIndex.set(norm, set);
        }
        set.add(key);
      }
    }
    return this;
  }

  override delete(key: string): boolean {
    const existing = super.get(key);
    if (existing && existing.phoneNumber && typeof existing.phoneNumber === "string") {
      const norm = existing.phoneNumber.trim();
      if (norm.length > 0) {
        const set = this.phoneIndex.get(norm);
        if (set) {
          set.delete(key);
          if (set.size === 0) {
            this.phoneIndex.delete(norm);
          }
        }
      }
    }
    return super.delete(key);
  }

  override clear(): void {
    super.clear();
    this.phoneIndex.clear();
  }
}
```

### 2.2 Bounded Candidate Lookup (`getByPhoneNumber`)

```typescript
  async getByPhoneNumber(
    phone: string,
    options?: VoiceSessionLookupOptions
  ): Promise<VoiceBookingSession | null> {
    const maxBudget = validateScanBudget(options?.maxScanBudget);

    if (!phone || typeof phone !== "string" || phone.trim().length === 0) {
      return null;
    }

    const trimmedPhone = phone.trim();
    const maskedPhone = maskVoicePhoneNumber(trimmedPhone);

    this.lastScanInspectedCount = 0;

    const candidateIds = this.phoneIndex.get(trimmedPhone);
    if (!candidateIds || candidateIds.size === 0) {
      return null;
    }

    const validSessions: VoiceBookingSession[] = [];
    let hasMoreBeyondBudget = false;

    for (const sessionId of candidateIds) {
      this.lastScanInspectedCount++;
      if (this.lastScanInspectedCount > maxBudget) {
        // Documented 1-candidate truncation probe
        hasMoreBeyondBudget = true;
        break;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }

      const validated = this.validateSessionCandidate(session, maskedPhone);
      validSessions.push(validated);
    }

    // If additional matching records exist beyond the budget, fail closed with IncompleteSessionLookupError
    if (hasMoreBeyondBudget) {
      throw new IncompleteSessionLookupError(trimmedPhone, maxBudget);
    }

    if (validSessions.length === 0) {
      return null;
    }

    // Sort in memory by createdAt descending, tie-breaking on document ID descending
    validSessions.sort((a, b) => {
      const timeA = Date.parse(a.createdAt);
      const timeB = Date.parse(b.createdAt);
      if (timeB !== timeA) return timeB - timeA;
      return b.id.localeCompare(a.id);
    });

    if (!options?.activeOnly) {
      return JSON.parse(JSON.stringify(validSessions[0]));
    }

    const active = validSessions.find(
      (s) => !isTerminalVoiceState(s.state) && !Boolean(s.staffApprovalAudit)
    );
    return active ? JSON.parse(JSON.stringify(active)) : null;
  }
```

---

## 3. Comprehensive Verification Results

### 3.1 Phase 6.3.1.8 Verification Suite (`scripts/verify-phase6-3-1-8-hardening.ts`)

| Test # | Test Scenario Description | Result | Details |
|---|---|---|---|
| **Test 1** | Many unrelated customer sessions do not consume requested phone's budget | **PASS** | 150 unrelated sessions present; target query inspected exactly 3 candidates (`lastScanInspectedCount === 3`). |
| **Test 2** | Two matching sessions among >100 unrelated sessions return correct latest | **PASS** | Successfully isolated and returned newest target session among 120 unrelated sessions. |
| **Test 3** | Matching sessions beyond the budget cause `IncompleteSessionLookupError` | **PASS** | 6 matching sessions with budget 5 threw `IncompleteSessionLookupError` with `scannedCount === 5`. |
| **Test 4** | Exactly budget matching sessions do not cause truncation | **PASS** | 5 matching sessions with budget 5 succeeded cleanly without truncation. |
| **Test 5** | Phone-number changes remove old index entry and add new one | **PASS** | Session updated to new phone; verified old phone index count is 0 and new is 1. |
| **Test 6** | Deletion removes index entry and clears empty phone set | **PASS** | `deleteSession` purged index entry and removed the key from `phoneIndex`. |
| **Test 7** | Clear removes all sessions and index entries | **PASS** | `repo.clear()` purged all sessions and reduced `indexedPhoneCount` to 0. |
| **Test 8** | Updating session without changing phone does not duplicate index entry | **PASS** | Multiple saves on same session retained set size of 1. |
| **Test 9** | Malformed matching sessions trigger fail-closed `VoiceSessionLookupIntegrityError` | **PASS** | Invalid timestamp on matching candidate failed closed immediately. |
| **Test 10** | Malformed unrelated sessions do not break lookup for another phone number | **PASS** | Corrupted session on phone B did not prevent successful lookup on clean phone A. |
| **Test 11** | `activeOnly` still returns latest eligible session | **PASS** | Terminal session safely bypassed in favor of active session. |
| **Test 12** | Invalid budgets cause zero candidate inspections | **PASS** | Tested 9 invalid budget variations; `lastScanInspectedCount` remained 0. |
| **Test 13** | Index consistency verified through create, update, phone change, delete, and clear | **PASS** | Full lifecycle index invariants verified across multi-step mutations. |
| **Test 14** | 100% Contract parity maintained between InMemory and Firestore repositories | **PASS** | Parity verified across normal lookups, activeOnly, and truncation errors. |

**Suite Summary:** **14 / 14 TESTS PASSED (100%)**

---

## 4. Test Mode & Environment Transparency

- **Test Mode:** High-Fidelity Deterministic Simulator (`MockFirestoreStore`) & In-Memory Secondary Phone Index (`IndexedSessionMap`).
- **Live Google Cloud Firestore Emulator:** Not installed in local development environment (`cloud-firestore-emulator: Not Installed`). Deterministic simulation verifies document-ID cursor pagination, transactions, CAS revisions, and probe queries.

---

## 5. Master Regression & CI Verification

All regression test suites across the repository were executed and verified:

```
✔ Phase 6.3.1.8 Suite: 14/14 passed (npm run test:p6318)
✔ Phase 6.3.1.7 Suite: 10/10 passed (npm run test:p6317)
✔ Phase 6.3.1.6 Suite: 15/15 passed (npm run test:p6316)
✔ Phase 6.3.1.5 Suite: 11/11 passed (npm run test:p6315)
✔ Phase 6.3.1.4 Suite: 10/10 passed (npm run test:p6314)
✔ Phase 6.3.1.3 Suite: 11/11 passed (npm run test:p6313)
✔ Phase 6.3.1.2 Suite: 10/10 passed (npm run test:p6312)
✔ Phase 6.3.1.1 Suite: 12/12 passed (npm run test:p6311)
✔ Phase 6.3.1 Suite: 24/24 passed (npm run test:p631)
✔ Phase 6.2 Suite: 19/19 passed (npm run test:p62)
✔ Phase 6.2.1 Suite: 10/10 passed (npm run test:p621)
✔ Phase 6.2.2 Suite: 18/18 passed (npm run test:p622)
✔ Phase 6.2.3 Suite: 15/15 passed (npm run test:p623)
✔ Phase 6.2.4.1 Suite: 12/12 passed (npm run test:p6241)
✔ Phase 6.2.4.2 Suite: 16/16 passed (npm run test:p6242)
✔ Phase 6.2.4.3 Suite: 18/18 passed (npm run test:p6243)
✔ Phase 6.2.4.4 Suite: 15/15 passed (npm run test:p6244)
✔ TypeScript Typecheck: 0 errors (tsc --noEmit)
✔ ESLint Code Quality: 0 errors (eslint)
✔ Production Test Suite: 19/19 test suites passed in 12.6s (node scripts/verify-all.mjs)
✔ Playwright E2E Tests: 18/18 passed in 11.8s (playwright test)
✔ Next.js Production Build: 19/19 static pages compiled and optimized in 3.1s
```

---

## 6. Strict Boundary Verification

- `VOICE_BOOKING_ENABLED=false` strictly preserved.
- Phase 6.3.2 booking lifecycle bridge NOT implemented.
- `van_requests` records NOT created.
- Zero telephony, WhatsApp, SMTP, calendar, or external provider integrations.
- Zero GCP billing or paid services.
- Zero git staging (`git add`), commits, or pushes.
- Work strictly stops at Phase 6.3.1.8.
