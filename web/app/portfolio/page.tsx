"use client";

// "My Agents" — the holder's home base. For the connected wallet, show every Slingshot coin it holds,
// the agent's treasury, the holder's share of it, and the profit distributed to holders. Read-only:
// the agent list comes from the DB, holdings + treasury are batched on-chain reads (multicall), and
// distributions come from the read API. All values are honest estimates labelled as such; the precise
// per-epoch claimed-vs-pending Merkle breakdown lands in a follow-up once agents start distributing.

import Link from "next/link";
import { useMemo } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";
import { getAgentDistributions, listAgents } from "@/lib/api";
import { CHAIN_ID, USDG } from "@/lib/constants";
import { ERC20_ABI, fmtUsdg } from "@/components/agent/onchain";
import { TokenLogo } from "@/components/agent/ui";
import { ConnectButton } from "@/components/ConnectButton";
import type { Agent } from "@/lib/types";
import styles from "./portfolio.module.css";

interface Holding {
  agent: Agent;
  symbol?: string;
  balance: bigint; // 18dp agent token
  supply: bigint; // 18dp
  treasuryUsdg: bigint; // 6dp (agent account USDG balance)
}

function pctOfSupply(balance: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  // ratio only — Number() on large bigints is fine for a percentage estimate
  return (Number(balance) / Number(supply)) * 100;
}
function shareUsdg(treasuryUsdg: bigint, balance: bigint, supply: bigint): bigint {
  if (supply <= 0n) return 0n;
  return (treasuryUsdg * balance) / supply; // precise bigint share
}
function fmtToken(bal: bigint): string {
  const n = Number(formatUnits(bal, 18));
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 2 });
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();

  const agentsQ = useQuery({
    queryKey: ["portfolio-agents"],
    queryFn: () => listAgents({ limit: 200 }),
    staleTime: 30_000,
  });
  const agents = useMemo(
    () => (agentsQ.data ?? []).filter((a) => a.token_addr && a.account_addr),
    [agentsQ.data],
  );

  // Batched reads: per agent -> [symbol, balanceOf(you), totalSupply, USDG.balanceOf(account)].
  const contracts = useMemo(() => {
    if (!address) return [];
    return agents.flatMap((a) => [
      { address: a.token_addr as Address, abi: ERC20_ABI, functionName: "symbol", chainId: CHAIN_ID },
      { address: a.token_addr as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [address], chainId: CHAIN_ID },
      { address: a.token_addr as Address, abi: ERC20_ABI, functionName: "totalSupply", chainId: CHAIN_ID },
      { address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [a.account_addr as Address], chainId: CHAIN_ID },
    ]);
  }, [agents, address]);

  const reads = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: !!address && agents.length > 0, refetchInterval: 30_000 },
  });

  const holdings: Holding[] = useMemo(() => {
    if (!reads.data) return [];
    const out: Holding[] = [];
    agents.forEach((agent, i) => {
      const base = i * 4;
      const symbol = reads.data?.[base]?.result as string | undefined;
      const balance = (reads.data?.[base + 1]?.result as bigint | undefined) ?? 0n;
      const supply = (reads.data?.[base + 2]?.result as bigint | undefined) ?? 0n;
      const treasuryUsdg = (reads.data?.[base + 3]?.result as bigint | undefined) ?? 0n;
      if (balance > 0n) out.push({ agent, symbol, balance, supply, treasuryUsdg });
    });
    return out.sort((a, b) => Number(shareUsdg(b.treasuryUsdg, b.balance, b.supply) - shareUsdg(a.treasuryUsdg, a.balance, a.supply)));
  }, [reads.data, agents]);

  const totalShareUsdg = holdings.reduce((acc, h) => acc + shareUsdg(h.treasuryUsdg, h.balance, h.supply), 0n);

  const loading = agentsQ.isLoading || (!!address && reads.isLoading);

  return (
    <div className={styles.root}>
      <div className={styles.container}>
        <div className={styles.topbar}>
          <Link href="/" className={styles.brand}>
            Sling<span>shot</span>
          </Link>
          <div className={styles.topRight}>
            <Link href="/board" className={styles.backlink}>
              ← All agents
            </Link>
            <ConnectButton />
          </div>
        </div>

        <header className={styles.head}>
          <h1 className={styles.title}>My Agents</h1>
          <p className={styles.sub}>Every Slingshot coin you hold, your share of its treasury, and the profit paid to holders.</p>
        </header>

        {!isConnected ? (
          <div className={styles.connectPrompt}>
            <p>Connect your wallet to see the agents you hold.</p>
            <ConnectButton />
          </div>
        ) : loading ? (
          <div className={styles.stack}>
            <div className={styles.skel} style={{ height: 96 }} />
            <div className={styles.skel} style={{ height: 150 }} />
            <div className={styles.skel} style={{ height: 150 }} />
          </div>
        ) : holdings.length === 0 ? (
          <div className={styles.empty}>
            <p>You do not hold any agent coins yet.</p>
            <Link href="/board" className={styles.cta}>Explore the board →</Link>
          </div>
        ) : (
          <>
            <div className={styles.summary}>
              <div className={styles.sumItem}>
                <span className={styles.sumLabel}>Your treasury share</span>
                <span className={styles.sumValue}>{fmtUsdg(totalShareUsdg)}</span>
              </div>
              <div className={styles.sumItem}>
                <span className={styles.sumLabel}>Agents held</span>
                <span className={styles.sumValue}>{holdings.length}</span>
              </div>
            </div>
            <div className={styles.stack}>
              {holdings.map((h) => (
                <HoldingCard key={h.agent.id} h={h} />
              ))}
            </div>
            <p className={styles.note}>
              Treasury share is your percent of supply applied to the agent&apos;s USDG treasury. Profit
              figures are estimates from published distributions; claim and per-epoch detail live on each
              agent&apos;s page.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function HoldingCard({ h }: { h: Holding }) {
  const { agent, symbol, balance, supply, treasuryUsdg } = h;
  const pct = pctOfSupply(balance, supply);
  const yourTreasury = shareUsdg(treasuryUsdg, balance, supply);
  const href = `/agent/${agent.token_addr}`;

  const distQ = useQuery({
    queryKey: ["portfolio-dist", agent.id],
    queryFn: () => getAgentDistributions(agent.id),
    staleTime: 60_000,
  });
  const distributedTotal = (distQ.data ?? []).reduce((acc, d) => acc + BigInt(d.total_usdg || "0"), 0n);
  const yourDist = shareUsdg(distributedTotal, balance, supply);

  return (
    <Link href={href} className={styles.card}>
      <div className={styles.cardLeft}>
        <TokenLogo src={agent.logo_url} symbol={symbol} size={52} />
        <div className={styles.cardId}>
          <div className={styles.cardName}>
            {symbol ? `$${symbol}` : "Agent"}
            <span className={styles.cardArch}>{String(agent.archetype)}</span>
          </div>
          <div className={styles.cardHolding}>
            {fmtToken(balance)} tokens · {pct < 0.01 ? "<0.01" : pct.toFixed(2)}% of supply
          </div>
        </div>
      </div>
      <div className={styles.cardStats}>
        <Stat label="Agent treasury" value={fmtUsdg(treasuryUsdg)} />
        <Stat label="Your share" value={fmtUsdg(yourTreasury)} accent />
        <Stat label="Paid to holders" value={fmtUsdg(distributedTotal)} />
        <Stat label="Your profit (est)" value={fmtUsdg(yourDist)} />
      </div>
      <span className={styles.cardArrow}>→</span>
    </Link>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={accent ? styles.statValueAccent : styles.statValue}>{value}</span>
    </div>
  );
}
