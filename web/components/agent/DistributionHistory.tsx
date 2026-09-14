"use client";

// Per-agent distribution history (roadmap 2 / ADR 0002). Lists every published Merkle epoch, newest
// first, with the epoch total in USDG, the date, and a per-epoch claim button for each epoch where
// the connected wallet is eligible. The claim flow itself lives in ClaimCard (ClaimButton +
// useClaimProof), so it is reused, not forked. Read-only data comes from GET /api/agents/:id/distributions.

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { getAgentDistributions } from "@/lib/api";
import type { Agent, Distribution } from "@/lib/types";
import { ClaimButton, useClaimProof } from "./ClaimCard";
import { fmtUsdg, shortAddr } from "./onchain";
import { Card, Empty, ErrorNote, relativeTime, Skeleton, styles } from "./ui";

export function DistributionHistory({ agent }: { agent: Agent }) {
  const q = useQuery({
    queryKey: ["distributions", agent.id],
    queryFn: () => getAgentDistributions(agent.id),
    refetchInterval: 60_000,
  });

  return (
    <Card title="Distribution history">
      {q.isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : q.isError ? (
        <ErrorNote>Could not load distributions. {(q.error as Error)?.message}</ErrorNote>
      ) : !q.data || q.data.length === 0 ? (
        <Empty>No distributions published yet.</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Epoch</th>
                <th className={styles.num}>Total (USDG)</th>
                <th>Merkle root</th>
                <th>When</th>
                <th>Claim</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((d) => (
                <EpochRow key={d.id} agent={agent} dist={d} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>
        Each epoch pays holders their pro-rata USDG share by Merkle proof. Only realized gains above
        the high-water mark are distributed (SPEC.md section 3).
      </p>
    </Card>
  );
}

// One epoch row. It probes the connected wallet's proof so the Claim cell shows a live button only
// where the wallet is eligible, and "Nothing to claim" otherwise.
function EpochRow({ agent, dist }: { agent: Agent; dist: Distribution }) {
  const { address, isConnected } = useAccount();
  const proofQ = useClaimProof(agent.id, dist.epoch, address as Address | undefined);

  return (
    <tr>
      <td className={styles.num}>#{dist.epoch}</td>
      <td className={styles.num}>{fmtUsdg(dist.total_usdg)}</td>
      <td>
        <span className={styles.statValueMono} title={dist.merkle_root}>
          {shortAddr(dist.merkle_root)}
        </span>
      </td>
      <td>{relativeTime(dist.ts)}</td>
      <td>{renderClaim()}</td>
    </tr>
  );

  function renderClaim() {
    if (!agent.distributor_addr) return <span className={styles.muted}>No distributor</span>;
    if (!isConnected || !address) return <span className={styles.muted}>Connect wallet</span>;
    if (proofQ.isLoading) return <span className={styles.muted}>Checking…</span>;
    if (proofQ.isError) return <span className={styles.muted}>Unavailable</span>;
    if (!proofQ.data) return <span className={styles.muted}>Nothing to claim</span>;
    return <ClaimButton distributor={agent.distributor_addr} proof={proofQ.data} />;
  }
}
