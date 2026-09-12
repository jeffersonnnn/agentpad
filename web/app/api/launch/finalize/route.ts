// POST /api/launch/finalize — Milestone 3 step 4 (SPEC.md section 8, ADR 0002/0003).
//
// Called after the creator broadcasts the launchToken tx. Relays {agentId, tokenAddr, curveAddr,
// txHash} to finalizeLaunch, which VERIFIES the on-chain launch (recipient = the splitter, buyback
// off, exact fee, matching salt, creator as sender) BEFORE wiring the curve into the splitter,
// deploying the per-agent Distributor, flipping the row to `live`, and starting the loop. txHash is
// REQUIRED — the launch cannot be verified without it.

import { NextResponse } from "next/server";
import { getLaunchModule } from "@/lib/server/launch";
import { reportError } from "@/lib/server/observatory";
import type { FinalizeLaunchInput } from "@/lib/types";

export const runtime = "nodejs"; // never edge
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: FinalizeLaunchInput;
  try {
    body = (await req.json()) as FinalizeLaunchInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { agentId, tokenAddr, curveAddr, txHash } = body ?? {};
  if (!agentId) return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  if (!tokenAddr) return NextResponse.json({ error: "tokenAddr is required" }, { status: 400 });
  if (!curveAddr) return NextResponse.json({ error: "curveAddr is required" }, { status: 400 });
  if (!txHash) return NextResponse.json({ error: "txHash is required" }, { status: 400 });

  try {
    const { finalizeLaunch } = await getLaunchModule();
    const result = await finalizeLaunch({ agentId, tokenAddr, curveAddr, txHash });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The creator ALREADY paid and the token is on-chain — capture everything needed to finalize by
    // hand (agentId + txHash + addresses) so a finalize failure is recoverable, not a lost launch.
    const ref = await reportError("launch.finalize", e, {
      level: "error",
      detail: { agentId, tokenAddr, curveAddr, txHash },
    });
    return NextResponse.json({ error: msg, ref }, { status: 500 });
  }
}
