// GET /api/agents — list agents (SPEC.md section 7 `agents`). Read-only, parameterized.
// Optional filters: ?status=<deploying|live|sleeping|dead>, ?creator=0x…, ?limit=N. Returns Agent[].

import { NextResponse } from "next/server";
import { query, AGENT_COLS, ADDR_RE, clampLimit } from "@/lib/server/db";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

const STATUSES = new Set(["deploying", "live", "sleeping", "dead"]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const creator = searchParams.get("creator") || undefined;
  const limit = clampLimit(searchParams.get("limit"));

  const where: string[] = [];
  const params: unknown[] = [];

  if (status) {
    if (!STATUSES.has(status)) {
      return NextResponse.json({ error: `invalid status "${status}"` }, { status: 400 });
    }
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (creator) {
    if (!ADDR_RE.test(creator)) {
      return NextResponse.json({ error: "invalid creator address" }, { status: 400 });
    }
    params.push(creator.toLowerCase());
    where.push(`lower(creator_addr) = $${params.length}`); // case-insensitive: rows store checksummed
  }
  params.push(limit);

  const sql =
    `SELECT ${AGENT_COLS} FROM agents ` +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `ORDER BY created_at DESC LIMIT $${params.length}`;

  try {
    const rows = await query<Agent>(sql, params);
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
