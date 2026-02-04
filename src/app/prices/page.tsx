"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const formatNumber = (value: number, digits = 2) => value.toFixed(digits);

type PriceRow = {
  date: string;
  open: number;
  close: number;
};

export default function PricesPage() {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [limit, setLimit] = useState(60);
  const [loading, setLoading] = useState(false);

  const fetchPrices = async () => {
    setLoading(true);
    const response = await fetch(`/api/prices?limit=${limit}`);
    const payload = await response.json();
    setRows(payload.items || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchPrices();
  }, []);

  const enriched = useMemo(() => {
    return rows.map((row) => {
      const change = row.close - row.open;
      const changePct = row.open ? change / row.open : 0;
      return { ...row, change, changePct };
    });
  }, [rows]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle>Daily SPY Prices</CardTitle>
          <div className="text-sm text-zinc-500">Open, close, and daily change.</div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={260}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="w-24"
          />
          <Button onClick={fetchPrices} disabled={loading}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-zinc-500">
                <th className="py-2">Date</th>
                <th>Open</th>
                <th>Close</th>
                <th>Change ($)</th>
                <th>Change (%)</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((row) => {
                const up = row.change >= 0;
                return (
                  <tr key={row.date} className="border-b last:border-0">
                    <td className="py-2">{row.date}</td>
                    <td>{formatNumber(row.open, 2)}</td>
                    <td>{formatNumber(row.close, 2)}</td>
                    <td className={up ? "text-emerald-600" : "text-red-600"}>
                      {up ? "+" : ""}
                      {formatNumber(row.change, 2)}
                    </td>
                    <td className={up ? "text-emerald-600" : "text-red-600"}>
                      {up ? "+" : ""}
                      {(row.changePct * 100).toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
