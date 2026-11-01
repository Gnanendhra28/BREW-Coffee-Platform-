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

import { NextRequest } from "next/server";
import { verifySessionToken } from "../authTokens";
import { isSessionRevoked } from "../sessionRevocation";
import {
  StaffAuthorizationContext,
  VoiceBookingSession,
  VoiceSessionRepository,
} from "../voiceBooking/types";
import { StaffAuthorizationContextSchema } from "../voiceBooking/schemas";
import {
  approveBookingByStaff,
  defaultSessionRepository,
} from "../voiceBooking/conversationEngine";

export interface VerifiedStaffSession {
  uid: string;
  role: "barista" | "fleet_admin" | "admin";
  email: string | null;
  displayName: string | null;
  sid?: string;
}

const AUTHORIZED_STAFF_ROLES = new Set(["barista", "fleet_admin", "admin"]);

/**
 * Extracts and cryptographically verifies the staff session token.
 * Rejects expired, revoked, malformed, or customer-role sessions.
 * Fails closed on any security violation.
 */
export async function verifyStaffSession(
  tokenOrRequest:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } }
): Promise<VerifiedStaffSession | null> {
  let token: string | undefined;

  if (typeof tokenOrRequest === "string") {
    token = tokenOrRequest;
  } else if (tokenOrRequest && "cookies" in tokenOrRequest) {
    token = tokenOrRequest.cookies.get("brew_session")?.value;
  }

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return null;
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return null; // Invalid HMAC signature or expired
  }

  // Durable revocation verification
  if (payload.sid && (await isSessionRevoked(payload.sid, payload.role, payload.expiresAt))) {
    return null; // Session revoked
  }

  // Role validation: strictly restrict to barista, fleet_admin, or admin
  const role = payload.role as string;
  if (!AUTHORIZED_STAFF_ROLES.has(role)) {
    return null; // Customer role or unauthorized role
  }

  return {
    uid: payload.uid,
    role: role as "barista" | "fleet_admin" | "admin",
    email: payload.email,
    displayName: payload.displayName,
    sid: payload.sid,
  };
}

export const getStaffSessionFromRequest = verifyStaffSession;
export const getStaffSessionFromToken = verifyStaffSession;

/**
 * Derives an authenticated, trusted StaffAuthorizationContext from verified server-side data.
 * Throws an explicit error if authentication fails, preventing unauthenticated callers
 * from manufacturing an administrative context.
 */
export async function deriveTrustedStaffAuthorizationContext(params: {
  tokenOrRequest:
    | string
    | NextRequest
    | { cookies: { get(name: string): { value: string } | undefined } };
  staffApprovalId?: string;
}): Promise<StaffAuthorizationContext> {
  const staffSession = await verifyStaffSession(params.tokenOrRequest);
  if (!staffSession) {
    throw new Error(
      "Authentication failure: valid staff session required to perform administrative booking approval."
    );
  }

  const approvalId =
    params.staffApprovalId && params.staffApprovalId.trim().length > 0
      ? params.staffApprovalId.trim()
      : `appr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const context: StaffAuthorizationContext = {
    staffIdentity: staffSession.uid,
    staffRole: staffSession.role,
    staffApprovalId: approvalId,
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
    repository || defaultSessionRepository
  );
}
