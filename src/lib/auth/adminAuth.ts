/**
 * BREW Coffee Platform — Phase 6.2.3 Server-Side Staff Authorization Boundary
 *
 * ARCHITECTURAL SPECIFICATION & SECURITY CONTRACT:
 * 1. Distinction Between HTTP Authentication and Domain Invariants:
 *    - Domain Level (`approveBookingByStaff`): Validates that a structurally complete,
 *      well-formed `StaffAuthorizationContext` with an authorized role is present.
 *    - Server Boundary Level (`adminAuth.ts`): Authenticates the incoming request against
 *      the authoritative server-side session store (`brew_session` cookie / HMAC-SHA256 token),
 *      verifies revocation status, and DERIVES the `StaffAuthorizationContext` directly from
 *      the verified cryptographic token payload.
 *
 * 2. Resistance to Client-Side Forgery:
 *    - An untrusted client can NEVER supply their own role (e.g. `staffRole: "admin"`)
 *      or arbitrary `staffIdentity` in request bodies.
 *    - The server extracts and verifies the session token using `verifySessionToken()`
 *      and durable revocation checks (`isSessionRevoked()`), then binds the authenticated
 *      `uid` as `staffIdentity` and verified session role as `staffRole`.
 *    - Only the audit trail identifier (`staffApprovalId`) may be accepted as an event
 *      correlation key, but it is strictly validated and separated from authentication.
 */

import crypto from "crypto";
import { NextRequest } from "next/server";
import { verifySessionToken } from "../authTokens";
import { isSessionRevoked } from "../sessionRevocation";
import {
  StaffAuthorizationContext,
  StaffRejectionAuthorizationContext,
  VoiceBookingSession,
  VoiceSessionRepository,
} from "../voiceBooking/types";
import {
  StaffAuthorizationContextSchema,
  StaffRejectionAuthorizationContextSchema,
} from "../voiceBooking/schemas";
import {
  approveBookingByStaff,
  rejectBookingByStaff,
  getVoiceSessionRepository,
} from "../voiceBooking/conversationEngine";

export interface VerifiedStaffSession {
  uid: string;
  role: "barista" | "fleet_admin" | "admin";
  email: string | null;
  displayName: string | null;
  sid: string;
}

export type StaffAuthInspectionResult =
  | {
      ok: true;
      session: VerifiedStaffSession;
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      code:
        | "MISSING_SESSION"
        | "INVALID_SESSION"
        | "EXPIRED_SESSION"
        | "REVOKED_SESSION"
        | "MISSING_SID"
        | "UNAUTHORIZED_ROLE";
    };

const AUTHORIZED_STAFF_ROLES = new Set(["barista", "fleet_admin", "admin"]);

/**
 * Extracts, cryptographically verifies, and inspects staff session token status.
 * Accurately differentiates HTTP 401 (missing, expired, revoked, invalid) from HTTP 403 (customer or unauthorized role).
 * Unconditionally checks session revocation on every privileged session without skip bypasses.
 */
export async function inspectStaffSession(
  tokenOrRequest:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } }
): Promise<StaffAuthInspectionResult> {
  let token: string | undefined;

  if (typeof tokenOrRequest === "string") {
    token = tokenOrRequest;
  } else if (tokenOrRequest && "cookies" in tokenOrRequest) {
    token = tokenOrRequest.cookies.get("brew_session")?.value;
  }

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return {
      ok: false,
      status: 401,
      error: "Authentication required: missing brew_session cookie.",
      code: "MISSING_SESSION",
    };
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return {
      ok: false,
      status: 401,
      error: "Authentication failed: invalid, expired, or malformed session token.",
      code: "INVALID_SESSION",
    };
  }

  // Role validation: accurately identify customer roles (403 Forbidden) vs unauthorized roles
  if (payload.role === "customer") {
    return {
      ok: false,
      status: 403,
      error: "Forbidden: Customer role is not permitted to perform staff operations.",
      code: "UNAUTHORIZED_ROLE",
    };
  }

  const role = payload.role as string;
  if (!AUTHORIZED_STAFF_ROLES.has(role)) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden: Role '${role}' is not authorized for staff operations. Permitted roles: barista, fleet_admin, admin.`,
      code: "UNAUTHORIZED_ROLE",
    };
  }

  // Privileged Staff Session ID Enforcement:
  // Every privileged staff session strictly requires a non-empty session ID (sid).
  if (!payload.sid || typeof payload.sid !== "string" || payload.sid.trim().length === 0) {
    return {
      ok: false,
      status: 401,
      error: "Authentication failed: privileged staff session requires a valid session ID.",
      code: "MISSING_SID",
    };
  }

  // Durable revocation verification — CANNOT be skipped for any privileged staff token
  const revoked = await isSessionRevoked(payload.sid, payload.role, payload.expiresAt);
  if (revoked) {
    return {
      ok: false,
      status: 401,
      error: "Authentication failed: staff session has been revoked.",
      code: "REVOKED_SESSION",
    };
  }

  return {
    ok: true,
    session: {
      uid: payload.uid,
      role: role as "barista" | "fleet_admin" | "admin",
      email: payload.email,
      displayName: payload.displayName,
      sid: payload.sid,
    },
  };
}

/**
 * Extracts and cryptographically verifies the staff session token.
 * Returns VerifiedStaffSession on success, or null on any failure.
 */
export async function verifyStaffSession(
  tokenOrRequest:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } }
): Promise<VerifiedStaffSession | null> {
  const result = await inspectStaffSession(tokenOrRequest);
  return result.ok ? result.session : null;
}

export const getStaffSessionFromRequest = verifyStaffSession;
export const getStaffSessionFromToken = verifyStaffSession;

/**
 * Derives an authenticated, trusted StaffAuthorizationContext from verified server-side data.
 * Throws an explicit error with status code if authentication fails.
 * Eliminates redundant inspection lookups if an already verifiedSession is provided.
 * Generates an authoritative server-side approval audit ID (client IDs are correlation only).
 */
export async function deriveTrustedStaffAuthorizationContext(params: {
  tokenOrRequest?:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } };
  verifiedSession?: VerifiedStaffSession;
  staffApprovalId?: string;
}): Promise<StaffAuthorizationContext> {
  let staffSession: VerifiedStaffSession;

  if (params.verifiedSession) {
    staffSession = params.verifiedSession;
  } else if (params.tokenOrRequest) {
    const inspection = await inspectStaffSession(params.tokenOrRequest);
    if (!inspection.ok) {
      const error = new Error(inspection.error) as Error & { status: number; code: string };
      error.status = inspection.status;
      error.code = inspection.code;
      throw error;
    }
    staffSession = inspection.session;
  } else {
    const error = new Error("Authentication failed: missing session or request.") as Error & {
      status: number;
      code: string;
    };
    error.status = 401;
    error.code = "MISSING_SESSION";
    throw error;
  }

  // Use provided approval ID if explicitly supplied by internal caller; otherwise generate server-side
  const serverApprovalId =
    params.staffApprovalId && params.staffApprovalId.trim().length > 0
      ? params.staffApprovalId.trim()
      : `appr_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

  const context: StaffAuthorizationContext = {
    staffIdentity: staffSession.uid,
    staffRole: staffSession.role,
    staffApprovalId: serverApprovalId,
  };

  // Runtime schema enforcement via Zod
  return StaffAuthorizationContextSchema.parse(context);
}

/**
 * End-to-end server-side execution boundary for staff booking approval.
 * Authenticates caller session, derives trusted context, and delegates to domain approval.
 */
export async function authenticateAndApproveBooking(params: {
  sessionId: string;
  tokenOrRequest:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } };
  staffApprovalId?: string;
  repository?: VoiceSessionRepository;
}): Promise<VoiceBookingSession> {
  const { sessionId, tokenOrRequest, staffApprovalId, repository } = params;

  // 1. Authenticate and derive context strictly from verified server-side session
  const trustedContext = await deriveTrustedStaffAuthorizationContext({
    tokenOrRequest,
    staffApprovalId,
  });

  // 2. Delegate to domain engine
  return approveBookingByStaff(
    sessionId,
    trustedContext,
    repository || getVoiceSessionRepository()
  );
}

/**
 * Derives an authenticated, trusted StaffRejectionAuthorizationContext from verified server-side data.
 */
export async function deriveTrustedStaffRejectionContext(params: {
  tokenOrRequest?:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } };
  verifiedSession?: VerifiedStaffSession;
  staffRejectionId?: string;
  reason: string;
  customerFacingReason?: string;
}): Promise<StaffRejectionAuthorizationContext> {
  let staffSession: VerifiedStaffSession;

  if (params.verifiedSession) {
    staffSession = params.verifiedSession;
  } else if (params.tokenOrRequest) {
    const inspection = await inspectStaffSession(params.tokenOrRequest);
    if (!inspection.ok) {
      const error = new Error(inspection.error) as Error & { status: number; code: string };
      error.status = inspection.status;
      error.code = inspection.status === 401 ? "UNAUTHENTICATED" : "UNAUTHORIZED";
      throw error;
    }
    staffSession = inspection.session;
  } else {
    const error = new Error("Authentication failure: missing staff session credentials.") as Error & {
      status: number;
      code: string;
    };
    error.status = 401;
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  const generatedRejectionId =
    params.staffRejectionId || `rej_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

  const rawContext = {
    staffIdentity: staffSession.uid,
    staffRole: staffSession.role,
    staffRejectionId: generatedRejectionId,
    reason: params.reason,
    customerFacingReason: params.customerFacingReason,
  };

  const parsed = StaffRejectionAuthorizationContextSchema.safeParse(rawContext);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "context"}: ${i.message}`)
      .join("; ");
    const error = new Error(`Staff authorization context derivation failed: ${issues}`) as Error & {
      status: number;
      code: string;
    };
    error.status = 403;
    error.code = "FORBIDDEN";
    throw error;
  }

  return parsed.data;
}

/**
 * End-to-end server-side execution boundary for staff booking rejection.
 * Authenticates caller session, derives trusted context, and delegates to domain rejection.
 */
export async function authenticateAndRejectBooking(params: {
  sessionId: string;
  tokenOrRequest:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } };
  staffRejectionId?: string;
  reason: string;
  customerFacingReason?: string;
  repository?: VoiceSessionRepository;
}): Promise<VoiceBookingSession> {
  const { sessionId, tokenOrRequest, staffRejectionId, reason, customerFacingReason, repository } = params;

  const trustedContext = await deriveTrustedStaffRejectionContext({
    tokenOrRequest,
    staffRejectionId,
    reason,
    customerFacingReason,
  });

  return rejectBookingByStaff(
    sessionId,
    trustedContext,
    repository || getVoiceSessionRepository()
  );
}
