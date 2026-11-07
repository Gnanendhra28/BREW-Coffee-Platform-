/**
 * BREW Coffee Platform — Phase P1 Voice Prototype Configuration
 *
 * Establishes a zero-cost, browser-accessible AI voice-booking prototype foundation.
 * Enables fully functional end-to-end voice booking testing without real telephone calls
 * or paid external provider dependencies.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Zero External Telephony: Outbound PSTN/Exotel API dispatch is strictly disabled.
 * 2. Zero Paid Cloud Services: Azure Cognitive Services and paid carrier minutes are NEVER invoked.
 * 3. Browser-Native Execution: Speech Recognition and Synthesis run in-browser via Web Speech API at $0.00 cost.
 * 4. Production Adapter Preservation: Exotel and Azure production adapters remain intact for future live deployment.
 * 5. Booking & Staff Approval Integrity: Quotations are deterministic; barista approval remains mandatory.
 */

export type VoiceOperatingMode = "prototype" | "production";

export interface VoicePrototypeConfig {
  mode: VoiceOperatingMode;
  isPrototype: boolean;
  allowSimulatedOutbound: boolean;
  browserSpeechEnabled: boolean;
  mockSpeechEnabled: boolean;
  externalCarrierCallsDisabled: boolean;
  externalAzureSpeechDisabled: boolean;
  zeroCostGuaranteed: boolean;
}

/**
 * Determines whether the voice booking system is operating in zero-cost prototype mode.
 * Safe for both server and browser environments.
 *
 * Rules:
 * - If VOICE_PROTOTYPE_MODE is explicitly set to "true" or "1" -> prototype mode.
 * - If running in browser and NEXT_PUBLIC_VOICE_PROTOTYPE_MODE !== "false" -> prototype mode.
 * - If real voice booking (VOICE_BOOKING_ENABLED) is NOT explicitly enabled -> defaults to prototype mode.
 */
export function isVoicePrototypeMode(): boolean {
  if (typeof window !== "undefined") {
    const clientVal = process.env.NEXT_PUBLIC_VOICE_PROTOTYPE_MODE;
    if (clientVal !== undefined) {
      return clientVal.trim().toLowerCase() !== "false";
    }
    // Default to true in browser prototype
    return true;
  }

  const prototypeEnv = process.env.VOICE_PROTOTYPE_MODE;
  if (prototypeEnv !== undefined) {
    const normalized = prototypeEnv.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }

  // Safe default: If real outbound dialing is disabled, system operates in prototype mode
  const realVoiceEnabled = process.env.VOICE_BOOKING_ENABLED;
  if (!realVoiceEnabled) return true;
  const normalizedReal = realVoiceEnabled.trim().toLowerCase();
  const isReal = normalizedReal === "true" || normalizedReal === "1";
  return !isReal;
}

/**
 * Returns current voice operating mode: "prototype" or "production".
 */
export function getVoiceOperatingMode(): VoiceOperatingMode {
  return isVoicePrototypeMode() ? "prototype" : "production";
}

/**
 * Returns the active prototype configuration settings and safety guarantees.
 */
export function getVoicePrototypeConfig(): VoicePrototypeConfig {
  const isPrototype = isVoicePrototypeMode();

  return {
    mode: isPrototype ? "prototype" : "production",
    isPrototype,
    allowSimulatedOutbound: isPrototype,
    browserSpeechEnabled: true,
    mockSpeechEnabled: isPrototype,
    externalCarrierCallsDisabled: isPrototype,
    externalAzureSpeechDisabled: isPrototype,
    zeroCostGuaranteed: isPrototype,
  };
}

/**
 * Safety assertion: Throws an error if any code attempts to invoke paid external services
 * while operating in prototype mode.
 */
export function assertPrototypeSafetyGuard(serviceName: "exotel" | "azure_speech"): void {
  if (isVoicePrototypeMode()) {
    throw new Error(
      `Safety violation: Attempted to invoke paid service '${serviceName}' while operating in zero-cost Prototype Mode. External telephony and paid speech services are strictly prohibited in prototype mode.`
    );
  }
}
