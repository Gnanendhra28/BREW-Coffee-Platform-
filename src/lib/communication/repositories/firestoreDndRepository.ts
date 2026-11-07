/**
 * BREW Coffee Platform — Phase 6.3.4.1 Firestore DND Repository
 * Server-authoritative suppression repository for Do-Not-Contact (DND) registrations.
 * Backed by Firestore collection 'dnd_suppression_records'.
 */

import {
  DndAuditEvent,
  DndRecord,
  DndRepository,
  DndScope,
} from "../types";
import { DndRecordSchema, DndAuditEventSchema } from "../schemas";
import { assertValidPhoneNumber, normalizePhoneNumber } from "../consent";
import { maskPhoneNumber } from "../config";
import { getAdminFirestore } from "../../firebaseAdmin";
import type { Firestore } from "firebase-admin/firestore";

export const DND_SUPPRESSION_COLLECTION = "dnd_suppression_records";
export const DND_AUDIT_COLLECTION = "dnd_audit_events";

export class FirestoreDndRepository implements DndRepository {
  private suppressionCollection = DND_SUPPRESSION_COLLECTION;
  private auditCollection = DND_AUDIT_COLLECTION;
  private auditHistory: DndAuditEvent[] = [];
  private db: Firestore | null = null;
  private dbExplicitlyProvided = false;

  constructor(options?: { db?: Firestore | null }) {
    if (options && "db" in options) {
      this.db = options.db || null;
      this.dbExplicitlyProvided = true;
    }
  }

  private getDb(): Firestore {
    const db = this.dbExplicitlyProvided ? this.db : (this.db || getAdminFirestore());
    if (!db) {
      throw new Error(
        "Firestore Admin DB unavailable in FirestoreDndRepository."
      );
    }
    return db;
  }

  async save(entry: DndRecord): Promise<void> {
    const validated = DndRecordSchema.parse(entry);
    const phone = assertValidPhoneNumber(validated.phoneNumber);

    const db = this.getDb();

    // Deterministic document ID per phone and scope to prevent duplicate scope entries
    const docId = validated.id || `dnd_${phone.replace(/[^a-zA-Z0-9]/g, "_")}_${validated.scope}`;
    const docRef = db.collection(this.suppressionCollection).doc(docId);

    // Generate server-side audit event in UTC
    const auditId = `audit_reg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const auditEvent: DndAuditEvent = {
      id: auditId,
      action: "REGISTER_DND",
      phoneNumberMasked: maskPhoneNumber(phone),
      scope: validated.scope,
      reason: validated.reason,
      timestamp: new Date().toISOString(),
    };
    const validatedAudit = DndAuditEventSchema.parse(auditEvent);
    const auditRef = db.collection(this.auditCollection).doc(auditId);

    // Atomically commit suppression record and audit event via Firestore batch
    const batch = db.batch();
    batch.set(docRef, validated);
    batch.set(auditRef, validatedAudit);
    await batch.commit();

    // In-memory audit history updated strictly after durable operation succeeds
    this.auditHistory.push(validatedAudit);
  }

  async findActiveScopes(phoneNumber: string): Promise<DndRecord[]> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return [];

    const db = this.getDb();

    const snapshot = await db
      .collection(this.suppressionCollection)
      .where("phoneNumber", "==", normalized)
      .get();

    const records: DndRecord[] = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const parsed = DndRecordSchema.parse(data);
      records.push(parsed);
    }
    return records;
  }

  async findByPhone(phoneNumber: string): Promise<DndRecord | null> {
    const scopes = await this.findActiveScopes(phoneNumber);
    if (scopes.length === 0) return null;

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

    const db = this.getDb();

    const snapshot = await db
      .collection(this.suppressionCollection)
      .where("phoneNumber", "==", normalized)
      .where("scope", "==", scope)
      .get();

    if (snapshot.empty) {
      return false;
    }

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }

    const auditId = `audit_rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const auditEvent: DndAuditEvent = {
      id: auditId,
      action: "REMOVE_DND",
      phoneNumberMasked: maskPhoneNumber(normalized),
      scope,
      reason: "Scope administratively removed",
      justification,
      performedBy,
      timestamp: new Date().toISOString(),
    };
    const validatedAudit = DndAuditEventSchema.parse(auditEvent);

    batch.set(
      db.collection(this.auditCollection).doc(auditId),
      validatedAudit
    );

    await batch.commit();

    // In-memory audit history updated strictly after durable commit succeeds
    this.auditHistory.push(validatedAudit);
    return true;
  }

  async remove(phoneNumber: string, justification: string): Promise<boolean> {
    return this.removeScope(phoneNumber, "all", justification);
  }

  getAuditHistory(): ReadonlyArray<DndAuditEvent> {
    return [...this.auditHistory];
  }
}
