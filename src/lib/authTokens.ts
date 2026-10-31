// Secure Web Crypto-based Session Token Generator and Verifier
// Compatible with Next.js Edge Middleware, Server Components, Route Handlers, and Client.

export type UserRole = "customer" | "barista" | "fleet_admin";

export interface SessionPayload {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  issuedAt: number;
  expiresAt: number;
  sid?: string; // Unique Session ID for durable cross-instance revocation
}

function getAuthSecret(): string {
  if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET) {
    throw new Error("[SECURITY CRITICAL] AUTH_SECRET environment variable is strictly required in production!");
  }
  return process.env.AUTH_SECRET || "brew-platform-secure-jwt-hmac-secret-key-2026";
}

export function getStaffPins(): { baristaPin: string; fleetAdminPin: string } {
  const isProd =
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LOCAL_FALLBACK !== "true" &&
    process.env.BREW_TEST_SUITE !== "true" &&
    process.env.PLAYWRIGHT_TEST !== "true";

  const barista = process.env.BARISTA_PIN;
  const fleetAdmin = process.env.FLEET_ADMIN_PIN;

  if (isProd) {
    // In production, development PINs ('2026', '7788') are strictly prohibited
    const safeBarista = barista && barista !== "2026" ? barista : "";
    const safeFleetAdmin = fleetAdmin && fleetAdmin !== "7788" ? fleetAdmin : "";

    if (barista === "2026" || fleetAdmin === "7788" || !barista || !fleetAdmin) {
      console.error(
        "[SECURITY CRITICAL] Staff PINs not configured or using prohibited development defaults in production! " +
        "Staff authentication requires rotated BARISTA_PIN and FLEET_ADMIN_PIN environment variables."
      );
    }
    return {
      baristaPin: safeBarista,
      fleetAdminPin: safeFleetAdmin,
    };
  }

  return {
    baristaPin: barista || "2026",
    fleetAdminPin: fleetAdmin || "7788",
  };
}

/**
 * Constant-time PIN comparison across all runtimes (Edge, Node, Browser)
 * to prevent timing-attack side channels.
 */
export function verifyStaffPin(submittedPin: string, expectedPin: string): boolean {
  if (!submittedPin || !expectedPin) return false;
  if (submittedPin.length !== expectedPin.length) return false;
  let mismatch = 0;
  for (let i = 0; i < submittedPin.length; i++) {
    mismatch |= submittedPin.charCodeAt(i) ^ expectedPin.charCodeAt(i);
  }
  return mismatch === 0;
}

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function getHmacKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(getAuthSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function base64UrlEncode(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64url");
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "base64url").toString("utf8");
  }
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

export async function createSessionToken(
  user: {
    uid: string;
    email: string | null;
    displayName: string | null;
    role?: UserRole;
    sid?: string;
  }
): Promise<string> {
  const sid =
    user.sid ||
    `sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 6)}`;

  const payload: SessionPayload = {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: user.role || "customer",
    issuedAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    sid,
  };

  const payloadStr = JSON.stringify(payload);
  const encodedPayload = base64UrlEncode(payloadStr);

  const key = await getHmacKey();
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload)
  );

  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const signatureBinary = String.fromCharCode(...signatureArray);
  const encodedSignature = base64UrlEncode(signatureBinary);

  return `${encodedPayload}.${encodedSignature}`;
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    if (!token || !token.includes(".")) return null;
    const [encodedPayload, encodedSignature] = token.split(".");
    if (!encodedPayload || !encodedSignature) return null;

    const key = await getHmacKey();
    const signatureBinary = base64UrlDecode(encodedSignature);
    const signatureBytes = new Uint8Array(
      signatureBinary.split("").map((c) => c.charCodeAt(0))
    );

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(encodedPayload)
    );

    if (!isValid) return null;

    const payloadStr = base64UrlDecode(encodedPayload);
    const payload = JSON.parse(payloadStr) as SessionPayload;

    if (Date.now() > payload.expiresAt) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}
