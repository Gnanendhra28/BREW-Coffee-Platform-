/**
 * BREW Coffee Platform — Phase 6.3.3.2.3 Outbox Test Fixture Helpers
 *
 * Dedicated test fixture utilities for unit tests and verification suites.
 * Excluded from the production communication barrel (src/lib/communication/index.ts).
 * Production code must never import or call these functions.
 */

import { CommunicationDeliveryRecord } from "../types";
import { CommunicationDeliveryRecordSchema } from "../schemas";
import {
  CommunicationOutboxRepository,
  InMemoryCommunicationOutboxRepository,
  FirestoreCommunicationOutboxRepository,
  internalSeedOutboxRecord,
  internalGetOutboxRecordCount,
} from "./outboxRepository";
import { getAdminFirestore } from "../../firebaseAdmin";

/**
 * Permitted local loopback hostnames for the Firestore Emulator.
 */
const PERMITTED_LOCAL_EMULATOR_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

/**
 * Validates whether an emulator endpoint string represents an authorized local loopback emulator.
 * Must match `<host>:<port>` or `[<ipv6>]:<port>` where host is a local loopback address and port is 1-65535.
 * Rejects remote hostnames, production Firestore endpoints, schemes, paths, whitespace, and malformed strings.
 */
export function isValidLocalFirestoreEmulatorHost(host: string): boolean {
  if (!host || typeof host !== "string") return false;
  const trimmed = host.trim();
  if (trimmed.length === 0) return false;

  // Reject URL schemes, credentials, paths, query strings, fragments, or whitespace
  if (
    trimmed.includes("://") ||
    trimmed.includes("@") ||
    trimmed.includes("/") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes(" ")
  ) {
    return false;
  }

  let hostname: string;
  let portStr: string;

  if (trimmed.startsWith("[")) {
    // IPv6 bracketed format: [::1]:8080
    const closeBracketIdx = trimmed.indexOf("]");
    if (closeBracketIdx === -1 || trimmed[closeBracketIdx + 1] !== ":") {
      return false;
    }
    hostname = trimmed.slice(1, closeBracketIdx);
    portStr = trimmed.slice(closeBracketIdx + 2);
  } else {
    // Standard host:port format
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx === -1) {
      return false; // missing port
    }
    hostname = trimmed.slice(0, colonIdx);
    portStr = trimmed.slice(colonIdx + 1);

    // If unbracketed hostname contains colons, it is unbracketed IPv6 (invalid host:port format)
    if (hostname.includes(":")) {
      return false;
    }
  }

  const normalizedHostname = hostname.toLowerCase();
  if (!PERMITTED_LOCAL_EMULATOR_HOSTNAMES.has(normalizedHostname)) {
    return false;
  }

  if (!/^\d+$/.test(portStr)) {
    return false;
  }

  const port = parseInt(portStr, 10);
  if (port < 1 || port > 65535) {
    return false;
  }

  return true;
}

/**
 * Dedicated test-only repository adapter for in-memory outbox testing.
 * Extends InMemoryCommunicationOutboxRepository without accepting or passing an external mutable Map.
 * Exposes seedDelivery() for test setup without weakening production encapsulation.
 */
export class TestInMemoryCommunicationOutboxRepository extends InMemoryCommunicationOutboxRepository {
  constructor(tokenGenerator?: () => string) {
    super(tokenGenerator);
  }

  seedDelivery(delivery: CommunicationDeliveryRecord): void {
    const validated = CommunicationDeliveryRecordSchema.parse(delivery);
    internalSeedOutboxRecord(this, validated);
  }

  getRecordCount(): number {
    return internalGetOutboxRecordCount(this);
  }
}

/**
 * Dedicated test fixture adapter for Firestore outbox testing.
 * Fails closed unless BOTH an explicitly authorized local FIRESTORE_EMULATOR_HOST
 * and an explicit test environment marker are verified.
 * Never connects or writes to a non-emulator or remote Firestore database.
 */
export class TestFirestoreOutboxFixtureAdapter {
  private collectionName = "booking_communication_outbox";

  /**
   * Validates that the runtime is unequivocally running against an authorized local Firestore Emulator.
   * Throws immediately if FIRESTORE_EMULATOR_HOST is missing, malformed, remote, or test markers are absent.
   */
  public verifyEmulatorEnvironment(): void {
    const isTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.BREW_TEST_ENV === "true" ||
      process.env.BREW_TEST_ENVIRONMENT === "true";

    if (!isTestEnv) {
      throw new Error(
        "Security violation: Firestore fixture seeding requires an explicit test environment marker " +
          "(NODE_ENV=test or BREW_TEST_ENV=true)."
      );
    }

    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
    if (!emulatorHost || emulatorHost.trim().length === 0) {
      throw new Error(
        "Security violation: Firestore fixture seeding is strictly prohibited outside the Firebase Emulator. " +
          "FIRESTORE_EMULATOR_HOST environment variable is not configured."
      );
    }

    if (!isValidLocalFirestoreEmulatorHost(emulatorHost)) {
      throw new Error(
        `Security violation: FIRESTORE_EMULATOR_HOST '${emulatorHost}' is not an authorized local emulator endpoint. ` +
          "Only local loopback endpoints (e.g. localhost:<port>, 127.0.0.1:<port>, [::1]:<port>) are permitted for test fixture seeding."
      );
    }
  }

  async seedDelivery(delivery: CommunicationDeliveryRecord): Promise<void> {
    // Fail-closed verification runs BEFORE any Admin Firestore database reference is obtained
    this.verifyEmulatorEnvironment();

    const db = getAdminFirestore();
    if (!db) {
      throw new Error(
        "Firestore Admin DB unavailable in verified emulator environment."
      );
    }

    const validated = CommunicationDeliveryRecordSchema.parse(delivery);
    await db
      .collection(this.collectionName)
      .doc(validated.id)
      .set(validated);
  }
}

/**
 * Test fixture utility to directly seed a delivery record into an outbox repository.
 * This function is strictly for setting up test fixtures and is intentionally isolated
 * outside of the production repository classes.
 */
export async function seedOutboxDeliveryForTest(
  repo: CommunicationOutboxRepository,
  delivery: CommunicationDeliveryRecord
): Promise<void> {
  const validated = CommunicationDeliveryRecordSchema.parse(delivery);

  if (repo instanceof TestInMemoryCommunicationOutboxRepository) {
    repo.seedDelivery(validated);
    return;
  }

  if (repo instanceof FirestoreCommunicationOutboxRepository) {
    const adapter = new TestFirestoreOutboxFixtureAdapter();
    adapter.verifyEmulatorEnvironment();
    await adapter.seedDelivery(validated);
    return;
  }

  throw new Error(
    `Unsupported repository type for test fixture seeding: ${repo.constructor.name}. ` +
      "Test fixtures must use TestInMemoryCommunicationOutboxRepository or Firestore with verified emulator."
  );
}

/**
 * Executes a callback within a temporary test environment where VOICE_BOOKING_ENABLED is enabled,
 * and guarantees restoration to 'false' immediately upon completion.
 */
export async function withTestVoiceBookingEnabled<T>(
  fn: () => Promise<T>
): Promise<T> {
  const prev = process.env.VOICE_BOOKING_ENABLED;
  process.env.VOICE_BOOKING_ENABLED = "true";
  try {
    return await fn();
  } finally {
    process.env.VOICE_BOOKING_ENABLED = prev ?? "false";
  }
}
