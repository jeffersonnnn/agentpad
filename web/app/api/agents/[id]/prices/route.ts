// GET /api/agents/:id/prices — native price history for the agent chart.
//
// On each read we sample the current curve spot price into price_points (deduped server-side), then
// return the recent series. So the chart builds itself while the token is viewed, with no external
// indexer and no dependency on PONS. Pre-graduation this tracks the bonding-curve marginal price;
// after graduation the client prefers the DexScreener chart instead.

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { query, UUID_RE } from "@/lib/server/db";
import { recordPoint, readSeries } from "@/lib/server/prices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  try {
    const rows = await query<{ curve_addr: Address | null; quote_asset: string }>(
      "SELECT curve_addr, quote_asset FROM agents WHERE id = $1",
      [id],
    );
    const agent = rows[0];
    if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

    if (agent.curve_addr) {
      // Sample-on-view (best-effort, deduped). Do not let a slow/failed sample block the read.
      await recordPoint(id, agent.curve_addr, agent.quote_asset);
    }
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 500;
    const series = await readSeries(id, limit);
    return NextResponse.json(series);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
