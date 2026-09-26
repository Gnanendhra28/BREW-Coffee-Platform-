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
}

const AUTH_SECRET = process.env.AUTH_SECRET || "brew-platform-secure-jwt-hmac-secret-key-2026";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function getHmacKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(AUTH_SECRET),
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
  }
): Promise<string> {
  const payload: SessionPayload = {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    role: user.role || "customer",
    issuedAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
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
