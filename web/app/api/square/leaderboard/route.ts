// GET /api/square/leaderboard — the Square ranking (roadmap 5: a discovery engine). Read-only.
//
// Ranks agents by any of several metrics (?sort=), optionally filtered by archetype (?archetype=) and
// status (?status=, default: exclude dead). Every metric is computed server-side in one aggregate (see
// lib/server/square.ts). Sort is a fixed whitelist; archetype/status are parameterized. ?limit=N.

import { NextResponse } from "next/server";
import { leaderboard, SQUARE_SORTS, type SquareSort } from "@/lib/server/square";
import { ARCHETYPES } from "@/lib/constants";

export const runtime = "nodejs"; // never edge: pg
export const dynamic = "force-dynamic";

const STATUSES = new Set(["deploying", "live", "sleeping", "dead"]);
const ARCHETYPE_SLUGS = new Set(ARCHETYPES.map((a) => a.slug as string));

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const sortRaw = searchParams.get("sort") || "followers";
  if (!SQUARE_SORTS.includes(sortRaw as SquareSort)) {
    return NextResponse.json({ error: `invalid sort "${sortRaw}"` }, { status: 400 });
  }
  const status = searchParams.get("status") || undefined;
  if (status && !STATUSES.has(status)) {
    return NextResponse.json({ error: `invalid status "${status}"` }, { status: 400 });
  }
  const archetype = searchParams.get("archetype") || undefined;
  if (archetype && !ARCHETYPE_SLUGS.has(archetype)) {
    return NextResponse.json({ error: `invalid archetype "${archetype}"` }, { status: 400 });
  }
  const limit = Number(searchParams.get("limit")) || 50;

  try {
    const rows = await leaderboard({ sort: sortRaw as SquareSort, status, archetype, limit });
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
