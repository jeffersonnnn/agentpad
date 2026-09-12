// SERVER-ONLY. Native price history for the agent chart.
//
// Robinhood Chain has no free OHLC indexer that covers the PONS bonding curve (pre-graduation), and the
// curve interface exposes no price view. So we build our OWN series: sample the curve spot price (by
// simulating a tiny buy, the same probe the client uses) and store points in `price_points`. The agent
// page reads the series and draws an area chart, so the chart lives ON Slingshot, not on PONS.
//
// Points accrue whenever the chart is read (deduped to at most one per SAMPLE_MIN_GAP_MS) and whenever
// the keeper runs, so an actively-viewed token fills in at ~viewer-poll granularity. The table
// self-creates on first use (no separate migration).

import { createPublicClient, http, formatUnits, type Address } from "viem";
import { getPool } from "./db";
import { loadRepoRootEnv } from "./env";

const CHAIN_ID = 4663;
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DECIMALS = 6;
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const SAMPLE_MIN_GAP_MS = 40_000; // do not store points closer together than this (bounds viewer writes)

const CURVE_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
] as const;

export type PriceQuote = "ETH" | "USDG";
export interface PricePoint {
  ts: string;
  price: number;
}

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (ensured) return ensured;
  ensured = getPool()
    .query(
      `create table if not exists price_points (
         agent_id uuid not null,
         ts       timestamptz not null default now(),
         price    double precision not null,
         quote    text not null,
         primary key (agent_id, ts)
       );
       create index if not exists price_points_agent_ts on price_points (agent_id, ts desc);`,
    )
    .then(() => undefined)
    .catch((e) => {
      ensured = null;
      throw e;
    });
  return ensured;
}

let client: ReturnType<typeof createPublicClient> | null = null;
function publicClient() {
  if (client) return client;
  loadRepoRootEnv();
  const rpcUrl = process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
  const chain = {
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
  } as const;
  client = createPublicClient({ transport: http(rpcUrl), chain });
  return client;
}

function classifyQuote(quote?: string | null): PriceQuote | null {
  const q = (quote ?? "").trim().toUpperCase();
  if (q === "ETH") return "ETH";
  if (q === "USDG" || q === USDG.toLowerCase().toUpperCase()) return "USDG";
  return null;
}

/** Spot price per token in the pair unit, by simulating a tiny buy. null if unpriceable/reverting. */
export async function sampleSpot(curve: Address, quote?: string | null): Promise<{ price: number | null; quoteSym: PriceQuote | null }> {
  const quoteSym = classifyQuote(quote);
  if (!quoteSym) return { price: null, quoteSym: null };
  const isUsdg = quoteSym === "USDG";
  const quoteDecimals = isUsdg ? USDG_DECIMALS : 18;
  const quoteIn = isUsdg ? 10n ** BigInt(USDG_DECIMALS) : 10n ** 15n;
  try {
    const sim = await publicClient().simulateContract({
      address: curve,
      abi: CURVE_ABI,
      functionName: "buy",
      args: [quoteIn, 0n, DEAD],
      value: isUsdg ? 0n : quoteIn,
      account: DEAD,
    });
    const tokensOut = sim.result as bigint;
    if (!tokensOut || tokensOut <= 0n) return { price: null, quoteSym };
    const per = Number(formatUnits(quoteIn, quoteDecimals)) / Number(formatUnits(tokensOut, 18));
    return { price: Number.isFinite(per) ? per : null, quoteSym };
  } catch {
    return { price: null, quoteSym }; // curve graduated, USDG holdings-free revert, etc.
  }
}

/** Record a point if enough time passed since the last one. Best-effort; never throws. */
export async function recordPoint(agentId: string, curve: Address, quote?: string | null): Promise<void> {
  try {
    await ensureTable();
    const last = await getPool().query<{ ts: string }>(
      "select ts from price_points where agent_id = $1 order by ts desc limit 1",
      [agentId],
    );
    if (last.rows[0] && Date.now() - new Date(last.rows[0].ts).getTime() < SAMPLE_MIN_GAP_MS) return;
    const { price, quoteSym } = await sampleSpot(curve, quote);
    if (price === null || quoteSym === null) return;
    await getPool().query(
      "insert into price_points (agent_id, price, quote) values ($1,$2,$3) on conflict do nothing",
      [agentId, price, quoteSym],
    );
  } catch {
    // best-effort sampling — a failed sample must never break the chart read
  }
}

/** Read the recent price series for an agent (oldest first), capped. */
export async function readSeries(agentId: string, limit = 500): Promise<{ points: PricePoint[]; quote: string | null }> {
  await ensureTable();
  const rows = await getPool().query<{ ts: string; price: number; quote: string }>(
    "select ts, price, quote from price_points where agent_id = $1 order by ts desc limit $2",
    [agentId, Math.min(2000, Math.max(1, limit))],
  );
  const points = rows.rows.map((r) => ({ ts: r.ts, price: Number(r.price) })).reverse();
  return { points, quote: rows.rows[0]?.quote ?? null };
}
