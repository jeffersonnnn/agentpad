// GET /api/agents/:id/distributions — published Merkle epochs (SPEC.md section 7 `distributions`),
// newest epoch first. Read-only. Returns Distribution[]. total_usdg is USDG base units (decimal
// string); epoch / to_block are bigints returned as strings.

import { NextResponse } from "next/server";
import { query, UUID_RE } from "@/lib/server/db";
import type { Distribution } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }

  try {
    const rows = await query<Distribution>(
      `SELECT id, agent_id, epoch, merkle_root, total_usdg, to_block, ts FROM distributions
       WHERE agent_id = $1 ORDER BY epoch DESC`,
      [id],
    );
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
