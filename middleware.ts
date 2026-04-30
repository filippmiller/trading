import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth/constants";
import { verifySessionToken } from "@/lib/auth/session";

const PUBLIC_PAGE_PATHS = new Set(["/login"]);
const PUBLIC_API_PREFIXES = ["/api/auth/login", "/api/auth/logout", "/api/healthz"];
const RATE_LIMITS = {
  login: { max: 20, windowMs: 5 * 60 * 1000 },
  api: { max: 120, windowMs: 60 * 1000 },
  unauthenticated: { max: 60, windowMs: 60 * 1000 },
} as const;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

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

function clientIdentity(req: NextRequest): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip");
  const userAgent = req.headers.get("user-agent") || "unknown";
  return `${cfIp || forwardedFor || realIp || "unknown"}:${userAgent.slice(0, 80)}`;
}

function rateLimitResponse(resetAt: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: "Too Many Requests" },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
      },
    }
  );
}

function checkRateLimit(key: string, max: number, windowMs: number): NextResponse | null {
  const now = Date.now();
  if (rateLimitBuckets.size > 5000) {
    for (const [bucketKey, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey);
    }
  }

  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  bucket.count += 1;
  if (bucket.count > max) return rateLimitResponse(bucket.resetAt);
  return null;
}

function enforceRateLimit(req: NextRequest, pathname: string, scope: keyof typeof RATE_LIMITS): NextResponse | null {
  const config = RATE_LIMITS[scope];
  const routeGroup = scope === "login" ? pathname : "all";
  return checkRateLimit(`${scope}:${clientIdentity(req)}:${routeGroup}`, config.max, config.windowMs);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname.includes(".")) {
    return NextResponse.next();
  }

  if (pathname === "/login" || pathname.startsWith("/api/auth/login")) {
    const limited = enforceRateLimit(req, pathname, "login");
    if (limited) return limited;
  }

  if (pathname.startsWith("/api/") && pathname !== "/api/healthz") {
    const limited = enforceRateLimit(req, pathname, "api");
    if (limited) return limited;
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
    const limited = enforceRateLimit(req, pathname, "unauthenticated");
    if (limited) return limited;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
