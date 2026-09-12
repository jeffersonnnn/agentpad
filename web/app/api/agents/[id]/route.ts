// GET /api/agents/:id — one agent + its distribution_config (SPEC.md section 7). Read-only.
// Returns { agent: Agent; distribution: DistributionConfig | null }.

import { NextResponse } from "next/server";
import { query, AGENT_COLS, UUID_RE, ADDR_RE } from "@/lib/server/db";
import type { Agent, DistributionConfig } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

// The :id path segment can be EITHER the agent's UUID or its token contract address, so the canonical
// URL is /agent/<contract>. We look up by whichever it matches (address case-insensitively).
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const byUuid = UUID_RE.test(id);
  const byAddr = ADDR_RE.test(id);
  if (!byUuid && !byAddr) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }

  try {
    const where = byUuid ? "id = $1" : "lower(token_addr) = lower($1)";
    const agents = await query<Agent>(`SELECT ${AGENT_COLS} FROM agents WHERE ${where}`, [id]);
    if (agents.length === 0) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    const agent = agents[0];
    const cfg = await query<DistributionConfig>(
      `SELECT agent_id, mode, rate_bps, cadence, high_water_usdg FROM distribution_config WHERE agent_id = $1`,
      [agent.id],
    );
    return NextResponse.json({ agent, distribution: cfg[0] ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
