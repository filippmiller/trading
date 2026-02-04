import { NextResponse } from "next/server";

import { getAvailableSymbols } from "@/lib/data";

export async function GET() {
  try {
    const items = await getAvailableSymbols();
    return NextResponse.json({ items });
  } catch (error) {
    console.error("symbols error", error);
    return NextResponse.json({ error: "Failed to load symbols." }, { status: 500 });
  }
}
