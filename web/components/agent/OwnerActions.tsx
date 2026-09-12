"use client";

// Owner actions for one agent:
//   1. TOP UP — anyone can fund the agent's ERC-4337 account (it pays its own gas from ETH and trades
//      from USDG). The address is shown copyable; a small form sends ETH or USDG from the connected
//      wallet straight to the account (the user signs their own transfer; we never custody).
//   2. CLAIM FEES — the agent's CREATOR can trigger FeeSplitter.claimAndRoute() on demand. The creator
//      signs a message; the server (DEPLOYER_KEY, the splitter owner) runs the routing and 80% of the
//      swept fees land in the treasury. Useful to top the treasury up from accrued fees.

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { parseEther, parseUnits, type Address } from "viem";
import type { Agent } from "@/lib/types";
import { CHAIN_ID, USDG, USDG_DECIMALS } from "@/lib/constants";
import { claimAgentFees, claimFeesMessage, type ClaimFeesResult } from "@/lib/api";
import { reportClient, describeError } from "@/lib/observatory-client";
import { fmtUsdg } from "./onchain";
import { Card, CopyAddress, styles } from "./ui";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export function OwnerActions({ agent }: { agent: Agent }) {
  const account = agent.account_addr as Address | null;
  const { address: connected } = useAccount();
  const isCreator =
    !!connected && connected.toLowerCase() === agent.creator_addr.toLowerCase();

  return (
    <Card title="Fund & manage">
      {account ? (
        <>
          <p className={styles.muted} style={{ marginTop: 0 }}>
            Top up this agent. It pays its own gas in ETH and trades from USDG (ADR 0004).
          </p>
          <div style={{ marginBottom: 12 }}>
            <CopyAddress addr={account} label="Agent account" />
          </div>
          <TopUpForm account={account} />
        </>
      ) : (
        <p className={styles.muted}>The agent account is not set yet.</p>
      )}

      {isCreator ? <ClaimFees agent={agent} /> : null}
    </Card>
  );
}

function TopUpForm({ account }: { account: Address }) {
  const { isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [asset, setAsset] = useState<"ETH" | "USDG">("ETH");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const wrongChain = isConnected && chainId !== CHAIN_ID;

  async function send() {
    setErr(null);
    setMsg(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setErr("Enter an amount greater than 0.");
      return;
    }
    if (!walletClient || !publicClient) {
      setErr("Connect your wallet first.");
      return;
    }
    if (chainId !== CHAIN_ID) {
      setErr("Switch your wallet to Robinhood Chain (4663).");
      return;
    }
    setBusy(true);
    try {
      let hash: `0x${string}`;
      if (asset === "ETH") {
        hash = await walletClient.sendTransaction({ to: account, value: parseEther(amount) });
      } else {
        hash = await walletClient.writeContract({
          address: USDG,
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [account, parseUnits(amount, USDG_DECIMALS)],
        });
      }
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`Transfer reverted (${hash}).`);
      setMsg(`Sent ${amount} ${asset} to the agent.`);
      setAmount("");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setErr(/user rejected|denied/i.test(raw) ? "You rejected the request in your wallet." : raw.split("\n")[0].slice(0, 200));
    } finally {
      setBusy(false);
    }
  }

  if (!isConnected) {
    return <p className={styles.muted}>Connect a wallet to top up, or send funds to the address above.</p>;
  }

  return (
    <div className={styles.topupRow}>
      <select
        className={styles.topupSelect}
        value={asset}
        onChange={(e) => setAsset(e.target.value as "ETH" | "USDG")}
        disabled={busy}
        aria-label="Asset to send"
      >
        <option value="ETH">ETH</option>
        <option value="USDG">USDG</option>
      </select>
      <input
        className={styles.topupInput}
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0.0"
        inputMode="decimal"
        disabled={busy}
      />
      <button type="button" className={styles.topupBtn} onClick={send} disabled={busy || wrongChain}>
        {busy ? "Sending…" : "Top up"}
      </button>
      {wrongChain ? <span className={styles.topupErr}>Switch to Robinhood Chain (4663).</span> : null}
      {msg ? <span className={styles.topupOk}>{msg}</span> : null}
      {err ? <span className={styles.topupErr}>{err}</span> : null}
    </div>
  );
}

function ClaimFees({ agent }: { agent: Agent }) {
  const { data: walletClient } = useWalletClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaimFeesResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function claim() {
    setErr(null);
    setResult(null);
    if (!walletClient) {
      setErr("Connect your creator wallet first.");
      return;
    }
    if (!window.confirm("Claim accrued fees and route them now? 80% goes to the agent treasury.")) {
      return;
    }
    setBusy(true);
    try {
      const message = claimFeesMessage(agent.id, new Date().toISOString());
      const signature = await walletClient.signMessage({ message });
      const res = await claimAgentFees(agent.id, { message, signature });
      setResult(res);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setErr(/user rejected|denied/i.test(raw) ? "You rejected the signature." : raw.split("\n")[0].slice(0, 240));
      const { message, detail } = describeError(e);
      void reportClient({ scope: "agent.claim-fees.client", message, detail: { ...detail, agentId: agent.id } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.ownerClaim}>
      <h3 className={styles.cardTitle} style={{ marginTop: 18 }}>
        Creator: claim fees
      </h3>
      <p className={styles.muted} style={{ marginTop: 0 }}>
        Sweep accrued creator fees and route them now. 80% funds the treasury; 20% buy-and-burns the
        platform token.
      </p>
      <button type="button" className={styles.claimBtn} onClick={claim} disabled={busy}>
        {busy ? "Claiming…" : "Claim fees now"}
      </button>
      {result ? (
        result.claimed === false ? (
          <p className={styles.muted}>{result.message}</p>
        ) : (
          <p className={styles.topupOk}>
            Routed{result.agentAmount ? ` ${fmtUsdg(result.agentAmount)} to the treasury` : ""}.{" "}
            {result.txHash ? <code className={styles.copyValue}>{result.txHash.slice(0, 10)}…</code> : null}
          </p>
        )
      ) : null}
      {err ? <p className={styles.topupErr}>{err}</p> : null}
    </div>
  );
}
