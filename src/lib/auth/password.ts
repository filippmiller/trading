import "server-only";

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEYLEN) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = storedHash.split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = await scrypt(password, salt, KEYLEN) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}
