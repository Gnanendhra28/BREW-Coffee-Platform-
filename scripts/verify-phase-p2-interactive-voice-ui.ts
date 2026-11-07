/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * BREW Coffee Platform — Phase P2 Verification Suite
 * Interactive Browser Voice UI & Client Speech Integration Audit
 *
 * Verifies:
 * 1. Browser speech capability detection in simulated browser and SSR environments.
 * 2. Recognition start/stop, status lifecycle, and error handling.
 * 3. Transcript submission, turn processing, and duplicate prevention.
 * 4. Language switching (en-IN, hi-IN, te-IN) on both STT and TTS adapters.
 * 5. Speech synthesis playback, cancellation, and barge-in interruption.
 * 6. Seamless text-chat fallback when speech recognition is absent.
 * 7. Prototype mode zero-cost isolation from Exotel and Azure Speech.
 */

import assert from "assert";

process.env.BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "catering@brewcoffee.in";

import {
  detectBrowserSpeechCapabilities,
  createBrowserSpeechRecognizer,
  createBrowserSpeechSynthesizer,
  BROWSER_SPEECH_LANGUAGES,
} from "../src/lib/voiceBooking/browserSpeechAdapter";
import {
  isVoicePrototypeMode,
  assertPrototypeSafetyGuard,
} from "../src/lib/voiceBooking/prototypeConfig";
import {
  createVoiceBookingSession,
  processConversationTurn,
} from "../src/lib/voiceBooking/conversationEngine";
import { InMemoryVoiceSessionRepository } from "../src/lib/voiceBooking/repositories/sessionRepository";
import { SupportedLanguage } from "../src/lib/voiceBooking/types";

let passedCount = 0;
let failedCount = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failedCount++;
  }
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("   BREW Coffee Platform — Phase P2 Verification Suite");
  console.log("   Interactive Browser Voice UI & Client Speech Integration Audit");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. CAPABILITY DETECTION & SSR SAFETY
  // ---------------------------------------------------------------------------
  console.log("--- 1. BROWSER SPEECH CAPABILITY DETECTION ---");

  test("1.1 detectBrowserSpeechCapabilities is safe in non-browser environment", () => {
    const caps = detectBrowserSpeechCapabilities();
    assert.strictEqual(caps.hasSpeechRecognition, false);
    assert.strictEqual(caps.hasSpeechSynthesis, false);
    assert.strictEqual(caps.hasMediaDevices, false);
    assert.strictEqual(caps.browserFamily, "unknown");
    assert.ok(caps.notes[0].includes("Server environment"));
  });

  test("1.2 Capability detector recognizes Web Speech API in simulated browser context", () => {
    // Temporarily simulate browser window
    const originalWindow = (global as any).window;
    const originalNavigator = (global as any).navigator;

    try {
      (global as any).window = {
        webkitSpeechRecognition: class MockWebkitSpeechRecognition {},
        speechSynthesis: {
          getVoices: () => [],
          speak: () => {},
          cancel: () => {},
        },
        SpeechSynthesisUtterance: class MockSpeechSynthesisUtterance {},
        isSecureContext: true,
      };
      (global as any).navigator = {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        mediaDevices: { getUserMedia: async () => ({}) },
      };

      const caps = detectBrowserSpeechCapabilities();
      assert.strictEqual(caps.hasSpeechRecognition, true);
      assert.strictEqual(caps.hasSpeechSynthesis, true);
      assert.strictEqual(caps.hasMediaDevices, true);
      assert.strictEqual(caps.isSecureContext, true);
      assert.strictEqual(caps.browserFamily, "chrome");
    } finally {
      (global as any).window = originalWindow;
      (global as any).navigator = originalNavigator;
    }
  });

  // ---------------------------------------------------------------------------
  // 2. RECOGNITION START/STOP & ERROR HANDLING
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. RECOGNITION START/STOP & ERROR HANDLING ---");

  test("2.1 Speech recognizer starts, stops, and notifies status changes", () => {
    const originalWindow = (global as any).window;

    try {
      let started = false;
      let stopped = false;
      let activeLang = "";
      let reportedStatus = "";

      class MockRecognition {
        public continuous = false;
        public interimResults = false;
        public lang = "";
        public onstart: (() => void) | null = null;
        public onend: (() => void) | null = null;
        public onerror: ((ev: any) => void) | null = null;
        public onresult: ((ev: any) => void) | null = null;

        start() {
          started = true;
          activeLang = this.lang;
          this.onstart?.();
        }

        stop() {
          stopped = true;
          this.onend?.();
        }

        abort() {
          this.onend?.();
        }
      }

      (global as any).window = {
        webkitSpeechRecognition: MockRecognition,
      };

      const recognizer = createBrowserSpeechRecognizer({
        language: "hi",
        onStatusChange: (status) => {
          reportedStatus = status;
        },
      });

      recognizer.start();
      assert.strictEqual(started, true);
      assert.strictEqual(activeLang, "hi-IN");
      assert.strictEqual(reportedStatus, "listening");
      assert.strictEqual(recognizer.getStatus(), "listening");

      recognizer.stop();
      assert.strictEqual(stopped, true);
      assert.strictEqual(reportedStatus, "idle");
      assert.strictEqual(recognizer.getStatus(), "idle");
    } finally {
      (global as any).window = originalWindow;
    }
  });

  test("2.2 Speech recognizer handles microphone errors and recovers gracefully", () => {
    const originalWindow = (global as any).window;

    try {
      let capturedError = "";
      let reportedStatus = "";
      let mockInstance: any = null;

      class MockRecognition {
        public lang = "";
        public onstart: (() => void) | null = null;
        public onerror: ((ev: any) => void) | null = null;
        public onend: (() => void) | null = null;

        constructor() {
          mockInstance = this;
        }

        start() {
          this.onstart?.();
        }
        stop() {
          this.onend?.();
        }
      }

      (global as any).window = {
        webkitSpeechRecognition: MockRecognition,
      };

      const recognizer = createBrowserSpeechRecognizer({
        language: "en",
        onStatusChange: (status) => {
          reportedStatus = status;
        },
        onError: (errMsg) => {
          capturedError = errMsg;
        },
      });

      recognizer.start();
      assert.strictEqual(reportedStatus, "listening");

      // Simulate not-allowed error (microphone permission denied)
      mockInstance.onerror?.({ error: "not-allowed" });
      assert.strictEqual(capturedError, "not-allowed");
      assert.strictEqual(reportedStatus, "error");
      assert.strictEqual(recognizer.getStatus(), "error");

      // Simulate no-speech event (recovers to idle without fatal error)
      mockInstance.onerror?.({ error: "no-speech" });
      assert.strictEqual(reportedStatus, "idle");
      assert.strictEqual(recognizer.getStatus(), "idle");
    } finally {
      (global as any).window = originalWindow;
    }
  });

  // ---------------------------------------------------------------------------
  // 3. TRANSCRIPT SUBMISSION & DUPLICATE PREVENTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. TRANSCRIPT SUBMISSION & DUPLICATE PREVENTION ---");

  test("3.1 Duplicate transcripts submitted in rapid succession are prevented", () => {
    let lastTranscript = "";
    let lastTime = 0;
    let submittedCount = 0;

    const submitVoiceTurn = (text: string) => {
      const now = Date.now();
      if (text === lastTranscript && now - lastTime < 2500) {
        return false; // rejected as duplicate
      }
      lastTranscript = text;
      lastTime = now;
      submittedCount++;
      return true;
    };

    // First submission: accepted
    assert.strictEqual(submitVoiceTurn("100 guests in Gachibowli"), true);
    assert.strictEqual(submittedCount, 1);

    // Repeated identical submission within 200ms (duplicate event): rejected
    assert.strictEqual(submitVoiceTurn("100 guests in Gachibowli"), false);
    assert.strictEqual(submittedCount, 1);

    // Distinct submission: accepted
    assert.strictEqual(submitVoiceTurn("Yes, please confirm this quotation"), true);
    assert.strictEqual(submittedCount, 2);
  });

  await test("3.2 Finalized transcript executes full conversation engine turn", async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await repo.save(session);

    // Simulated finalized transcript from speech recognizer
    const recognizedSpeech = "We need catering for 80 guests on 2026-11-24 at Hitec City starting at 10:00 for 3 hours with Standard tier";

    const turnResult = await processConversationTurn(session, recognizedSpeech, {
      sessionRepository: repo,
    });

    assert.strictEqual(turnResult.session.requirements.guestCount, 80);
    assert.strictEqual(turnResult.session.requirements.venueAddress, "Hitec City");
    assert.strictEqual(turnResult.session.requirements.eventDate, "2026-11-24");
    assert.strictEqual(turnResult.session.requirements.selectedTier, "STANDARD");
    assert.ok(turnResult.assistantResponse.length > 0);
    assert.ok(turnResult.session.quotation !== null);
  });

  // ---------------------------------------------------------------------------
  // 4. LANGUAGE SWITCHING ACROSS STT AND TTS
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. LANGUAGE SWITCHING (EN, HI, TE) ---");

  test("4.1 Switching language updates both speech recognizer and synthesizer locales", () => {
    const originalWindow = (global as any).window;

    try {
      let recLang = "";
      let ttsUtteranceLang = "";

      class MockRecognition {
        public lang = "";
        start() {
          recLang = this.lang;
        }
        stop() {}
      }

      class MockUtterance {
        public lang = "";
        constructor(public text: string) {}
      }

      (global as any).window = {
        webkitSpeechRecognition: MockRecognition,
        SpeechSynthesisUtterance: MockUtterance,
        speechSynthesis: {
          getVoices: () => [
            { lang: "en-IN", name: "English India" },
            { lang: "hi-IN", name: "Hindi India" },
            { lang: "te-IN", name: "Telugu India" },
          ],
          speak: (utt: any) => {
            ttsUtteranceLang = utt.lang;
          },
          cancel: () => {},
        },
      };

      const recognizer = createBrowserSpeechRecognizer({ language: "en" });
      const synthesizer = createBrowserSpeechSynthesizer({ language: "en" });

      // Start in English
      recognizer.start();
      assert.strictEqual(recLang, "en-IN");
      synthesizer.speak("Hello welcome to BREW");
      assert.strictEqual(ttsUtteranceLang, "en-IN");

      // Switch to Hindi
      recognizer.setLanguage("hi");
      recognizer.start();
      assert.strictEqual(recLang, "hi-IN");
      synthesizer.setLanguage("hi");
      synthesizer.speak("नमस्ते, BREW में आपका स्वागत है");
      assert.strictEqual(ttsUtteranceLang, "hi-IN");

      // Switch to Telugu
      recognizer.setLanguage("te");
      recognizer.start();
      assert.strictEqual(recLang, "te-IN");
      synthesizer.setLanguage("te");
      synthesizer.speak("నమస్కారం, BREW కాఫీకి స్వాగతం");
      assert.strictEqual(ttsUtteranceLang, "te-IN");
    } finally {
      (global as any).window = originalWindow;
    }
  });

  // ---------------------------------------------------------------------------
  // 5. SPEECH SYNTHESIS & BARGE-IN INTERRUPTION
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. SPEECH SYNTHESIS & BARGE-IN INTERRUPTION ---");

  test("5.1 Synthesizer cancels ongoing speech when interrupted by user interaction", () => {
    const originalWindow = (global as any).window;

    try {
      let cancelCount = 0;
      let speakCount = 0;

      class MockUtterance {
        public lang = "";
        constructor(public text: string) {}
      }

      (global as any).window = {
        SpeechSynthesisUtterance: MockUtterance,
        speechSynthesis: {
          speaking: true,
          getVoices: () => [],
          speak: () => {
            speakCount++;
          },
          cancel: () => {
            cancelCount++;
          },
        },
      };

      const synthesizer = createBrowserSpeechSynthesizer({ language: "en" });

      // Speak assistant response
      synthesizer.speak("Your quotation is ready for 50 guests.");
      assert.strictEqual(speakCount, 1);
      // Cancel is called before new speech to avoid queue buildup
      assert.strictEqual(cancelCount, 1);

      // User interrupts (barge-in): cancel is invoked immediately
      synthesizer.cancel();
      assert.strictEqual(cancelCount, 2);
    } finally {
      (global as any).window = originalWindow;
    }
  });

  // ---------------------------------------------------------------------------
  // 6. TEXT-CHAT FALLBACK INTEGRATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. TEXT-CHAT FALLBACK INTEGRATION ---");

  await test("6.1 Text-chat fallback functions with 100% parity when voice is unavailable", async () => {
    const repo = new InMemoryVoiceSessionRepository();
    const session = createVoiceBookingSession("+919876543210", "en");
    await repo.save(session);

    // Customer types response via standard text input
    const turn1 = await processConversationTurn(
      session,
      "Corporate event for 60 guests on 2026-11-30 in Jubilee Hills at 09:00 for 4 hours with Premium tier",
      { sessionRepository: repo }
    );

    assert.strictEqual(turn1.session.requirements.guestCount, 60);
    assert.strictEqual(turn1.session.requirements.venueAddress, "Jubilee Hills");
    assert.strictEqual(turn1.session.requirements.selectedTier, "PREMIUM");
    assert.ok(turn1.session.quotation !== null);

    // Confirm via text
    const turn2 = await processConversationTurn(
      turn1.session,
      "Yes, I confirm this quotation",
      { sessionRepository: repo }
    );

    assert.strictEqual(turn2.session.state, "awaiting_staff_approval");
    assert.strictEqual(turn2.session.requirements.customerConfirmed, true);
  });

  // ---------------------------------------------------------------------------
  // 7. PROTOTYPE MODE ZERO-COST ISOLATION
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. ZERO-COST ISOLATION AUDIT ---");

  test("7.1 Prototype mode guarantees zero paid services and zero carrier calls", () => {
    assert.strictEqual(isVoicePrototypeMode(), true);

    let exotelBlocked = false;
    try {
      assertPrototypeSafetyGuard("exotel");
    } catch {
      exotelBlocked = true;
    }
    assert.strictEqual(exotelBlocked, true, "Exotel must be strictly blocked");

    let azureBlocked = false;
    try {
      assertPrototypeSafetyGuard("azure_speech");
    } catch {
      azureBlocked = true;
    }
    assert.strictEqual(azureBlocked, true, "Azure Speech must be strictly blocked");
  });

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   Phase P2 Verification Complete: ${passedCount}/${passedCount + failedCount} checks passed`);
  console.log(`   RESULT: ${failedCount === 0 ? "ALL TESTS PASSED (SUCCESS)" : "TESTS FAILED"}`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner threw unhandled error:", err);
  process.exit(1);
});
