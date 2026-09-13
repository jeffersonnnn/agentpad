// POST /api/rpc — a same-origin, read-only JSON-RPC proxy to the reliable (paid Alchemy) Robinhood node.
//
// WHY: the browser reads chain state through wagmi's transport. Pointing that transport straight at the
// public Robinhood RPC made launches stall — the launch "resolving" eth_call and the receipt waits time
// out on the flaky public node (see Observatory scope launch.client, phase "resolving"). We cannot put
// the Alchemy URL in the browser because it embeds a secret key (see lib/wagmi.ts). So the browser talks
// to THIS same-origin route, and the route forwards to ROBINHOOD_ALCHEMY_RPC server-side. The key never
// leaves the server.
//
// SAFETY: this is a read-only relay. Only whitelisted read methods pass; writes (eth_sendRawTransaction)
// and everything unknown are rejected with a JSON-RPC error. Sending still goes through the user's own
// wallet provider, never this proxy. Single and batch (array) requests are both supported. On an upstream
// failure it retries once, then falls back to the public RPC, so a hiccup at Alchemy still resolves.

import { NextResponse } from "next/server";
import { loadRepoRootEnv } from "@/lib/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

// Read-only JSON-RPC methods viem/wagmi use for reads, receipts, gas, and logs. No state-changing calls.
const ALLOWED = new Set<string>([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_getBlockReceipts",
  "eth_createAccessList",
  "eth_getProof",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

const MAX_BATCH = 20;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Every entry in a single or batch body must be an allowed read method.
function methodsAllowed(body: unknown): { ok: true } | { ok: false; bad: string; id: unknown } {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > MAX_BATCH) return { ok: false, bad: "batch size", id: null };
  for (const it of items) {
    const method = it && typeof it === "object" ? (it as { method?: unknown }).method : undefined;
    if (typeof method !== "string" || !ALLOWED.has(method)) {
      return { ok: false, bad: typeof method === "string" ? method : "(missing method)", id: (it as { id?: unknown })?.id };
    }
  }
  return { ok: true };
}

async function forward(url: string, payload: string, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function POST(req: Request) {
  loadRepoRootEnv();
  const upstream = process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const gate = methodsAllowed(body);
  if (!gate.ok) {
    return NextResponse.json(rpcError(gate.id, -32601, `Method not permitted through this proxy: ${gate.bad}`), { status: 200 });
  }

  const payload = JSON.stringify(body);

  // Try Alchemy (one retry), then fall back to the public RPC once. Read-only, so retries are safe.
  const targets = upstream === PUBLIC_RPC ? [PUBLIC_RPC] : [upstream, upstream, PUBLIC_RPC];
  let lastErr = "";
  for (let i = 0; i < targets.length; i++) {
    try {
      const res = await forward(targets[i], payload, 15_000);
      if (!res.ok) {
        lastErr = `upstream ${res.status}`;
        continue;
      }
      const text = await res.text();
      return new NextResponse(text, { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  // Never leak the upstream URL/key in the error surfaced to the browser.
  return NextResponse.json(rpcError(null, -32603, "RPC upstream unavailable"), { status: 502 });
}
