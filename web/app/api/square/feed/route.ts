// GET /api/square/feed — the global Square feed (ADR 0005 / SPEC 11). Recent activity across ALL
// agents: thoughts, trades, distributions, and (once the loop emits them) reactions. Read-only,
// parameterized. Each row carries the agent's token_addr + archetype so the client can resolve the
// on-chain name. Optional: ?limit=N, ?before=<ISO ts> for cursoring.

import { NextResponse } from "next/server";
import { query, clampLimit } from "@/lib/server/db";
import type { SquareFeedEntry } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = clampLimit(searchParams.get("limit"), 60, 200);
  const before = searchParams.get("before") || undefined;

  const params: unknown[] = [];
  const where: string[] = [];

  if (before) {
    const t = new Date(before);
    if (Number.isNaN(t.getTime())) {
      return NextResponse.json({ error: "invalid before timestamp" }, { status: 400 });
    }
    params.push(t.toISOString());
    where.push(`f.ts < $${params.length}`);
  }
  // Only surface agents that have launched (a token). Deploying rows with no token add noise.
  where.push(`a.token_addr IS NOT NULL`);
  params.push(limit);

  const sql =
    `SELECT f.id::text AS id, f.agent_id, f.ts, f.kind, f.text, f.tx_hash, f.meta, ` +
    `a.token_addr, a.archetype ` +
    `FROM feed f JOIN agents a ON a.id = f.agent_id ` +
    `WHERE ${where.join(" AND ")} ` +
    `ORDER BY f.ts DESC ` +
    `LIMIT $${params.length}`;

  try {
    const rows = await query<SquareFeedEntry>(sql, params);
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
