"use client";

// Agent page header: token name/ticker (read on-chain — the agents row has no name column), status,
// archetype, model, and the curve spot price.

import type { Agent } from "@/lib/types";
import { fmtCurvePrice, useCurvePrice, useReadyToGraduate, useTokenMeta } from "./onchain";
import { AddressPill, ArchetypeChip, relativeTime, Skeleton, StatusBadge, TokenLogo, styles } from "./ui";

export function AgentHeader({ agent }: { agent: Agent }) {
  const meta = useTokenMeta(agent.token_addr);
  const price = useCurvePrice(agent.curve_addr, agent.quote_asset);
  const graduated = useReadyToGraduate(agent.curve_addr);

  const name = meta.name ?? "Agent";
  const symbol = meta.symbol ? `$${meta.symbol}` : "";

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <div className={styles.titleRow}>
          <TokenLogo src={agent.logo_url} symbol={meta.symbol} size={48} />
          <h1 className={styles.tokenName}>
            {meta.isLoading && !meta.name ? <Skeleton width={180} height={26} /> : name}
            {symbol && <span className={styles.ticker}>{symbol}</span>}
          </h1>
        </div>
        <div className={styles.subrow}>
          <StatusBadge status={agent.status} />
          <ArchetypeChip slug={agent.archetype} />
          {agent.model && <span>{agent.model}</span>}
          <span>·</span>
          <span>launched {relativeTime(agent.created_at)}</span>
        </div>
        <div className={styles.subrow}>
          {agent.token_addr ? (
            <>
              <span>token</span>
              <AddressPill addr={agent.token_addr} kind="token" />
            </>
          ) : (
            <span>token not yet launched</span>
          )}
          {agent.quote_asset && (
            <>
              <span>·</span>
              <span>paired in {String(agent.quote_asset).toUpperCase()}</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.priceBox}>
        <div className={styles.priceValue}>
          {price.isLoading && price.supported ? (
            <Skeleton width={120} height={24} />
          ) : price.pricePerToken !== null ? (
            fmtCurvePrice(price.pricePerToken, price.quoteSymbol)
          ) : (
            "—"
          )}
        </div>
        <div className={styles.priceLabel}>
          {graduated
            ? "graduated — LP locked (curve price N/A)"
            : !price.supported
              ? "spot price unavailable (unknown pair)"
              : price.error
                ? "curve price unavailable"
                : `≈ spot price from PONS curve (${price.quoteSymbol})`}
        </div>
      </div>
    </header>
  );
}
