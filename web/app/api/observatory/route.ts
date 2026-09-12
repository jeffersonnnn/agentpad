// The Observatory endpoint (SPEC: developer error visibility).
//
//   GET  /api/observatory?token=...&limit=&scope=&level=&since=   -> recent events, newest first.
//        Guarded by OBSERVATORY_TOKEN (repo-root .env). Without a configured token, reads are refused
//        so events are never exposed publicly. Pass the token as ?token= or `Authorization: Bearer`.
//
//   POST /api/observatory   { scope, message, detail?, url?, level? }   -> record a CLIENT error.
//        Open (no token): the browser reports its own uncaught errors and caught launch failures here
//        so they reach the developer. Values are size-capped; source is forced to 'client'.
//
// This is how caught errors "come back to the dev": the app writes them, you read them with the token.

import { NextResponse } from "next/server";
import { loadRepoRootEnv } from "@/lib/server/env";
import { listEvents, reportEvent, type ObservatoryLevel } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEVELS: ObservatoryLevel[] = ["error", "warn", "info"];

function tokenOk(req: Request): boolean {
  loadRepoRootEnv();
  const expected = process.env.OBSERVATORY_TOKEN;
  if (!expected) return false; // not configured -> deny reads
  const url = new URL(req.url);
  const got =
    url.searchParams.get("token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  // length-guarded equality; tokens are compared as whole strings
  return got.length > 0 && got === expected;
}

export async function GET(req: Request) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const level = url.searchParams.get("level");
  try {
    const events = await listEvents({
      limit: Number(url.searchParams.get("limit")) || 100,
      scope: url.searchParams.get("scope") || undefined,
      level: level && LEVELS.includes(level as ObservatoryLevel) ? (level as ObservatoryLevel) : undefined,
      since: url.searchParams.get("since") || undefined,
    });
    return NextResponse.json({ count: events.length, events });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: {
    scope?: string;
    message?: string;
    detail?: Record<string, unknown>;
    url?: string;
    level?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const scope = (body.scope || "client.unknown").toString();
  const message = (body.message || "(no message)").toString();
  const level: ObservatoryLevel = LEVELS.includes(body.level as ObservatoryLevel)
    ? (body.level as ObservatoryLevel)
    : "error";

  const ref = await reportEvent(scope, message, {
    source: "client",
    level,
    detail: body.detail && typeof body.detail === "object" ? body.detail : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
    ua: req.headers.get("user-agent") || undefined,
  });
  return NextResponse.json({ ref });
}
