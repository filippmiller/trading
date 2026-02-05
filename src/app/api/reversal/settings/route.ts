import { NextResponse } from "next/server";

import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import { ReversalSettings, ReversalSettingsSchema } from "@/lib/reversal";

const SETTINGS_KEY = "reversal_settings";

const DEFAULT_SETTINGS: ReversalSettings = {
  position_size_usd: 100,
  commission_per_trade_usd: 1,
  short_borrow_rate_apr: 0.03,
  leverage_interest_apr: 0.08,
  leverage_multiplier: 1,
};

// GET - Fetch reversal settings
export async function GET() {
  try {
    await ensureSchema();
    const pool = await getPool();

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT `value` FROM app_settings WHERE `key` = ?",
      [SETTINGS_KEY]
    );

    if (!rows.length) {
      return NextResponse.json({ settings: DEFAULT_SETTINGS });
    }

    const settings = JSON.parse(rows[0].value);
    return NextResponse.json({ settings: { ...DEFAULT_SETTINGS, ...settings } });
  } catch (error) {
    console.error("reversal settings GET error", error);
    return NextResponse.json({ error: "Failed to fetch settings." }, { status: 500 });
  }
}

// POST - Update reversal settings
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const pool = await getPool();

    const body = await req.json();

    // Validate settings
    const parsed = ReversalSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid settings: " + parsed.error.message },
        { status: 400 }
      );
    }

    const settings = parsed.data;

    // Upsert settings
    await pool.execute(
      `INSERT INTO app_settings (\`key\`, \`value\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
      [SETTINGS_KEY, JSON.stringify(settings)]
    );

    return NextResponse.json({ settings });
  } catch (error) {
    console.error("reversal settings POST error", error);
    return NextResponse.json({ error: "Failed to save settings." }, { status: 500 });
  }
}
