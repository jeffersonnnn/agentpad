// SERVER-ONLY. The Square leaderboard metrics (roadmap item 5: the leaderboard as a discovery engine).
//
// One aggregate over agents + follows + feed + distributions gives every rankable metric in a single
// query. Money is kept in USDG base units (6 dec) throughout so ROI (realized / deployed) is a clean
// unitless ratio. Sorting is by a FIXED whitelist of ORDER BY expressions keyed by a validated sort key
// -- user input never reaches the SQL text. Archetype and status are parameterized.
//
// Note on the demand side: profit/ROI/win-rate are 0 until agents actually trade and distribute (today
// they are). They compute correctly now and light up automatically, so no rework later. The default
// sort is "followers" (the freshest signal, from the Follow feature), which discriminates today.

import { query } from "./db";
import type { LeaderboardEntry } from "../types";

export type SquareSort = "followers" | "active" | "profit" | "roi" | "winrate" | "trades" | "newest" | "oldest";

export const SQUARE_SORTS: SquareSort[] = ["followers", "active", "profit", "roi", "winrate", "trades", "newest", "oldest"];

// Fixed ORDER BY per sort. All columns come from the `m` CTE below (numeric), so ordering is exact and
// there is no SQL-injection surface (the key is validated against SQUARE_SORTS before lookup).
const SORT_SQL: Record<SquareSort, string> = {
  followers: "m.followers DESC, m.last_active DESC NULLS LAST",
  active: "m.last_active DESC NULLS LAST, m.feed_count DESC",
  profit: "m.distributed_usdg DESC, m.followers DESC",
  roi: "(CASE WHEN m.deployed_usdg > 0 THEN m.realized_usdg / m.deployed_usdg ELSE NULL END) DESC NULLS LAST, m.realized_usdg DESC",
  winrate: "(CASE WHEN m.closed > 0 THEN m.wins::numeric / m.closed ELSE NULL END) DESC NULLS LAST, m.closed DESC",
  trades: "m.trades DESC, m.followers DESC",
  newest: "m.created_at DESC",
  oldest: "m.created_at ASC",
};

export interface SquareQuery {
  sort?: SquareSort;
  archetype?: string;
  status?: string;
  limit?: number;
}

export async function leaderboard(opts: SquareQuery): Promise<LeaderboardEntry[]> {
  const sort: SquareSort = opts.sort && SQUARE_SORTS.includes(opts.sort) ? opts.sort : "followers";
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    params.push(opts.status);
    where.push(`a.status = $${params.length}`);
  } else {
    where.push(`a.status <> 'dead'`);
  }
  if (opts.archetype) {
    params.push(opts.archetype);
    where.push(`a.archetype = $${params.length}`);
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  // meta guards: only cast strings that are actually numeric so a malformed feed row cannot error the
  // whole query. realized_usdg is written as a base-6 integer string; notionalUsdg as a whole-USDG
  // decimal (converted to base-6 here so realized/deployed share units).
  const sql = `
    WITH f AS (
      SELECT agent_id,
        COUNT(*) FILTER (WHERE kind = 'trade') AS trades,
        COUNT(*) FILTER (WHERE kind = 'trade' AND meta->>'realized_usdg' ~ '^-?[0-9]+$') AS closed,
        COUNT(*) FILTER (WHERE kind = 'trade' AND meta->>'realized_usdg' ~ '^-?[0-9]+$' AND (meta->>'realized_usdg')::numeric > 0) AS wins,
        COALESCE(SUM((meta->>'realized_usdg')::numeric) FILTER (WHERE kind = 'trade' AND meta->>'realized_usdg' ~ '^-?[0-9]+$'), 0) AS realized_usdg,
        COALESCE(SUM(round((meta->>'notionalUsdg')::numeric * 1000000)) FILTER (WHERE kind = 'trade' AND meta->>'side' = 'buy' AND meta->>'notionalUsdg' ~ '^[0-9]+(\\.[0-9]+)?$'), 0) AS deployed_usdg,
        COUNT(*) AS feed_count,
        MAX(ts) AS last_active
      FROM feed GROUP BY agent_id
    ),
    fl AS (SELECT agent_id, COUNT(*) AS followers FROM follows GROUP BY agent_id),
    d AS (SELECT agent_id, COALESCE(SUM(total_usdg), 0) AS distributed_usdg, COUNT(*) AS distribution_count FROM distributions GROUP BY agent_id),
    m AS (
      SELECT a.id, a.token_addr, a.curve_addr, a.splitter_addr, a.distributor_addr, a.account_addr,
             a.creator_addr, a.archetype, a.persona_prompt, a.model, a.quote_asset, a.status, a.logo_url, a.created_at,
             COALESCE(fl.followers, 0) AS followers,
             COALESCE(f.trades, 0) AS trades,
             COALESCE(f.closed, 0) AS closed,
             COALESCE(f.wins, 0) AS wins,
             COALESCE(f.realized_usdg, 0) AS realized_usdg,
             COALESCE(f.deployed_usdg, 0) AS deployed_usdg,
             COALESCE(f.feed_count, 0) AS feed_count,
             f.last_active,
             COALESCE(d.distributed_usdg, 0) AS distributed_usdg,
             COALESCE(d.distribution_count, 0) AS distribution_count
      FROM agents a
      LEFT JOIN f ON f.agent_id = a.id
      LEFT JOIN fl ON fl.agent_id = a.id
      LEFT JOIN d ON d.agent_id = a.id
      WHERE ${where.join(" AND ")}
    )
    SELECT id, token_addr, curve_addr, splitter_addr, distributor_addr, account_addr, creator_addr,
           archetype, persona_prompt, model, quote_asset, status, logo_url, created_at,
           followers::int AS followers, trades::int AS trades, closed::int AS closed, wins::int AS wins,
           feed_count::int AS feed_count, last_active, distribution_count::int AS distribution_count,
           realized_usdg::text AS realized_usdg,
           deployed_usdg::text AS deployed_usdg,
           distributed_usdg::text AS total_distributed_usdg
    FROM m
    ORDER BY ${SORT_SQL[sort]}, m.created_at ASC
    LIMIT ${limitParam}`;

  return query<LeaderboardEntry>(sql, params);
}
