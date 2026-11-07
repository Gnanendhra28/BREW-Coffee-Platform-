/**
 * BREW Coffee Platform — Phase 6.3.4.1 Firestore Consent Repository
 * Server-authoritative persistence for customer consent grants and revocations.
 * Backed by Firestore collection 'customer_consent_records'.
 */

import {
  CommunicationChannel,
  CommunicationPurpose,
  ConsentRecord,
  ConsentRepository,
} from "../types";
import { ConsentRecordSchema } from "../schemas";
import {
  assertValidPhoneNumber,
  createRevocationRecord,
  hasActiveConsent,
  normalizePhoneNumber,
} from "../consent";
import { getAdminFirestore } from "../../firebaseAdmin";
import type { Firestore } from "firebase-admin/firestore";

export const CUSTOMER_CONSENT_COLLECTION = "customer_consent_records";

export class FirestoreConsentRepository implements ConsentRepository {
  private collectionName = CUSTOMER_CONSENT_COLLECTION;
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
        "Firestore Admin DB unavailable in FirestoreConsentRepository."
      );
    }
    return db;
  }

  async save(record: ConsentRecord): Promise<void> {
    const validated = ConsentRecordSchema.parse(record);
    const db = this.getDb();

    await db.collection(this.collectionName).doc(validated.id).set(validated);
  }

  async findByPhone(phoneNumber: string): Promise<ConsentRecord[]> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return [];

    const db = this.getDb();

    const snapshot = await db
      .collection(this.collectionName)
      .where("phoneNumber", "==", normalized)
      .get();

    const records: ConsentRecord[] = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const parsed = ConsentRecordSchema.parse(data);
      records.push(parsed);
    }

    // Sort by timestamp ascending for chronological consent evaluation
    return records.sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
    );
  }

  async getActiveConsent(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose
  ): Promise<ConsentRecord | null> {
    const records = await this.findByPhone(phoneNumber);
    const isActive = hasActiveConsent(records, channel, purpose);
    if (!isActive) return null;

    const grants = records.filter(
      (r) =>
        r.channel === channel &&
        r.purpose === purpose &&
        r.eventType === "grant" &&
        r.granted
    );

    if (grants.length === 0) return null;

    const sorted = [...grants].sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
    );

    return sorted[0];
  }

  async revoke(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose,
    reason = "customer_requested_opt_out",
    timestamp?: string
  ): Promise<ConsentRecord> {
    const normalized = assertValidPhoneNumber(phoneNumber);
    const revocationEvent = createRevocationRecord({
      phoneNumber: normalized,
      channel,
      purpose,
      reason,
      timestamp,
    });

    await this.save(revocationEvent);
    return revocationEvent;
  }
}
