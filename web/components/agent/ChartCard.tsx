"use client";

// Price chart for the agent token. Robinhood Chain is indexed by DexScreener (chainId "robinhood"), so
// once the token has a Uniswap market we embed DexScreener's candlestick chart for its pair. While the
// token is still on the PONS bonding curve (pre-graduation) there is no pool yet, so we show the curve
// spot price and link to the PONS launchpad page, which charts the curve from its first trade.

import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@/lib/types";
import { ponsLaunchpadUrl } from "@/lib/constants";
import { fmtCurvePrice, useCurvePrice } from "./onchain";
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
  const price = useCurvePrice(agent.curve_addr, agent.quote_asset);

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
          <iframe
            src={embed}
            title="DexScreener price chart"
            loading="lazy"
            allow="clipboard-write"
          />
        </div>
        <p className={styles.muted}>
          Live chart via DexScreener.{" "}
          <a className={styles.addr} href={pair.url} target="_blank" rel="noreferrer">
            Open full chart ↗
          </a>
        </p>
      </Card>
    );
  }

  // No Uniswap pair yet — still on the PONS curve. Show the curve spot price + the PONS chart link.
  return (
    <Card title="Chart">
      <div className={styles.chartEmpty}>
        <div className={styles.chartPrice}>
          {price.pricePerToken !== null ? fmtCurvePrice(price.pricePerToken, price.quoteSymbol) : "—"}
        </div>
        <p className={styles.muted}>
          {q.isLoading
            ? "Loading market…"
            : "This token trades on the PONS bonding curve. A full candlestick chart appears here once it graduates to a Uniswap market."}
        </p>
        <a
          className={styles.marketPrimary}
          href={ponsLaunchpadUrl(token)}
          target="_blank"
          rel="noreferrer"
        >
          View the live curve chart on PONS ↗
        </a>
      </div>
    </Card>
  );
}
