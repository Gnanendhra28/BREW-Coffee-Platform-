/**
 * BREW Coffee Platform — Phase 6.2.1 Voice Booking Session Repository
 * In-memory repository implementation with deep cloning to ensure caller immutability.
 * 
 * ARCHITECTURAL NOTICE — HORIZONTAL SCALING & PRODUCTION PERSISTENCE:
 * - This `InMemoryVoiceSessionRepository` is designed strictly for automated verification,
 *   offline testing, and local developer single-process execution.
 * - In multi-instance, auto-scaled, or serverless environments (e.g., Cloud Run, Vercel, Render),
 *   in-memory repositories DO NOT share state across concurrent containers or requests.
 * - Production deployment of voice booking sessions across clustered instances will require
 *   an external distributed datastore (e.g., Cloud Firestore with atomic transactions or Upstash Redis)
 *   once multi-instance persistence is introduced in Phase 6.3.
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
