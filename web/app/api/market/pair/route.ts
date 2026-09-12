// GET /api/market/pair?token=0x... — resolve a token's Robinhood-Chain market via DexScreener.
//
// PONS has no public price API and third-party aggregators like GeckoTerminal do not index Robinhood
// Chain, but DexScreener DOES (chainId "robinhood"). We proxy its token endpoint server-side (avoids
// browser CORS and keeps the upstream swappable), pick the deepest-liquidity Robinhood pair, and return
// the pair address + USD stats. The agent page embeds DexScreener's chart for that pair.
//
// A token still on the PONS bonding curve (pre-graduation) has no Uniswap pool yet, so DexScreener
// returns nothing; the caller then shows the curve price + the PONS link instead. This is expected.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DS_CHAIN = "robinhood";

interface DsPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  baseToken?: { address?: string; symbol?: string };
  url?: string;
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!ADDR_RE.test(token)) {
    return NextResponse.json({ error: "invalid token address" }, { status: 400 });
  }

  let pairs: DsPair[] = [];
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      headers: { accept: "application/json" },
      // brief server-side cache: market data does not need to be sub-30s fresh here
      next: { revalidate: 30 },
    });
    if (res.ok) {
      const body = (await res.json()) as { pairs?: DsPair[] | null };
      pairs = Array.isArray(body.pairs) ? body.pairs : [];
    }
  } catch {
    // upstream down — treat as "no pair" so the UI degrades to the curve price + PONS link
    return NextResponse.json({ pair: null, source: "dexscreener", error: "upstream unavailable" });
  }

  const rh = pairs
    .filter((p) => (p.chainId || "").toLowerCase() === DS_CHAIN && p.pairAddress)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

  const best = rh[0];
  if (!best) return NextResponse.json({ pair: null, source: "dexscreener" });

  return NextResponse.json({
    source: "dexscreener",
    pair: {
      chainId: best.chainId,
      dexId: best.dexId ?? null,
      pairAddress: best.pairAddress,
      priceUsd: best.priceUsd ?? null,
      marketCap: best.marketCap ?? best.fdv ?? null,
      liquidityUsd: best.liquidity?.usd ?? null,
      baseSymbol: best.baseToken?.symbol ?? null,
      url: best.url ?? `https://dexscreener.com/${DS_CHAIN}/${best.pairAddress}`,
    },
  });
}
