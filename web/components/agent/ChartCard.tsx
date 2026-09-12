"use client";

// Price chart for the agent token, hosted ON Slingshot.
//   - Pre-graduation (PONS bonding curve): our own sampled area chart (PriceChart) — no PONS redirect.
//   - Post-graduation (Uniswap market): embed DexScreener's candlestick chart for the pair.
// The token's market is resolved via /api/market/pair (DexScreener indexes Robinhood Chain).

import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@/lib/types";
import { PriceChart } from "./PriceChart";
import { Card, styles } from "./ui";

interface PairInfo {
  pairAddress: string;
  priceUsd: string | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  url: string;
}

async function fetchPair(token: string): Promise<PairInfo | null> {
  const res = await fetch(`/api/market/pair?token=${token}`);
  const body = (await res.json().catch(() => null)) as { pair?: PairInfo | null } | null;
  return body?.pair ?? null;
}

export function ChartCard({ agent }: { agent: Agent }) {
  const token = agent.token_addr;

  const q = useQuery({
    queryKey: ["market-pair", token],
    queryFn: () => fetchPair(token as string),
    enabled: !!token,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!token) {
    return (
      <Card title="Chart">
        <p className={styles.muted}>The token is not launched yet.</p>
      </Card>
    );
  }

  const pair = q.data;

  if (pair) {
    const embed = `https://dexscreener.com/robinhood/${pair.pairAddress}?embed=1&theme=dark&info=0&trades=0`;
    return (
      <Card title="Chart">
        <div className={styles.chartFrame}>
          <iframe src={embed} title="DexScreener price chart" loading="lazy" allow="clipboard-write" />
        </div>
      </Card>
    );
  }

  // Still on the PONS curve — draw our own sampled chart, no redirect off-site.
  return (
    <Card title="Chart">
      <PriceChart agentId={agent.id} curve={agent.curve_addr} quote={agent.quote_asset} />
    </Card>
  );
}
