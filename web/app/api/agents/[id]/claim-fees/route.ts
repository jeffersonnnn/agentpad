// POST /api/agents/:id/claim-fees — manual fee claim (SPEC 1, ADR 0003).
//
// Triggers FeeSplitter.claimAndRoute() for one agent using the platform DEPLOYER_KEY (the splitter's
// owner). That sweeps accrued creator fees, converts to USDG, sends 80% to the agent treasury, and
// buy-and-burns 20% of the platform token. It is the on-demand version of the keeper's timed routing,
// so a creator can top the treasury up from accrued fees (e.g. after the agent wallet was drained).
//
// AUTHORIZATION: creator-signed, exactly like X-connect. The request carries a wallet signature over a
// fresh message; we recover the signer and require it to equal agents.creator_addr. The server holds
// DEPLOYER_KEY and performs the on-chain call; the creator never needs gas or admin access.

import { NextResponse } from "next/server";
import { recoverMessageAddress, isHex } from "viem";
import type { Address, Hex } from "viem";
import { query, UUID_RE } from "@/lib/server/db";
import { getLaunchModule } from "@/lib/server/launch";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MSG_AGE_MS = 10 * 60 * 1000; // anti-replay: the signed message must be fresh

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  const rows = await query<{ creator_addr: Address }>(
    "SELECT creator_addr FROM agents WHERE id = $1",
    [id],
  );
  const creator = rows[0]?.creator_addr;
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  let body: { message?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Verify the creator signature (recover the signer; never trust the message's address claim).
  try {
    const { message, signature } = body;
    if (typeof message !== "string" || !message.startsWith("Slingshot claim fees")) {
      throw new Error("bad message");
    }
    if (typeof signature !== "string" || !isHex(signature)) throw new Error("bad signature");
    if (!message.includes(`agent: ${id}`)) throw new Error("message is for a different agent");
    const m = message.match(/issued: (.+)$/m);
    const issued = m ? Date.parse(m[1].trim()) : NaN;
    if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_MSG_AGE_MS) {
      throw new Error("signature expired; please sign again");
    }
    const signer = await recoverMessageAddress({ message, signature: signature as Hex });
    if (signer.toLowerCase() !== creator.toLowerCase()) {
      throw new Error("only the agent's creator can claim fees");
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const { claimFees } = await getLaunchModule();
    const result = await claimFees({ agentId: id });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // "nothing to claim" is an expected, benign outcome — a 200 so the UI shows it plainly, no ref.
    if (/nothing to claim/i.test(msg)) {
      return NextResponse.json({ claimed: false, message: msg });
    }
    const ref = await reportError("agent.claim-fees", e, { detail: { agentId: id } });
    return NextResponse.json({ error: msg, ref }, { status: 500 });
  }
}
