// X connect for one agent (ADR 0005 / SPEC 11 item 6). The creator brings THEIR OWN X keys (opt-in,
// creator-funded); we only store them where the loop's socials MCP server reads them. Storage is a
// gitignored per-agent file (Q11: file now, encrypt-in-DB is a go-live step). Only the agent's creator
// may write: the request carries a wallet signature we recover and check against agents.creator_addr.
//
// SECURITY: keys arrive in the POST body over TLS (never a URL param), are written 0600 to a
// gitignored path, are NEVER logged, and are NEVER returned by any response. GET reveals only whether
// X is connected and which auth flavor, no key material.

import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { recoverMessageAddress, isHex } from "viem";
import type { Address, Hex } from "viem";
import { query, UUID_RE } from "@/lib/server/db";
import { socialsConfigPath } from "@/lib/server/paths";

export const runtime = "nodejs"; // fs + pg
export const dynamic = "force-dynamic";

const MAX_MSG_AGE_MS = 10 * 60 * 1000; // signed message must be issued within 10 minutes (anti-replay)

type Ctx = { params: { id: string } };

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
async function creatorOf(id: string): Promise<Address | null> {
  const rows = await query<{ creator_addr: Address }>("SELECT creator_addr FROM agents WHERE id = $1", [id]);
  return rows[0]?.creator_addr ?? null;
}

// Validate the signed message shape + freshness, then recover the signer. Returns the signer address,
// or throws with a client-safe reason. The message is NOT trusted for its address claim; we recover it.
async function verifyCreatorSig(opts: {
  agentId: string;
  action: "connect" | "disconnect";
  message: unknown;
  signature: unknown;
  creator: Address;
}): Promise<void> {
  const { agentId, action, message, signature, creator } = opts;
  if (typeof message !== "string" || !message.startsWith("Slingshot X connect")) {
    throw new Error("bad message");
  }
  if (typeof signature !== "string" || !isHex(signature)) throw new Error("bad signature");
  if (!message.includes(`agent: ${agentId}`)) throw new Error("message is for a different agent");
  if (!message.includes(`action: ${action}`)) throw new Error("message is for a different action");
  const m = message.match(/issued: (.+)$/m);
  const issued = m ? Date.parse(m[1].trim()) : NaN;
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_MSG_AGE_MS) {
    throw new Error("signature expired; please sign again");
  }
  const signer = await recoverMessageAddress({ message, signature: signature as Hex });
  if (signer.toLowerCase() !== creator.toLowerCase()) {
    throw new Error("only the agent's creator can connect X");
  }
}

function readConfig(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── GET: connection status (no secrets) ───────────────────────────────────────────────────────────
export async function GET(_req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const file = socialsConfigPath(id);
  if (!fs.existsSync(file)) return NextResponse.json({ connected: false });
  const cfg = readConfig(file);
  const x = (cfg.x ?? {}) as Record<string, unknown>;
  const connected = x.enabled !== false && Boolean(x.accessToken);
  return NextResponse.json({ connected, auth: connected ? x.auth ?? null : null });
}

// ── POST: connect (creator-signed) ─────────────────────────────────────────────────────────────────
export async function POST(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  const creator = await creatorOf(id);
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    await verifyCreatorSig({ agentId: id, action: "connect", message: body.message, signature: body.signature, creator });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
  }

  const auth = body.auth === "oauth1a" ? "oauth1a" : "oauth2";
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  // Build the x block; validate the minimum keys per auth flavor.
  const x: Record<string, unknown> = { enabled: true, auth };
  if (auth === "oauth2") {
    const accessToken = str(keys.accessToken);
    if (!accessToken) return NextResponse.json({ error: "OAuth 2.0 needs an accessToken" }, { status: 400 });
    x.accessToken = accessToken;
    for (const k of ["refreshToken", "clientId", "clientSecret"] as const) {
      const v = str(keys[k]);
      if (v) x[k] = v;
    }
  } else {
    const apiKey = str(keys.apiKey);
    const apiSecret = str(keys.apiSecret);
    const accessToken = str(keys.accessToken);
    const accessSecret = str(keys.accessSecret);
    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
      return NextResponse.json({ error: "OAuth 1.0a needs apiKey, apiSecret, accessToken, accessSecret" }, { status: 400 });
    }
    Object.assign(x, { apiKey, apiSecret, accessToken, accessSecret });
  }

  const file = socialsConfigPath(id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cfg = readConfig(file);
    cfg.agentId = id;
    cfg.x = x;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (e) {
    // Do not leak key material in the error.
    return NextResponse.json({ error: "could not store X credentials" }, { status: 500 });
  }

  return NextResponse.json({ connected: true, auth });
}

// ── DELETE: disconnect (creator-signed) — wipes the stored keys ─────────────────────────────────────
export async function DELETE(req: Request, { params }: Ctx) {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });

  const creator = await creatorOf(id);
  if (!creator) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    await verifyCreatorSig({ agentId: id, action: "disconnect", message: body.message, signature: body.signature, creator });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unauthorized" }, { status: 401 });
  }

  const file = socialsConfigPath(id);
  try {
    if (fs.existsSync(file)) fs.rmSync(file); // remove the file entirely: no key material retained
  } catch {
    return NextResponse.json({ error: "could not remove X credentials" }, { status: 500 });
  }
  return NextResponse.json({ connected: false });
}
