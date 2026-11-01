/**
 * BREW Coffee Platform — Phase 6.1.1 Consent Repository
 * Provides in-memory implementation for deterministic testing and clean event history persistence.
 */

import {
  CommunicationChannel,
  CommunicationPurpose,
  ConsentRecord,
  ConsentRepository,
} from "../types";
import {
  assertValidPhoneNumber,
  createRevocationRecord,
  hasActiveConsent,
  normalizePhoneNumber,
} from "../consent";

export class InMemoryConsentRepository implements ConsentRepository {
  private eventsByPhone: Map<string, ConsentRecord[]> = new Map();

  async save(record: ConsentRecord): Promise<void> {
    const phone = assertValidPhoneNumber(record.phoneNumber);
    const existing = this.eventsByPhone.get(phone) || [];

    // If an event with the exact same ID exists, update it; otherwise append as a new historical event
    const index = existing.findIndex((r) => r.id === record.id);
    if (index >= 0) {
      existing[index] = record;
    } else {
      existing.push(record);
    }

    this.eventsByPhone.set(phone, existing);
  }

  async findByPhone(phoneNumber: string): Promise<ConsentRecord[]> {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return [];
    const list = this.eventsByPhone.get(normalized) || [];
    return [...list];
  }

  async getActiveConsent(
    phoneNumber: string,
    channel: CommunicationChannel,
    purpose: CommunicationPurpose
  ): Promise<ConsentRecord | null> {
    const records = await this.findByPhone(phoneNumber);
    const isActive = hasActiveConsent(records, channel, purpose);
    if (!isActive) return null;

    // Filter matching grants and sort by timestamp descending to return latest active grant
    const grants = records.filter(
      (r) => r.channel === channel && r.purpose === purpose && r.eventType === "grant" && r.granted
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

  clear(): void {
    this.eventsByPhone.clear();
  }
}
