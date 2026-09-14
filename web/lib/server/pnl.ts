// SERVER-ONLY. Realized PnL, high-water mark, and "distributable now" for one agent.
//
// This module is READ-ONLY. It never moves funds. It mirrors the keeper distribution formula
// (api/keeper.mjs, runDistributionEpoch) 1:1 so the card shows holders the SAME number the keeper
// would pay. The keeper is the source of truth. Do not invent a different formula here.
//
// The keeper formula (all money is USDG base units, 6 decimals):
//   cumulativeRealized = SUM((feed.meta->>'realized_usdg')::numeric) over rows
//                        WHERE agent_id = $1 AND kind = 'trade'   (can be negative)
//   hwm                = distribution_config.high_water_usdg
//   excess             = cumulativeRealized - hwm
//   distributable      = excess <= 0 ? 0 : (excess * rate_bps) / 10000   (integer bigint division)
//   distributable is paid ONLY when distribution_config.mode = 'distribute'.
//
// The feed.meta key name matches the keeper const REALIZED_KEY (env override KEEPER_REALIZED_KEY,
// default "realized_usdg").

import { query } from "./db";
import type { DistributionMode } from "../constants";

// The feed.meta key that holds a trade's realized USDG (base units). Same default and env override as
// the keeper (KEEPER_REALIZED_KEY). Kept in lockstep so the card and the keeper read the same key.
const REALIZED_KEY = process.env.KEEPER_REALIZED_KEY || "realized_usdg";

// USDG has 6 decimals. One whole USDG is 1_000_000 base units.
const USDG_BASE = 1_000_000n;

// The read-only PnL view for one agent. Money fields come in two forms:
//   - *_base:  USDG base units (6 decimals), as a decimal string (can be negative).
//   - the whole USDG strings: the same amount formatted to 2 decimals for display (can be negative).
export interface AgentPnl {
  realized_usdg_base: string; // cumulative realized PnL, USDG base units (may be negative)
  realized_usdg: string; // cumulative realized PnL, whole USDG, 2 decimals (may be negative)
  high_water_usdg: string; // high-water mark, whole USDG, 2 decimals
  distributable_usdg: string; // distributable now, whole USDG, 2 decimals
  mode: DistributionMode; // payout policy mode ('distribute' | 'buyback' | 'off')
  rate_bps: number; // payout rate in basis points (0..10000)
}

interface PnlRow {
  realized_base: string;
  hwm_base: string;
  rate_bps: number;
  mode: string;
}

// Format a USDG base-unit amount (6 decimals) as a whole USDG string with 2 decimals. The function
// truncates to 2 decimals (it does not round), which keeps the display consistent with the integer
// base-unit math above. It handles negative amounts.
function toWholeUsdg(base: bigint): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / USDG_BASE;
  const cents = (abs % USDG_BASE) / 10_000n; // the first 2 of the 6 fractional digits (0..99)
  const text = `${whole.toString()}.${cents.toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

// Compute the read-only PnL view for one agent in ONE SQL round trip.
//
// The realized sum mirrors the keeper query exactly (same WHERE, same cast, same COALESCE). The
// LEFT JOIN on distribution_config makes a missing config safe: hwm = 0, rate_bps = 0, mode = 'off'.
// The distributable math runs in JS with BigInt to match the keeper's integer semantics 1:1.
export async function getAgentPnl(agentId: string): Promise<AgentPnl> {
  const rows = await query<PnlRow>(
    `SELECT
       (SELECT COALESCE(SUM((meta->>$2)::numeric), 0)::text
          FROM feed
         WHERE agent_id = a.id AND kind = 'trade') AS realized_base,
       COALESCE(dc.high_water_usdg, 0)::text AS hwm_base,
       COALESCE(dc.rate_bps, 0)              AS rate_bps,
       COALESCE(dc.mode, 'off')::text        AS mode
     FROM agents a
     LEFT JOIN distribution_config dc ON dc.agent_id = a.id
     WHERE a.id = $1`,
    [agentId, REALIZED_KEY],
  );

  // No such agent: return a safe, zeroed, read-only view. Nothing is ever paid on 'off'.
  if (rows.length === 0) {
    return {
      realized_usdg_base: "0",
      realized_usdg: "0.00",
      high_water_usdg: "0.00",
      distributable_usdg: "0.00",
      mode: "off",
      rate_bps: 0,
    };
  }

  const row = rows[0];
  const realizedBase = BigInt(row.realized_base);
  const hwm = BigInt(row.hwm_base);
  const rateBps = Number(row.rate_bps) || 0;
  const mode = (row.mode as DistributionMode) || "off";

  // Mirror the keeper: excess above the high-water mark, floored at 0, times the rate, integer
  // division by 10000. The keeper pays ONLY when mode is 'distribute', so a 'buyback' or 'off'
  // policy shows 0 distributable here as well.
  const excess = realizedBase - hwm;
  let distributableBase = 0n;
  if (mode === "distribute" && excess > 0n) {
    distributableBase = (excess * BigInt(rateBps)) / 10_000n;
    if (distributableBase < 0n) distributableBase = 0n;
  }

  return {
    realized_usdg_base: realizedBase.toString(),
    realized_usdg: toWholeUsdg(realizedBase),
    high_water_usdg: toWholeUsdg(hwm),
    distributable_usdg: toWholeUsdg(distributableBase),
    mode,
    rate_bps: rateBps,
  };
}
