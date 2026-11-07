/**
 * BREW Coffee Platform — Phase 6.6.3.2 Exotel WebSocket Audio Bridge Types & Schemas
 *
 * Strongly typed definitions for Exotel AgentStream bidirectional WebSocket events,
 * audio encoding configurations (Linear PCM / G.711 μ-law), packetization bounds (3.2KB - 100KB),
 * media format negotiation, and speech provider contracts.
 */

import { z } from "zod";
import { SupportedLanguage, VoiceBookingSession } from "../../../voiceBooking/types";
import { VoiceCallAttemptRecord } from "../types";

// ============================================================================
// Audio Format & Packetization Constants
// ============================================================================

export type AudioEncoding = "pcm16" | "mulaw";

export type AudioSampleRate = 8000 | 16000 | 24000;

export interface AudioFormatConfig {
  encoding: AudioEncoding;
  sampleRate: AudioSampleRate;
  channels: 1;
}

/** Exotel required frame granularity: all packets must be integer multiples of 320 bytes */
export const EXOTEL_FRAME_GRANULARITY_BYTES = 320;

/** Exotel documented minimum packet size for bidirectional AgentStream: 3.2 KB (3,200 bytes) */
export const EXOTEL_MIN_PACKET_BYTES = 3200;

/** Exotel documented maximum packet size for bidirectional AgentStream: 99,840 bytes (312 * 320 bytes) */
export const EXOTEL_MAX_PACKET_BYTES = 99840;

/** Default outbound packet size: 3,200 bytes (10 * 320 bytes = 200ms at 8kHz 16-bit PCM) */
export const EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES = 3200;

export const DEFAULT_EXOTEL_AUDIO_FORMAT: AudioFormatConfig = {
  encoding: "pcm16",
  sampleRate: 8000,
  channels: 1,
};

export const MULAW_8K_AUDIO_FORMAT: AudioFormatConfig = {
  encoding: "mulaw",
  sampleRate: 8000,
  channels: 1,
};

export const PCM_16K_AUDIO_FORMAT: AudioFormatConfig = {
  encoding: "pcm16",
  sampleRate: 16000,
  channels: 1,
};

/**
 * Calculates audio duration in milliseconds from byte length and format.
 */
export function calculateAudioDurationMs(
  byteLength: number,
  encoding: AudioEncoding,
  sampleRate: AudioSampleRate
): number {
  if (byteLength <= 0) return 0;
  const bytesPerSample = encoding === "mulaw" ? 1 : 2;
  const samples = byteLength / bytesPerSample;
  return Math.round((samples / sampleRate) * 1000);
}

/**
 * Calculates byte length from duration in milliseconds and format.
 */
export function calculateAudioByteLength(
  durationMs: number,
  encoding: AudioEncoding,
  sampleRate: AudioSampleRate
): number {
  if (durationMs <= 0) return 0;
  const bytesPerSample = encoding === "mulaw" ? 1 : 2;
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  return samples * bytesPerSample;
}

// ============================================================================
// Exotel AgentStream Media Format Negotiation
// ============================================================================

export const ExotelMediaFormatSchema = z.object({
  encoding: z.string().min(1, "encoding is required in media_format"),
  sample_rate: z.number().int("sample_rate must be an integer"),
  bit_rate: z.number().int().optional(),
  channels: z.number().int().default(1),
}).passthrough();

export type ExotelMediaFormat = z.infer<typeof ExotelMediaFormatSchema>;

export interface NegotiatedMediaFormatResult {
  isValid: boolean;
  format?: AudioFormatConfig;
  errorReason?: string;
}

/**
 * Validates and negotiates Exotel's actual media_format payload.
 *
 * Invariants:
 * 1. Channels must strictly be 1 (mono). Stereo is rejected.
 * 2. Supported PCM formats: "audio/x-l16", "l16", "pcm16", "pcm_s16le", "audio/l16", "pcm", "raw".
 *    Allowed sample rates: 8,000 Hz or 16,000 Hz.
 * 3. Supported μ-law formats: "audio/x-mulaw", "pcmu", "mulaw", "audio/mulaw", "audio/basic".
 *    Allowed sample rate: strictly 8,000 Hz.
 * 4. All other formats (e.g. "audio/opus", "audio/mp3", 44.1kHz) are rejected fail-closed.
 */
export function negotiateExotelMediaFormat(rawFormat?: unknown): NegotiatedMediaFormatResult {
  if (!rawFormat || typeof rawFormat !== "object") {
    return {
      isValid: false,
      errorReason: "Missing or non-object media_format in start event",
    };
  }

  const parsed = ExotelMediaFormatSchema.safeParse(rawFormat);
  if (!parsed.success) {
    return {
      isValid: false,
      errorReason: `Malformed media_format: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    };
  }

  const { encoding, sample_rate, channels } = parsed.data;

  // 1. Validate channels: Exotel AgentStream only supports mono (channels=1)
  if (channels !== 1) {
    return {
      isValid: false,
      errorReason: `Unsupported channels '${channels}': only mono audio (channels=1) is supported by Exotel AgentStream`,
    };
  }

  const normalizedEnc = encoding.trim().toLowerCase();

  // 2. Identify Linear PCM 16-bit
  const isPcm16 =
    normalizedEnc === "audio/x-l16" ||
    normalizedEnc === "l16" ||
    normalizedEnc === "pcm16" ||
    normalizedEnc === "pcm_s16le" ||
    normalizedEnc === "audio/l16" ||
    normalizedEnc === "pcm" ||
    normalizedEnc === "raw";

  // 3. Identify G.711 μ-law
  const isMuLaw =
    normalizedEnc === "audio/x-mulaw" ||
    normalizedEnc === "pcmu" ||
    normalizedEnc === "mulaw" ||
    normalizedEnc === "audio/mulaw" ||
    normalizedEnc === "audio/basic";

  if (!isPcm16 && !isMuLaw) {
    return {
      isValid: false,
      errorReason: `Unsupported encoding '${encoding}': only PCM16 and μ-law supported`,
    };
  }

  if (isPcm16) {
    if (sample_rate !== 8000 && sample_rate !== 16000) {
      return {
        isValid: false,
        errorReason: `Unsupported sample_rate '${sample_rate}' for Linear PCM: only 8000 Hz and 16000 Hz are supported`,
      };
    }
    return {
      isValid: true,
      format: {
        encoding: "pcm16",
        sampleRate: sample_rate as 8000 | 16000,
        channels: 1,
      },
    };
  }

  if (isMuLaw) {
    if (sample_rate !== 8000) {
      return {
        isValid: false,
        errorReason: `Unsupported sample_rate '${sample_rate}' for μ-law: only 8000 Hz is supported by G.711 standard`,
      };
    }
    return {
      isValid: true,
      format: {
        encoding: "mulaw",
        sampleRate: 8000,
        channels: 1,
      },
    };
  }

  return {
    isValid: false,
    errorReason: "Unknown media format error",
  };
}

// ============================================================================
// Exotel AgentStream Incoming Event Schemas
// ============================================================================

export const ExotelStreamConnectedEventSchema = z.object({
  event: z.literal("connected"),
  protocol: z.string().optional(),
  version: z.string().optional(),
  sequence_number: z.union([z.number(), z.string()]).optional(),
  stream_sid: z.string().optional(),
}).passthrough();

export const ExotelStreamStartDataSchema = z.object({
  stream_sid: z.string().optional(),
  account_sid: z.string().optional(),
  call_sid: z.string().min(1, "call_sid is required in start event"),
  from: z.string().optional(),
  to: z.string().optional(),
  custom_parameters: z.record(z.string(), z.string()).optional(),
  custom_field: z.string().optional(),
  media_format: ExotelMediaFormatSchema.optional(),
}).passthrough();

export const ExotelStreamStartEventSchema = z.object({
  event: z.literal("start"),
  sequence_number: z.union([z.number(), z.string()]).optional(),
  stream_sid: z.string().min(1, "stream_sid is required in start event"),
  start: ExotelStreamStartDataSchema.optional(),
}).passthrough();

export const ExotelStreamMediaDataSchema = z.object({
  chunk: z.union([z.number(), z.string()]).optional(),
  timestamp: z.string().optional(),
  payload: z.string().min(1, "Base64 payload is required in media event"),
  track: z.string().optional(),
}).passthrough();

export const ExotelStreamMediaEventSchema = z.object({
  event: z.literal("media"),
  sequence_number: z.union([z.number(), z.string()]).optional(),
  stream_sid: z.string().min(1, "stream_sid is required in media event"),
  media: ExotelStreamMediaDataSchema,
}).passthrough();

export const ExotelStreamStopDataSchema = z.object({
  call_sid: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

export const ExotelStreamStopEventSchema = z.object({
  event: z.literal("stop"),
  sequence_number: z.union([z.number(), z.string()]).optional(),
  stream_sid: z.string().min(1, "stream_sid is required in stop event"),
  stop: ExotelStreamStopDataSchema.optional(),
}).passthrough();

export const ExotelStreamMarkDataSchema = z.object({
  name: z.string().min(1),
}).passthrough();

export const ExotelStreamMarkEventSchema = z.object({
  event: z.literal("mark"),
  sequence_number: z.union([z.number(), z.string()]).optional(),
  stream_sid: z.string().min(1, "stream_sid is required in mark event"),
  mark: ExotelStreamMarkDataSchema.optional(),
}).passthrough();

export const ExotelStreamIncomingEventSchema = z.discriminatedUnion("event", [
  ExotelStreamConnectedEventSchema,
  ExotelStreamStartEventSchema,
  ExotelStreamMediaEventSchema,
  ExotelStreamStopEventSchema,
  ExotelStreamMarkEventSchema,
]);

export type ExotelStreamConnectedEvent = z.infer<typeof ExotelStreamConnectedEventSchema>;
export type ExotelStreamStartEvent = z.infer<typeof ExotelStreamStartEventSchema>;
export type ExotelStreamMediaEvent = z.infer<typeof ExotelStreamMediaEventSchema>;
export type ExotelStreamStopEvent = z.infer<typeof ExotelStreamStopEventSchema>;
export type ExotelStreamMarkEvent = z.infer<typeof ExotelStreamMarkEventSchema>;
export type ExotelStreamIncomingEvent = z.infer<typeof ExotelStreamIncomingEventSchema>;

// ============================================================================
// Exotel AgentStream Outgoing Event Schemas
// ============================================================================

export const ExotelStreamOutboundMediaEventSchema = z.object({
  event: z.literal("media"),
  stream_sid: z.string().min(1),
  media: z.object({
    payload: z.string().min(1),
  }),
});

export const ExotelStreamClearEventSchema = z.object({
  event: z.literal("clear"),
  stream_sid: z.string().min(1),
});

export const ExotelStreamOutboundStopEventSchema = z.object({
  event: z.literal("stop"),
  stream_sid: z.string().min(1),
});

export const ExotelStreamOutboundMarkEventSchema = z.object({
  event: z.literal("mark"),
  stream_sid: z.string().min(1),
  mark: z.object({
    name: z.string().min(1),
  }),
});

export type ExotelStreamOutboundMediaEvent = z.infer<typeof ExotelStreamOutboundMediaEventSchema>;
export type ExotelStreamClearEvent = z.infer<typeof ExotelStreamClearEventSchema>;
export type ExotelStreamOutboundStopEvent = z.infer<typeof ExotelStreamOutboundStopEventSchema>;
export type ExotelStreamOutboundMarkEvent = z.infer<typeof ExotelStreamOutboundMarkEventSchema>;
export type ExotelStreamOutboundEvent =
  | ExotelStreamOutboundMediaEvent
  | ExotelStreamClearEvent
  | ExotelStreamOutboundStopEvent
  | ExotelStreamOutboundMarkEvent;

// ============================================================================
// Speech Provider Types (STT & TTS)
// ============================================================================

export interface TranscribeAudioOptions {
  language: SupportedLanguage;
  encoding: AudioEncoding;
  sampleRate: AudioSampleRate;
  alternativeLanguages?: SupportedLanguage[];
}

export interface TranscribeAudioResult {
  text: string;
  detectedLanguage: SupportedLanguage;
  confidence: number;
  durationMs: number;
}

export interface SynthesizeSpeechOptions {
  language: SupportedLanguage;
  voiceName?: string;
  encoding: AudioEncoding;
  sampleRate: AudioSampleRate;
  speakingRate?: number;
}

export interface SynthesizeSpeechResult {
  audioBuffer: Buffer;
  durationMs: number;
  encoding: AudioEncoding;
  sampleRate: AudioSampleRate;
}

export interface SpeechProvider {
  readonly name: string;
  transcribeAudio(audioBuffer: Buffer, options: TranscribeAudioOptions): Promise<TranscribeAudioResult>;
  synthesizeSpeech(text: string, options: SynthesizeSpeechOptions): Promise<SynthesizeSpeechResult>;
}

// ============================================================================
// Audio Bridge Session & Turn State
// ============================================================================

export interface AudioBridgeSessionState {
  streamSid: string;
  callSid: string;
  attemptId: string;
  sessionId: string;
  phoneNumber: string;
  language: SupportedLanguage;
  audioFormat: AudioFormatConfig;
  isActive: boolean;
  connectedAt: string;
  lastTurnAt?: string;
  turnIndex: number;
  isStreamingAssistantAudio: boolean;
  bargeInOccurred: boolean;
  sessionRecord?: VoiceBookingSession;
  attemptRecord?: VoiceCallAttemptRecord;
}

export interface TurnExecutionMetrics {
  turnIndex: number;
  language: SupportedLanguage;
  userUtterance: string;
  assistantResponse: string;
  sttDurationMs: number;
  engineDurationMs: number;
  ttsDurationMs: number;
  totalTurnLatencyMs: number;
  state: string;
}
