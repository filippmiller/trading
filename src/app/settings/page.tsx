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

export default function SettingsPage() {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const response = await fetch("/api/settings");
      const payload = await response.json();
      setDefaults(payload.defaults);
    };
    load();
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

  if (!defaults) return <div>Loading...</div>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Defaults</CardTitle>
        <CardDescription>Default costs and sizing used by new runs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="text-sm text-zinc-600">Commission per side ($)</label>
        <Input
          type="number"
          step={0.1}
          value={defaults.commission_per_side_usd}
          onChange={(event) => updateField("commission_per_side_usd", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Slippage (bps)</label>
        <Input
          type="number"
          step={0.5}
          value={defaults.slippage_bps}
          onChange={(event) => updateField("slippage_bps", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Margin APR</label>
        <Input
          type="number"
          step={0.01}
          value={defaults.margin_interest_apr}
          onChange={(event) => updateField("margin_interest_apr", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Leverage</label>
        <Input
          type="number"
          step={1}
          value={defaults.leverage}
          onChange={(event) => updateField("leverage", Number(event.target.value))}
        />
        <label className="text-sm text-zinc-600">Base capital (USD)</label>
        <Input
          type="number"
          step={50}
          value={defaults.base_capital_usd}
          onChange={(event) => updateField("base_capital_usd", Number(event.target.value))}
        />
        <Button onClick={save} disabled={saving}>
          Save defaults
        </Button>
        {message && <div className="text-sm text-zinc-500">{message}</div>}
      </CardContent>
    </Card>
  );
}
