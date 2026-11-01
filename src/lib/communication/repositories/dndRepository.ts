/**
 * BREW Coffee Platform — Phase 6.1 Do-Not-Contact (DND) Repository
 * Provides in-memory implementation for deterministic testing and auditable removal.
 */

import { DndRecord, DndRepository } from "../types";
import { normalizePhoneNumber } from "../consent";

export class InMemoryDndRepository implements DndRepository {
  private entriesByPhone: Map<string, DndRecord> = new Map();
  private auditLog: Array<{ action: string; phone: string; justification?: string; at: string }> = [];

  async save(entry: DndRecord): Promise<void> {
    const phone = entry.phoneNumber;
    const existing = this.entriesByPhone.get(phone);

    if (existing) {
      // Idempotency rule: Do not downgrade 'all' to a narrower scope
      if (existing.scope === "all" && entry.scope !== "all") {
        return;
      }
    }

    this.entriesByPhone.set(phone, entry);
    this.auditLog.push({
      action: "REGISTER_DND",
      phone,
      justification: entry.reason,
      at: new Date().toISOString(),
    });
  }

  async findByPhone(phoneNumber: string): Promise<DndRecord | null> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return null;
    return this.entriesByPhone.get(normalized) || null;
  }

  async remove(phoneNumber: string, justification: string): Promise<boolean> {
    if (!justification || justification.trim().length < 5) {
      throw new Error("DND removal requires an explicit, auditable justification (minimum 5 characters).");
    }

    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return false;

    const exists = this.entriesByPhone.has(normalized);
    if (exists) {
      this.entriesByPhone.delete(normalized);
      this.auditLog.push({
        action: "REMOVE_DND",
        phone: normalized,
        justification: justification.trim(),
        at: new Date().toISOString(),
      });
      return true;
    }

    return false;
  }

  getAuditLog(): ReadonlyArray<{ action: string; phone: string; justification?: string; at: string }> {
    return [...this.auditLog];
  }

  clear(): void {
    this.entriesByPhone.clear();
    this.auditLog = [];
  }
}
