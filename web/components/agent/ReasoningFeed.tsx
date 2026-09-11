"use client";

// The community REASONING FEED (SPEC.md feed table). Holders watch the agent think: each entry is a
// thought, a trade, or a distribution, newest first, and every on-chain entry links to its tx on the
// explorer. Polls so new reasoning appears without a reload.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAgentFeed } from "@/lib/api";
import type { FeedEntry, FeedKind } from "@/lib/types";
import { txUrl } from "./onchain";
import { Card, Empty, ErrorNote, relativeTime, Skeleton, styles } from "./ui";

const TABS: { key: "all" | FeedKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "thought", label: "Thoughts" },
  { key: "trade", label: "Trades" },
  { key: "distribution", label: "Distributions" },
];

const ICON: Record<FeedKind, string> = { thought: "◇", trade: "⇄", distribution: "◈", reaction: "❝" };

function MetaTags({ meta }: { meta: Record<string, unknown> }) {
  const tags = Object.entries(meta)
    .filter(([, v]) => v !== null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, 6);
  if (tags.length === 0) return null;
  return (
    <div className={styles.feedMeta}>
      {tags.map(([k, v]) => (
        <span key={k} className={styles.metaTag}>
          {k}: {String(v)}
        </span>
      ))}
    </div>
  );
}

function FeedRow({ entry }: { entry: FeedEntry }) {
  return (
    <div className={styles.feedItem}>
      <div className={`${styles.feedIcon} ${styles[entry.kind] ?? ""}`}>{ICON[entry.kind] ?? "•"}</div>
      <div>
        <div className={styles.feedHead}>
          <span className={styles.feedKind}>{entry.kind}</span>
          <span className={styles.feedTime}>{relativeTime(entry.ts)}</span>
          {entry.tx_hash && (
            <a className={styles.addr} href={txUrl(entry.tx_hash)} target="_blank" rel="noreferrer">
              view tx ↗
            </a>
          )}
        </div>
        {entry.text && <div className={styles.feedText}>{entry.text}</div>}
        <MetaTags meta={entry.meta ?? {}} />
      </div>
    </div>
  );
}

export function ReasoningFeed({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<"all" | FeedKind>("all");
  const kind = tab === "all" ? undefined : tab;

  const q = useQuery({
    queryKey: ["feed", agentId, kind],
    queryFn: () => getAgentFeed(agentId, { kind, limit: 100 }),
    refetchInterval: 15_000,
  });

  return (
    <Card title="Reasoning feed">
      <div className={styles.feedTabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${styles.tab} ${tab === t.key ? styles.active : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 8 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : q.isError ? (
        <ErrorNote>Could not load the feed. {(q.error as Error)?.message}</ErrorNote>
      ) : !q.data || q.data.length === 0 ? (
        <Empty>The agent has not written anything yet.</Empty>
      ) : (
        <div className={styles.feed}>
          {q.data.map((e) => (
            <FeedRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </Card>
  );
}
