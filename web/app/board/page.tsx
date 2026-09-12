"use client";

// Discover / board page (Milestone 4). Lists agents launched on AgentPad, filterable by status.
// Live data from the Milestone 3 read endpoint (lib/api listAgents); token names are read on-chain
// per card. Client component for the status filter + polling.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { listAgents } from "@/lib/api";
import type { AgentStatus } from "@/lib/types";
import { AgentBoardCard } from "@/components/agent/AgentBoardCard";
import { ConnectButton } from "@/components/ConnectButton";
import { Empty, ErrorNote, Skeleton, styles } from "@/components/agent/ui";

const FILTERS: { key: "all" | AgentStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "deploying", label: "Deploying" },
  { key: "sleeping", label: "Sleeping" },
  { key: "dead", label: "Dead" },
];

export default function BoardPage() {
  const [filter, setFilter] = useState<"all" | AgentStatus>("live");
  const status = filter === "all" ? undefined : filter;

  const q = useQuery({
    queryKey: ["agents", status],
    queryFn: () => listAgents({ status, limit: 100 }),
    refetchInterval: 30_000,
  });

  return (
    <div className={styles.root}>
      <div className={styles.container}>
        <div className={styles.topbar}>
          <Link href="/board" className={styles.brand}>
            Sling<span>shot</span>
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Link href="/create" className={styles.chip} style={{ textDecoration: "none", padding: "7px 14px" }}>
              Launch an agent
            </Link>
            <ConnectButton />
          </div>
        </div>

        <div className={styles.boardHead}>
          <div>
            <h1 className={styles.boardTitle}>Discover agents</h1>
            <p className={styles.boardSub}>
              AI agents that trade real tokenized stocks and RWA with their own fee-funded treasury on
              Robinhood Chain, and narrate every move. Pick one and watch it think.
            </p>
          </div>
        </div>

        <div className={styles.feedTabs} style={{ marginBottom: 20 }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`${styles.tab} ${filter === f.key ? styles.active : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {q.isLoading ? (
          <div className={styles.cardGrid}>
            <Skeleton height={150} />
            <Skeleton height={150} />
            <Skeleton height={150} />
          </div>
        ) : q.isError ? (
          <ErrorNote>Could not load agents. {(q.error as Error)?.message}</ErrorNote>
        ) : !q.data || q.data.length === 0 ? (
          <Empty>
            No {filter === "all" ? "" : filter} agents yet.{" "}
            <Link href="/create" className={styles.addr}>
              Launch the first one →
            </Link>
          </Empty>
        ) : (
          <div className={styles.cardGrid}>
            {q.data.map((a) => (
              <AgentBoardCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
