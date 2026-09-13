// GET /api/notifications?address=0x..&limit=50 — the in-app alert inbox for one wallet.
//
// The rows are alerts about PUBLIC on-chain events (the agent's trades and distributions), filled by the
// outbox dispatcher (deploy/alerts-dispatch.mjs). Read by wallet address, like the /portfolio holdings
// read: no signature, because the content is public activity and the only private-ish fact is which
// agents the wallet follows. The unread badge is a per-viewer, client-side "last seen" (localStorage),
// so there is no mutate-by-address endpoint to grief.

import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { listNotifications } from "@/lib/server/follows";
import { reportError } from "@/lib/server/observatory";

export const runtime = "nodejs"; // pg
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const address = url.searchParams.get("address");
    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: "a valid ?address is required" }, { status: 400 });
    }
    const limit = Number(url.searchParams.get("limit") || 50);
    const rows = await listNotifications(address, Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ notifications: rows });
  } catch (e) {
    const ref = await reportError("api/notifications.GET", e, { url: req.url });
    return NextResponse.json({ error: "could not read notifications", ref }, { status: 500 });
  }
}
