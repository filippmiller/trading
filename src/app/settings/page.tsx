"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Defaults = {
  commission_per_side_usd: number;
  slippage_bps: number;
  margin_interest_apr: number;
  leverage: number;
  base_capital_usd: number;
};

/** W4 — paper-trading risk-model config. Edited via /api/paper/settings. */
type RiskSettings = {
  slippage_bps: number;
  commission_per_share: number;
  commission_min_per_leg: number;
  allow_fractional_shares: boolean;
  default_borrow_rate_pct: number;
};

export default function SettingsPage() {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // W4 — paper-trading risk model section (separate from the legacy
  // backtest defaults above; they live in different app_settings keys).
  const [risk, setRisk] = useState<RiskSettings | null>(null);
  const [riskSaving, setRiskSaving] = useState(false);
  const [riskMessage, setRiskMessage] = useState<string | null>(null);

  const loadRisk = async () => {
    try {
      const res = await fetch("/api/paper/settings");
      if (!res.ok) return;
      const data = await res.json();
      setRisk({
        slippage_bps: Number(data.slippage_bps ?? 0),
        commission_per_share: Number(data.commission_per_share ?? 0),
        commission_min_per_leg: Number(data.commission_min_per_leg ?? 0),
        allow_fractional_shares: Boolean(data.allow_fractional_shares),
        default_borrow_rate_pct: Number(data.default_borrow_rate_pct ?? 0),
      });
    } catch { /* keep section hidden on error */ }
  };
  useEffect(() => { loadRisk(); }, []);

  // Hotfix 2026-04-22 (Claude Desktop Finding #2): pre-save client-side
  // validation mirrors server Zod bounds. Without it the user could save a
  // value the server would accept in the old lax schema, and even after the
  // tightened server bounds the UI just said "Failed to save." Now we reject
  // obvious typos inline, and on server 400 we surface the first Zod issue
  // so the user knows WHICH field is out of range and WHY.
  const RISK_BOUNDS = {
    slippage_bps:            { min: 0, max: 200, label: "Slippage (bps)" },
    commission_per_share:    { min: 0, max: 0.5, label: "Commission — per share" },
    commission_min_per_leg:  { min: 0, max: 10,  label: "Commission — minimum per leg" },
    default_borrow_rate_pct: { min: 0, max: 100, label: "Default short borrow rate (%)" },
  } as const;

  const validateRisk = (r: RiskSettings): string | null => {
    for (const [key, { min, max, label }] of Object.entries(RISK_BOUNDS)) {
      const v = (r as unknown as Record<string, number>)[key];
      if (!Number.isFinite(v)) return `${label}: must be a number`;
      if (v < min || v > max) return `${label}: must be between ${min} and ${max} (got ${v})`;
    }
    return null;
  };

  const saveRisk = async () => {
    if (!risk) return;
    const clientError = validateRisk(risk);
    if (clientError) {
      setRiskMessage(clientError);
      return;
    }
    setRiskSaving(true);
    setRiskMessage(null);
    try {
      const res = await fetch("/api/paper/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(risk),
      });
      if (res.ok) {
        setRiskMessage("Saved.");
        return;
      }
      let detail = "Failed to save risk settings.";
      try {
        const body = await res.json();
        if (body?.issues?.length) {
          const first = body.issues[0];
          detail = `Invalid input — ${Array.isArray(first.path) ? first.path.join(".") : "(field)"}: ${first.message}`;
        } else if (typeof body?.error === "string") {
          detail = body.error;
        }
      } catch { /* non-JSON body */ }
      setRiskMessage(detail);
    } finally {
      setRiskSaving(false);
    }
  };

  // Previous version silently hung on "Loading..." whenever the DB tunnel dropped —
  // fetch rejected, nothing caught it, user never knew. Now any failure surfaces
  // an actionable error state with a retry button instead of an infinite spinner.
  const loadDefaults = async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload?.defaults) throw new Error("Malformed response: missing `defaults` key");
      setDefaults(payload.defaults);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    loadDefaults();
  }, []);

  const updateField = (key: keyof Defaults, value: number) => {
    if (!defaults) return;
    setDefaults({ ...defaults, [key]: value });
  };

  const save = async () => {
    if (!defaults) return;
    setSaving(true);
    setMessage(null);
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaults),
    });
    setSaving(false);
    if (response.ok) {
      setMessage("Saved.");
    } else {
      setMessage("Failed to save.");
    }
  };

  if (loadError) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-rose-600">Failed to load settings</CardTitle>
          <CardDescription className="font-mono text-xs">{loadError}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={loadDefaults}>Retry</Button>
        </CardContent>
      </Card>
    );
  }
  if (!defaults) {
    return (
      <div className="flex items-center gap-3 text-zinc-500 text-sm">
        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        Loading settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>Defaults</CardTitle>
        <CardDescription>Default costs and sizing used by new runs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* min={0} guards against the browser-number-input minus-stripping
            bug that corrupted commission_per_share on the risk-model card. */}
        <label className="text-sm text-zinc-600">Commission per side ($)</label>
        <Input
          type="number"
          step={0.1}
          min={0}
          value={defaults.commission_per_side_usd}
          onChange={(event) => updateField("commission_per_side_usd", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Slippage (bps)</label>
        <Input
          type="number"
          step={0.5}
          min={0}
          value={defaults.slippage_bps}
          onChange={(event) => updateField("slippage_bps", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Margin APR</label>
        <Input
          type="number"
          step={0.01}
          min={0}
          value={defaults.margin_interest_apr}
          onChange={(event) => updateField("margin_interest_apr", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Leverage</label>
        <Input
          type="number"
          step={1}
          min={1}
          value={defaults.leverage}
          onChange={(event) => updateField("leverage", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Base capital (USD)</label>
        <Input
          type="number"
          step={50}
          min={0}
          value={defaults.base_capital_usd}
          onChange={(event) => updateField("base_capital_usd", Number(event.target.value))}
        />
        <Button onClick={save} disabled={saving}>
          Save defaults
        </Button>
        {message && <div className="text-sm text-zinc-500">{message}</div>}
      </CardContent>
    </Card>

    {/* W4 — paper-trading risk model */}
    {risk && (
      <Card>
        <CardHeader>
          <CardTitle>Paper trading — risk model</CardTitle>
          <CardDescription>
            Slippage, commission, fractional shares, and default short-borrow rate.
            Applied to every paper fill immediately after saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="text-sm text-zinc-600">Slippage (bps) — MARKET orders only</label>
          <Input type="number" step={0.5} min={0} max={200} value={risk.slippage_bps}
            onChange={e => setRisk({ ...risk, slippage_bps: Number(e.target.value) })} />
          <label className="text-sm text-zinc-600">Commission — per share ($)</label>
          <Input type="number" step={0.001} min={0} max={0.5} value={risk.commission_per_share}
            onChange={e => setRisk({ ...risk, commission_per_share: Number(e.target.value) })} />
          <label className="text-sm text-zinc-600">Commission — minimum per leg ($)</label>
          <Input type="number" step={0.1} min={0} max={10} value={risk.commission_min_per_leg}
            onChange={e => setRisk({ ...risk, commission_min_per_leg: Number(e.target.value) })} />
          <label className="text-sm text-zinc-600 flex items-center gap-2">
            <input type="checkbox" checked={risk.allow_fractional_shares}
              onChange={e => setRisk({ ...risk, allow_fractional_shares: e.target.checked })} />
            Allow fractional shares (off = floor quantity to whole shares)
          </label>
          <label className="text-sm text-zinc-600">Default short borrow rate (annual %)</label>
          <Input type="number" step={0.1} min={0} max={100} value={risk.default_borrow_rate_pct}
            onChange={e => setRisk({ ...risk, default_borrow_rate_pct: Number(e.target.value) })} />
          <Button onClick={saveRisk} disabled={riskSaving}>Save risk settings</Button>
          {riskMessage && (
            <div className={`text-sm ${riskMessage === "Saved." ? "text-emerald-600" : "text-rose-600"}`}>
              {riskMessage}
            </div>
          )}
        </CardContent>
      </Card>
    )}
    </div>
  );
}
