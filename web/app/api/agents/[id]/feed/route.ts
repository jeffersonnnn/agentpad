// GET /api/agents/:id/feed — the reasoning feed (SPEC.md section 7 `feed`), newest first. Read-only.
// Optional: ?kind=<thought|trade|distribution>, ?limit=N, ?before=<ISO ts> (cursor). Returns FeedEntry[].

import { NextResponse } from "next/server";
import { query, UUID_RE, clampLimit } from "@/lib/server/db";
import type { FeedEntry } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

const KINDS = new Set(["thought", "trade", "distribution"]);

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind") || undefined;
  const before = searchParams.get("before") || undefined;
  const limit = clampLimit(searchParams.get("limit"));

  const where: string[] = ["agent_id = $1"];
  const qp: unknown[] = [id];

  if (kind) {
    if (!KINDS.has(kind)) {
      return NextResponse.json({ error: `invalid kind "${kind}"` }, { status: 400 });
    }
    qp.push(kind);
    where.push(`kind = $${qp.length}`);
  }
  if (before) {
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid before cursor (expected an ISO timestamp)" }, { status: 400 });
    }
    qp.push(d.toISOString());
    where.push(`ts < $${qp.length}::timestamptz`);
  }
  qp.push(limit);

  const sql =
    `SELECT id, agent_id, ts, kind, text, tx_hash, meta FROM feed ` +
    `WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT $${qp.length}`;

  try {
    const rows = await query<FeedEntry>(sql, qp);
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
