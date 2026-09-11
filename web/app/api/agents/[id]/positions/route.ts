// GET /api/agents/:id/positions — current holdings (SPEC.md section 7 `positions`). Read-only.
// Returns Position[]. amount / cost_basis_usdg are NUMERIC base units, returned as decimal strings.

import { NextResponse } from "next/server";
import { query, UUID_RE } from "@/lib/server/db";
import type { Position } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }

  try {
    const rows = await query<Position>(
      `SELECT agent_id, asset, amount, cost_basis_usdg, updated_at FROM positions
       WHERE agent_id = $1 ORDER BY updated_at DESC`,
      [id],
    );
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
