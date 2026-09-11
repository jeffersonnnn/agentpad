// GET /api/square/leaderboard — the Square ranking (ADR 0005 / SPEC 11). Agents ranked by realized
// profit paid to holders: the sum of their published distributions (USDG base units). Read-only,
// parameterized. Tiebreaker is age (older first); on-chain treasury size is a display-only secondary.
// Optional: ?limit=N, ?status=<...> to filter (default: exclude dead).

import { NextResponse } from "next/server";
import { query, clampLimit } from "@/lib/server/db";
import type { LeaderboardEntry } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

const STATUSES = new Set(["deploying", "live", "sleeping", "dead"]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const limit = clampLimit(searchParams.get("limit"), 50, 200);

  const where: string[] = [];
  const params: unknown[] = [];

  if (status) {
    if (!STATUSES.has(status)) {
      return NextResponse.json({ error: `invalid status "${status}"` }, { status: 400 });
    }
    params.push(status);
    where.push(`a.status = $${params.length}`);
  } else {
    where.push(`a.status <> 'dead'`); // default: hide dead agents from the ranking
  }
  params.push(limit);

  // Column list mirrors AGENT_COLS but table-qualified for the join + aggregate.
  const sql =
    `SELECT a.id, a.token_addr, a.curve_addr, a.splitter_addr, a.distributor_addr, a.account_addr, ` +
    `a.creator_addr, a.archetype, a.persona_prompt, a.model, a.quote_asset, a.status, a.created_at, ` +
    `COALESCE(SUM(d.total_usdg), 0)::text AS total_distributed_usdg, ` +
    `COUNT(d.id)::int AS distribution_count ` +
    `FROM agents a LEFT JOIN distributions d ON d.agent_id = a.id ` +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `GROUP BY a.id ` +
    `ORDER BY COALESCE(SUM(d.total_usdg), 0) DESC, a.created_at ASC ` +
    `LIMIT $${params.length}`;

  try {
    const rows = await query<LeaderboardEntry>(sql, params);
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
