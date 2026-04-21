import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth/constants";
import { getCurrentUserFromToken } from "@/lib/auth/server";

export async function GET(req: Request) {
  try {
    const cookie = req.headers.get("cookie") ?? "";
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(`${SESSION_COOKIE}=`.length);
    const user = await getCurrentUserFromToken(token);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load session.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
