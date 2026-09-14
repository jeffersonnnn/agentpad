// Archetype -> allowed-token set, and the shared on-chain addresses a session key is scoped to.
//
// Stack-neutral. This file has NO SDK dependency, so it is safe to import before `npm install`
// (the `--plan` mode of account.mjs runs on this alone). The ZeroDev / Alchemy adapters translate
// the neutral token list into their own call + spend policies.
//
// Source of truth: SPEC.md section 4 (archetype templates) and FACTS.md (verified token addresses
// on Robinhood Chain 4663, as of 2026-09-10). Re-verify addresses before any mainnet write.

// --- Verified token addresses (FACTS.md) ---
export const TOKENS = {
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // 6 dec — base trading/accounting/payout currency
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // 18 dec — SPY is quoted in WETH, not USDG
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  GLD:  "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e",
  SGOV: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
  GME:  "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  USO:  "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  MSTR: "0xec262a75e413fAfD0dF80480274532C79D42da09",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  QQQ:  "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  SLV:  "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
  AMD:  "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
  NFLX: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
  SPY:  "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  // --- 24/7 crypto + native coins (roadmap: 24/7 trading). Verified on-chain 2026-09-14 (pool depth,
  //     decimals, fee tier). ETH has a 24/7 Chainlink feed; PONS/MEME/AI are TWAP-priced (feedless),
  //     guarded by a short-vs-long TWAP deviation band like GLD. All 18-dec, USDG-paired, single-hop. ---
  PONS: "0x39dBED3a2bd333467115dE45665cC57F813C4571", // 18 dec — PONS ecosystem token, $592k USDG pool (fee 10000)
  MEME: "0x385F4f8ae47651ce5F58F5265395a669f8281e18", // 18 dec — $40k USDG pool (fee 3000); small size only
  AI:   "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", // 18 dec — $42k USDG pool (fee 10000); small size only
};

// SwapRouter02 (Uniswap v3) — the only DEX target the agent trades through (FACTS.md).
export const SWAP_ROUTER_02 = "0xCaf681a66D020601342297493863E78C959E5cb2";

// EntryPoint v0.7 (SPEC.md section 2, FACTS.md). All adapters pin this.
export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

export const CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

// USDG smallest-unit scale (6 decimals). The spend budget is denominated in USDG.
export const USDG_DECIMALS = 6;

// --- Archetype templates (SPEC.md section 4) ---
// Each lists the tradeable assets. USDG is ALWAYS added by resolveArchetype() as the base currency,
// even when a template does not name it, because every trade legs through USDG (WETH for SPY).
export const ARCHETYPES = {
  "macro":      { label: "Macro (safe-haven)", assets: ["SGOV", "GLD", "SLV"] },
  "tech-bull":  { label: "Tech Bull",          assets: ["NVDA", "TSLA", "AMD", "MSFT", "AMZN", "META", "GOOGL"] },
  "hard-money": { label: "Hard Money",         assets: ["GLD", "SLV"] },
  "index":      { label: "Index",              assets: ["SPY", "QQQ", "SGOV"] },
  "meme-stock": { label: "Meme-stock",         assets: ["GME", "MSTR", "USO"] },
  "yield":      { label: "Yield / Cash",       assets: ["SGOV"] },
  // 24/7 archetype: crypto + native coins that trade around the clock (no US-market-hours gate). ETH is
  // the deep, oracle-backed anchor; PONS/MEME/AI are the chain's most liquid native coins (TWAP-priced).
  "degen":      { label: "Degen (24/7)",       assets: ["WETH", "PONS", "MEME", "AI"] },
};

// Archetypes whose assets trade 24/7 (no US-equity-hours block). Used for UI labelling and to explain
// the difference to creators. The trading engine already permits these via their own price path
// (ETH: a 24/7 Chainlink feed; PONS/MEME/AI: a 24/7 TWAP with a deviation-band guard).
export const ALWAYS_ON_ARCHETYPES = new Set(["degen"]);

/**
 * Resolve an archetype key into the concrete allowed-token set for a session key.
 * Always includes USDG (base currency). Adds WETH when SPY is present (SPY legs through WETH).
 * @param {string} key one of ARCHETYPES
 * @returns {{ key: string, label: string, symbols: string[], allowedTokens: string[] }}
 */
export function resolveArchetype(key) {
  const tpl = ARCHETYPES[key];
  if (!tpl) {
    throw new Error(
      `unknown archetype "${key}". Valid: ${Object.keys(ARCHETYPES).join(", ")}`
    );
  }
  const symbols = [...tpl.assets];
  if (!symbols.includes("USDG")) symbols.push("USDG");
  if (symbols.includes("SPY") && !symbols.includes("WETH")) symbols.push("WETH");

  const allowedTokens = symbols.map((s) => {
    const addr = TOKENS[s];
    if (!addr) throw new Error(`no verified address for asset "${s}"`);
    return addr;
  });
  return { key, label: tpl.label, symbols, allowedTokens };
}

/**
 * Build the stack-neutral session-key policy an adapter installs.
 *
 * IMPORTANT — this is NOT a true rolling "daily cumulative spend cap". The ZeroDev permissions SDK
 * has no cumulative-sum spend policy, so what the chain actually enforces is the PRODUCT of two
 * separate, per-op policies (see stack-zerodev.mjs):
 *   - a per-trade USDG ceiling (`perTradeCap`): every USDG approve is capped at `perTradeCap`, and
 *     USDG may only ever be approved to the SwapRouter02, so no single userOp moves more than
 *     perTradeCap USDG;
 *   - a rate limit of at most `dailyTradeLimit` userOps per rate-limit interval.
 * The honest description of the enforced bound is therefore `perTradeCap x dailyTradeLimit`, NOT a
 * summed cumulative cap. `spendBudget = perTradeCap x dailyTradeLimit` (minus flooring) is only the
 * ceiling of USDG that CAN leave the account, and only when the rate-limit interval and the key TTL
 * coincide (see below). `perTradeCap = floor(spendBudget / dailyTradeLimit)`.
 *
 * Honesty conditions the bound depends on:
 *   1. The rate-limit interval MUST equal the session-key TTL. Otherwise the key can spend
 *      `perTradeCap x dailyTradeLimit` in each interval for as many intervals as it stays alive, so
 *      the "per key life" bound would be larger than advertised. We therefore set
 *      `rateLimitInterval = ttl` and assert `validUntil ≈ now + ttl` here, so the rate-limit window
 *      resets exactly when the key expires — one window, one budget, per key.
 *   2. Daily key rotation is ASSUMED. A true rolling cumulative cap (a running sum that can never be
 *      exceeded regardless of op count or timing) requires a custom ERC-7579 spending-limit module,
 *      which we do NOT build here (flagged as a build-time open item). Until such a module exists,
 *      operators MUST rotate the session key each day so one budget maps to one day.
 *
 * @param {object} p
 * @param {string} p.archetype archetype key
 * @param {bigint} p.spendBudget USDG budget ceiling in smallest units (6 dec) = perTradeCap x dailyTradeLimit
 * @param {number} [p.dailyTradeLimit=10] max userOps per rate-limit interval; the rate-limit ceiling
 * @param {number} p.validUntil unix seconds; the key stops signing after this (the expiry)
 * @param {number} p.ttl session-key lifetime in seconds; the rate-limit interval is pinned to this
 * @param {number} [p.validAfter=0] unix seconds; the key does not sign before this
 * @returns {object} neutral policy consumed by every stack adapter
 */
export function buildSessionPolicy({ archetype, spendBudget, dailyTradeLimit = 10, validUntil, ttl, validAfter = 0 }) {
  const { allowedTokens, symbols, label } = resolveArchetype(archetype);
  if (spendBudget < BigInt(dailyTradeLimit)) {
    throw new Error(`spendBudget (${spendBudget} units) must be >= dailyTradeLimit (${dailyTradeLimit})`);
  }
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`ttl must be a positive integer number of seconds (got ${ttl})`);
  }
  // Enforce that the rate-limit interval equals the key TTL, so `perTradeCap x dailyTradeLimit` is an
  // honest bound over the key's whole life (one rate-limit window that closes when the key expires).
  // We can only pin the interval to ttl; guard that the caller's validUntil actually reflects ttl.
  const now = Math.floor(Date.now() / 1000);
  const start = validAfter > now ? validAfter : now; // when the key first becomes usable
  if (Math.abs((validUntil - start) - ttl) > 5) {
    throw new Error(
      `validUntil (${validUntil}) is inconsistent with ttl (${ttl}s): the expiry must be ~start+ttl so ` +
      `the rate-limit interval (= ttl) and the key expiry coincide (start=${start}).`
    );
  }
  const rateLimitInterval = ttl; // pinned to TTL — see honesty condition 1 above
  const perTradeCap = spendBudget / BigInt(dailyTradeLimit); // floor
  return {
    archetype,
    archetypeLabel: label,
    symbols,
    allowedTokens,          // ERC-20s the key may approve (to the router) / trade
    router: SWAP_ROUTER_02, // the ONLY swap target, and the only approve spender, the key may use
    spendToken: TOKENS.USDG, // the budget is denominated in USDG
    perTradeCap,            // bigint, USDG smallest units — max USDG per approve
    dailyTradeLimit,        // int — max userOps per rate-limit interval
    rateLimitInterval,      // int seconds — pinned to ttl so perTradeCap x dailyTradeLimit is honest per key life
    spendBudget,            // bigint, USDG smallest units — perTradeCap x dailyTradeLimit ceiling (NOT a rolling cumulative cap)
    ttl,                    // int seconds — session-key lifetime
    validUntil,             // expiry (unix seconds)
    validAfter,
  };
}
