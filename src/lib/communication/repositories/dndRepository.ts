/**
 * BREW Coffee Platform — Phase 6.1.1 Do-Not-Contact (DND) Repository
 * 
 * Provides in-memory multi-scope suppression storage and diagnostic audit tracking.
 * 
 * ARCHITECTURAL NOTICE:
 * This in-memory implementation is designed strictly for deterministic unit, integration,
 * and preflight testing. In-memory storage is ephemeral and is NOT durable production storage.
 * Prior to production deployment and enabling the feature flag, persistent, access-controlled
 * Firestore audit storage must be configured.
 */

import { DndAuditEvent, DndRecord, DndRepository, DndScope } from "../types";
import { assertValidPhoneNumber, normalizePhoneNumber } from "../consent";
import { maskPhoneNumber } from "../config";

export class InMemoryDndRepository implements DndRepository {
  // Multi-scope storage: Map<normalizedPhone, Map<DndScope, DndRecord>>
  private scopesByPhone: Map<string, Map<DndScope, DndRecord>> = new Map();
  private auditHistory: DndAuditEvent[] = [];

  async save(entry: DndRecord): Promise<void> {
    const phone = assertValidPhoneNumber(entry.phoneNumber);

    let phoneScopes = this.scopesByPhone.get(phone);
    if (!phoneScopes) {
      phoneScopes = new Map<DndScope, DndRecord>();
      this.scopesByPhone.set(phone, phoneScopes);
    }

    // Idempotent: Registers or updates the specific scope without removing other coexisting scopes
    phoneScopes.set(entry.scope, entry);

    // Record auditable registration event with masked phone number (zero raw PII)
    const auditId = `audit_reg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.auditHistory.push({
      id: auditId,
      action: "REGISTER_DND",
      phoneNumberMasked: maskPhoneNumber(phone),
      scope: entry.scope,
      reason: entry.reason,
      timestamp: new Date().toISOString(),
    });
  }

  async findActiveScopes(phoneNumber: string): Promise<DndRecord[]> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return [];

    const phoneScopes = this.scopesByPhone.get(normalized);
    if (!phoneScopes || phoneScopes.size === 0) return [];

    return Array.from(phoneScopes.values());
  }

  async findByPhone(phoneNumber: string): Promise<DndRecord | null> {
    const scopes = await this.findActiveScopes(phoneNumber);
    if (scopes.length === 0) return null;

    // Highest priority scope: 'all' if present, otherwise first active scope
    const globalScope = scopes.find((s) => s.scope === "all");
    return globalScope || scopes[0];
  }

  async removeScope(
    phoneNumber: string,
    scope: DndScope,
    justification: string,
    performedBy = "system"
  ): Promise<boolean> {
    if (!justification || justification.trim().length < 5) {
      throw new Error(
        "DND removal requires an explicit, auditable justification (minimum 5 characters)."
      );
    }

    if (scope === "all" && justification.trim().length < 10) {
      throw new Error(
        "Removing global 'all' DND scope requires a detailed administrative justification (minimum 10 characters)."
      );
    }

    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return false;

    const phoneScopes = this.scopesByPhone.get(normalized);
    if (!phoneScopes || !phoneScopes.has(scope)) {
      return false;
    }

    const removedRecord = phoneScopes.get(scope)!;
    phoneScopes.delete(scope);

    if (phoneScopes.size === 0) {
      this.scopesByPhone.delete(normalized);
    }

    // Record auditable removal event with masked phone number
    const auditId = `audit_rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.auditHistory.push({
      id: auditId,
      action: "REMOVE_DND",
      phoneNumberMasked: maskPhoneNumber(normalized),
      scope,
      reason: removedRecord.reason,
      justification: justification.trim(),
      performedBy,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  async remove(phoneNumber: string, justification: string): Promise<boolean> {
    // Default backward-compatible remove delegates to removing "all" scope
    return this.removeScope(phoneNumber, "all", justification, "admin_action");
  }

  getAuditHistory(): ReadonlyArray<DndAuditEvent> {
    return [...this.auditHistory];
  }

  getAuditLog(): ReadonlyArray<{ action: string; phone: string; justification?: string; at: string }> {
    // Kept for backward compatibility: returns masked phone representations
    return this.auditHistory.map((e) => ({
      action: e.action,
      phone: e.phoneNumberMasked,
      justification: e.justification || e.reason,
      at: e.timestamp,
    }));
  }

  clear(): void {
    this.scopesByPhone.clear();
    this.auditHistory = [];
  }
}
