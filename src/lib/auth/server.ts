import "server-only";

import { randomUUID } from "node:crypto";

import { ensureAppBootstrapReady } from "@/lib/bootstrap";
import { getPool, mysql } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSessionToken, verifySessionToken, type SessionPayload } from "@/lib/auth/session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export type AuthUser = {
  id: number;
  email: string;
  role: string;
};

let authReadyPromise: Promise<void> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getSessionSecret(): string {
  return requireEnv("SESSION_SECRET");
}

async function seedBootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const rawPassword = process.env.ADMIN_PASSWORD?.trim();
  if (!email || !rawPassword) return;

  const pool = await getPool();

  // Check if an admin row already exists for this email.
  // SECURITY: We intentionally do NOT overwrite an existing row.
  // If the env vars change after the account is created, that must be
  // done via the authenticated password-change API — not by env-var
  // manipulation at deploy time. An attacker who gains write access to
  // Railway env vars must not be able to silently takeover the admin
  // account on the next cold start.
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM app_users WHERE email = ? LIMIT 1",
    [email]
  );
  if (rows.length > 0) {
    // Row already exists — skip. Log a warning so operators know the
    // env vars are not being applied (avoids silent confusion).
    console.warn(
      `[auth] Bootstrap skipped: admin account for ${email} already exists. ` +
      `To change the password, use the /api/auth/password endpoint. ` +
      `ADMIN_PASSWORD env var is ignored for existing accounts.`
    );
    return;
  }

  const passwordHash = await hashPassword(rawPassword);
  await pool.execute(
    "INSERT INTO app_users (email, password_hash, role) VALUES (?, ?, 'admin')",
    [email, passwordHash]
  );
  console.info(`[auth] Bootstrap: created admin account for ${email}.`);
}

export async function ensureAuthReady() {
  if (!authReadyPromise) {
    authReadyPromise = (async () => {
      await ensureAppBootstrapReady();
      await seedBootstrapAdmin();
    })().catch((error) => {
      authReadyPromise = null;
      throw error;
    });
  }
  return authReadyPromise;
}

export async function authenticateUser(email: string, password: string): Promise<AuthUser | null> {
  await ensureAuthReady();
  const normalizedEmail = email.trim().toLowerCase();
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id, email, password_hash, role, is_active FROM app_users WHERE email = ? LIMIT 1",
    [normalizedEmail]
  );
  const user = rows[0];
  if (!user || Number(user.is_active) !== 1) return null;
  const ok = await verifyPassword(password, String(user.password_hash));
  if (!ok) return null;

  await pool.execute(
    "UPDATE app_users SET last_login_at = CURRENT_TIMESTAMP(6) WHERE id = ?",
    [user.id]
  );

  return {
    id: Number(user.id),
    email: String(user.email),
    role: String(user.role),
  };
}

export async function buildSessionCookie(user: AuthUser) {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: now + SESSION_TTL_SECONDS,
  };
  const token = await createSessionToken(payload, getSessionSecret());
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict" as const,
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    },
  };
}

export async function getCurrentUserFromToken(token?: string): Promise<AuthUser | null> {
  await ensureAuthReady();
  if (!token) return null;

  const payload = await verifySessionToken(token, getSessionSecret());
  if (!payload) return null;

  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id, email, role, is_active FROM app_users WHERE id = ? LIMIT 1",
    [payload.sub]
  );
  const user = rows[0];
  if (!user || Number(user.is_active) !== 1) return null;

  return {
    id: Number(user.id),
    email: String(user.email),
    role: String(user.role),
  };
}

export function generatePasswordForSetup(): string {
  return randomUUID().replace(/-/g, "");
}
