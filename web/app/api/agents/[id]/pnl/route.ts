// GET /api/agents/:id/pnl - realized PnL + high-water mark + distributable now (read-only).
// Returns AgentPnl. It mirrors the keeper formula (see web/lib/server/pnl.ts). It never moves funds.

import { NextResponse } from "next/server";
import { UUID_RE } from "@/lib/server/db";
import { getAgentPnl } from "@/lib/server/pnl";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }
  try {
    const pnl = await getAgentPnl(id);
    return NextResponse.json(pnl);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
