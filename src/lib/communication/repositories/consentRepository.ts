/**
 * BREW Coffee Platform — Phase 6.1 Consent Repository
 * Provides in-memory implementation for deterministic testing and clean repository abstraction.
 */

import {
  CommunicationChannel,
  CommunicationPurpose,
  ConsentRecord,
  ConsentRepository,
} from "../types";
import { normalizePhoneNumber, revokeConsentRecord } from "../consent";
import { ConsentMissingError } from "../errors";

export class InMemoryConsentRepository implements ConsentRepository {
  private recordsByPhone: Map<string, ConsentRecord[]> = new Map();

  async save(record: ConsentRecord): Promise<void> {
    const phone = record.phoneNumber;
    const existing = this.recordsByPhone.get(phone) || [];

    // Check if updating an existing record by id
    const index = existing.findIndex((r) => r.id === record.id);
    if (index >= 0) {
      existing[index] = record;
    } else {
      existing.push(record);
    }

    this.recordsByPhone.set(phone, existing);
  }

  async findByPhone(phoneNumber: string): Promise<ConsentRecord[]> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return [];
    const list = this.recordsByPhone.get(normalized) || [];
    return [...list];
  }

  async getActiveConsent(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose
  ): Promise<ConsentRecord | null> {
    const records = await this.findByPhone(phoneNumber);
    const matching = records.filter(
      (r) => r.channel === channel && r.purpose === purpose
    );

    if (matching.length === 0) return null;

    // Sort descending by timestamp
    const sorted = [...matching].sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    const latest = sorted[0];
    if (latest.revokedAt || !latest.granted) {
      return null;
    }

    return latest;
  }

  async revoke(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose,
    reason = "customer_requested_opt_out"
  ): Promise<ConsentRecord> {
    const active = await this.getActiveConsent(phoneNumber, channel, purpose);
    if (!active) {
      throw new ConsentMissingError(
        `Cannot revoke consent: no active consent found for ${channel} ${purpose}`
      );
    }

    const revoked = revokeConsentRecord(active, reason);
    await this.save(revoked);
    return revoked;
  }

  clear(): void {
    this.recordsByPhone.clear();
  }
}
