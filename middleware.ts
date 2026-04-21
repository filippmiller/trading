import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth/constants";
import { verifySessionToken } from "@/lib/auth/session";

const PUBLIC_PAGE_PATHS = new Set(["/login"]);
const PUBLIC_API_PREFIXES = ["/api/auth/login", "/api/auth/logout", "/api/healthz"];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PAGE_PATHS.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  const payload = await verifySessionToken(token, secret);
  return !!payload;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname.includes(".")) {
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) {
    if (pathname === "/login" && await hasValidSession(req)) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  const authenticated = await hasValidSession(req);
  if (authenticated) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
