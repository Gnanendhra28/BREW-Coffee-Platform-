import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  verifySessionToken,
  UserRole,
} from "@/lib/authTokens";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "brew_session";

// Secret Staff PINs for quick shift login on tablet/kiosk
const BARISTA_PIN = process.env.BARISTA_PIN || "2026";
const FLEET_ADMIN_PIN = process.env.FLEET_ADMIN_PIN || "7788";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ authenticated: false, user: null }, { status: 200 });
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    // Clear invalid or expired cookie
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
    const body = await req.json();
    const { action, pin, role, user } = body;

    let determinedRole: UserRole = "customer";
    let finalUser = user || {
      uid: `usr-${Date.now()}`,
      displayName: "Sanctuary Guest",
      email: null,
    };

    // 1. Staff PIN Authentication (for Barista or Fleet Admin)
    if (action === "staff_pin") {
      if (pin === FLEET_ADMIN_PIN) {
        determinedRole = "fleet_admin";
        finalUser = {
          uid: "staff-fleet-admin-1",
          displayName: "Fleet Commander",
          email: "fleet.admin@brew.cafe",
        };
      } else if (pin === BARISTA_PIN) {
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
    } else if (role === "barista" || role === "fleet_admin") {
      determinedRole = role;
    } else if (user?.role) {
      determinedRole = user.role;
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
      httpOnly: false, // Accessible to client verification
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

export async function DELETE() {
  const response = NextResponse.json({ success: true, message: "Logged out" });
  response.cookies.delete(COOKIE_NAME);
  return response;
}
