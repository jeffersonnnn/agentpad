"use client";

// Trades: the trade-kind entries from the feed table, in a compact ledger. Complements the live
// holdings in the treasury panel and the narrative in the reasoning feed. Each row links to its tx.
//
// CANONICAL TRADE META (written by the loop agent, agent/loop.mjs): a feed row of kind='trade' has
//   tx_hash = the swap tx hash, and
//   meta = { side: "buy"|"sell"|"rotate", fromSymbol, toSymbol,
//            amountIn: <whole-unit string>, amountOut: <whole-unit string>,
//            notionalUsdg: <whole-USDG string>, realized_usdg?: <base-unit USDG integer string> }.
// amountIn / amountOut / notionalUsdg are already WHOLE-unit strings — no base-unit conversion here.
// Everything is read defensively: a missing field renders "—", never a crash.

import { useQuery } from "@tanstack/react-query";
import { getAgentFeed } from "@/lib/api";
import type { FeedEntry } from "@/lib/types";
import { txUrl } from "./onchain";
import { Card, Empty, ErrorNote, relativeTime, Skeleton, styles } from "./ui";

// A meta value is only usable if it is a non-empty string (numbers are coerced to strings).
function metaStr(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

// Format a whole-USDG string as a $ value; fall back to the raw string when it is not a number.
function fmtNotional(notional?: string): string | undefined {
  if (!notional) return undefined;
  const n = Number(notional);
  if (!Number.isFinite(n)) return `$${notional}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Pull the canonical trade fields out of the meta bag (all optional / defensive).
function tradeBits(e: FeedEntry): { side?: string; detail?: string; value?: string } {
  const m = e.meta ?? {};
  const side = metaStr(m.side);
  const fromSymbol = metaStr(m.fromSymbol);
  const toSymbol = metaStr(m.toSymbol);
  const amountIn = metaStr(m.amountIn);
  const amountOut = metaStr(m.amountOut);
  const value = fmtNotional(metaStr(m.notionalUsdg));

  // Detail: "<amountIn> <fromSymbol> → <amountOut> <toSymbol>", each half degrading to what we have.
  const left = [amountIn, fromSymbol].filter(Boolean).join(" ");
  const right = [amountOut, toSymbol].filter(Boolean).join(" ");
  const detail = left || right ? `${left || "?"} → ${right || "?"}` : undefined;

  return { side, detail, value };
}

export function TradesPanel({ agentId }: { agentId: string }) {
  const q = useQuery({
    queryKey: ["trades", agentId],
    queryFn: () => getAgentFeed(agentId, { kind: "trade", limit: 50 }),
    refetchInterval: 20_000,
  });

  return (
    <Card title="Trades">
      {q.isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Skeleton height={20} />
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : q.isError ? (
        <ErrorNote>Could not load trades. {(q.error as Error)?.message}</ErrorNote>
      ) : !q.data || q.data.length === 0 ? (
        <Empty>No trades yet.</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Detail</th>
                <th className={styles.num}>Value</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((e) => {
                const b = tradeBits(e);
                return (
                  <tr key={e.id}>
                    <td>{relativeTime(e.ts)}</td>
                    <td>
                      {b.side ? (
                        <span style={{ textTransform: "capitalize" }}>{b.side}</span>
                      ) : (
                        <span className={styles.muted}>{e.text ? e.text.slice(0, 48) : "trade"}</span>
                      )}
                    </td>
                    <td className={styles.muted}>{b.detail ?? "—"}</td>
                    <td className={styles.num}>{b.value ?? "—"}</td>
                    <td>
                      {e.tx_hash ? (
                        <a className={styles.addr} href={txUrl(e.tx_hash)} target="_blank" rel="noreferrer">
                          view ↗
                        </a>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
