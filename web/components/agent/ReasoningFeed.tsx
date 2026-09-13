"use client";

// The community REASONING FEED (SPEC.md feed table), styled as a classic macOS terminal window: the
// agent "thinks out loud" and holders watch the stream. Each entry is a thought, a trade, or a
// distribution, newest first; on-chain entries link to the explorer. Polls so new reasoning appears
// without a reload.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAgentFeed } from "@/lib/api";
import type { FeedEntry, FeedKind } from "@/lib/types";
import { txUrl } from "./onchain";
import { relativeTime, styles } from "./ui";

const TABS: { key: "all" | FeedKind; label: string }[] = [
  { key: "all", label: "all" },
  { key: "thought", label: "thoughts" },
  { key: "trade", label: "trades" },
  { key: "distribution", label: "distributions" },
];

// Terminal "command" verb per feed kind.
const VERB: Record<FeedKind, string> = {
  thought: "think",
  trade: "trade",
  distribution: "distribute",
  reaction: "react",
};

function TermLine({ entry }: { entry: FeedEntry }) {
  const verb = VERB[entry.kind] ?? entry.kind;
  const meta = entry.meta ?? {};
  const tags = Object.entries(meta)
    .filter(([, v]) => v !== null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, 6);

  return (
    <div className={styles.tLine}>
      <div className={styles.tCmd}>
        <span className={styles.tPrompt}>agent@slingshot</span>
        <span className={styles.tSep}>:</span>
        <span className={styles.tPath}>~</span>
        <span className={styles.tDollar}>$</span>
        <span className={`${styles.tVerb} ${styles[entry.kind] ?? ""}`}>{verb}</span>
        <span className={styles.tTime}># {relativeTime(entry.ts)}</span>
        {entry.tx_hash ? (
          <a className={styles.tTx} href={txUrl(entry.tx_hash)} target="_blank" rel="noreferrer">
            ↗ tx
          </a>
        ) : null}
      </div>
      {entry.text ? <div className={styles.tOut}>{entry.text}</div> : null}
      {tags.length ? (
        <div className={styles.tTags}>
          {tags.map(([k, v]) => (
            <span key={k} className={styles.tTag}>
              {k}={String(v)}
            </span>
          ))}
        </div>
      ) : null}
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
    <div className={styles.terminal}>
      <div className={styles.termBar}>
        <span className={styles.termDots}>
          <i className={styles.dotRed} />
          <i className={styles.dotYellow} />
          <i className={styles.dotGreen} />
        </span>
        <span className={styles.termTitle}>agent — reasoning — zsh</span>
        <span className={styles.termTabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? styles.termTabActive : styles.termTab}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </span>
      </div>

      <div className={styles.termBody}>
        {q.isLoading ? (
          <div className={styles.tSystem}>connecting to agent stream…</div>
        ) : q.isError ? (
          <div className={styles.tError}>error: could not load the feed — {(q.error as Error)?.message}</div>
        ) : !q.data || q.data.length === 0 ? (
          <div className={styles.tSystem}>
            <div>$ tail -f agent.log</div>
            <div className={styles.tDim}>waiting for the agent to think… nothing written yet.</div>
          </div>
        ) : (
          q.data.map((e) => <TermLine key={e.id} entry={e} />)
        )}
        <div className={styles.tCursorLine}>
          <span className={styles.tPrompt}>agent@slingshot</span>
          <span className={styles.tSep}>:</span>
          <span className={styles.tPath}>~</span>
          <span className={styles.tDollar}>$</span>
          <span className={styles.tCursor} aria-hidden />
        </div>
      </div>
    </div>
  );
}
