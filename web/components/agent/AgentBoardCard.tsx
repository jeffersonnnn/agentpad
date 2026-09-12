"use client";

// One agent on the discover board. Reads the token name/ticker on-chain (the agents row has none),
// and links to the full agent page.

import Link from "next/link";
import type { Agent } from "@/lib/types";
import { shortAddr, useTokenMeta } from "./onchain";
import { archetypeLabel, relativeTime, StatusBadge, styles } from "./ui";

export function AgentBoardCard({ agent }: { agent: Agent }) {
  const meta = useTokenMeta(agent.token_addr);
  const name = meta.name ?? "Agent";
  const symbol = meta.symbol ? `$${meta.symbol}` : shortAddr(agent.token_addr ?? undefined);

  return (
    <Link href={`/agent/${agent.token_addr ?? agent.id}`} className={styles.agentCard}>
      <div className={styles.agentCardTop}>
        <div className={styles.agentCardName}>
          {name}
          <span className={styles.ticker} style={{ fontSize: 13 }}>
            {symbol}
          </span>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      <span className={styles.chip} style={{ alignSelf: "flex-start" }}>
        {archetypeLabel(agent.archetype)}
      </span>

      {agent.persona_prompt && (
        <p className={styles.muted} style={{ margin: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {agent.persona_prompt}
        </p>
      )}

      <div className={styles.agentCardFoot}>
        <span>paired in {String(agent.quote_asset).toUpperCase()}</span>
        <span>{relativeTime(agent.created_at)}</span>
      </div>
    </Link>
  );
}
