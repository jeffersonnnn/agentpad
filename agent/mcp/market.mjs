// Milestone 2 — the market-data MCP server (BUILD.md M2.1; SPEC.md section 6; FACTS.md).
//
// A REAL Model Context Protocol server (stdio) that gives the agent brain its two market reads:
//
//   1. DECISION PRICE — the Chainlink feed for an asset (AggregatorV3Interface.latestRoundData,
//      8 dec), gated on the SPEC.md section 6 freshness cutoffs. This is the price the agent is
//      allowed to trade on, and only when it is fresh:
//        - equities & equity/commodity ETFs (24/5 feeds): cutoff 300s. Off-hours the feed goes
//          stale (no heartbeat, holds last price) so the trade is blocked automatically.
//        - short treasuries (SGOV) and metals (SLV): cutoff 24h; value barely moves off-hours.
//        - GLD has NO Chainlink feed: priced off the GLD/USDG v3 TWAP with a deviation band, and
//          BLOCKED off-hours (thin pool, no truth off-hours). Off-hours is derived from a reference
//          equity feed's freshness (NVDA), which is the on-chain, holiday-proof market-open signal.
//        - NFLX: FACTS.md said its feed is in the Chainlink directory, but it is NOT there as of
//          2026-09-10 (verified). Treated as feedless: blocked unless NFLX_FEED is set in env.
//
//   2. EXECUTION SANITY — the Uniswap v3 pool TWAP (`observe`), used ONLY to bound slippage, never
//      as truth off-hours. On pools whose observation cardinality is not expanded, `observe` reverts
//      and we fall back to the slot0 spot tick (flagged `twap_available: false`).
//
// The feed and pool addresses are the verified ones in FACTS.md (cross-checked against the live
// Chainlink directory feeds-robinhood-mainnet.json on 2026-09-10). Re-verify before mainnet.
//
// ── Tools exposed ─────────────────────────────────────────────────────────────────────────────────
//   list_assets           the supported universe with each asset's class, cutoff, feed and pool
//   get_price   {asset}    the freshness-gated decision price + an `ok_to_trade` verdict
//   get_twap    {asset,window_seconds?}  the v3 pool TWAP (execution sanity), quote per asset
//   market_status {reference?}  is the equity market open, from a reference feed's freshness
//
// ── Usage ───────────────────────────────────────────────────────────────────────────────────────
//   As an MCP stdio server (what the brain launches):
//       node --env-file=.env agent/mcp/market.mjs
//   Offline self-test (no MCP SDK needed — pure viem reads against the live RPC):
//       node --env-file=.env agent/mcp/market.mjs selftest [ASSET]
//       node --env-file=.env agent/mcp/market.mjs list
//   (market.mjs also auto-loads ./.env if present, so plain `node agent/mcp/market.mjs` works too.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, defineChain, parseAbi, getAddress } from "viem";
import { TOKENS, CHAIN_ID, PUBLIC_RPC } from "../lib/archetypes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny dependency-free .env loader (does not override already-set env) ---
function autoloadEnv() {
  for (const p of [
    path.join(__dirname, "..", "..", ".env"), // repo root
    path.join(__dirname, "..", ".env"),        // agent/.env
    path.join(process.cwd(), ".env"),
  ]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
    break;
  }
}
autoloadEnv();

// ── Freshness cutoffs (SPEC.md section 6) ────────────────────────────────────────────────────────
const CUTOFF_EQUITY = 300;    // seconds — equities and equity/commodity ETFs (24/5 feeds)
const CUTOFF_SLOW = 86400;    // seconds — SGOV (short treasuries), SLV (metals): value barely moves
// Crypto (ETH) has a 24/7 Chainlink feed, but it updates on a ~1-2h heartbeat + 0.5% deviation, so the
// cutoff must be wider than the equity 300s or a fresh-but-heartbeat-old price would read as stale. The
// 0.5% deviation trigger keeps the price accurate between updates, so ~2h is safe.
const CUTOFF_CRYPTO = 7200;
const CUTOFFS = { equity: CUTOFF_EQUITY, slow: CUTOFF_SLOW, crypto: CUTOFF_CRYPTO };
// Memecoins (PONS/MEME/AI) are feedless: priced off the v3 pool TWAP with a short-vs-long deviation band
// (manipulation guard, like GLD), but NOT off-hours-blocked — they trade 24/7.
const MEME_BAND_BPS = Number(process.env.MEME_TWAP_BAND_BPS ?? 500); // 5% (memecoins are volatile)
const MEME_LONG_WINDOW = 1800;  // seconds
const MEME_SHORT_WINDOW = 300;  // seconds
// GLD (feedless) manipulation guard: short vs long TWAP must agree within this band.
const GLD_BAND_BPS = Number(process.env.GLD_TWAP_BAND_BPS ?? 200); // 2%
const GLD_LONG_WINDOW = 1800; // seconds
const GLD_SHORT_WINDOW = 300; // seconds
// The reference equity feed whose freshness stands in for "US equity market is open".
const MARKET_REFERENCE = process.env.MARKET_REFERENCE_ASSET || "NVDA";

// ── Chainlink feeds (8-dec) — verified in FACTS.md, cross-checked vs the live directory 2026-09-10 ─
// GLD: no feed (price off the v3 TWAP). NFLX: NOT in the directory as of 2026-09-10 (feedless in
// practice); honor a NFLX_FEED override if the operator supplies one.
const FEEDS = {
  NVDA:  "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  SGOV:  "0xa0DF4ee0fFf975306345875E3548Fcc519577A11",
  GME:   "0x27C71df6A64fB476468EdF256CF72c038baB5B67",
  TSLA:  "0x4A1166a659A55625345e9515b32adECea5547C38",
  USO:   "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c",
  AMZN:  "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C",
  MSTR:  "0x396118bdFB181e6240E74D243F266B061c0edc3D",
  MSFT:  "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E",
  QQQ:   "0x80901d846d5D7B030F26B480776EE3b29374C2ae",
  AAPL:  "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
  META:  "0x7C38C00C30BEe9378381E7B6135d7283356D71b1",
  GOOGL: "0xF6f373a037c30F0e5010d854385cA89185AE638b",
  SLV:   "0x209b73908e92Ae021826eD79609845451Ecba2ce",
  AMD:   "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72",
  SPY:   "0x319724394D3A0e3669269846abE664Cd621f9f6A",
  NFLX:  process.env.NFLX_FEED || null, // FACTS said "directory"; absent as of 2026-09-10
  GLD:   null,                          // no Chainlink feed — TWAP-priced
  WETH:  "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", // ETH/USD (24/7 crypto feed), FACTS.md
  PONS:  null,                          // feedless — TWAP-priced (memecoin)
  MEME:  null,                          // feedless — TWAP-priced (memecoin)
  AI:    null,                          // feedless — TWAP-priced (memecoin)
};

// ── Best v3 pools (FACTS.md). `fee` is informational; `observe`/`slot0` do not need it. ───────────
// SPY's deep pool is WETH-paired (the USDG pool is thin), so the SPY TWAP is quoted in WETH.
const POOLS = {
  NVDA:  { pool: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3", fee: 500 },
  GLD:   { pool: "0x7A6A053eCCf1446A2633E05aA6D40D09381997ec", fee: 3000 },
  SGOV:  { pool: "0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe", fee: 3000 },
  GME:   { pool: "0xE9713f453aDB9245B19559790c96F470a18F2fDF", fee: 10000 },
  TSLA:  { pool: "0xf4ACdAEEB7022862A763C9B1B885e11191c889E3", fee: 3000 },
  USO:   { pool: "0x02175608F1b5E6b5ed221cCFdC7Be197D111D915", fee: 3000 },
  AMZN:  { pool: "0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef", fee: 3000 },
  MSTR:  { pool: "0x17578C0e0D15da44f31677263114F71aE76653EA", fee: 10000 },
  MSFT:  { pool: "0xeb60bCD1D920ad6E102690CCFC6fB488899E1510", fee: 3000 },
  QQQ:   { pool: "0xD60A5d14dB690B7Afad71F76B108071D7175597d", fee: 500 },
  AAPL:  { pool: "0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D", fee: 500 },
  META:  { pool: "0x107a7Cb40d8665360ba10E59471Af06150A50922", fee: 3000 },
  GOOGL: { pool: "0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7", fee: 500 },
  SLV:   { pool: "0x8cB787e6c315D464775289BaD00FDD67d53Ecb3D", fee: 3000 },
  AMD:   { pool: "0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f", fee: 3000 },
  NFLX:  { pool: "0x59895C0302F41aEaa129D2fa2442CEc01E7eF45E", fee: 3000 },
  SPY:   { pool: "0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e", fee: 500 }, // WETH-paired (deep); USDG pool is thin
  // 24/7 crypto + native coins (verified on-chain 2026-09-14: USDG-paired, single-hop, depth measured).
  WETH:  { pool: "0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a", fee: 500 },   // WETH/USDG $2.58M (deepest)
  PONS:  { pool: "0x7a192e71564ec66ee0763e328a3ac274942de4e1", fee: 10000 }, // PONS/USDG $592k
  MEME:  { pool: "0x5d37b1d887b502594414a82d2cf7d4ef774a8027", fee: 3000 },  // MEME/USDG $40k (thin)
  AI:    { pool: "0xe547c18f46db55ab788343bcc503f9cf0bd7d564", fee: 10000 }, // AI/USDG $42k (thin)
};

// Asset class → freshness cutoff (SPEC.md section 6). Everything not listed is an equity.
const SLOW_ASSETS = new Set(["SGOV", "SLV"]);
const CRYPTO_ASSETS = new Set(["WETH"]);          // 24/7 Chainlink feed (ETH/USD)
const MEME_ASSETS = new Set(["PONS", "MEME", "AI"]); // 24/7, feedless, TWAP + band
function assetClass(sym) {
  if (sym === "GLD") return "gld";
  if (CRYPTO_ASSETS.has(sym)) return "crypto";
  if (MEME_ASSETS.has(sym)) return "meme";
  if (SLOW_ASSETS.has(sym)) return "slow";
  return "equity";
}

// Reverse lookup for naming the quote side of a pool.
const QUOTE_SYMBOLS = {
  [TOKENS.USDG.toLowerCase()]: "USDG",
  [TOKENS.WETH.toLowerCase()]: "WETH",
  "0xcec185eb182c47d1ba1efc84e6959e18cd620be4": "cbBTC",
};
function symbolForAddress(addr) {
  const lc = addr.toLowerCase();
  if (QUOTE_SYMBOLS[lc]) return QUOTE_SYMBOLS[lc];
  for (const [s, a] of Object.entries(TOKENS)) if (a.toLowerCase() === lc) return s;
  return addr;
}

const SUPPORTED = Object.keys(POOLS); // the ~17 deep+tradeable assets

// ── viem client + ABIs ────────────────────────────────────────────────────────────────────────────
const RPC = process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });

const AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const POOL_ABI = parseAbi([
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

// ── small caches (the registry is static within a process) ─────────────────────────────────────────
const decimalsCache = new Map();
async function tokenDecimals(addr) {
  const lc = addr.toLowerCase();
  if (decimalsCache.has(lc)) return decimalsCache.get(lc);
  const d = Number(await client.readContract({ address: getAddress(addr), abi: ERC20_ABI, functionName: "decimals" }));
  decimalsCache.set(lc, d);
  return d;
}
const feedDecimalsCache = new Map();
async function feedDecimals(addr) {
  const lc = addr.toLowerCase();
  if (feedDecimalsCache.has(lc)) return feedDecimalsCache.get(lc);
  let d = 8;
  try {
    d = Number(await client.readContract({ address: getAddress(addr), abi: AGGREGATOR_ABI, functionName: "decimals" }));
  } catch { /* Chainlink equity feeds are 8-dec; default stands */ }
  feedDecimalsCache.set(lc, d);
  return d;
}

async function blockNow() {
  const b = await client.getBlock();
  return Number(b.timestamp); // matches on-chain `block.timestamp` for the freshness gate
}

function assertSupported(sym) {
  const s = String(sym || "").toUpperCase();
  if (!SUPPORTED.includes(s)) {
    throw new Error(`unknown asset "${sym}". Supported: ${SUPPORTED.join(", ")}`);
  }
  return s;
}

// ── the v3 pool tick (TWAP over `window`, or slot0 spot if `observe` reverts) ──────────────────────
async function poolTick(pool, window) {
  try {
    const [tickCumulatives] = await client.readContract({
      address: getAddress(pool), abi: POOL_ABI, functionName: "observe", args: [[window, 0]],
    });
    // tickCumulatives[i] pairs with secondsAgos[i]=[window,0]; avg = (now - past) / window.
    const avgTick = Number(tickCumulatives[1] - tickCumulatives[0]) / window;
    return { tick: avgTick, twap: true };
  } catch {
    // Cardinality not expanded → `observe` reverts ("OLD"). Fall back to the current spot tick.
    const s = await client.readContract({ address: getAddress(pool), abi: POOL_ABI, functionName: "slot0" });
    return { tick: Number(s[1]), twap: false };
  }
}

// Price of one whole ASSET token in whole QUOTE-token units, from a v3 tick.
// v3: 1.0001^tick = token1/token0 in smallest units. Convert to whole units by the decimal gap.
async function tickToAssetPrice(pool, assetAddr, tick) {
  const [t0, t1] = await Promise.all([
    client.readContract({ address: getAddress(pool), abi: POOL_ABI, functionName: "token0" }),
    client.readContract({ address: getAddress(pool), abi: POOL_ABI, functionName: "token1" }),
  ]);
  const [d0, d1] = await Promise.all([tokenDecimals(t0), tokenDecimals(t1)]);
  const asset = assetAddr.toLowerCase();
  const p = Math.pow(1.0001, tick); // token1 per token0, smallest-unit ratio
  let price, quoteAddr;
  if (t0.toLowerCase() === asset) {        // asset = token0, quote = token1
    price = p * Math.pow(10, d0 - d1);
    quoteAddr = t1;
  } else if (t1.toLowerCase() === asset) { // asset = token1, quote = token0
    price = (1 / p) * Math.pow(10, d1 - d0);
    quoteAddr = t0;
  } else {
    throw new Error(`pool ${pool} does not hold asset token ${assetAddr}`);
  }
  return { price, quote: symbolForAddress(quoteAddr) };
}

// ── core reads (used by both the MCP tools and the self-test) ──────────────────────────────────────
async function getTwap(symIn, windowIn) {
  const sym = assertSupported(symIn);
  const window = Number(windowIn ?? GLD_LONG_WINDOW);
  if (!Number.isInteger(window) || window <= 0) throw new Error(`window_seconds must be a positive integer`);
  const { pool, fee } = POOLS[sym];
  const { tick, twap } = await poolTick(pool, window);
  const { price, quote } = await tickToAssetPrice(pool, TOKENS[sym], tick);
  return {
    asset: sym, source: "uniswap-v3", pool, pool_fee: fee,
    window_seconds: window, twap_available: twap,
    tick, price, quote,
    note: twap
      ? "TWAP for execution sanity only; do NOT trust off-hours."
      : "observe() reverted (cardinality not expanded); this is the slot0 SPOT tick, not a TWAP.",
  };
}

async function marketStatus(referenceIn) {
  const reference = assertSupported(referenceIn ?? MARKET_REFERENCE);
  const feed = FEEDS[reference];
  if (!feed) throw new Error(`reference asset "${reference}" has no feed; pick an equity like NVDA`);
  const [now, [, answer, , updatedAt]] = await Promise.all([
    blockNow(),
    client.readContract({ address: getAddress(feed), abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
  ]);
  const staleness = now - Number(updatedAt);
  const open = staleness <= CUTOFF_EQUITY && answer > 0n;
  return {
    reference, feed, market_open: open,
    staleness_seconds: staleness, cutoff_seconds: CUTOFF_EQUITY,
    updated_at: Number(updatedAt), now,
    note: "Market-open is derived from a reference equity feed's freshness (holiday-proof, on-chain).",
  };
}

async function gldPrice(now) {
  const [status, long, short] = await Promise.all([
    marketStatus(MARKET_REFERENCE),
    getTwap("GLD", GLD_LONG_WINDOW),
    getTwap("GLD", GLD_SHORT_WINDOW),
  ]);
  const deviation = long.price > 0 ? Math.abs(short.price - long.price) / long.price : 1;
  const withinBand = deviation <= GLD_BAND_BPS / 10000;
  // If neither window is a real TWAP (cardinality not expanded), the band check is meaningless.
  const bandMeaningful = long.twap_available && short.twap_available;
  const ok = status.market_open && (bandMeaningful ? withinBand : true);
  let reason;
  if (!status.market_open) reason = "GLD blocked off-hours: no feed and a thin pool leave no trustworthy price.";
  else if (bandMeaningful && !withinBand) reason = `GLD TWAP deviation ${(deviation * 100).toFixed(2)}% exceeds the ${GLD_BAND_BPS / 100}% band.`;
  else if (!bandMeaningful) reason = "GLD priced off spot (pool cardinality not expanded); trade with extra caution.";
  else reason = "GLD priced off the v3 TWAP, within the deviation band, market open.";
  // Loop price contract (loop.mjs freshnessOk): GLD is feedless, so the loop keys off `off_hours`
  // (market closed → no trade) and `source` (must be "twap"). It has no deviation-band knob, so a
  // band violation is surfaced as `stale` too, which the loop's stale check rejects. `off_hours` is
  // left independent of `stale` so the loop's GLD off-hours block is the branch that fires off-hours.
  const off_hours = !status.market_open;
  const stale = bandMeaningful && !withinBand;
  return {
    asset: "GLD", source: "twap", feed: null, class: "gld",
    price: long.price, price_usdg: long.price, quote: long.quote,
    long_window_seconds: GLD_LONG_WINDOW, short_window_seconds: GLD_SHORT_WINDOW,
    short_twap_price: short.price,
    deviation, deviation_band_bps: GLD_BAND_BPS, within_band: withinBand,
    twap_available: bandMeaningful,
    // TWAP observation time == current block; keeps the loop's own age check from misfiring.
    updated_at: now,
    stale, off_hours,
    market_open: status.market_open, reference: status,
    now, ok_to_trade: ok, reason,
  };
}

// Memecoin price: feedless, priced off the v3 pool TWAP with a short-vs-long deviation band (the GLD
// manipulation guard), but 24/7 — no US-market-hours block (off_hours is always false). A band
// violation surfaces as `stale`, which the loop rejects. Thin pools without expanded TWAP cardinality
// fall back to spot and are flagged so the loop's own notional caps do the bounding.
async function memePrice(sym, now) {
  const [long, short] = await Promise.all([
    getTwap(sym, MEME_LONG_WINDOW),
    getTwap(sym, MEME_SHORT_WINDOW),
  ]);
  const deviation = long.price > 0 ? Math.abs(short.price - long.price) / long.price : 1;
  const withinBand = deviation <= MEME_BAND_BPS / 10000;
  const bandMeaningful = long.twap_available && short.twap_available;
  const ok = bandMeaningful ? withinBand : true; // no real TWAP → allow with caution (caps bound it)
  const stale = bandMeaningful && !withinBand;   // band violation → the loop rejects on `stale`
  let reason;
  if (bandMeaningful && !withinBand) reason = `${sym} TWAP deviation ${(deviation * 100).toFixed(2)}% exceeds the ${MEME_BAND_BPS / 100}% band; likely manipulation, do not trade.`;
  else if (!bandMeaningful) reason = `${sym} priced off spot (thin pool, TWAP cardinality not expanded); 24/7 memecoin, trade small with caution.`;
  else reason = `${sym} priced off the v3 TWAP within the ${MEME_BAND_BPS / 100}% band; 24/7 memecoin.`;
  return {
    asset: sym, source: "twap", feed: null, class: "meme",
    price: long.price, price_usdg: long.price, quote: long.quote,
    long_window_seconds: MEME_LONG_WINDOW, short_window_seconds: MEME_SHORT_WINDOW,
    short_twap_price: short.price,
    deviation, deviation_band_bps: MEME_BAND_BPS, within_band: withinBand,
    twap_available: bandMeaningful,
    updated_at: now,        // TWAP observation == current block; keeps the loop's age check from misfiring
    stale, off_hours: false, // memecoins trade 24/7
    market_open: true, now, ok_to_trade: ok, reason,
  };
}

async function getPrice(symIn) {
  const sym = assertSupported(symIn);
  const cls = assetClass(sym);
  const now = await blockNow();

  if (cls === "gld") return gldPrice(now);
  if (cls === "meme") return memePrice(sym, now);

  const feed = FEEDS[sym];
  if (!feed) {
    // NFLX in practice (feed absent from the directory) unless NFLX_FEED is set.
    return {
      asset: sym, source: "none", feed: null, class: cls,
      price_usdg: null, stale: true, off_hours: true, ok_to_trade: false,
      reason: sym === "NFLX"
        ? "NFLX has no Chainlink feed on 4663 (FACTS.md was stale; verified absent 2026-09-10). Set NFLX_FEED to override, or do not trade NFLX."
        : `no Chainlink feed configured for ${sym}.`,
      now,
    };
  }

  // marketStatus (reference equity feed's freshness) is the on-chain "is the US equity market open"
  // signal; it feeds the loop's `off_hours` boolean (loop.mjs freshnessOk price contract).
  const [dec, round, status] = await Promise.all([
    feedDecimals(feed),
    client.readContract({ address: getAddress(feed), abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
    marketStatus(MARKET_REFERENCE),
  ]);
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = round;
  const cutoff = CUTOFFS[cls];
  const staleness = now - Number(updatedAt);
  const priceValid = answer > 0n;
  const fresh = priceValid && staleness <= cutoff;
  const price = Number(answer) / 10 ** dec;
  // Loop price contract (loop.mjs freshnessOk): `stale` = freshness cutoff exceeded / feed unusable;
  // `off_hours` = US equity market closed, from the reference-equity-feed freshness signal. Crypto (ETH)
  // has its own 24/7 feed, so it is never off-hours; only its own staleness gates it.
  const stale = !fresh;
  const off_hours = cls === "crypto" ? false : !status.market_open;

  let reason;
  if (!priceValid) reason = `feed returned a non-positive answer (${answer}); do not trade.`;
  else if (!fresh) reason = `stale: ${staleness}s since update > ${cutoff}s cutoff (feed likely off-hours). Do not trade.`;
  else reason = "fresh Chainlink price within the cutoff.";

  return {
    asset: sym, source: "chainlink", feed, class: cls,
    price, price_usdg: price, decimals: dec,
    round_id: roundId.toString(), answered_in_round: answeredInRound.toString(),
    updated_at: Number(updatedAt), started_at: Number(startedAt), now,
    staleness_seconds: staleness, cutoff_seconds: cutoff,
    stale, off_hours, market_open: status.market_open,
    fresh, ok_to_trade: fresh, reason,
  };
}

function listAssets() {
  return {
    chain_id: CHAIN_ID,
    freshness_cutoffs: {
      equity_seconds: CUTOFF_EQUITY, slow_seconds: CUTOFF_SLOW, crypto_seconds: CUTOFF_CRYPTO,
      gld: "off-hours-blocked (TWAP-priced)", meme: "24/7 (TWAP-priced, deviation-band guarded)",
    },
    market_reference: MARKET_REFERENCE,
    assets: SUPPORTED.map((sym) => {
      const cls = assetClass(sym);
      return {
      asset: sym,
      class: cls,
      always_on: cls === "crypto" || cls === "meme", // trades 24/7 (no US-market-hours block)
      cutoff_seconds: cls === "gld" || cls === "meme" ? null : CUTOFFS[cls],
      has_feed: Boolean(FEEDS[sym]),
      feed: FEEDS[sym],
      pool: POOLS[sym].pool,
      pool_fee: POOLS[sym].fee,
      token: TOKENS[sym],
      };
    }),
  };
}

// ── JSON helpers ────────────────────────────────────────────────────────────────────────────────
const jsonReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const asText = (obj) => JSON.stringify(obj, jsonReplacer, 2);

// ── self-test / list modes (no MCP SDK needed — pure viem against the live RPC) ────────────────────
async function runSelftest(asset) {
  const rows = asset ? [asset.toUpperCase()] : ["NVDA", "SGOV", "GLD", "NFLX"];
  console.error(`market-data self-test — RPC ${RPC}\n`);
  const status = await marketStatus();
  console.log("market_status:", asText(status));
  for (const a of rows) {
    console.log(`\n=== ${a} ===`);
    try {
      console.log("get_price:", asText(await getPrice(a)));
      console.log("get_twap :", asText(await getTwap(a)));
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
}

// ── the MCP server ─────────────────────────────────────────────────────────────────────────────
async function runMcpServer() {
  let McpServer, StdioServerTransport, z;
  try {
    ({ McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js"));
    ({ StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js"));
    ({ z } = await import("zod"));
  } catch (e) {
    console.error(
      `\n  The MCP SDK / zod are not installed. Run:  cd agent && npm install\n` +
      `  (or run the offline self-test: node agent/mcp/market.mjs selftest)\n  ${e.message}\n`
    );
    process.exit(1);
  }

  const server = new McpServer({ name: "agentpad-market", version: "0.1.0" });
  // Wrap a core read so every tool returns MCP content and surfaces errors as isError, not a throw.
  const tool = (fn) => async (args) => {
    try {
      return { content: [{ type: "text", text: asText(await fn(args)) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `error: ${e.message}` }] };
    }
  };

  server.registerTool(
    "list_assets",
    {
      title: "List tradeable assets",
      description:
        "List the supported asset universe on Robinhood Chain 4663 — each asset's freshness class " +
        "and cutoff, whether it has a Chainlink feed, and its feed and v3 pool addresses.",
      inputSchema: {},
    },
    tool(() => listAssets()),
  );

  server.registerTool(
    "get_price",
    {
      title: "Get freshness-gated decision price",
      description:
        "Read the Chainlink decision price (8-dec) for an asset and enforce the SPEC section 6 " +
        "freshness cutoffs (equities 300s; SGOV/SLV 24h; GLD is feedless — TWAP-priced and blocked " +
        "off-hours). Returns the price and an `ok_to_trade` verdict with a reason. Trade ONLY when " +
        "`ok_to_trade` is true.",
      inputSchema: { asset: z.string().describe("asset symbol, e.g. NVDA, SGOV, GLD, SPY") },
    },
    tool(({ asset }) => getPrice(asset)),
  );

  server.registerTool(
    "get_twap",
    {
      title: "Get v3 pool TWAP (execution sanity)",
      description:
        "Read the Uniswap v3 pool TWAP for an asset (via `observe`), quoted per asset in the pool's " +
        "quote token (USDG, or WETH for SPY). Use ONLY to bound execution slippage, never as truth " +
        "off-hours. Falls back to the slot0 spot tick when the pool's observation cardinality is not " +
        "expanded (flagged `twap_available: false`).",
      inputSchema: {
        asset: z.string().describe("asset symbol, e.g. NVDA, GLD, SPY"),
        window_seconds: z.number().int().positive().optional().describe("TWAP window in seconds (default 1800)"),
      },
    },
    tool(({ asset, window_seconds }) => getTwap(asset, window_seconds)),
  );

  server.registerTool(
    "market_status",
    {
      title: "Is the equity market open",
      description:
        "Report whether the US equity market appears open, derived from a reference equity feed's " +
        "freshness (default NVDA): if the feed is fresh (<=300s) the market is open, else it is " +
        "off-hours. Holiday-proof and fully on-chain. Used to gate GLD and other off-hours calls.",
      inputSchema: { reference: z.string().optional().describe("reference equity asset (default NVDA)") },
    },
    tool(({ reference }) => marketStatus(reference)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; log to stderr only.
  console.error(`agentpad-market MCP server up (stdio) — chain ${CHAIN_ID}, RPC ${RPC}`);
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2];
if (mode === "selftest") {
  runSelftest(process.argv[3]).then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
} else if (mode === "list") {
  console.log(asText(listAssets()));
  process.exit(0);
} else {
  runMcpServer().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
}
