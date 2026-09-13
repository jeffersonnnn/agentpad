// Follow + Alerts for one agent (roadmap item 3).
//   GET  /api/agents/:id/follow?address=0x..  -> follow state for that wallet + follower count (public).
//   POST /api/agents/:id/follow               -> follow / unfollow / edit channels (wallet-signed).
//
// WRITES are wallet-signature-gated (mirrors x-connect): the follower signs a fresh, agent-scoped,
// action-scoped message; the server recovers the signer and requires it to equal the address being
// followed. That stops anyone from registering someone else's wallet (and email/Telegram) as a follower.
// The :id path segment may be the agent UUID or its token address (canonical URL is /agent/<contract>).

import { NextResponse } from "next/server";
import { recoverMessageAddress, isHex, isAddress } from "viem";
import type { Address, Hex } from "viem";
import { query, UUID_RE, ADDR_RE } from "@/lib/server/db";
import { getFollow, upsertFollow, deleteFollow, countFollowers } from "@/lib/server/follows";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs"; // pg
export const dynamic = "force-dynamic";

const MAX_MSG_AGE_MS = 10 * 60 * 1000; // anti-replay window

type Ctx = { params: { id: string } };

interface AgentLite {
  id: string;
  token_addr: Address | null;
  creator_addr: Address;
  archetype: string;
}

async function resolveAgent(idParam: string): Promise<AgentLite | null> {
  const byUuid = UUID_RE.test(idParam);
  const byAddr = ADDR_RE.test(idParam);
  if (!byUuid && !byAddr) return null;
  const where = byUuid ? "id = $1" : "lower(token_addr) = lower($1)";
  const rows = await query<AgentLite>(`SELECT id, token_addr, creator_addr, archetype FROM agents WHERE ${where}`, [idParam]);
  return rows[0] ?? null;
}

// The message the follower signs is built by followMessage() in lib/api.ts. We do not rebuild it here;
// we bind it to the request fields with includes-checks below, then recover the signer.

// Validate shape + freshness, recover the signer, and require signer == the address in the message.
// The message is NOT trusted for its address claim; we bind it to the request fields and recover it.
async function verifyFollowerSig(opts: {
  agentId: string;
  action: "follow" | "unfollow";
  address: string;
  message: unknown;
  signature: unknown;
}): Promise<void> {
  const { agentId, action, address, message, signature } = opts;
  if (typeof message !== "string" || !message.startsWith("Slingshot follow")) throw new Error("bad message");
  if (typeof signature !== "string" || !isHex(signature)) throw new Error("bad signature");
  if (!message.includes(`agent: ${agentId}`)) throw new Error("message is for a different agent");
  if (!message.includes(`action: ${action}`)) throw new Error("message is for a different action");
  if (!message.includes(`address: ${address}`)) throw new Error("message is for a different address");
  const m = message.match(/issued: (.+)$/m);
  const issued = m ? Date.parse(m[1].trim()) : NaN;
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_MSG_AGE_MS) {
    throw new Error("signature expired; please sign again");
  }
  const signer = await recoverMessageAddress({ message, signature: signature as Hex });
  if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("signature does not match the address");
}

// ── GET: follow state for a wallet (public; content is public on-chain activity) ─────────────────────
export async function GET(req: Request, { params }: Ctx) {
  try {
    const agent = await resolveAgent(params.id);
    if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    const address = new URL(req.url).searchParams.get("address");
    const followers = await countFollowers(agent.id);
    if (!address || !isAddress(address)) return NextResponse.json({ following: false, follow: null, followers });
    const row = await getFollow(agent.id, address);
    return NextResponse.json({
      following: !!row,
      follow: row
        ? { email: row.email, telegram: row.telegram, onTrade: row.on_trade, onDistribution: row.on_distribution }
        : null,
      followers,
    });
  } catch (e) {
    const ref = await reportError("api/follow.GET", e, { url: req.url });
    return NextResponse.json({ error: "could not read follow state", ref }, { status: 500 });
  }
}

// ── POST: follow / unfollow / edit channels (wallet-signed) ─────────────────────────────────────────
export async function POST(req: Request, { params }: Ctx) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const agent = await resolveAgent(params.id);
    if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

    const action = body.action === "unfollow" ? "unfollow" : "follow";
    const address = typeof body.address === "string" ? body.address : "";
    if (!isAddress(address)) return NextResponse.json({ error: "invalid address" }, { status: 400 });

    try {
      await verifyFollowerSig({ agentId: agent.id, action, address, message: body.message, signature: body.signature });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
    }

    if (action === "unfollow") {
      await deleteFollow(agent.id, address);
      const followers = await countFollowers(agent.id);
      return NextResponse.json({ following: false, follow: null, followers });
    }

    // Optional contact channels. Basic shape checks only; delivery is best-effort in the dispatcher.
    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "invalid email" }, { status: 400 });
    }
    const telegram = typeof body.telegram === "string" && body.telegram.trim() ? body.telegram.trim() : null;
    const onTrade = body.onTrade !== false;
    const onDistribution = body.onDistribution !== false;

    const row = await upsertFollow({ agentId: agent.id, follower: address, email, telegram, onTrade, onDistribution });
    const followers = await countFollowers(agent.id);
    return NextResponse.json({
      following: true,
      follow: { email: row.email, telegram: row.telegram, onTrade: row.on_trade, onDistribution: row.on_distribution },
      followers,
    });
  } catch (e) {
    const ref = await reportError("api/follow.POST", e, { url: req.url });
    return NextResponse.json({ error: "could not update follow", ref }, { status: 500 });
  }
}
