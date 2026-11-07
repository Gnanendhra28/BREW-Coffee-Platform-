/**
 * BREW Coffee Platform — Phase P1 Browser Speech Adapter Foundation
 *
 * Implements a browser-native Web Speech API adapter for client-side Speech-to-Text (STT)
 * and Speech Synthesis (TTS). Enables zero-cost voice interaction directly inside the browser
 * without calling paid cloud speech services (Azure Speech) or carrier telephony (Exotel).
 *
 * ARCHITECTURAL SPECIFICATION:
 * 1. Web Speech API STT: Utilizes window.SpeechRecognition or window.webkitSpeechRecognition.
 * 2. Web Speech API TTS: Utilizes window.speechSynthesis and window.SpeechSynthesisUtterance.
 * 3. Multilingual Support: Configures locale mapping for English (en-IN), Hindi (hi-IN), and Telugu (te-IN).
 * 4. Graceful Fallbacks: Detects browser capabilities, handles microphone permissions,
 *    and provides clear compatibility status across Chrome, Safari, Edge, and Firefox.
 * 5. Server/Client Safety: All window/navigator accesses are guarded with typeof checks.
 */

import { SupportedLanguage } from "./types";
import { SafeCustomerVoiceSessionView } from "../communication/visibility";

// ============================================================================
// Types and Contracts
// ============================================================================

export interface BrowserSpeechLanguageConfig {
  sttLocale: string;
  ttsLocales: string[];
  label: string;
  scriptName: string;
}

export const BROWSER_SPEECH_LANGUAGES: Record<SupportedLanguage, BrowserSpeechLanguageConfig> = {
  en: {
    sttLocale: "en-IN",
    ttsLocales: ["en-IN", "en-GB", "en-US"],
    label: "English (India)",
    scriptName: "Latin",
  },
  hi: {
    sttLocale: "hi-IN",
    ttsLocales: ["hi-IN", "hi"],
    label: "Hindi (हिंदी)",
    scriptName: "Devanagari",
  },
  te: {
    sttLocale: "te-IN",
    ttsLocales: ["te-IN", "te"],
    label: "Telugu (తెలుగు)",
    scriptName: "Telugu",
  },
};

export type BrowserSpeechRecognitionStatus =
  | "idle"
  | "listening"
  | "processing"
  | "error"
  | "unsupported";

export interface BrowserSpeechCapabilities {
  hasSpeechRecognition: boolean;
  hasSpeechSynthesis: boolean;
  hasMediaDevices: boolean;
  isSecureContext: boolean;
  browserFamily: "chrome" | "safari" | "firefox" | "edge" | "unknown";
  supportedLanguages: SupportedLanguage[];
  notes: string[];
}

export type MicrophonePermissionState = "granted" | "denied" | "prompt" | "unsupported";

export interface BrowserSpeechRecognizerOptions {
  language: SupportedLanguage;
  continuous?: boolean;
  interimResults?: boolean;
  onStatusChange?: (status: BrowserSpeechRecognitionStatus) => void;
  onTranscript?: (transcript: string, isFinal: boolean) => void;
  onError?: (errorMessage: string, errorCode?: string) => void;
  onEnd?: () => void;
}

export interface BrowserSpeechSynthesizerOptions {
  language: SupportedLanguage;
  rate?: number; // 0.8 to 1.1 recommended
  pitch?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: unknown) => void;
}

// ============================================================================
// Capability Detection
// ============================================================================

/**
 * Inspects browser-native Web Speech API support and environment permissions.
 * Safe to execute on both server (returns unsupported) and browser.
 */
export function detectBrowserSpeechCapabilities(): BrowserSpeechCapabilities {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      hasSpeechRecognition: false,
      hasSpeechSynthesis: false,
      hasMediaDevices: false,
      isSecureContext: false,
      browserFamily: "unknown",
      supportedLanguages: [],
      notes: ["Server environment: Web Speech API is not available."],
    };
  }

  // Detect Speech Recognition API
  const hasRecognition = Boolean(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );

  // Detect Speech Synthesis API
  const hasSynthesis = Boolean(
    "speechSynthesis" in window && "SpeechSynthesisUtterance" in window
  );

  // Detect Media Devices
  const hasMediaDevices = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // Detect Secure Context (required for getUserMedia in modern browsers)
  const isSecure = typeof window.isSecureContext === "boolean" ? window.isSecureContext : true;

  // Detect Browser Family
  const userAgent = navigator.userAgent.toLowerCase();
  let family: "chrome" | "safari" | "firefox" | "edge" | "unknown" = "unknown";
  if (userAgent.includes("edg/")) {
    family = "edge";
  } else if (userAgent.includes("chrome") && !userAgent.includes("edg")) {
    family = "chrome";
  } else if (userAgent.includes("safari") && !userAgent.includes("chrome")) {
    family = "safari";
  } else if (userAgent.includes("firefox")) {
    family = "firefox";
  }

  const notes: string[] = [];
  const supportedLanguages: SupportedLanguage[] = ["en", "hi", "te"];

  if (!hasRecognition) {
    if (family === "firefox") {
      notes.push("Firefox requires 'media.webspeech.recognition.enable' in about:config.");
    } else {
      notes.push("SpeechRecognition is not supported in this browser; text fallback available.");
    }
  }

  if (family === "safari") {
    notes.push("Safari on iOS requires a user tap/gesture to start audio recognition.");
    notes.push("Telugu (te-IN) speech synthesis voice depends on installed iOS voices.");
  }

  if (!isSecure && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    notes.push("Microphone access requires HTTPS in production.");
  }

  return {
    hasSpeechRecognition: hasRecognition,
    hasSpeechSynthesis: hasSynthesis,
    hasMediaDevices,
    isSecureContext: isSecure,
    browserFamily: family,
    supportedLanguages,
    notes,
  };
}

/**
 * Checks microphone permission state if navigator.permissions is available.
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionState> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unsupported";
  }

  try {
    if (navigator.permissions && navigator.permissions.query) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const permission = await navigator.permissions.query({ name: "microphone" as any });
      return permission.state as MicrophonePermissionState;
    }
  } catch {
    // Some browsers throw on permission query for microphone
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return "unsupported";
  }

  return "prompt";
}

/**
 * Requests microphone permission via navigator.mediaDevices.getUserMedia.
 * Safely releases audio tracks immediately after permission check.
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop tracks immediately so mic indicator does not linger
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Speech Recognition Controller
// ============================================================================

export interface BrowserSpeechRecognizer {
  start(): void;
  stop(): void;
  abort(): void;
  setLanguage(lang: SupportedLanguage): void;
  getStatus(): BrowserSpeechRecognitionStatus;
}

/**
 * Factory for browser-native speech recognition controller.
 */
export function createBrowserSpeechRecognizer(
  options: BrowserSpeechRecognizerOptions
): BrowserSpeechRecognizer {
  let status: BrowserSpeechRecognitionStatus = "idle";
  let activeLanguage = options.language;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recognitionInstance: any = null;

  const updateStatus = (newStatus: BrowserSpeechRecognitionStatus) => {
    status = newStatus;
    options.onStatusChange?.(newStatus);
  };

  const initRecognition = () => {
    if (typeof window === "undefined") {
      updateStatus("unsupported");
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      updateStatus("unsupported");
      return null;
    }

    try {
      const rec = new SpeechRecognitionClass();
      rec.continuous = options.continuous ?? false;
      rec.interimResults = options.interimResults ?? true;
      rec.lang = BROWSER_SPEECH_LANGUAGES[activeLanguage].sttLocale;

      rec.onstart = () => {
        updateStatus("listening");
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (event: any) => {
        let finalTranscript = "";
        let interimTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcriptChunk = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcriptChunk;
          } else {
            interimTranscript += transcriptChunk;
          }
        }

        if (finalTranscript.trim()) {
          options.onTranscript?.(finalTranscript.trim(), true);
        } else if (interimTranscript.trim()) {
          options.onTranscript?.(interimTranscript.trim(), false);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (event: any) => {
        const errorMsg = event.error || "Speech recognition error";
        if (event.error !== "no-speech" && event.error !== "aborted") {
          updateStatus("error");
          options.onError?.(errorMsg, event.error);
        } else {
          updateStatus("idle");
        }
      };

      rec.onend = () => {
        if (status === "listening") {
          updateStatus("idle");
        }
        options.onEnd?.();
      };

      return rec;
    } catch (err) {
      updateStatus("error");
      options.onError?.("Failed to initialize speech recognition", String(err));
      return null;
    }
  };

  return {
    start() {
      if (!recognitionInstance) {
        recognitionInstance = initRecognition();
      }
      if (!recognitionInstance) {
        options.onError?.("Speech recognition not supported in this browser", "unsupported");
        return;
      }

      try {
        recognitionInstance.lang = BROWSER_SPEECH_LANGUAGES[activeLanguage].sttLocale;
        recognitionInstance.start();
      } catch (err) {
        // Recognition may already be started
        console.warn("SpeechRecognition start warning:", err);
      }
    },
    stop() {
      if (recognitionInstance) {
        try {
          recognitionInstance.stop();
        } catch {
          // ignore
        }
        updateStatus("idle");
      }
    },
    abort() {
      if (recognitionInstance) {
        try {
          recognitionInstance.abort();
        } catch {
          // ignore
        }
        updateStatus("idle");
      }
    },
    setLanguage(lang: SupportedLanguage) {
      activeLanguage = lang;
      if (recognitionInstance) {
        recognitionInstance.lang = BROWSER_SPEECH_LANGUAGES[lang].sttLocale;
      }
    },
    getStatus() {
      return status;
    },
  };
}

// ============================================================================
// Speech Synthesis Controller
// ============================================================================

export interface BrowserSpeechSynthesizer {
  speak(text: string, optionsOverride?: Partial<BrowserSpeechSynthesizerOptions>): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  isSpeaking(): boolean;
  setLanguage(lang: SupportedLanguage): void;
}

/**
 * Selects the best available natural voice matching target locales.
 */
function findBestVoice(
  voices: SpeechSynthesisVoice[],
  targetLocales: string[]
): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;

  // 1. Exact match on primary locale (e.g. "en-IN")
  for (const locale of targetLocales) {
    const exact = voices.find(
      (v) => v.lang.toLowerCase().replace("_", "-") === locale.toLowerCase()
    );
    if (exact) return exact;
  }

  // 2. Prefix match (e.g. startsWith "hi" or "te" or "en")
  for (const locale of targetLocales) {
    const prefix = locale.split("-")[0].toLowerCase();
    const prefixMatch = voices.find((v) =>
      v.lang.toLowerCase().replace("_", "-").startsWith(prefix)
    );
    if (prefixMatch) return prefixMatch;
  }

  // 3. Fallback to default voice
  return voices.find((v) => v.default) || voices[0] || null;
}

/**
 * Factory for browser-native speech synthesis controller.
 */
export function createBrowserSpeechSynthesizer(
  options: BrowserSpeechSynthesizerOptions
): BrowserSpeechSynthesizer {
  let activeLanguage = options.language;
  let cachedVoices: SpeechSynthesisVoice[] = [];
  let activeUtterance: SpeechSynthesisUtterance | null = null;

  const loadVoices = () => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      cachedVoices = window.speechSynthesis.getVoices();
    }
  };

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  return {
    speak(text: string, optionsOverride?: Partial<BrowserSpeechSynthesizerOptions>) {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        return;
      }

      const cleanText = text.trim();
      if (!cleanText) return;

      // Cancel any ongoing utterance to avoid queue buildup
      window.speechSynthesis.cancel();

      const langConfig = BROWSER_SPEECH_LANGUAGES[optionsOverride?.language || activeLanguage];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const UtteranceClass = (window as any).SpeechSynthesisUtterance;
      if (!UtteranceClass) return;
      const utterance = new UtteranceClass(cleanText);

      // Refresh voice list if empty
      if (cachedVoices.length === 0) {
        cachedVoices = window.speechSynthesis.getVoices();
      }

      const voice = findBestVoice(cachedVoices, langConfig.ttsLocales);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = langConfig.sttLocale;
      }

      utterance.rate = optionsOverride?.rate ?? options.rate ?? 0.95;
      utterance.pitch = optionsOverride?.pitch ?? options.pitch ?? 1.0;
      utterance.volume = optionsOverride?.volume ?? options.volume ?? 1.0;

      utterance.onstart = () => {
        options.onStart?.();
      };

      utterance.onend = () => {
        activeUtterance = null;
        options.onEnd?.();
      };

      utterance.onerror = (err: unknown) => {
        activeUtterance = null;
        options.onError?.(err);
      };

      activeUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    },
    cancel() {
      activeUtterance = null;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    pause() {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.pause();
      }
    },
    resume() {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.resume();
      }
    },
    isSpeaking() {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        return false;
      }
      return window.speechSynthesis.speaking || Boolean(activeUtterance);
    },
    setLanguage(lang: SupportedLanguage) {
      activeLanguage = lang;
    },
  };
}

// ============================================================================
// Turn Client Adapter
// ============================================================================

export interface BrowserVoiceTurnResponse {
  success: boolean;
  assistantResponse?: string;
  session?: SafeCustomerVoiceSessionView;
  error?: string;
}

/**
 * Dispatches a recognized customer speech turn to the backend conversation engine
 * via /api/voice-booking/chat.
 */
export async function sendBrowserVoiceTurn(params: {
  sessionId: string;
  transcript: string;
  turnIndex?: number;
}): Promise<BrowserVoiceTurnResponse> {
  const { sessionId, transcript, turnIndex } = params;

  try {
    const res = await fetch("/api/voice-booking/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        message: transcript,
        turnIndex,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Request failed with HTTP ${res.status}`,
      };
    }

    return {
      success: true,
      assistantResponse: data.assistantResponse,
      session: data.session,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error contacting voice booking service",
    };
  }
}
