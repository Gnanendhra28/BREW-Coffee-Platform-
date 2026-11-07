/**
 * BREW Coffee Platform — Standalone Fastify WebSocket Audio Bridge Server Entrypoint
 *
 * Runs independently of Next.js to provide dedicated, low-latency, persistent WebSocket
 * connectivity for carrier audio streaming (Exotel Connect Voice AI).
 *
 * INVARIANTS:
 * 1. Dedicated Process: Runs outside Next.js App Router to avoid serverless timeouts,
 *    SSR contention, or idle container spindowns.
 * 2. Host & Port Configuration: Defaults to 0.0.0.0:18091 (local development/testing).
 * 3. Environment Validation: Validates required stream secrets and speech provider credentials
 *    at startup; fails closed before binding if configuration is missing.
 * 4. Graceful Shutdown: Handles SIGTERM and SIGINT, closes active connections, and drains sockets cleanly.
 */

import type { FastifyInstance } from "fastify";
import {
  createExotelAudioBridgeApp,
  createSharedTokenNonceRegistry,
  TokenNonceRegistry,
} from "../lib/communication/voice/audioBridge/exotelAudioBridge";
import {
  AzureSpeechProvider,
  MockSpeechProvider,
} from "../lib/communication/voice/audioBridge/speechProvider";
import {
  EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
  SpeechProvider,
} from "../lib/communication/voice/audioBridge/types";
import {
  FirestoreVoiceCallAttemptRepository,
  InMemoryVoiceCallAttemptRepository,
} from "../lib/communication/voice/callAttemptRepository";
import { VoiceCallAttemptRepository } from "../lib/communication/voice/types";
import { isFirebaseAdminAvailable } from "../lib/firebaseAdmin";
import {
  GeminiExtractionProvider,
  MockExtractionProvider,
} from "../lib/voiceBooking/providers/extractionProvider";
import { FirestoreVoiceSessionRepository } from "../lib/voiceBooking/repositories/firestoreSessionRepository";
import { InMemoryVoiceSessionRepository } from "../lib/voiceBooking/repositories/sessionRepository";
import { ExtractionProvider, VoiceSessionRepository } from "../lib/voiceBooking/types";

export interface VoiceBridgeServerOptions {
  host?: string;
  port?: number;
  speechProvider?: SpeechProvider;
  sessionRepository?: VoiceSessionRepository;
  callAttemptRepository?: VoiceCallAttemptRepository;
  extractionProvider?: ExtractionProvider;
  tokenNonceRegistry?: TokenNonceRegistry;
  streamSecret?: string;
  chunkSizeBytes?: number;
  allowStaticSecret?: boolean;
}

export interface ValidatedBridgeConfig {
  streamSecret: string;
  azureSpeechKey?: string;
  azureSpeechRegion?: string;
}

/**
 * Validates required configuration before the server starts.
 * Throws in production if mandatory credentials are missing.
 */
export function validateVoiceBridgeConfig(isProduction: boolean): ValidatedBridgeConfig {
  const streamSecret = (
    process.env.STREAM_SECRET_KEY ||
    process.env.EXOTEL_STREAM_SECRET ||
    process.env.AUTH_SECRET ||
    ""
  ).trim();

  if (!streamSecret && isProduction) {
    throw new Error(
      "Fatal configuration error: STREAM_SECRET_KEY (or EXOTEL_STREAM_SECRET) must be set in production for stream token authentication."
    );
  }

  const azureSpeechKey = process.env.AZURE_SPEECH_KEY?.trim();
  const azureSpeechRegion = process.env.AZURE_SPEECH_REGION?.trim();

  if (isProduction && (!azureSpeechKey || !azureSpeechRegion)) {
    throw new Error(
      "Fatal configuration error: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be configured in production."
    );
  }

  return {
    streamSecret: streamSecret || "brew-dev-stream-secret-change-in-production",
    azureSpeechKey,
    azureSpeechRegion,
  };
}

/**
 * Factory that starts the standalone Fastify audio bridge server.
 */
export async function startVoiceBridgeServer(
  options: VoiceBridgeServerOptions = {}
): Promise<{
  app: FastifyInstance;
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const isProduction =
    process.env.NODE_ENV === "production" &&
    process.env.BREW_TEST_SUITE !== "true" &&
    process.env.PLAYWRIGHT_TEST !== "true";

  const config = validateVoiceBridgeConfig(isProduction);

  const host = options.host || process.env.VOICE_BRIDGE_HOST || process.env.HOST || "0.0.0.0";
  const port = options.port ?? Number(process.env.VOICE_BRIDGE_PORT || process.env.PORT || 18091);

  // Initialize Speech Provider
  let speechProvider = options.speechProvider;
  if (!speechProvider) {
    if (config.azureSpeechKey && config.azureSpeechRegion) {
      speechProvider = new AzureSpeechProvider({
        subscriptionKey: config.azureSpeechKey,
        region: config.azureSpeechRegion,
      });
    } else {
      console.warn("[VoiceBridgeServer] Using MockSpeechProvider (development/test mode)");
      speechProvider = new MockSpeechProvider({ generateSyntheticTone: true });
    }
  }

  // Initialize Session Repository
  let sessionRepository = options.sessionRepository;
  if (!sessionRepository) {
    if (isFirebaseAdminAvailable()) {
      sessionRepository = new FirestoreVoiceSessionRepository();
    } else {
      console.warn("[VoiceBridgeServer] Firestore unavailable. Using InMemoryVoiceSessionRepository.");
      sessionRepository = new InMemoryVoiceSessionRepository();
    }
  }

  // Initialize Call Attempt Repository
  let callAttemptRepository = options.callAttemptRepository;
  if (!callAttemptRepository) {
    if (isFirebaseAdminAvailable()) {
      callAttemptRepository = new FirestoreVoiceCallAttemptRepository();
    } else {
      console.warn(
        "[VoiceBridgeServer] Firestore unavailable. Using InMemoryVoiceCallAttemptRepository."
      );
      callAttemptRepository = new InMemoryVoiceCallAttemptRepository();
    }
  }

  // Initialize Extraction Provider
  let extractionProvider = options.extractionProvider;
  if (!extractionProvider) {
    if (process.env.GEMINI_API_KEY) {
      extractionProvider = new GeminiExtractionProvider();
    } else {
      extractionProvider = new MockExtractionProvider();
    }
  }

  // Initialize Token Nonce Registry
  const tokenNonceRegistry = options.tokenNonceRegistry || createSharedTokenNonceRegistry();

  const streamSecret = options.streamSecret || config.streamSecret;

  const app = await createExotelAudioBridgeApp({
    speechProvider,
    sessionRepository,
    callAttemptRepository,
    extractionProvider,
    tokenNonceRegistry,
    streamSecret,
    chunkSizeBytes: options.chunkSizeBytes ?? EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
    allowStaticSecret: options.allowStaticSecret ?? false,
  });

  await app.listen({ host, port });
  console.log(`[VoiceBridgeServer] WebSocket audio bridge listening on ${host}:${port}`);

  let isClosing = false;
  const close = async () => {
    if (isClosing) return;
    isClosing = true;
    console.log("[VoiceBridgeServer] Graceful shutdown initiated...");
    await app.close();
    console.log("[VoiceBridgeServer] Server closed successfully.");
  };

  return { app, host, port, close };
}

// Entrypoint execution when invoked directly via CLI (npm run start:voice-bridge)
const isDirectExecution =
  (typeof require !== "undefined" && require.main === module) ||
  (process.argv[1] && process.argv[1].endsWith("voiceBridgeServer.ts"));

if (isDirectExecution) {
  startVoiceBridgeServer()
    .then(({ close }) => {
      const handleShutdown = async (signal: string) => {
        console.log(`[VoiceBridgeServer] Received ${signal}. Initiating graceful shutdown...`);
        try {
          await close();
          process.exit(0);
        } catch (err) {
          console.error("[VoiceBridgeServer] Error during shutdown:", err);
          process.exit(1);
        }
      };

      process.on("SIGTERM", () => handleShutdown("SIGTERM"));
      process.on("SIGINT", () => handleShutdown("SIGINT"));
    })
    .catch((err) => {
      console.error("[VoiceBridgeServer] Fatal startup failure:", err);
      process.exit(1);
    });
}
