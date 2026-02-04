import { NextResponse } from "next/server";

import { refreshSpyData } from "@/lib/data";

export async function POST() {
  try {
    const result = await refreshSpyData();
    return NextResponse.json(result);
  } catch (error) {
    console.error("refresh data error", error);
    return NextResponse.json({ error: "Failed to refresh data." }, { status: 500 });
  }
}
