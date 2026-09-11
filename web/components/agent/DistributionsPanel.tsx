"use client";

// Distributions (ADR 0002 / SPEC.md section 3). Shows the creator-configured payout policy and the
// history of published Merkle epochs from the distributions table. Payout asset is always USDG.

import { type CSSProperties, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import { ApiError, getAgentDistributions, getClaim } from "@/lib/api";
import { CHAIN_ID, DISTRIBUTION_CADENCES, DISTRIBUTION_MODES } from "@/lib/constants";
import type { Agent, DistributionConfig } from "@/lib/types";
import { fmtUsdg, shortAddr, txUrl } from "./onchain";
import { AddressPill, Card, Empty, ErrorNote, relativeTime, Skeleton, StatRow, styles } from "./ui";

// Distributor.claim signature (byte-for-byte from src/Distributor.sol). The holder signs this
// client-side; the server only rebuilds the proof (ADR 0004 — never custody, never sign).
const DISTRIBUTOR_ABI = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "index", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "merkleProof", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

function modeLabel(mode: string): string {
  return DISTRIBUTION_MODES.find((m) => m.value === mode)?.label ?? mode;
}
function cadenceLabel(cadence: string): string {
  return DISTRIBUTION_CADENCES.find((c) => c.value === cadence)?.label ?? cadence;
}

export function DistributionsPanel({ agent, config }: { agent: Agent; config: DistributionConfig | null }) {
  const q = useQuery({
    queryKey: ["distributions", agent.id],
    queryFn: () => getAgentDistributions(agent.id),
    refetchInterval: 60_000,
  });

  return (
    <Card title="Distributions">
      <StatRow label="Policy">
        <span>{config ? modeLabel(config.mode) : "—"}</span>
      </StatRow>
      {config && config.mode !== "off" && (
        <>
          <StatRow label="Rate">
            <span>{(config.rate_bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}% of realized gain</span>
          </StatRow>
          <StatRow label="Cadence">
            <span>{cadenceLabel(config.cadence)}</span>
          </StatRow>
          <StatRow label="High-water mark">
            <span className={styles.statValueMono}>{fmtUsdg(config.high_water_usdg)}</span>
          </StatRow>
        </>
      )}
      <StatRow label="Distributor contract">
        <AddressPill addr={agent.distributor_addr} />
      </StatRow>

      <h3 className={styles.cardTitle} style={{ marginTop: 20 }}>
        Epochs
      </h3>
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
                <tr key={d.id}>
                  <td className={styles.num}>{d.epoch}</td>
                  <td className={styles.num}>{fmtUsdg(d.total_usdg)}</td>
                  <td>
                    <span className={styles.statValueMono} title={d.merkle_root}>
                      {shortAddr(d.merkle_root)}
                    </span>
                  </td>
                  <td>{relativeTime(d.ts)}</td>
                  <td>
                    <ClaimCell agentId={agent.id} distributor={agent.distributor_addr} epoch={d.epoch} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>
        Holders claim their pro-rata share in USDG by Merkle proof. Only realized gains above the
        high-water mark are distributed (SPEC.md section 3). Characterization is under legal review.
      </p>
    </Card>
  );
}

type ClaimState =
  | { kind: "idle" }
  | { kind: "working"; step: "fetching" | "signing" | "pending" }
  | { kind: "nothing" }
  | { kind: "success"; hash: Hex; amount: string }
  | { kind: "error"; message: string };

const claimBtnStyle: CSSProperties = {
  font: "inherit",
  fontSize: 13,
  padding: "3px 10px",
  borderRadius: 6,
  border: "1px solid currentColor",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

// One epoch's claim control. The holder's connected wallet signs Distributor.claim; the server only
// supplies the proof. Gated to Robinhood Chain (4663) — the claim is offered there or not at all.
function ClaimCell({
  agentId,
  distributor,
  epoch,
}: {
  agentId: string;
  distributor: Address | null;
  epoch: string;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [state, setState] = useState<ClaimState>({ kind: "idle" });

  const busy = state.kind === "working";

  async function onClaim() {
    if (!distributor) {
      setState({ kind: "error", message: "No distributor deployed for this agent yet." });
      return;
    }
    if (!isConnected || !address) {
      setState({ kind: "error", message: "Connect your wallet to claim." });
      return;
    }
    try {
      // Gate to Robinhood Chain (4663): the Distributor lives there.
      if (chainId !== CHAIN_ID) {
        await switchChainAsync({ chainId: CHAIN_ID });
      }

      setState({ kind: "working", step: "fetching" });
      let proof;
      try {
        proof = await getClaim(agentId, epoch, address as Address);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setState({ kind: "nothing" });
          return;
        }
        throw e;
      }

      setState({ kind: "working", step: "signing" });
      const hash = await writeContractAsync({
        address: distributor,
        abi: DISTRIBUTOR_ABI,
        functionName: "claim",
        args: [BigInt(proof.epoch), BigInt(proof.index), proof.account, BigInt(proof.amount), proof.proof],
        chainId: CHAIN_ID,
      });

      setState({ kind: "working", step: "pending" });
      if (publicClient) {
        const rc = await publicClient.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") {
          setState({ kind: "error", message: `Claim reverted (${hash}).` });
          return;
        }
      }
      setState({ kind: "success", hash, amount: proof.amount });
    } catch (e) {
      setState({ kind: "error", message: normalizeClaimError(e) });
    }
  }

  if (state.kind === "success") {
    return (
      <span className={styles.statValueMono}>
        Claimed {fmtUsdg(state.amount)}{" "}
        <a className={styles.addr} href={txUrl(state.hash)} target="_blank" rel="noreferrer">
          ↗
        </a>
      </span>
    );
  }
  if (state.kind === "nothing") {
    return <span className={styles.muted}>Nothing to claim</span>;
  }

  const stepLabel =
    state.kind === "working"
      ? state.step === "fetching"
        ? "Preparing…"
        : state.step === "signing"
          ? "Confirm in wallet…"
          : "Claiming…"
      : "Claim";

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <button type="button" style={claimBtnStyle} className={styles.addr} disabled={busy} onClick={onClaim}>
        {stepLabel}
      </button>
      {state.kind === "error" && <span className={styles.muted}>{state.message}</span>}
    </span>
  );
}

// Short, human line for a wallet/RPC/API error. Wallet rejection is the common case.
function normalizeClaimError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied|rejected the request/i.test(raw)) {
    return "You rejected the request in your wallet.";
  }
  return raw.split("\n")[0].slice(0, 200);
}
