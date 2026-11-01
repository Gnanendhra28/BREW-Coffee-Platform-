/**
 * BREW Coffee Platform — Phase 6.2 Voice Booking Session Repository
 * In-memory repository implementation with deep cloning to ensure immutability.
 */

import { VoiceBookingSession, VoiceSessionRepository } from "../types";

export class InMemoryVoiceSessionRepository implements VoiceSessionRepository {
  private sessions: Map<string, VoiceBookingSession> = new Map();

  async getById(id: string): Promise<VoiceBookingSession | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    return JSON.parse(JSON.stringify(session));
  }

  async save(session: VoiceBookingSession): Promise<void> {
    const clone = JSON.parse(JSON.stringify(session));
    this.sessions.set(session.id, clone);
  }

  async getByPhoneNumber(phone: string): Promise<VoiceBookingSession | null> {
    for (const session of this.sessions.values()) {
      if (session.phoneNumber === phone) {
        return JSON.parse(JSON.stringify(session));
      }
    }
    return null;
  }

  clear(): void {
    this.sessions.clear();
  }
}
