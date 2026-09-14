"use client";

// Agent page (Milestone 4). One live agent: its token price (read from the PONS curve), its wallet
// and treasury, its trades and distributions, and the community reasoning feed where holders watch it
// think. All data comes from the Milestone 3 read endpoints (lib/api) plus live on-chain reads; no
// mocks. Client component so wallet/chain reads and polling work; the read endpoints are same-origin.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getAgent, getAgentPositions } from "@/lib/api";
import { ARCHETYPES } from "@/lib/constants";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { ChartCard } from "@/components/agent/ChartCard";
import { MarketCard } from "@/components/agent/MarketCard";
import { FollowCard } from "@/components/agent/FollowCard";
import { OwnerActions } from "@/components/agent/OwnerActions";
import { CreatorSettings } from "@/components/agent/CreatorSettings";
import { NotificationBell } from "@/components/NotificationBell";
import { TradePanel } from "@/components/agent/TradePanel";
import { TreasuryPanel } from "@/components/agent/TreasuryPanel";
import { ReasoningFeed } from "@/components/agent/ReasoningFeed";
import { TradesPanel } from "@/components/agent/TradesPanel";
import { DistributionsPanel } from "@/components/agent/DistributionsPanel";
import { XConnectPanel } from "@/components/agent/XConnectPanel";
import { ConnectButton } from "@/components/ConnectButton";
import { ArchetypeChip, Card, ErrorNote, Skeleton, styles } from "@/components/agent/ui";

function StrategyCard({ archetype, persona }: { archetype: string; persona: string | null }) {
  const template = ARCHETYPES.find((a) => a.slug === archetype);
  return (
    <Card title="Strategy & persona">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <ArchetypeChip slug={archetype} />
        {template && <span className={styles.muted}>{template.notes}</span>}
      </div>
      {template && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {template.assets.map((a) => (
            <span key={a} className={styles.metaTag}>
              {a}
            </span>
          ))}
        </div>
      )}
      {persona ? <p className={styles.prose}>{persona}</p> : <p className={styles.muted}>No persona prompt recorded.</p>}
    </Card>
  );
}

export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const q = useQuery({
    queryKey: ["agent", id],
    queryFn: () => getAgent(id as string),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  return (
    <div className={styles.root}>
      <div className={styles.container}>
        <div className={styles.topbar}>
          <Link href="/" className={styles.brand}>
            Sling<span>shot</span>
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Link href="/board" className={styles.backlink}>
              ← All agents
            </Link>
            <NotificationBell />
            <ConnectButton />
          </div>
        </div>

        {q.isLoading ? (
          <div className={styles.stack}>
            <Skeleton height={90} />
            <div className={styles.grid2}>
              <Skeleton height={320} />
              <Skeleton height={320} />
            </div>
          </div>
        ) : q.isError ? (
          <ErrorNote>
            Could not load this agent. {(q.error as Error)?.message}
            <div style={{ marginTop: 8 }}>
              <Link href="/board" className={styles.addr}>
                Back to the board
              </Link>
            </div>
          </ErrorNote>
        ) : q.data ? (
          // Sub-resources key off the real UUID (data.agent.id), so the URL can be the token address.
          <AgentView agentId={q.data.agent.id} data={q.data} />
        ) : null}
      </div>
    </div>
  );
}

function AgentView({
  agentId,
  data,
}: {
  agentId: string;
  data: Awaited<ReturnType<typeof getAgent>>;
}) {
  const { agent, distribution } = data;
  const positionsQ = useQuery({
    queryKey: ["positions", agentId],
    queryFn: () => getAgentPositions(agentId),
    refetchInterval: 30_000,
  });

  return (
    <>
      <AgentHeader agent={agent} />
      <div className={styles.grid2}>
        <div className={styles.stack}>
          <ChartCard agent={agent} />
          <ReasoningFeed agentId={agentId} />
          <TradesPanel agentId={agentId} />
        </div>
        <div className={styles.stack}>
          <TradePanel agent={agent} />
          <FollowCard agent={agent} />
          <MarketCard agent={agent} />
          <TreasuryPanel agent={agent} positions={positionsQ.data ?? []} />
          <OwnerActions agent={agent} />
          <CreatorSettings agent={agent} distribution={distribution} />
          <DistributionsPanel agent={agent} config={distribution} />
          <StrategyCard archetype={agent.archetype} persona={agent.persona_prompt} />
          <XConnectPanel agent={agent} />
        </div>
      </div>
    </>
  );
}
