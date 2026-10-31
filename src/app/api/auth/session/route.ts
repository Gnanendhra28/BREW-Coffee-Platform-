import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  verifySessionToken,
  getStaffPins,
  UserRole,
} from "../../../../lib/authTokens";
import { revokeSession, isSessionRevoked } from "../../../../lib/sessionRevocation";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "brew_session";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ authenticated: false, user: null }, { status: 200 });
  }

  const payload = await verifySessionToken(token);
  if (!payload || (payload.sid && (await isSessionRevoked(payload.sid, payload.role, payload.expiresAt)))) {
    // Clear invalid, expired, or revoked cookie
    const res = NextResponse.json({ authenticated: false, user: null }, { status: 200 });
    res.cookies.delete(COOKIE_NAME);
    return res;
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      uid: payload.uid,
      email: payload.email,
      displayName: payload.displayName,
      role: payload.role,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    // Rate limit session attempts (max 15 attempts / 60 seconds per IP, sensitive in production)
    const clientIp = getClientIp(req);
    const rateLimit = await checkRateLimit(clientIp, "auth-session", 15, 60, {
      sensitive: true,
    });
    if (!rateLimit.success) {
      if (rateLimit.error === "RATE_LIMITER_UNAVAILABLE") {
        return NextResponse.json(
          { error: "Authentication rate limiting service temporarily unavailable. Please retry shortly." },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Too many authentication attempts. Please wait a moment." },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { action, pin, role, user } = body;

    let determinedRole: UserRole = "customer";
    let finalUser = user || {
      uid: `usr-${Date.now()}`,
      displayName: "Sanctuary Guest",
      email: null,
    };

    // 0. Handle Explicit Logout Action with Durable Revocation
    if (action === "logout") {
      const token = req.cookies.get(COOKIE_NAME)?.value;
      if (token) {
        const payload = await verifySessionToken(token);
        if (payload?.sid) {
          await revokeSession(payload.sid, payload.uid, payload.expiresAt);
        }
      }
      const res = NextResponse.json({ success: true, message: "Logged out successfully" });
      res.cookies.delete(COOKIE_NAME);
      return res;
    }

    // 1. Staff PIN Authentication (for Barista or Fleet Admin)
    if (action === "staff_pin") {
      const { baristaPin, fleetAdminPin } = getStaffPins();
      if (fleetAdminPin && pin === fleetAdminPin) {
        determinedRole = "fleet_admin";
        finalUser = {
          uid: "staff-fleet-admin-1",
          displayName: "Fleet Commander",
          email: "fleet.admin@brew.cafe",
        };
      } else if (baristaPin && pin === baristaPin) {
        determinedRole = "barista";
        finalUser = {
          uid: "staff-barista-arjun",
          displayName: "Arjun (Lead Barista)",
          email: "arjun.barista@brew.cafe",
        };
      } else {
        return NextResponse.json(
          { error: "Invalid Staff Security PIN. Access denied." },
          { status: 401 }
        );
      }
    } else if (
      role === "barista" ||
      role === "fleet_admin" ||
      user?.role === "barista" ||
      user?.role === "fleet_admin"
    ) {
      // PREVENT PRIVILEGE ESCALATION: Clients cannot self-assign staff roles without valid Staff PIN
      return NextResponse.json(
        { error: "Privileged roles require verified Staff Security PIN authentication." },
        { status: 403 }
      );
    } else {
      // Default to customer role for social or guest login
      determinedRole = "customer";
    }

    // 2. Generate signed session token
    const token = await createSessionToken({
      uid: finalUser.uid,
      email: finalUser.email,
      displayName: finalUser.displayName,
      role: determinedRole,
    });

    const response = NextResponse.json({
      success: true,
      user: {
        ...finalUser,
        role: determinedRole,
      },
    });

    // Set cookie on response
    response.cookies.set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true, // Secure against client XSS exfiltration
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Authentication failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload?.sid) {
      await revokeSession(payload.sid, payload.uid, payload.expiresAt);
    }
  }
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete(COOKIE_NAME);
  return response;
}
