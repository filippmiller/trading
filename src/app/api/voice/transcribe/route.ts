import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Audio file missing." }, { status: 400 });
  }

  const upstream = new FormData();
  upstream.append("file", file);
  upstream.append("model", "gpt-4o-mini-transcribe");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: upstream,
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error("transcription error", payload);
    return NextResponse.json({ error: "Transcription failed." }, { status: 500 });
  }

  const payload = await response.json();
  return NextResponse.json({ text: payload.text ?? "" });
}
