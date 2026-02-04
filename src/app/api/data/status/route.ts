import { NextResponse } from "next/server";

import { getDataStatus } from "@/lib/data";

export async function GET() {
  try {
    const status = await getDataStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("data status error", error);
    return NextResponse.json({ error: "Failed to load status." }, { status: 500 });
  }
}
