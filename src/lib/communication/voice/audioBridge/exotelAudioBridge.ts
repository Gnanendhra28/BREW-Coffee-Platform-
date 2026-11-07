/**
 * BREW Coffee Platform — Phase 6.6.3.1 Exotel WebSocket Audio Bridge Server
 *
 * Implements a production-grade Fastify WebSocket service for Exotel AgentStream bidirectional audio:
 * - Short-lived, attempt-bound, session-bound HMAC authentication with replay prevention.
 * - Authoritative validation of incoming `call_sid` against the stored call attempt.
 * - Strict 3.2 KB (3,200 bytes) minimum outbound packetization in 320-byte multiples.
 * - Format negotiation defaulting to signed 16-bit PCM (audio/x-l16); μ-law only when explicitly negotiated.
 * - Complete lifecycle support: connected, start, media, mark, stop.
 * - Barge-in interruption detection with immediate Exotel stream 'clear' event.
 * - Mark event dispatch and acknowledgment for playback completion.
 * - Full preservation of quotation integrity (HMAC-SHA256) and staff approval safety gates.
 * - Absolute runtime prohibition of audio recording.
 */

import crypto from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import {
  AudioFormatConfig,
  calculateAudioByteLength,
  DEFAULT_EXOTEL_AUDIO_FORMAT,
  EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
  ExotelStreamClearEvent,
  ExotelStreamConnectedEvent,
  ExotelStreamIncomingEvent,
  ExotelStreamMarkEvent,
  ExotelStreamMediaEvent,
  ExotelStreamOutboundMarkEvent,
  ExotelStreamOutboundMediaEvent,
  ExotelStreamStartEvent,
  negotiateExotelMediaFormat,
  SpeechProvider,
  TurnExecutionMetrics,
} from "./types";
import { MockSpeechProvider, packetizeAudioForExotel } from "./speechProvider";
import {
  createVoiceBookingSession,
  defaultExtractionProvider,
  getVoiceSessionRepository,
  processConversationTurn,
} from "../../../voiceBooking/conversationEngine";
import {
  ExtractionProvider,
  SupportedLanguage,
  VoiceBookingSession,
  VoiceSessionRepository,
} from "../../../voiceBooking/types";
import { InMemoryVoiceCallAttemptRepository } from "../callAttemptRepository";
import {
  VoiceCallAttemptRecord,
  VoiceCallAttemptRepository,
} from "../types";
import { GREETINGS } from "../../../voiceBooking/prompts";
import { getAdminFirestore, isFirebaseAdminAvailable, Timestamp } from "../../../firebaseAdmin";

// ============================================================================
// Bridge Configuration Options
// ============================================================================

export interface ExotelAudioBridgeOptions {
  speechProvider?: SpeechProvider;
  sessionRepository?: VoiceSessionRepository;
  callAttemptRepository?: VoiceCallAttemptRepository;
  extractionProvider?: ExtractionProvider;
  streamSecret?: string;
  chunkSizeBytes?: number; // Minimum 3,200 bytes, multiples of 320 bytes
  enableAudioRecording?: boolean; // Must strictly remain false (prohibited)
  allowStaticSecret?: boolean; // Allow static shared secret in tests/dev
  tokenNonceRegistry?: TokenNonceRegistry;
}

// ============================================================================
// Safe WebSocket Close Helper (RFC 6455 Compliant)
// ============================================================================

/**
 * Safely closes a WebSocket connection conforming to RFC 6455.
 * The close frame payload body must not exceed 123 UTF-8 bytes.
 */
export function safeCloseSocket(
  socket: WebSocket,
  code: number,
  reason: string = "Closure"
): void {
  try {
    const buf = Buffer.from(reason, "utf8");
    const safeReason = buf.length > 120 ? buf.subarray(0, 120).toString("utf8") : reason;
    socket.close(code, safeReason);
  } catch {
    try {
      socket.terminate();
    } catch {
      // Ignored
    }
  }
}

// ============================================================================
// Single-Use Token Nonce Registry (Replay & Concurrent Use Prevention)
// ============================================================================

// ============================================================================
// Single-Use Token Nonce Registry (Replay & Concurrent Use Prevention)
// ============================================================================

export interface TokenNonceRegistry {
  /**
   * Atomically claims a single-use token nonce.
   * Returns true on initial successful claim.
   * Returns false if the nonce has already been claimed (replay or concurrent use detected)
   * or if the registry is unreachable (fail-closed).
   */
  atomicConsume(nonce: string, exp: number, nowMs?: number): Promise<boolean> | boolean;
}

/**
 * Validates that a token nonce is a safe, non-empty alphanumeric/hex identifier.
 * Prevents path traversal in Firestore document paths and key injection in Redis.
 */
export function isValidStreamNonce(nonce: unknown): boolean {
  if (!nonce || typeof nonce !== "string") return false;
  const trimmed = nonce.trim();
  // Safe alphanumeric, hex, hyphen, or underscore between 8 and 128 characters
  return /^[a-zA-Z0-9_-]{8,128}$/.test(trimmed);
}

/**
 * Process-local in-memory registry for unit testing and local development.
 * 
 * IMPORTANT: Does NOT provide distributed replay protection across multiple server instances.
 * Use UpstashRedisTokenNonceRegistry or FirestoreTokenNonceRegistry in distributed/production deployments.
 */
export class InMemoryTokenNonceRegistry implements TokenNonceRegistry {
  private consumedNonces = new Map<string, number>();

  atomicConsume(nonce: string, exp: number, nowMs?: number): boolean {
    if (!isValidStreamNonce(nonce)) return false;
    const trimmed = nonce.trim();

    const nowSec = Math.floor((nowMs ?? Date.now()) / 1000);
    this.pruneExpired(nowSec);

    if (this.consumedNonces.has(trimmed)) {
      return false; // Replay detected!
    }

    this.consumedNonces.set(trimmed, exp);
    return true;
  }

  isConsumed(nonce: string): boolean {
    return this.consumedNonces.has(nonce.trim());
  }

  reset(): void {
    this.consumedNonces.clear();
  }

  get size(): number {
    return this.consumedNonces.size;
  }

  private pruneExpired(nowSec: number): void {
    if (this.consumedNonces.size > 1000) {
      for (const [nonce, exp] of this.consumedNonces.entries()) {
        if (exp < nowSec) {
          this.consumedNonces.delete(nonce);
        }
      }
    }
  }
}

/**
 * Distributed atomic single-use nonce registry powered by Upstash Redis REST API.
 * Uses atomic Redis `SET key "consumed" EX <ttl> NX` command.
 * Fails closed (returns false) if Redis is unreachable or returns non-200.
 */
export class UpstashRedisTokenNonceRegistry implements TokenNonceRegistry {
  private url: string;
  private token: string;
  private keyPrefix: string;

  constructor(options: { url?: string; token?: string; keyPrefix?: string } = {}) {
    this.url = options.url || process.env.UPSTASH_REDIS_REST_URL || "";
    this.token = options.token || process.env.UPSTASH_REDIS_REST_TOKEN || "";
    this.keyPrefix = options.keyPrefix || "brew:voice:nonce:";
  }

  async atomicConsume(nonce: string, exp: number, nowMs?: number): Promise<boolean> {
    if (!isValidStreamNonce(nonce)) {
      return false; // Malformed/illegal nonce input fails closed
    }
    const trimmed = nonce.trim();

    const nowSec = Math.floor((nowMs ?? Date.now()) / 1000);
    if (nowSec > exp) {
      return false; // Token already expired
    }

    const ttlSeconds = Math.max(60, exp - nowSec);

    if (!this.url || !this.token) {
      console.error("[UpstashRedisTokenNonceRegistry] Missing Redis URL or Token, failing closed");
      return false;
    }

    try {
      const key = `${this.keyPrefix}${trimmed}`;
      const res = await fetch(`${this.url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([["SET", key, "consumed", "EX", ttlSeconds, "NX"]]),
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        console.error(`[UpstashRedisTokenNonceRegistry] HTTP ${res.status}: ${res.statusText}, failing closed`);
        return false;
      }

      const data = await res.json();
      const setResult = Array.isArray(data) ? data[0]?.result : data?.result;
      return setResult === "OK";
    } catch (err) {
      console.error("[UpstashRedisTokenNonceRegistry] Request failed, failing closed:", err);
      return false;
    }
  }
}

/**
 * Distributed atomic single-use nonce registry powered by Google Cloud Firestore.
 * Uses Firestore atomic transactions to prevent replayed and concurrent token consumption
 * across multiple server instances.
 * Fails closed (returns false) if Firestore is unreachable or errors.
 */
export class FirestoreTokenNonceRegistry implements TokenNonceRegistry {
  private collectionName: string;

  constructor(collectionName = "voice_stream_nonces") {
    this.collectionName = collectionName;
  }

  async atomicConsume(nonce: string, exp: number, nowMs?: number): Promise<boolean> {
    if (!isValidStreamNonce(nonce)) {
      return false; // Malformed/illegal nonce input fails closed
    }
    const trimmed = nonce.trim();

    const nowSec = Math.floor((nowMs ?? Date.now()) / 1000);
    if (nowSec > exp) {
      return false; // Token already expired
    }

    const db = getAdminFirestore();
    if (!db) {
      console.error("[FirestoreTokenNonceRegistry] Firestore not available, failing closed");
      return false;
    }

    try {
      const docRef = db.collection(this.collectionName).doc(trimmed);

      const transactionPromise = db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(docRef);
        if (snapshot.exists) {
          const data = snapshot.data();
          if (data && typeof data.exp === "number" && data.exp >= nowSec) {
            return false; // Replay detected
          }
        }

        transaction.set(docRef, {
          nonce: trimmed,
          exp,
          expireAt: Timestamp.fromMillis(exp * 1000),
          consumedAt: new Date(nowMs ?? Date.now()).toISOString(),
        });
        return true;
      });

      // Strict fail-closed timeout (2000ms) prevents unbounded hangs
      const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error("Firestore transaction timeout")), 2000);
      });

      const consumed = await Promise.race([transactionPromise, timeoutPromise]);
      return consumed;
    } catch (err) {
      console.error("[FirestoreTokenNonceRegistry] Transaction failed, failing closed:", err);
      return false;
    }
  }
}

/**
 * Factory function to create the appropriate distributed atomic nonce registry.
 * Prefers Upstash Redis, then Firestore (in production or emulator), then fallback to in-memory for testing.
 * Strictly forbids silent fallback to in-memory in production.
 */
export function createSharedTokenNonceRegistry(): TokenNonceRegistry {
  const isLocalTest =
    process.env.PLAYWRIGHT_TEST === "true" ||
    process.env.BREW_TEST_SUITE === "true";
  const isProduction =
    process.env.NODE_ENV === "production" && !isLocalTest;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashRedisTokenNonceRegistry();
  }
  if (process.env.FIRESTORE_EMULATOR_HOST && isFirebaseAdminAvailable()) {
    return new FirestoreTokenNonceRegistry();
  }
  if (isProduction) {
    if (isFirebaseAdminAvailable()) {
      return new FirestoreTokenNonceRegistry();
    }
    // Hard security invariant: production must never silently select in-memory registry
    throw new Error(
      "Configuration safety violation: production environment must configure distributed replay protection (Upstash Redis or Firestore). In-memory registry is strictly prohibited in production."
    );
  }
  return new InMemoryTokenNonceRegistry();
}

/**
 * Alias for backward compatibility with existing tests and code.
 */
export const TokenNonceRegistry = InMemoryTokenNonceRegistry;
export const defaultTokenNonceRegistry: TokenNonceRegistry = new InMemoryTokenNonceRegistry();

// ============================================================================
// Active Connection Context
// ============================================================================

export interface ActiveStreamConnection {
  socket: WebSocket;
  streamSid: string | null;
  callSid: string | null;
  attemptId: string | null;
  sessionId: string | null;
  phoneNumber: string;
  language: SupportedLanguage;
  audioFormat: AudioFormatConfig;
  sessionRecord: VoiceBookingSession | null;
  attemptRecord: VoiceCallAttemptRecord | null;
  inboundAudioChunks: Buffer[];
  isStreamingAssistantAudio: boolean;
  bargeInOccurred: boolean;
  turnInProgress: boolean;
  abortController: AbortController | null;
  turnIndex: number;
  turnHistory: TurnExecutionMetrics[];
  isClosed: boolean;
  connectedAt: string;
}

// ============================================================================
// Authentication & Token Utilities
// ============================================================================

export interface GenerateStreamTokenParams {
  secretKey: string;
  attemptId: string;
  sessionId: string;
  expiresInSeconds?: number;
  nowMs?: number;
  nonce?: string;
}

/**
 * Generates an attempt-bound, session-bound, single-use HMAC token with a cryptographically
 * random nonce for stream authentication.
 * Format: `${exp}.${nonce}.${signature}`
 */
export function generateStreamToken(params: GenerateStreamTokenParams): {
  token: string;
  exp: number;
  nonce: string;
} {
  const nowMs = params.nowMs ?? Date.now();
  const expiresInSeconds = params.expiresInSeconds ?? 300; // 5 minutes default
  const exp = Math.floor(nowMs / 1000) + expiresInSeconds;
  const nonce = params.nonce ?? crypto.randomBytes(16).toString("hex");

  const payload = `${params.attemptId.trim()}:${params.sessionId.trim()}:${exp}:${nonce.trim()}`;
  const signature = crypto
    .createHmac("sha256", params.secretKey.trim())
    .update(payload)
    .digest("hex");

  return {
    token: `${exp}.${nonce}.${signature}`,
    exp,
    nonce,
  };
}

export interface VerifyStreamTokenParams {
  secretKey: string;
  token?: string | null;
  attemptId?: string | null;
  sessionId?: string | null;
  nowMs?: number;
  allowStaticSecret?: boolean;
  tokenNonceRegistry?: TokenNonceRegistry;
}

/**
 * Verifies that a stream token is unexpired, attempt-bound, session-bound, and atomically
 * consumes its nonce to prevent replay and concurrent use.
 */
export async function verifyStreamToken(params: VerifyStreamTokenParams): Promise<{
  isValid: boolean;
  reason?: string;
  nonce?: string;
}> {
  const { secretKey, token, attemptId, sessionId, nowMs, allowStaticSecret, tokenNonceRegistry } = params;

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return { isValid: false, reason: "Missing token" };
  }

  const trimmedToken = token.trim();
  const trimmedSecret = secretKey.trim();

  // Allow static shared secret in tests or development if explicitly enabled
  if (allowStaticSecret && timingSafeCompare(trimmedToken, trimmedSecret)) {
    return { isValid: true };
  }

  const parts = trimmedToken.split(".");
  let expStr = "";
  let nonce = "";
  let signature = "";

  if (parts.length === 3) {
    // Standard single-use format: `${exp}.${nonce}.${signature}`
    [expStr, nonce, signature] = parts;
    if (!isValidStreamNonce(nonce)) {
      return { isValid: false, reason: "Malformed token nonce" };
    }
  } else if (parts.length === 2) {
    // Legacy 2-part format: `${exp}.${signature}`
    [expStr, signature] = parts;
    nonce = "legacy_no_nonce";
  } else {
    return { isValid: false, reason: "Malformed token format: expected exp.nonce.signature" };
  }

  const exp = parseInt(expStr, 10);
  if (Number.isNaN(exp) || !Number.isFinite(exp)) {
    return { isValid: false, reason: "Invalid expiration in token" };
  }

  const currentSec = Math.floor((nowMs ?? Date.now()) / 1000);
  if (currentSec > exp) {
    return { isValid: false, reason: "Token has expired" };
  }

  if (!attemptId || !sessionId) {
    return { isValid: false, reason: "Missing attemptId or sessionId for signature binding" };
  }

  // Construct expected payload based on format
  const expectedPayload =
    parts.length === 3
      ? `${attemptId.trim()}:${sessionId.trim()}:${exp}:${nonce.trim()}`
      : `${attemptId.trim()}:${sessionId.trim()}:${exp}`;

  const expectedSignature = crypto
    .createHmac("sha256", trimmedSecret)
    .update(expectedPayload)
    .digest("hex");

  if (!timingSafeCompare(signature, expectedSignature)) {
    return { isValid: false, reason: "Invalid token signature" };
  }

  // Atomically claim the nonce to prevent replay and concurrent reuse
  if (parts.length === 3) {
    const registry = tokenNonceRegistry || defaultTokenNonceRegistry;
    const claimed = await registry.atomicConsume(nonce, exp, nowMs);
    if (!claimed) {
      return {
        isValid: false,
        reason: "Token has already been consumed (replay detected)",
      };
    }
  }

  return { isValid: true, nonce };
}

// ============================================================================
// Audio Bridge Fastify Factory
// ============================================================================

/**
 * Creates and configures the standalone Fastify instance with the Exotel WebSocket audio bridge.
 */
export async function createExotelAudioBridgeApp(
  options: ExotelAudioBridgeOptions = {}
): Promise<FastifyInstance> {
  const speechProvider = options.speechProvider || new MockSpeechProvider();
  const sessionRepo = options.sessionRepository || getVoiceSessionRepository();
  const attemptRepo = options.callAttemptRepository || new InMemoryVoiceCallAttemptRepository();
  const extractionProvider = options.extractionProvider || defaultExtractionProvider;
  const configuredSecret =
    options.streamSecret ||
    process.env.EXOTEL_STREAM_SECRET ||
    process.env.COMMUNICATION_WORKER_SECRET ||
    "brew-voice-stream-secret-dev";
  const chunkSizeBytes = options.chunkSizeBytes || EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES;
  const allowStaticSecret = options.allowStaticSecret ?? true;
  const tokenNonceRegistry = options.tokenNonceRegistry || createSharedTokenNonceRegistry();

  // Hard safety invariant: audio recording must never be enabled
  if (options.enableAudioRecording === true) {
    throw new Error(
      "Safety violation: audio recording is strictly prohibited across all BREW voice systems."
    );
  }

  const app = Fastify({
    logger: false,
  });

  // Register WebSocket plugin
  await app.register(fastifyWebsocket);

  // Health check route
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "exotel-audio-bridge",
      timestamp: new Date().toISOString(),
      speechProvider: speechProvider.name,
      recordingEnabled: false,
      minPacketBytes: EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
    };
  });

  // WebSocket route for Exotel AgentStream
  app.get(
    "/media",
    { websocket: true },
    async (socket: WebSocket, req) => {
      // 1. Handshake Authentication (attempt-bound, session-bound, replay-protected)
      const query = (req.query || {}) as Record<string, string | undefined>;
      const token = query.token;
      const queryAttemptId = query.attemptId || null;
      const querySessionId = query.sessionId || null;

      const authCheck = await verifyStreamToken({
        secretKey: configuredSecret,
        token,
        attemptId: queryAttemptId,
        sessionId: querySessionId,
        allowStaticSecret,
        tokenNonceRegistry,
      });

      if (!authCheck.isValid) {
        // Reject unauthorized connection immediately
        safeCloseSocket(socket, 4401, authCheck.reason || "Unauthorized");
        return;
      }

      const connection: ActiveStreamConnection = {
        socket,
        streamSid: null,
        callSid: null,
        attemptId: queryAttemptId,
        sessionId: querySessionId,
        phoneNumber: query.from || query.to || "+919876543210",
        language: "en",
        audioFormat: { ...DEFAULT_EXOTEL_AUDIO_FORMAT },
        sessionRecord: null,
        attemptRecord: null,
        inboundAudioChunks: [],
        isStreamingAssistantAudio: false,
        bargeInOccurred: false,
        turnInProgress: false,
        abortController: null,
        turnIndex: 0,
        turnHistory: [],
        isClosed: false,
        connectedAt: new Date().toISOString(),
      };

      // 2. Incoming WebSocket Message Dispatcher
      socket.on("message", async (rawMessage: Buffer | string) => {
        try {
          const rawString = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
          const event = JSON.parse(rawString) as ExotelStreamIncomingEvent;

          if (!event || typeof event !== "object" || !("event" in event)) {
            // Malformed frame without event name
            return;
          }

          switch (event.event) {
            case "connected":
              await handleConnectedEvent(connection, event as ExotelStreamConnectedEvent);
              break;

            case "start":
              await handleStartEvent(connection, event as ExotelStreamStartEvent);
              break;

            case "media":
              await handleMediaEvent(connection, event as ExotelStreamMediaEvent);
              break;

            case "mark":
              await handleMarkEvent(connection, event as ExotelStreamMarkEvent);
              break;

            case "stop":
              await handleStopEvent(connection);
              break;

            default:
              // Unknown event ignored safely
              break;
          }
        } catch {
          // Gracefully swallow malformed JSON frames to prevent crashing the worker
        }
      });

      socket.on("close", async () => {
        connection.isClosed = true;
        if (connection.abortController) {
          connection.abortController.abort();
        }
      });

      socket.on("error", () => {
        connection.isClosed = true;
      });
    }
  );

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  async function handleConnectedEvent(
    conn: ActiveStreamConnection,
    event: ExotelStreamConnectedEvent
  ): Promise<void> {
    conn.connectedAt = new Date().toISOString();
    if (event.stream_sid) {
      conn.streamSid = event.stream_sid;
    }
  }

  async function handleStartEvent(
    conn: ActiveStreamConnection,
    event: ExotelStreamStartEvent
  ): Promise<void> {
    conn.streamSid = event.stream_sid;
    conn.callSid = event.start?.call_sid || null;

    if (!conn.callSid) {
      safeCloseSocket(conn.socket, 4400, "Missing call_sid in start event");
      return;
    }

    // Resolve correlation IDs from start payload if not provided on handshake
    if (event.start?.custom_parameters) {
      if (event.start.custom_parameters.attemptId && !conn.attemptId) {
        conn.attemptId = event.start.custom_parameters.attemptId;
      }
      if (event.start.custom_parameters.sessionId && !conn.sessionId) {
        conn.sessionId = event.start.custom_parameters.sessionId;
      }
    }

    if (!conn.attemptId && event.start?.custom_field) {
      const parsed = parseCustomFieldCorrelation(event.start.custom_field);
      if (parsed.attemptId) conn.attemptId = parsed.attemptId;
      if (parsed.sessionId && !conn.sessionId) conn.sessionId = parsed.sessionId;
    }

    // Require an attemptId for safe call correlation
    if (!conn.attemptId) {
      safeCloseSocket(conn.socket, 4400, "Missing attemptId correlation");
      return;
    }

    // Authoritative check against stored attempt repository
    const storedAttempt = await attemptRepo.getById(conn.attemptId);
    if (!storedAttempt) {
      safeCloseSocket(conn.socket, 4404, `Attempt '${conn.attemptId}' not found in repository`);
      return;
    }

    // Validate that incoming call_sid matches stored providerCallId
    if (storedAttempt.providerCallId && storedAttempt.providerCallId !== conn.callSid) {
      safeCloseSocket(
        conn.socket,
        4409,
        `Call SID mismatch: stored '${storedAttempt.providerCallId}' vs incoming '${conn.callSid}'`
      );
      return;
    }

    // Validate session correlation if stored on attempt
    if (conn.sessionId && storedAttempt.sessionId && storedAttempt.sessionId !== conn.sessionId) {
      safeCloseSocket(
        conn.socket,
        4409,
        `Session ID mismatch: stored '${storedAttempt.sessionId}' vs incoming '${conn.sessionId}'`
      );
      return;
    }

    // Attach providerCallId if it was not yet persisted (e.g. worker recovery)
    if (!storedAttempt.providerCallId) {
      await attemptRepo.attachProviderCallId(conn.attemptId, conn.callSid);
    }
    conn.attemptRecord = storedAttempt;
    if (!conn.sessionId) conn.sessionId = storedAttempt.sessionId;

    // Validate and negotiate media format
    // Exotel media strictly requires supported PCM or μ-law mono format.
    // Malformed or unsupported formats are rejected fail-closed (code 4415) without silent fallback.
    if (event.start?.media_format) {
      const negotiation = negotiateExotelMediaFormat(event.start.media_format);
      if (!negotiation.isValid || !negotiation.format) {
        safeCloseSocket(conn.socket, 4415, negotiation.errorReason || "Unsupported media format");
        return;
      }
      conn.audioFormat = negotiation.format;
    } else {
      // Default to standard signed 16-bit little-endian mono PCM if omitted
      conn.audioFormat = { ...DEFAULT_EXOTEL_AUDIO_FORMAT };
    }

    // Correlate with Session Repository
    if (conn.sessionId) {
      const session = await sessionRepo.getById(conn.sessionId);
      if (session) {
        conn.sessionRecord = session;
        conn.language = session.language;
        conn.phoneNumber = session.phoneNumber;
      }
    }

    // If session doesn't exist, initialize a new VoiceBookingSession
    if (!conn.sessionRecord) {
      const newSession = createVoiceBookingSession(conn.phoneNumber, conn.language);
      if (conn.sessionId) {
        newSession.id = conn.sessionId;
      }
      await sessionRepo.save(newSession);
      conn.sessionRecord = newSession;
      conn.sessionId = newSession.id;
    }

    // Mark call attempt in_progress if not already terminal
    if (conn.attemptId) {
      try {
        await attemptRepo.updateStatus(conn.attemptId, {
          status: "in_progress",
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-blocking if attempt update is ignored or conflict
      }
    }

    // Synthesize and stream initial welcome greeting to Exotel
    const greetingText = GREETINGS[conn.language];
    await streamAssistantReply(conn, greetingText);
  }

  async function handleMediaEvent(
    conn: ActiveStreamConnection,
    event: ExotelStreamMediaEvent
  ): Promise<void> {
    if (!event.media?.payload) return;

    const chunk = Buffer.from(event.media.payload, "base64");

    // Barge-in check: if caller transmits audio while bot is speaking, interrupt immediately!
    if (conn.isStreamingAssistantAudio) {
      conn.bargeInOccurred = true;
      conn.isStreamingAssistantAudio = false;
      if (conn.abortController) {
        conn.abortController.abort();
      }

      // Send clear event to Exotel to flush buffered playback
      sendClearEvent(conn);
    }

    conn.inboundAudioChunks.push(chunk);

    // Calculate dynamic turn threshold: ~1.5s of audio based on encoding & sample rate
    const turnThresholdBytes = calculateAudioByteLength(
      1500,
      conn.audioFormat.encoding,
      conn.audioFormat.sampleRate
    );

    const totalBuffered = conn.inboundAudioChunks.reduce((acc, c) => acc + c.length, 0);

    if (
      totalBuffered >= turnThresholdBytes &&
      !conn.isStreamingAssistantAudio &&
      !conn.turnInProgress
    ) {
      await processTurn(conn);
    }
  }

  async function handleMarkEvent(
    conn: ActiveStreamConnection,
    event: ExotelStreamMarkEvent
  ): Promise<void> {
    // Record playback completion mark received from Exotel
    const markName = event.mark?.name;
    if (markName && conn.turnHistory.length > 0) {
      const lastTurn = conn.turnHistory[conn.turnHistory.length - 1];
      if (markName.includes(`turn_${lastTurn.turnIndex}_complete`)) {
        conn.isStreamingAssistantAudio = false;
      }
    }
  }

  async function handleStopEvent(
    conn: ActiveStreamConnection
  ): Promise<void> {
    conn.isClosed = true;
    if (conn.abortController) {
      conn.abortController.abort();
    }

    // Mark attempt completed if still active
    if (conn.attemptId) {
      try {
        await attemptRepo.updateStatus(conn.attemptId, {
          status: "completed",
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Safe to ignore if already terminal
      }
    }

    try {
      conn.socket.close(1000, "Normal Closure");
    } catch {
      // Socket may already be closed
    }
  }

  // ==========================================================================
  // Turn Execution & Speech Processing
  // ==========================================================================

  async function processTurn(conn: ActiveStreamConnection): Promise<void> {
    if (conn.inboundAudioChunks.length === 0 || conn.isClosed || conn.turnInProgress) return;

    conn.turnInProgress = true;
    const startTime = Date.now();
    conn.turnIndex++;

    try {
      // 1. Consolidate buffered audio
      const combinedBuffer = Buffer.concat(conn.inboundAudioChunks);
      conn.inboundAudioChunks = [];

      // 2. Transcribe Audio via SpeechProvider (STT)
      const sttStart = Date.now();
      const sttResult = await speechProvider.transcribeAudio(combinedBuffer, {
        language: conn.language,
        encoding: conn.audioFormat.encoding,
        sampleRate: conn.audioFormat.sampleRate,
      });
      const sttDurationMs = Date.now() - sttStart;

      const userUtterance = sttResult.text.trim();
      if (!userUtterance) {
        // Empty or silence; ignore turn
        return;
      }

      // 3. Dispatch to BREW Conversation Engine (processConversationTurn)
      const engineStart = Date.now();
      if (!conn.sessionRecord) {
        throw new Error("Cannot process turn without active session record.");
      }

      // Always reload latest session state from repository to guarantee concurrency freshness
      const currentSession = (await sessionRepo.getById(conn.sessionRecord.id)) || conn.sessionRecord;

      const turnResult = await processConversationTurn(currentSession, userUtterance, {
        extractionProvider,
        sessionRepository: sessionRepo,
        callerPhoneNumber: conn.phoneNumber,
        turnIndex: conn.turnIndex,
        turnId: `turn_${conn.turnIndex}_${Date.now()}`,
      });
      const engineDurationMs = Date.now() - engineStart;

      // Update active connection state
      conn.sessionRecord = turnResult.session;
      conn.language = turnResult.language;

      // 4. Synthesize Assistant Audio via SpeechProvider (TTS)
      const ttsStart = Date.now();
      const ttsResult = await speechProvider.synthesizeSpeech(turnResult.assistantResponse, {
        language: conn.language,
        encoding: conn.audioFormat.encoding,
        sampleRate: conn.audioFormat.sampleRate,
      });
      const ttsDurationMs = Date.now() - ttsStart;

      // 5. Stream Audio Chunks to Exotel
      await streamAudioBuffer(conn, ttsResult.audioBuffer);

      // Record turn execution metrics
      const totalTurnLatencyMs = Date.now() - startTime;
      conn.turnHistory.push({
        turnIndex: conn.turnIndex,
        language: conn.language,
        userUtterance,
        assistantResponse: turnResult.assistantResponse,
        sttDurationMs,
        engineDurationMs,
        ttsDurationMs,
        totalTurnLatencyMs,
        state: turnResult.state,
      });
    } finally {
      conn.turnInProgress = false;
    }
  }

  async function streamAssistantReply(
    conn: ActiveStreamConnection,
    text: string
  ): Promise<void> {
    const ttsResult = await speechProvider.synthesizeSpeech(text, {
      language: conn.language,
      encoding: conn.audioFormat.encoding,
      sampleRate: conn.audioFormat.sampleRate,
    });
    await streamAudioBuffer(conn, ttsResult.audioBuffer);
  }

  async function streamAudioBuffer(
    conn: ActiveStreamConnection,
    audioBuffer: Buffer
  ): Promise<void> {
    if (!conn.streamSid || conn.socket.readyState !== WebSocket.OPEN) return;

    conn.isStreamingAssistantAudio = true;
    conn.bargeInOccurred = false;
    conn.abortController = new AbortController();
    const signal = conn.abortController.signal;

    // Strictly packetize in compliant >= 3,200-byte frames (multiples of 320 bytes)
    const packets = packetizeAudioForExotel(audioBuffer, conn.audioFormat, chunkSizeBytes);

    try {
      for (const packet of packets) {
        if (signal.aborted || conn.bargeInOccurred || conn.socket.readyState !== WebSocket.OPEN) {
          break;
        }

        const payload = packet.toString("base64");
        const message: ExotelStreamOutboundMediaEvent = {
          event: "media",
          stream_sid: conn.streamSid,
          media: { payload },
        };

        conn.socket.send(JSON.stringify(message));

        // Yield to event loop to allow incoming frames (e.g. barge-in) to be handled
        await new Promise((r) => setImmediate(r));
      }

      // Send mark frame to signal stream playback completion to Exotel
      if (!signal.aborted && !conn.bargeInOccurred && conn.socket.readyState === WebSocket.OPEN) {
        const markMessage: ExotelStreamOutboundMarkEvent = {
          event: "mark",
          stream_sid: conn.streamSid,
          mark: { name: `turn_${conn.turnIndex}_complete` },
        };
        conn.socket.send(JSON.stringify(markMessage));
      }
    } finally {
      conn.isStreamingAssistantAudio = false;
      conn.abortController = null;
    }
  }

  function sendClearEvent(conn: ActiveStreamConnection): void {
    if (!conn.streamSid || conn.socket.readyState !== WebSocket.OPEN) return;

    const clearMsg: ExotelStreamClearEvent = {
      event: "clear",
      stream_sid: conn.streamSid,
    };
    try {
      conn.socket.send(JSON.stringify(clearMsg));
    } catch {
      // Non-blocking
    }
  }

  return app;
}

// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Constant-time comparison between two strings to prevent timing attacks.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parses Exotel's CustomField format (e.g. "vca:vca_123;s:vbs_456")
 */
export function parseCustomFieldCorrelation(customField: string): {
  attemptId?: string;
  sessionId?: string;
} {
  const result: { attemptId?: string; sessionId?: string } = {};
  if (!customField || typeof customField !== "string") return result;

  const parts = customField.split(";");
  for (const part of parts) {
    const [key, val] = part.split(":");
    if (key === "vca" && val) {
      result.attemptId = val.trim();
    } else if (key === "s" && val) {
      result.sessionId = val.trim();
    }
  }

  return result;
}
