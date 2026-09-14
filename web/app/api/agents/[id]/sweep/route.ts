// GET  /api/agents/:id/sweep?to=0x..  — dry-run: preview what a sweep WOULD move (public on-chain reads).
// POST /api/agents/:id/sweep          — execute the sweep (creator-signed).
//
// Recovers an agent's account value (USDG + any archetype token it holds) back to a destination
// (default: the creator wallet), using the platform DEPLOYER_KEY to derive the account's owner (SPEC:
// the same owner the launch predicted the account from). For shutting an agent down. ETH is left in
// place (it is the gas the owner ops spend). The signed message binds the destination.

import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { query, UUID_RE } from "@/lib/server/db";
import { creatorOf, verifyCreator } from "@/lib/server/creator-auth";
import { getLaunchModule } from "@/lib/server/launch";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

// Dry-run preview (no auth; the balances are public on-chain reads).
export async function GET(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const to = new URL(req.url).searchParams.get("to") || undefined;
  if (to && !isAddress(to)) return NextResponse.json({ error: "invalid destination address" }, { status: 400 });
  try {
    const { sweepAgent } = await getLaunchModule();
    const plan = await sweepAgent({ agentId: id, to, dryRun: true });
    return NextResponse.json(plan);
  } catch (e) {
    const ref = await reportError("agent.sweep.preview", e, { detail: { agentId: id } });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), ref }, { status: 500 });
  }
}

// Execute the sweep (creator-signed).
export async function POST(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  let body: { to?: unknown; message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const creator = await creatorOf(id);
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const to = (typeof body.to === "string" && isAddress(body.to) ? body.to : creator) as Address;

  try {
    await verifyCreator({ agentId: id, prefix: "Slingshot sweep", creator, message: body.message, signature: body.signature, requireIncludes: [`to: ${to}`] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
  }

  try {
    const { sweepAgent } = await getLaunchModule();
    const result = await sweepAgent({ agentId: id, to });
    return NextResponse.json(result);
  } catch (e) {
    const ref = await reportError("agent.sweep", e, { detail: { agentId: id } });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), ref }, { status: 500 });
  }
}
