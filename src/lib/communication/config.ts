/**
 * BREW Coffee Platform — Phase 6.1 Communication Feature Flags & Config
 * Strictly server-side configuration. Never exposed to browser bundles.
 */

if (typeof window !== "undefined") {
  throw new Error("Security violation: Communication config cannot be imported in browser context.");
}

/**
 * Checks whether the Voice Booking and automated outbound communication subsystem is enabled.
 * Defaults to FALSE if the environment variable is unset, empty, or any value other than 'true' or '1'.
 */
export function isVoiceBookingEnabled(): boolean {
  const envVal = process.env.VOICE_BOOKING_ENABLED;
  if (!envVal) return false;
  const normalized = envVal.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * Masks a normalized phone number for safe diagnostic logging without leaking PII.
 * Example: +919876543210 -> +91******3210
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || phone.length < 8) return "[MASKED]";
  const start = phone.slice(0, 3);
  const end = phone.slice(-4);
  return `${start}******${end}`;
}
