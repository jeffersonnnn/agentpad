// POST /api/agents/:id/distribution — update the agent's payout policy (agent control panel).
//
// Creator-signed. Upserts distribution_config (mode / rate_bps / cadence) that the keeper reads each
// epoch (api/keeper.mjs). Does not touch the high-water mark. The signed message binds the three values
// so a tampered field fails the check.

import { NextResponse } from "next/server";
import { query, UUID_RE } from "@/lib/server/db";
import { creatorOf, verifyCreator } from "@/lib/server/creator-auth";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

const MODES = new Set(["distribute", "buyback", "off"]);
const CADENCES = new Set(["hourly", "daily", "weekly"]);

export async function POST(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  let body: { mode?: unknown; rate_bps?: unknown; cadence?: unknown; message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const mode = String(body.mode);
  const cadence = String(body.cadence);
  const rate = Number(body.rate_bps);
  if (!MODES.has(mode)) return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  if (!CADENCES.has(cadence)) return NextResponse.json({ error: "invalid cadence" }, { status: 400 });
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) return NextResponse.json({ error: "rate_bps must be 0..10000" }, { status: 400 });

  const creator = await creatorOf(id);
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  try {
    await verifyCreator({
      agentId: id, prefix: "Slingshot distribution", creator, message: body.message, signature: body.signature,
      requireIncludes: [`mode: ${mode}`, `rate_bps: ${rate}`, `cadence: ${cadence}`],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
  }

  try {
    await query(
      `INSERT INTO distribution_config (agent_id, mode, rate_bps, cadence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id) DO UPDATE SET mode = EXCLUDED.mode, rate_bps = EXCLUDED.rate_bps, cadence = EXCLUDED.cadence`,
      [id, mode, rate, cadence],
    );
    return NextResponse.json({ mode, rate_bps: rate, cadence });
  } catch (e) {
    const ref = await reportError("agent.distribution", e, { detail: { agentId: id } });
    return NextResponse.json({ error: "could not update the policy", ref }, { status: 500 });
  }
}
