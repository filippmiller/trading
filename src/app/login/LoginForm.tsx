"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Lock, Mail } from "lucide-react";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = useMemo(() => searchParams.get("next") || "/", [searchParams]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed.");
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.12),_transparent_38%),linear-gradient(180deg,_#f8fafc_0%,_#eef2f7_100%)] px-6 py-16">
      <div className="mx-auto max-w-md">
        <div className="rounded-[2rem] border border-white/70 bg-white/90 p-8 shadow-2xl shadow-zinc-300/40 backdrop-blur">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-2xl bg-emerald-600 p-3 text-white shadow-lg shadow-emerald-200">
              <Activity className="h-6 w-6" />
            </div>
            <div>
              <div className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Private Access</div>
              <h1 className="text-2xl font-bold text-zinc-900">QuantSurveillance</h1>
            </div>
          </div>

          <form className="space-y-5" onSubmit={onSubmit}>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-zinc-700">Email</span>
              <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                <Mail className="h-4 w-4 text-zinc-400" />
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-transparent text-sm outline-none"
                  placeholder="admin@example.com"
                  required
                />
              </div>
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-zinc-700">Password</span>
              <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                <Lock className="h-4 w-4 text-zinc-400" />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-transparent text-sm outline-none"
                  placeholder="••••••••"
                  required
                />
              </div>
            </label>

            {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
