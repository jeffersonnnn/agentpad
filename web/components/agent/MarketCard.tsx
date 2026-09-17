"use client";

// Market card for the agent page: the full copyable contract address, live curve price, fully-diluted
// value, total supply, the paired asset, and an outbound link to the token's PONS launchpad page for
// the full trading chart + buy/sell. The token is launched via the PONS factory, so PONS hosts the
// canonical chart; we surface the key numbers here and hand off the chart there.

import type { Agent } from "@/lib/types";
import {
  fmtCurvePrice,
  useCurvePrice,
  useTokenMeta,
  useTokenSupply,
} from "./onchain";
import { Card, StatRow, Skeleton, styles } from "./ui";

// Format a fully-diluted value (price × supply) in the pair's own unit.
function fmtValue(v: number | null, quote: "ETH" | "USDG" | null): string {
  if (v === null || quote === null || !Number.isFinite(v)) return "—";
  if (quote === "USDG") {
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  if (v === 0) return "0 ETH";
  if (v < 1e-6) return `${v.toExponential(3)} ETH`;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
}

function fmtSupply(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function MarketCard({ agent }: { agent: Agent }) {
  const meta = useTokenMeta(agent.token_addr);
  const price = useCurvePrice(agent.curve_addr, agent.quote_asset);
  const supplyQ = useTokenSupply(agent.token_addr, meta.decimals);

  const fdv =
    price.pricePerToken !== null && supplyQ.supply !== null
      ? price.pricePerToken * supplyQ.supply
      : null;

  if (!agent.token_addr) {
    return (
      <Card title="Market">
        <p className={styles.muted}>The token is not launched yet.</p>
      </Card>
    );
  }

  return (
    <Card title="Market">
      <StatRow label="Price">
        {price.isLoading && price.supported ? (
          <Skeleton width={90} height={16} />
        ) : price.pricePerToken !== null ? (
          fmtCurvePrice(price.pricePerToken, price.quoteSymbol)
        ) : (
          "—"
        )}
      </StatRow>
      <StatRow label="Fully diluted value">
        {fdv !== null ? fmtValue(fdv, price.quoteSymbol) : "—"}
      </StatRow>
      <StatRow label="Total supply">
        {supplyQ.isLoading ? <Skeleton width={90} height={16} /> : fmtSupply(supplyQ.supply)}
      </StatRow>
      <StatRow label="Paired in">{String(agent.quote_asset || "").toUpperCase() || "—"}</StatRow>
    </Card>
  );
}
