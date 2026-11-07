/**
 * BREW Coffee Platform — Phase 6.6.3 Speech Providers & Audio Codecs
 *
 * Implements:
 * 1. Mathematical ITU-T G.711 μ-law <-> Linear PCM 16-bit companding codecs.
 * 2. Deterministic MockSpeechProvider for automated testing across English, Hindi, and Telugu.
 * 3. AzureSpeechProvider adapter for Azure Cognitive Services Neural TTS and Speech-to-Text.
 *
 * All audio processing runs locally with zero external network side-effects during tests.
 */

import { SupportedLanguage } from "../../../voiceBooking/types";
import {
  AudioFormatConfig,
  EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES,
  EXOTEL_FRAME_GRANULARITY_BYTES,
  EXOTEL_MAX_PACKET_BYTES,
  EXOTEL_MIN_PACKET_BYTES,
  SpeechProvider,
  SynthesizeSpeechOptions,
  SynthesizeSpeechResult,
  TranscribeAudioOptions,
  TranscribeAudioResult,
} from "./types";

// ============================================================================
// ITU-T G.711 μ-Law Codec Implementation (16-bit PCM <-> 8-bit μ-law)
// ============================================================================

const BIAS = 132;
const CLIP = 32635;

/** Precomputed 256-entry lookup table for μ-law to 16-bit linear PCM conversion */
const MULAW_TO_PCM16_TABLE = new Int16Array(256);

(function initMuLawDecodeTable() {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const isNegative = (mu & 0x80) !== 0;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;

    // Standard ITU-T G.711 μ-law decode formula with midpoint reconstruction:
    const linear = ((mantissa * 2 + 33) << (exponent + 2)) - BIAS;
    const sample = isNegative ? -linear : linear;

    MULAW_TO_PCM16_TABLE[i] = Math.max(-32768, Math.min(32767, sample));
  }
})();

/**
 * Encodes a single 16-bit signed PCM sample into an 8-bit ITU-T G.711 μ-law byte.
 */
export function linearSampleToMuLaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muLawByte;
}

/**
 * Converts a Buffer of 16-bit signed linear PCM (little-endian) into G.711 μ-law.
 */
export function pcm16ToMuLaw(pcmBuffer: Buffer): Buffer {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const out = Buffer.alloc(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    out[i] = linearSampleToMuLaw(sample);
  }

  return out;
}

/**
 * Converts a Buffer of G.711 μ-law bytes into 16-bit signed linear PCM (little-endian).
 */
export function muLawToPcm16(muLawBuffer: Buffer): Buffer {
  const out = Buffer.alloc(muLawBuffer.length * 2);

  for (let i = 0; i < muLawBuffer.length; i++) {
    const byte = muLawBuffer[i];
    const sample = MULAW_TO_PCM16_TABLE[byte];
    out.writeInt16LE(sample, i * 2);
  }

  return out;
}

/**
 * Generates synthetic silence in either 16-bit PCM or μ-law.
 */
export function generateSilenceAudio(
  durationMs: number,
  format: AudioFormatConfig
): Buffer {
  const sampleCount = Math.floor((durationMs / 1000) * format.sampleRate);
  if (format.encoding === "mulaw") {
    // 0xFF represents digital zero in G.711 μ-law
    const buf = Buffer.alloc(sampleCount);
    buf.fill(0xff);
    return buf;
  }
  // Linear PCM 16-bit silence is all 0x00
  return Buffer.alloc(sampleCount * 2);
}

/**
 * Generates a synthetic test tone (sine wave) for audio streaming verification.
 */
export function generateTestToneAudio(
  frequencyHz: number,
  durationMs: number,
  format: AudioFormatConfig,
  amplitude = 0.25
): Buffer {
  const sampleCount = Math.floor((durationMs / 1000) * format.sampleRate);
  const pcmBuf = Buffer.alloc(sampleCount * 2);
  const maxAmp = 32767 * Math.max(0, Math.min(1, amplitude));

  for (let i = 0; i < sampleCount; i++) {
    const t = i / format.sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * frequencyHz * t) * maxAmp);
    pcmBuf.writeInt16LE(sample, i * 2);
  }

  if (format.encoding === "mulaw") {
    return pcm16ToMuLaw(pcmBuf);
  }
  return pcmBuf;
}

/**
 * Packetizes an audio buffer for Exotel AgentStream outbound media frames.
 *
 * Exotel Invariants:
 * 1. Bidirectional AgentStream requires packets in integer multiples of 320 bytes.
 * 2. Documented packet size bounds: 3,200 bytes (minimum) to 100,000 bytes (maximum).
 * 3. Bounded trailing silence: trailing fragments are merged into the final packet whenever possible
 *    (as long as total <= 100,000 bytes) so unnecessary silence padding is strictly bounded to < 320 bytes (< 20ms).
 * 4. If total audio length < 3,200 bytes, it is padded with silence up to 3,200 bytes to satisfy Exotel's minimum.
 */
export function packetizeAudioForExotel(
  audioBuffer: Buffer,
  format: AudioFormatConfig,
  targetChunkSizeBytes: number = EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES
): Buffer[] {
  if (audioBuffer.length === 0) {
    return [];
  }

  // Ensure targetChunkSizeBytes is bounded between EXOTEL_MIN_PACKET_BYTES (3,200) and EXOTEL_MAX_PACKET_BYTES (99,840)
  const clampedTarget = Math.max(
    EXOTEL_MIN_PACKET_BYTES,
    Math.min(EXOTEL_MAX_PACKET_BYTES, targetChunkSizeBytes)
  );
  // Ensure target is an integer multiple of 320 bytes and strictly <= EXOTEL_MAX_PACKET_BYTES
  const normalizedChunkSize = Math.max(
    EXOTEL_MIN_PACKET_BYTES,
    Math.floor(clampedTarget / EXOTEL_FRAME_GRANULARITY_BYTES) * EXOTEL_FRAME_GRANULARITY_BYTES
  );

  // Case 1: Audio is shorter than minimum packet size (3,200 bytes)
  // Exotel AgentStream strictly requires every bidirectional packet to be >= 3,200 bytes.
  // When total audio is < 3,200 bytes, it must be padded with digital silence up to 3,200 bytes.
  if (audioBuffer.length < EXOTEL_MIN_PACKET_BYTES) {
    const padded = Buffer.alloc(EXOTEL_MIN_PACKET_BYTES);
    if (format.encoding === "mulaw") {
      padded.fill(0xff); // μ-law digital zero
    } else {
      padded.fill(0x00); // 16-bit PCM silence
    }
    audioBuffer.copy(padded, 0);
    return [padded];
  }

  // Case 2: Multi-packet streaming with balanced chunking and bounded trailing silence
  const packets: Buffer[] = [];
  let offset = 0;

  while (offset < audioBuffer.length) {
    const remaining = audioBuffer.length - offset;

    // If remaining audio fits within one chunk (<= normalizedChunkSize)
    if (remaining <= normalizedChunkSize) {
      // Pad only to the next 320-byte boundary (trailing padding strictly < 320 bytes!)
      const targetLen =
        Math.max(
          EXOTEL_MIN_PACKET_BYTES,
          Math.ceil(remaining / EXOTEL_FRAME_GRANULARITY_BYTES) * EXOTEL_FRAME_GRANULARITY_BYTES
        );
      const chunk = Buffer.alloc(targetLen);
      if (format.encoding === "mulaw") {
        chunk.fill(0xff);
      } else {
        chunk.fill(0x00);
      }
      audioBuffer.copy(chunk, 0, offset, audioBuffer.length);
      packets.push(chunk);
      break;
    }

    // When remaining > normalizedChunkSize:
    // Determine chunk size while preventing an orphaned undersized fragment (< 3,200 bytes) in subsequent chunk
    let takeSize = normalizedChunkSize;
    const leftoverAfterChunk = remaining - takeSize;

    // If taking normalizedChunkSize leaves an undersized fragment (< 3,200 bytes) that cannot be merged,
    // rebalance takeSize so the subsequent chunk receives at least EXOTEL_MIN_PACKET_BYTES!
    if (leftoverAfterChunk > 0 && leftoverAfterChunk < EXOTEL_MIN_PACKET_BYTES) {
      if (takeSize - EXOTEL_MIN_PACKET_BYTES >= EXOTEL_MIN_PACKET_BYTES) {
        takeSize -= EXOTEL_MIN_PACKET_BYTES;
      }
    }

    const end = offset + takeSize;
    const chunkSlice = audioBuffer.subarray(offset, end);
    offset = end;

    // Check if the remaining fragment can be merged into this chunk (if <= EXOTEL_MAX_PACKET_BYTES)
    const nextRemaining = audioBuffer.length - offset;
    const targetMergedLen =
      Math.ceil((chunkSlice.length + nextRemaining) / EXOTEL_FRAME_GRANULARITY_BYTES) *
      EXOTEL_FRAME_GRANULARITY_BYTES;

    if (
      nextRemaining > 0 &&
      nextRemaining < EXOTEL_MIN_PACKET_BYTES &&
      targetMergedLen <= EXOTEL_MAX_PACKET_BYTES
    ) {
      // Merge trailing fragment into this chunk and pad only to next 320-byte boundary
      const mergedChunk = Buffer.alloc(targetMergedLen);
      if (format.encoding === "mulaw") {
        mergedChunk.fill(0xff);
      } else {
        mergedChunk.fill(0x00);
      }
      chunkSlice.copy(mergedChunk, 0);
      audioBuffer.copy(mergedChunk, chunkSlice.length, offset, audioBuffer.length);
      packets.push(mergedChunk);
      break;
    } else {
      packets.push(Buffer.from(chunkSlice));
    }
  }

  return packets;
}

/**
 * Streaming audio packet accumulator for Exotel AgentStream.
 * Retains undersized fragments (< 3,200 bytes or unaligned frames) across incoming chunks
 * and combines them with subsequent audio before emitting.
 *
 * Final Flush Policy:
 * When flush(isFinal = true) is called at the end of an audio stream:
 * 1. If buffer is empty: emits nothing.
 * 2. If buffer >= 3,200 bytes: packetizes and emits compliant chunks in [3,200, 99,840],
 *    padding only the tail to the nearest 320-byte boundary (strictly < 320 bytes silence).
 * 3. If buffer < 3,200 bytes: pads the remaining fragment to the required 3,200-byte minimum
 *    to satisfy Exotel's wire requirement.
 */
export class ExotelAudioStreamAccumulator {
  private buffer: Buffer = Buffer.alloc(0);
  private format: AudioFormatConfig;
  private targetChunkSizeBytes: number;

  constructor(
    format: AudioFormatConfig,
    targetChunkSizeBytes: number = EXOTEL_DEFAULT_OUTBOUND_PACKET_BYTES
  ) {
    this.format = format;
    this.targetChunkSizeBytes = targetChunkSizeBytes;
  }

  /**
   * Pushes incoming audio chunk into the accumulator.
   * Emits any full packets that satisfy >= 3,200 bytes and <= 99,840 bytes and % 320 === 0.
   * Retains trailing undersized fragments for subsequent chunks.
   */
  push(chunk: Buffer): Buffer[] {
    if (!chunk || chunk.length === 0) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);

    const emitted: Buffer[] = [];
    const minBytes = EXOTEL_MIN_PACKET_BYTES;
    const maxBytes = EXOTEL_MAX_PACKET_BYTES;
    const targetSize = Math.max(minBytes, Math.min(maxBytes, this.targetChunkSizeBytes));
    const normalizedTarget =
      Math.floor(targetSize / EXOTEL_FRAME_GRANULARITY_BYTES) * EXOTEL_FRAME_GRANULARITY_BYTES;

    // While we have enough data to emit a complete normalizedTarget packet
    while (this.buffer.length >= normalizedTarget) {
      const slice = this.buffer.subarray(0, normalizedTarget);
      this.buffer = Buffer.from(this.buffer.subarray(normalizedTarget));
      emitted.push(Buffer.from(slice));
    }

    return emitted;
  }

  /**
   * Flushes remaining buffered audio using the explicit final flush policy.
   */
  flush(isFinal: boolean = true): Buffer[] {
    if (this.buffer.length === 0) return [];
    if (!isFinal) return [];

    const remaining = this.buffer;
    this.buffer = Buffer.alloc(0);

    return packetizeAudioForExotel(remaining, this.format, this.targetChunkSizeBytes);
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

// ============================================================================
// Azure Speech Neural Voice Mapping
// ============================================================================

export const AZURE_NEURAL_VOICES: Record<SupportedLanguage, { female: string; male: string }> = {
  en: {
    female: "en-IN-NeerjaNeural",
    male: "en-IN-PrabhatNeural",
  },
  hi: {
    female: "hi-IN-SwaraNeural",
    male: "hi-IN-MadhurNeural",
  },
  te: {
    female: "te-IN-ShrutiNeural",
    male: "te-IN-MohanNeural",
  },
};

export const AZURE_LOCALE_CODES: Record<SupportedLanguage, string> = {
  en: "en-IN",
  hi: "hi-IN",
  te: "te-IN",
};

// ============================================================================
// Mock Speech Provider (Deterministic for Testing & Local Harness)
// ============================================================================

export interface MockSpeechProviderOptions {
  defaultLanguage?: SupportedLanguage;
  sttError?: string;
  ttsError?: string;
  transcriptionQueue?: string[];
  transcriptionMap?: Record<string, string>;
  generateSyntheticTone?: boolean;
}

export class MockSpeechProvider implements SpeechProvider {
  public readonly name = "MockSpeechProvider";
  private options: MockSpeechProviderOptions;
  private callLog: Array<{ method: "transcribe" | "synthesize"; text?: string; language?: string }> = [];

  constructor(options: MockSpeechProviderOptions = {}) {
    this.options = { ...options };
  }

  setOptions(options: Partial<MockSpeechProviderOptions>): void {
    this.options = { ...this.options, ...options };
  }

  enqueueTranscription(text: string): void {
    if (!this.options.transcriptionQueue) {
      this.options.transcriptionQueue = [];
    }
    this.options.transcriptionQueue.push(text);
  }

  getCallLog(): Array<{ method: "transcribe" | "synthesize"; text?: string; language?: string }> {
    return [...this.callLog];
  }

  clearCallLog(): void {
    this.callLog = [];
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    options: TranscribeAudioOptions
  ): Promise<TranscribeAudioResult> {
    this.callLog.push({ method: "transcribe", language: options.language });

    if (this.options.sttError) {
      throw new Error(`Mock STT Error: ${this.options.sttError}`);
    }

    let recognizedText = "";
    if (this.options.transcriptionQueue && this.options.transcriptionQueue.length > 0) {
      recognizedText = this.options.transcriptionQueue.shift()!;
    } else {
      // Deterministic fallback based on language
      switch (options.language) {
        case "hi":
          recognizedText = "नमस्ते, मुझे 50 लोगों के लिए कॉफ़ी चाहिए";
          break;
        case "te":
          recognizedText = "నమస్కారం, నాకు 50 మంది కోసం కాఫీ కావాలి";
          break;
        case "en":
        default:
          recognizedText = "Hello, I would like to book for 50 guests";
          break;
      }
    }

    // Determine detected language based on script/keywords
    let detectedLang = options.language;
    if (/[\u0900-\u097F]/.test(recognizedText)) {
      detectedLang = "hi";
    } else if (/[\u0C00-\u0C7F]/.test(recognizedText)) {
      detectedLang = "te";
    }

    const durationMs = Math.round(
      (audioBuffer.length /
        (options.encoding === "mulaw" ? options.sampleRate : options.sampleRate * 2)) *
        1000
    );

    return {
      text: recognizedText,
      detectedLanguage: detectedLang,
      confidence: 0.96,
      durationMs: Math.max(100, durationMs),
    };
  }

  async synthesizeSpeech(
    text: string,
    options: SynthesizeSpeechOptions
  ): Promise<SynthesizeSpeechResult> {
    this.callLog.push({ method: "synthesize", text, language: options.language });

    if (this.options.ttsError) {
      throw new Error(`Mock TTS Error: ${this.options.ttsError}`);
    }

    // Estimate realistic duration: ~150 words per minute => ~400ms per word, minimum 500ms
    const wordCount = Math.max(1, text.split(/\s+/).length);
    const estimatedDurationMs = Math.min(10000, Math.max(500, wordCount * 250));

    const format: AudioFormatConfig = {
      encoding: options.encoding,
      sampleRate: options.sampleRate,
      channels: 1,
    };

    let audioBuffer: Buffer;
    if (this.options.generateSyntheticTone) {
      audioBuffer = generateTestToneAudio(440, estimatedDurationMs, format, 0.15);
    } else {
      audioBuffer = generateSilenceAudio(estimatedDurationMs, format);
    }

    return {
      audioBuffer,
      durationMs: estimatedDurationMs,
      encoding: options.encoding,
      sampleRate: options.sampleRate,
    };
  }
}

// ============================================================================
// Azure Cognitive Services Speech Provider Adapter
// ============================================================================

export interface AzureSpeechConfig {
  subscriptionKey: string;
  region: string;
  timeoutMs?: number;
}

export class AzureSpeechProvider implements SpeechProvider {
  public readonly name = "AzureSpeechProvider";
  private subscriptionKey: string;
  private region: string;
  private timeoutMs: number;

  constructor(config?: Partial<AzureSpeechConfig>) {
    this.subscriptionKey = config?.subscriptionKey || process.env.AZURE_SPEECH_KEY || "";
    this.region = config?.region || process.env.AZURE_SPEECH_REGION || "centralindia";
    this.timeoutMs = config?.timeoutMs || 10000;
  }

  private validateConfig(): void {
    if (!this.subscriptionKey || this.subscriptionKey.trim().length === 0) {
      throw new Error(
        "Azure Speech configuration missing: AZURE_SPEECH_KEY is not defined. Refusing live speech call."
      );
    }
    if (!this.region || this.region.trim().length === 0) {
      throw new Error(
        "Azure Speech configuration missing: AZURE_SPEECH_REGION is not defined."
      );
    }
  }

  /**
   * Escape XML entities for SSML payload.
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Transcribes audio using Azure Speech REST API.
   */
  async transcribeAudio(
    audioBuffer: Buffer,
    options: TranscribeAudioOptions
  ): Promise<TranscribeAudioResult> {
    this.validateConfig();

    const locale = AZURE_LOCALE_CODES[options.language] || "en-IN";
    const url = `https://${this.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${locale}&format=detailed`;

    let contentType = "audio/wav; codecs=audio/pcm; samplerate=8000";
    let body = audioBuffer;

    if (options.encoding === "mulaw") {
      contentType = "audio/wav; codecs=audio/pcm; samplerate=8000";
      // Convert μ-law to Linear PCM 16-bit for Azure STT REST compliance
      body = muLawToPcm16(audioBuffer);
    } else if (options.sampleRate === 16000) {
      contentType = "audio/wav; codecs=audio/pcm; samplerate=16000";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
          "Content-Type": contentType,
          Accept: "application/json",
        },
        body: body as unknown as BodyInit,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Azure STT HTTP ${response.status}: ${errorText.substring(0, 200)}`
        );
      }

      const json = await response.json();
      const recognizedText = json.DisplayText || json.RecognitionStatus === "Success" ? json.DisplayText || "" : "";

      return {
        text: recognizedText,
        detectedLanguage: options.language,
        confidence: json.NBest?.[0]?.Confidence ?? 0.9,
        durationMs: json.Duration ? Math.round(json.Duration / 10000) : 1000,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Synthesizes text into speech audio using Azure Neural Voice SSML.
   */
  async synthesizeSpeech(
    text: string,
    options: SynthesizeSpeechOptions
  ): Promise<SynthesizeSpeechResult> {
    this.validateConfig();

    const locale = AZURE_LOCALE_CODES[options.language] || "en-IN";
    const voiceName =
      options.voiceName ||
      AZURE_NEURAL_VOICES[options.language]?.female ||
      "en-IN-NeerjaNeural";

    const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    let outputFormat = "raw-8khz-16bit-mono-pcm";
    if (options.encoding === "mulaw") {
      outputFormat = "raw-8khz-8bit-mono-mulaw";
    } else if (options.sampleRate === 16000) {
      outputFormat = "raw-16khz-16bit-mono-pcm";
    }

    const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${voiceName}'>${this.escapeXml(text)}</voice></speak>`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.subscriptionKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": outputFormat,
          "User-Agent": "BREW-VoiceBooking/1.0",
        },
        body: ssml,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Azure TTS HTTP ${response.status}: ${errorText.substring(0, 200)}`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      const bytesPerSample = options.encoding === "mulaw" ? 1 : 2;
      const durationMs = Math.round(
        (audioBuffer.length / (options.sampleRate * bytesPerSample)) * 1000
      );

      return {
        audioBuffer,
        durationMs,
        encoding: options.encoding,
        sampleRate: options.sampleRate,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
