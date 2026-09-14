// POST /api/agents/:id/control — pause or resume an agent (agent control panel).
//
// Creator-signed. Sets agents.paused, which the reasoner + grant crons skip (deploy/reason-all.mjs,
// deploy/grant-ready.mjs: `AND paused IS NOT TRUE`). Pause stops the agent reasoning and trading; it
// does NOT touch the status enum (the keeper flips status live<->sleeping on balance, independently).

import { NextResponse } from "next/server";
import { query, UUID_RE } from "@/lib/server/db";
import { creatorOf, verifyCreator } from "@/lib/server/creator-auth";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  let body: { action?: unknown; message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action === "pause" ? "pause" : body.action === "resume" ? "resume" : null;
  if (!action) return NextResponse.json({ error: "action must be 'pause' or 'resume'" }, { status: 400 });

  const creator = await creatorOf(id);
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  try {
    await verifyCreator({ agentId: id, prefix: "Slingshot control", creator, message: body.message, signature: body.signature, requireIncludes: [`action: ${action}`] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
  }

  try {
    const paused = action === "pause";
    await query("UPDATE agents SET paused = $2 WHERE id = $1", [id, paused]);
    return NextResponse.json({ paused });
  } catch (e) {
    const ref = await reportError("agent.control", e, { detail: { agentId: id, action } });
    return NextResponse.json({ error: "could not update the agent", ref }, { status: 500 });
  }
}
