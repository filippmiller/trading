import { NextResponse } from "next/server";
import { fetchAndAnalyzeMovers } from "@/lib/surveillance";

// Fetch top gainers, losers, and most active with trend analysis
export async function GET() {
  try {
    const data = await fetchAndAnalyzeMovers();
    return NextResponse.json(data);
  } catch (error) {
    console.error("movers fetch error", error);
    return NextResponse.json(
      { error: "Failed to fetch market movers." },
      { status: 500 }
    );
  }
}
