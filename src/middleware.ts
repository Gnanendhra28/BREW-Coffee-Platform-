import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/authTokens";

export const config = {
  matcher: [
    "/barista",
    "/barista/:path*",
    "/admin",
    "/admin/:path*",
  ],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get("brew_session")?.value;

  // 1. Verify existence of session token
  if (!token) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirect", pathname);
    loginUrl.searchParams.set("error", "auth_required");
    return NextResponse.redirect(loginUrl);
  }

  // 2. Cryptographically verify JWT HMAC signature and expiration
  const session = await verifySessionToken(token);
  if (!session) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirect", pathname);
    loginUrl.searchParams.set("error", "session_expired");
    return NextResponse.redirect(loginUrl);
  }

  // 3. Role-Based Access Control (RBAC)
  // Protected Barista KDS: Requires 'barista' or 'fleet_admin'
  if (pathname.startsWith("/barista")) {
    if (session.role !== "barista" && session.role !== "fleet_admin") {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("redirect", pathname);
      loginUrl.searchParams.set("error", "forbidden_role");
      loginUrl.searchParams.set("required", "barista");
      return NextResponse.redirect(loginUrl);
    }
  }

  // Protected Fleet Admin Controls: Requires 'fleet_admin'
  if (pathname.startsWith("/admin")) {
    if (session.role !== "fleet_admin") {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("redirect", pathname);
      loginUrl.searchParams.set("error", "forbidden_role");
      loginUrl.searchParams.set("required", "fleet_admin");
      return NextResponse.redirect(loginUrl);
    }
  }

  // Authorized: pass request along with attached role headers
  const response = NextResponse.next();
  response.headers.set("x-user-id", session.uid);
  response.headers.set("x-user-role", session.role);
  return response;
}
