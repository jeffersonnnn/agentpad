// GET /api/agents/:id — one agent + its distribution_config (SPEC.md section 7). Read-only.
// Returns { agent: Agent; distribution: DistributionConfig | null }.

import { NextResponse } from "next/server";
import { query, AGENT_COLS, UUID_RE } from "@/lib/server/db";
import type { Agent, DistributionConfig } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }

  try {
    const agents = await query<Agent>(`SELECT ${AGENT_COLS} FROM agents WHERE id = $1`, [id]);
    if (agents.length === 0) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    const cfg = await query<DistributionConfig>(
      `SELECT agent_id, mode, rate_bps, cadence, high_water_usdg FROM distribution_config WHERE agent_id = $1`,
      [id],
    );
    return NextResponse.json({ agent: agents[0], distribution: cfg[0] ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
