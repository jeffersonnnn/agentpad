"use client";

// Native price chart for the bonding-curve phase. Reads the sampled series from
// /api/agents/:id/prices (which also records a fresh point on each read) and draws a lightweight SVG
// area chart - no external chart library, no PONS dependency. The current spot price (from the curve)
// is shown big and appended as the live tip so the chart edge is always current.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { fmtCurvePrice, useCurvePrice, type PriceQuote } from "./onchain";
import { styles } from "./ui";

interface Series {
  points: { ts: string; price: number }[];
  quote: string | null;
}

async function fetchSeries(id: string): Promise<Series> {
  const res = await fetch(`/api/agents/${id}/prices?limit=500`);
  const body = (await res.json().catch(() => null)) as Series | null;
  return body && Array.isArray(body.points) ? body : { points: [], quote: null };
}

export function PriceChart({
  agentId,
  curve,
  quote,
}: {
  agentId: string;
  curve?: Address | null;
  quote?: string | null;
}) {
  const price = useCurvePrice(curve, quote);
  const q = useQuery({
    queryKey: ["prices", agentId],
    queryFn: () => fetchSeries(agentId),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const quoteSym: PriceQuote | null = price.quoteSymbol;

  // Merge the stored series with the live spot as the last point, so the tip is always current.
  const pts = useMemo(() => {
    const base = (q.data?.points ?? []).map((p) => ({ t: new Date(p.ts).getTime(), v: p.price }));
    if (price.pricePerToken !== null) {
      const now = Date.now();
      if (!base.length || now - base[base.length - 1].t > 5_000) base.push({ t: now, v: price.pricePerToken });
      else base[base.length - 1] = { t: now, v: price.pricePerToken };
    }
    return base.filter((p) => Number.isFinite(p.v));
  }, [q.data, price.pricePerToken]);

  const changePct = useMemo(() => {
    if (pts.length < 2) return null;
    const first = pts[0].v;
    const last = pts[pts.length - 1].v;
    if (!first) return null;
    return ((last - first) / first) * 100;
  }, [pts]);

  const bigPrice =
    price.pricePerToken !== null
      ? fmtCurvePrice(price.pricePerToken, quoteSym)
      : pts.length
        ? fmtCurvePrice(pts[pts.length - 1].v, quoteSym)
        : "—";

  return (
    <div className={styles.chartNative}>
      <div className={styles.chartHead}>
        <div>
          <div className={styles.chartPrice}>{bigPrice}</div>
          {changePct !== null ? (
            <div className={changePct >= 0 ? styles.chartUp : styles.chartDown}>
              {changePct >= 0 ? "+" : ""}
              {changePct.toFixed(2)}%
            </div>
          ) : null}
        </div>
        <span className={styles.muted} style={{ fontSize: 12 }}>
          {quoteSym ? `price in ${quoteSym}` : ""}
        </span>
      </div>
      {pts.length < 2 ? (
        <div className={styles.chartCollecting}>
          {q.isLoading ? "Loading price…" : "Collecting price data — the chart fills in as the token trades."}
        </div>
      ) : (
        <AreaChart values={pts.map((p) => p.v)} up={(changePct ?? 0) >= 0} />
      )}
    </div>
  );
}

// A dependency-free SVG area chart. Scales to its container via viewBox.
function AreaChart({ values, up }: { values: number[]; up: boolean }) {
  const W = 600;
  const H = 240;
  const pad = 6;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || max || 1;
  const n = values.length;
  const x = (i: number) => pad + (i / (n - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(2)},${H - pad} L${x(0).toFixed(2)},${H - pad} Z`;
  const stroke = up ? "var(--pos)" : "var(--neg)";
  const gid = up ? "cg-up" : "cg-down";

  return (
    <svg className={styles.chartSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Price chart">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={x(n - 1)} cy={y(values[n - 1])} r="3.5" fill={stroke} />
    </svg>
  );
}
