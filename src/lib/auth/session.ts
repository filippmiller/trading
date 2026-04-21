const encoder = new TextEncoder();

export type SessionPayload = {
  sub: number;
  email: string;
  role: string;
  exp: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sign(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken(payload: SessionPayload, secret: string): Promise<string> {
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) return null;
  const expectedSignature = await sign(encodedPayload, secret);
  if (expectedSignature !== providedSignature) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as SessionPayload;
    if (!payload?.sub || !payload?.email || !payload?.role || !payload?.exp) return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
