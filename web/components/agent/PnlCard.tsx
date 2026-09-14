"use client";

// Realized PnL + high-water mark + "distributable now" (read-only). Shows holders the payout that is
// building up. The numbers mirror the keeper distribution formula 1:1 (see web/lib/server/pnl.ts and
// api/keeper.mjs runDistributionEpoch), so this card shows the SAME amount the keeper would pay.
//
// This card is presentational. It moves no funds and reads no chain. All data arrives as the `pnl`
// prop, computed server-side by getAgentPnl.

import type { AgentPnl } from "@/lib/server/pnl";
import { Card, StatRow, styles } from "./ui";

// Format a whole-USDG string (e.g. "3.00" or "-2.00") as a dollar string. The value is negative when
// it starts with "-", so the sign goes before the "$" ("-$2.00", never "$-2.00").
function usd(whole: string): string {
  return whole.startsWith("-") ? `-$${whole.slice(1)}` : `$${whole}`;
}

export function PnlCard({ pnl }: { pnl: AgentPnl }) {
  // The keeper pays only on a 'distribute' policy. On any other mode the distributable is 0, so tell
  // the holder why with a subtle note.
  const policyOff = pnl.mode !== "distribute";

  return (
    <Card title="Realized PnL & payout">
      <StatRow label="Realized PnL">
        <span className={styles.statValueMono}>{usd(pnl.realized_usdg)}</span>
      </StatRow>
      <StatRow label="High-water mark">
        <span className={styles.statValueMono}>{usd(pnl.high_water_usdg)}</span>
      </StatRow>
      <StatRow label="Distributable now">
        <span className={styles.statValueMono}>{usd(pnl.distributable_usdg)}</span>
      </StatRow>

      {policyOff && (
        <p className={styles.note}>
          Payout policy is off, so nothing is distributable now. The keeper pays holders only on a
          &quot;distribute&quot; policy.
        </p>
      )}
      <p className={styles.note}>Realized gains above the high-water mark are what pays holders.</p>
    </Card>
  );
}
