// GET  /api/agents/:id/rules — read the agent's take-profit / stop-loss rules (public read).
// POST /api/agents/:id/rules — set the rules (creator-signed; agent control panel).
//
// The rules drive the loop's auto-exit (agent/loop.mjs maybeAutoExit): when a risk position's
// unrealized PnL crosses a threshold, the agent sells the full holding into USDG. That realized gain
// above the high-water mark is what lets the keeper pay holders (the first distribution).
//
// The client sends PERCENT; the route converts to bps and stores bps. Take-profit percent goes up to
// 1000 (100000 bps); stop-loss percent up to 100 (10000 bps). 0 = rule off. Creator-signed, with the
// same anti-replay shape as control/route.ts: the signed message binds the two bps values, so a
// tampered value fails the check.

import { NextResponse } from "next/server";
import { query, UUID_RE } from "@/lib/server/db";
import { creatorOf, verifyCreator } from "@/lib/server/creator-auth";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

const MAX_TP_BPS = 100000; // take-profit: up to 1000%
const MAX_SL_BPS = 10000; //  stop-loss: up to 100%

// GET: current rules, defaulting to 0/0 (both off) when there is no row. Public read.
export async function GET(_req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  try {
    const rows = await query<{ take_profit_bps: number; stop_loss_bps: number }>(
      "SELECT take_profit_bps, stop_loss_bps FROM trade_rules WHERE agent_id = $1",
      [id],
    );
    const r = rows[0];
    return NextResponse.json({
      take_profit_bps: Number(r?.take_profit_bps ?? 0),
      stop_loss_bps: Number(r?.stop_loss_bps ?? 0),
    });
  } catch (e) {
    const ref = await reportError("agent.rules.get", e, { detail: { agentId: id } });
    return NextResponse.json({ error: "could not read the rules", ref }, { status: 500 });
  }
}

// POST: set the rules (creator-signed). Accepts percent, converts to bps.
export async function POST(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  let body: { take_profit_pct?: unknown; stop_loss_pct?: unknown; message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const tpPct = Number(body.take_profit_pct);
  const slPct = Number(body.stop_loss_pct);
  if (!Number.isFinite(tpPct) || tpPct < 0 || tpPct > 1000) {
    return NextResponse.json({ error: "take_profit_pct must be 0..1000" }, { status: 400 });
  }
  if (!Number.isFinite(slPct) || slPct < 0 || slPct > 100) {
    return NextResponse.json({ error: "stop_loss_pct must be 0..100" }, { status: 400 });
  }
  const tpBps = Math.round(tpPct * 100);
  const slBps = Math.round(slPct * 100);
  if (tpBps < 0 || tpBps > MAX_TP_BPS || slBps < 0 || slBps > MAX_SL_BPS) {
    return NextResponse.json({ error: "rule out of range" }, { status: 400 });
  }

  const creator = await creatorOf(id);
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  try {
    await verifyCreator({
      agentId: id, prefix: "Slingshot rules", creator, message: body.message, signature: body.signature,
      requireIncludes: [`take_profit_bps: ${tpBps}`, `stop_loss_bps: ${slBps}`],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
  }

  try {
    await query(
      `INSERT INTO trade_rules (agent_id, take_profit_bps, stop_loss_bps, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (agent_id) DO UPDATE
         SET take_profit_bps = EXCLUDED.take_profit_bps,
             stop_loss_bps   = EXCLUDED.stop_loss_bps,
             updated_at      = now()`,
      [id, tpBps, slBps],
    );
    return NextResponse.json({ take_profit_bps: tpBps, stop_loss_bps: slBps });
  } catch (e) {
    const ref = await reportError("agent.rules.set", e, { detail: { agentId: id } });
    return NextResponse.json({ error: "could not update the rules", ref }, { status: 500 });
  }
}
