// POST /api/launch/prepare — Milestone 3 step 1-3 (SPEC.md section 8, ADR 0003/0004).
//
// Deploys the per-agent FeeSplitter (DEPLOYER_KEY infra), predicts the ERC-4337 account, and returns
// the UNSIGNED PONS launchToken tx (creatorFeeRecipient = the splitter, set server-side). THE SERVER
// NEVER SIGNS launchToken — the creator signs + broadcasts it client-side. DEPLOYER_KEY is read from
// the repo-root .env inside api/launch.mjs and is never exposed in the response.

import { NextResponse } from "next/server";
import { getLaunchModule } from "@/lib/server/launch";
import { reportError } from "@/lib/server/observatory";
import type { PrepareLaunchInput } from "@/lib/types";

export const runtime = "nodejs"; // never edge: needs Node fs/child_process + pg + the ESM api module
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let input: PrepareLaunchInput;
  try {
    input = (await req.json()) as PrepareLaunchInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!input?.creator) return NextResponse.json({ error: "creator is required" }, { status: 400 });
  if (!input?.archetype) return NextResponse.json({ error: "archetype is required" }, { status: 400 });

  try {
    const { prepareLaunch } = await getLaunchModule();
    const result = await prepareLaunch(input); // returns the UNSIGNED launchTx + addresses (JSON-safe)
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ref = await reportError("launch.prepare", e, {
      detail: {
        creator: input.creator,
        archetype: input.archetype,
        name: input.name,
        symbol: input.symbol,
        quote: input.quote,
      },
    });
    return NextResponse.json({ error: msg, ref }, { status: 500 });
  }
}
