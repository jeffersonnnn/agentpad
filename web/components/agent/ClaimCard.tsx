"use client";

// One-click claim (roadmap 2 / ADR 0002, 0004). A token holder claims their pro-rata USDG share of
// the newest published epoch straight from the agent page. The server only rebuilds the Merkle proof
// (GET /api/agents/:id/claim); the holder's own wallet signs Distributor.claim. Slingshot never signs
// and never custodies (ADR 0004).
//
// This file also exports the reusable claim hook + button that DistributionHistory uses per row, so
// the claim flow lives in one place.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import { ApiError, getAgentDistributions, getClaim, type ClaimProof } from "@/lib/api";
import { CHAIN_ID } from "@/lib/constants";
import type { Agent } from "@/lib/types";
import { fmtUsdg, txUrl } from "./onchain";
import { Card, Empty, ErrorNote, Skeleton, StatRow, styles } from "./ui";

// Distributor.claim signature, byte-for-byte from api/keeper.mjs DISTRIBUTOR_ABI and src/Distributor.sol.
// Mirrored here (minimal ABI) so the holder's wallet encodes the exact call: claim(epoch, index,
// account, amount, merkleProof). The keeper leaf is keccak256(abi.encodePacked(epoch,index,account,amount)).
export const DISTRIBUTOR_CLAIM_ABI = [
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

// ── Reusable claim proof probe ──────────────────────────────────────────────────────────────────
// Fetches the holder's proof for (agent, epoch). A 404 means the wallet is not in that epoch, so it
// resolves to null (not an error). Used to show "Nothing to claim" versus a live Claim button.
export function useClaimProof(agentId: string, epoch: string | null, address?: Address) {
  return useQuery<ClaimProof | null>({
    queryKey: ["claim-proof", agentId, epoch, address?.toLowerCase()],
    enabled: !!epoch && !!address,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        return await getClaim(agentId, epoch as string, address as Address);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null; // not in this epoch
        throw e;
      }
    },
  });
}

type ClaimState =
  | { kind: "idle" }
  | { kind: "working"; step: "signing" | "pending" }
  | { kind: "success"; hash: Hex; amount: string }
  | { kind: "error"; message: string };

// ── Reusable claim button ─────────────────────────────────────────────────────────────────────────
// One epoch, one wallet. The button appears only when a proof exists (the wallet is eligible). It
// gates to Robinhood Chain (4663), then the connected wallet signs Distributor.claim. Slingshot never
// sends this transaction: the holder does, in their own wallet.
export function ClaimButton({
  distributor,
  proof,
}: {
  distributor: Address | null;
  proof: ClaimProof;
}) {
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
    try {
      // Gate to Robinhood Chain (4663): the Distributor lives there.
      await switchChainAsync({ chainId: CHAIN_ID });

      setState({ kind: "working", step: "signing" });
      const hash = await writeContractAsync({
        address: distributor,
        abi: DISTRIBUTOR_CLAIM_ABI,
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
          &#8599;
        </a>
      </span>
    );
  }

  const label =
    state.kind === "working"
      ? state.step === "signing"
        ? "Confirm in wallet…"
        : "Claiming…"
      : `Claim ${fmtUsdg(proof.amount)}`;

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <button
        type="button"
        className={styles.addr}
        style={{
          font: "inherit",
          fontSize: 13,
          padding: "3px 10px",
          borderRadius: 6,
          border: "1px solid currentColor",
          background: "transparent",
          color: "inherit",
          cursor: busy ? "default" : "pointer",
        }}
        disabled={busy || !distributor}
        onClick={onClaim}
      >
        {label}
      </button>
      {state.kind === "error" && <span className={styles.muted}>{state.message}</span>}
    </span>
  );
}

// Short, human line for a wallet/RPC/API error. Wallet rejection is the common case.
export function normalizeClaimError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied|rejected the request/i.test(raw)) {
    return "You rejected the request in your wallet.";
  }
  return raw.split("\n")[0].slice(0, 200);
}

// ── The card: claim the newest epoch ──────────────────────────────────────────────────────────────
export function ClaimCard({ agent }: { agent: Agent }) {
  const { address, isConnected } = useAccount();

  // Newest published epoch for this agent.
  const distQ = useQuery({
    queryKey: ["distributions", agent.id],
    queryFn: () => getAgentDistributions(agent.id),
    refetchInterval: 60_000,
  });
  const latest = distQ.data && distQ.data.length > 0 ? distQ.data[0] : null;

  // The connected wallet's proof for that epoch (null when not eligible).
  const proofQ = useClaimProof(agent.id, latest?.epoch ?? null, address as Address | undefined);

  return (
    <Card title="Claim your share">
      <StatRow label="Latest epoch">
        <span className={styles.statValueMono}>{latest ? `#${latest.epoch}` : "—"}</span>
      </StatRow>
      {latest && (
        <StatRow label="Epoch total">
          <span className={styles.statValueMono}>{fmtUsdg(latest.total_usdg)}</span>
        </StatRow>
      )}

      <div style={{ marginTop: 12 }}>{renderBody()}</div>

      <p className={styles.note}>
        You claim your pro-rata USDG share by Merkle proof. Slingshot never signs and never holds your
        funds: your own wallet sends the claim. Characterization is under legal review.
      </p>
    </Card>
  );

  function renderBody() {
    if (!agent.distributor_addr) {
      return <Empty>No distributor is deployed for this agent yet, so there is nothing to claim.</Empty>;
    }
    if (distQ.isLoading) return <Skeleton height={22} />;
    if (distQ.isError) {
      return <ErrorNote>Could not load distributions. {(distQ.error as Error)?.message}</ErrorNote>;
    }
    if (!latest) return <Empty>No distribution is published yet. Come back after the first payout.</Empty>;
    if (!isConnected || !address) {
      return <span className={styles.muted}>Connect your wallet to check your share.</span>;
    }
    if (proofQ.isLoading) return <Skeleton height={22} />;
    if (proofQ.isError) {
      return <ErrorNote>Could not load your proof. {(proofQ.error as Error)?.message}</ErrorNote>;
    }
    if (!proofQ.data) return <span className={styles.muted}>Nothing to claim for epoch #{latest.epoch}.</span>;
    return <ClaimButton distributor={agent.distributor_addr} proof={proofQ.data} />;
  }
}
