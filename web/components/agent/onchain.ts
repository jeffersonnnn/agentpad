"use client";

// On-chain read helpers for the agent page + board. Everything here is READ-ONLY: ERC-20 metadata
// and balances, the PONS bonding-curve spot price, and graduation state. No writes, no signing.
//
// Price source: the verified curve interface (src/interfaces/IPonsV2BondingCurve.sol / FACTS.md) has
// NO price view — only buy/sell + fee-balance views. So we read a spot price by SIMULATING a tiny
// `buy` on the curve (eth_call, no funds moved) and dividing quote-in by tokens-out. The probe is
// denominated in the token's ACTUAL pair (agents.quote_asset): a native-ETH pair sends msg.value and
// prices in ETH (18 dp); a USDG pair sends no value and prices in USDG (6 dp). The ETH path is
// holdings-free (the call carries msg.value). The USDG path is a holdings-free `buy` that pulls USDG
// via transferFrom, which reverts without a balance/allowance state override (viem's simulate does
// not set one), so a USDG-paired curve degrades gracefully to null and the UI shows a caveat. A
// working USDG spot price needs a state override (the USDG allowance storage slot is NOT in FACTS.md;
// only the balance slot 1 is) or the graduated Uniswap v4 pool. See open_questions / the checklist.

import { formatUnits, type Address } from "viem";
import { useBalance, useReadContract, useReadContracts, useSimulateContract } from "wagmi";
import { CHAIN_ID, EXPLORER_URL, USDG, USDG_DECIMALS } from "@/lib/constants";

// 0x…dEaD — a canonical never-owned address, used as the simulated buyer / burn sink.
export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

// Minimal ERC-20 ABI (metadata + balance reads only).
export const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// The two curve functions we touch: `buy` (simulated for price) and `readyToGraduate` (view).
// Byte-for-byte from src/interfaces/IPonsV2BondingCurve.sol.
export const CURVE_ABI = [
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
  { type: "function", name: "readyToGraduate", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

// ── Known tradeable-asset directory (FACTS.md) — address(lowercase) → { ticker, decimals } ─────────
// Lets the positions/trades panels label a token address with its ticker and format its amount
// without an extra on-chain round-trip. Unknown addresses fall back to on-chain decimals + short addr.
export const ASSETS: Record<string, { ticker: string; decimals: number }> = {
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": { ticker: "NVDA", decimals: 18 },
  "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e": { ticker: "GLD", decimals: 18 },
  "0x92fd66527192e3e61d4ddd13322aa222de86f9b5": { ticker: "SGOV", decimals: 18 },
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": { ticker: "GME", decimals: 18 },
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": { ticker: "TSLA", decimals: 18 },
  "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344": { ticker: "USO", decimals: 18 },
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54": { ticker: "AMZN", decimals: 18 },
  "0xec262a75e413fafd0df80480274532c79d42da09": { ticker: "MSTR", decimals: 18 },
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": { ticker: "MSFT", decimals: 18 },
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": { ticker: "QQQ", decimals: 18 },
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": { ticker: "AAPL", decimals: 18 },
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": { ticker: "META", decimals: 18 },
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": { ticker: "GOOGL", decimals: 18 },
  "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f": { ticker: "SLV", decimals: 18 },
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": { ticker: "AMD", decimals: 18 },
  "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8": { ticker: "NFLX", decimals: 18 },
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": { ticker: "SPY", decimals: 18 },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { ticker: "USDG", decimals: 6 },
  "0xcec185eb182c47d1ba1efc84e6959e18cd620be4": { ticker: "cbBTC", decimals: 8 },
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { ticker: "WETH", decimals: 18 },
};

export function assetInfo(addr?: string | null): { ticker: string; decimals: number } {
  if (!addr) return { ticker: "?", decimals: 18 };
  return ASSETS[addr.toLowerCase()] ?? { ticker: shortAddr(addr), decimals: 18 };
}

// ── Explorer links + formatting ────────────────────────────────────────────────────────────────
export function shortAddr(addr?: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
export function txUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}
export function addrUrl(addr: string): string {
  return `${EXPLORER_URL}/address/${addr}`;
}
export function tokenUrl(addr: string): string {
  return `${EXPLORER_URL}/token/${addr}`;
}

/** Format a base-unit integer string/bigint to a human decimal string with sensible precision. */
export function fmtAmount(base: string | bigint | null | undefined, decimals: number, maxFrac = 4): string {
  if (base === null || base === undefined) return "—";
  let human: string;
  try {
    human = formatUnits(BigInt(base), decimals);
  } catch {
    return "—";
  }
  const n = Number(human);
  if (!Number.isFinite(n)) return human;
  if (n !== 0 && Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

/** Format a USDG base-unit (6 dec) amount as a $ dollar string. */
export function fmtUsdg(base: string | bigint | null | undefined): string {
  if (base === null || base === undefined) return "—";
  let human: string;
  try {
    human = formatUnits(BigInt(base), USDG_DECIMALS);
  } catch {
    return "—";
  }
  const n = Number(human);
  if (!Number.isFinite(n)) return `$${human}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Hooks ────────────────────────────────────────────────────────────────────────────────────────

/** ERC-20 name / symbol / decimals for a token (batched, failure-tolerant). */
export function useTokenMeta(token?: Address | null) {
  const enabled = !!token;
  const res = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: token as Address, abi: ERC20_ABI, functionName: "name", chainId: CHAIN_ID },
          { address: token as Address, abi: ERC20_ABI, functionName: "symbol", chainId: CHAIN_ID },
          { address: token as Address, abi: ERC20_ABI, functionName: "decimals", chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled },
  });
  const [name, symbol, decimals] = res.data ?? [];
  return {
    name: (name?.result as string | undefined) ?? undefined,
    symbol: (symbol?.result as string | undefined) ?? undefined,
    decimals: (decimals?.result as number | undefined) ?? 18,
    isLoading: res.isLoading,
  };
}

/** Native ETH balance of an address, refreshed periodically. */
export function useEthBalance(owner?: Address | null) {
  const res = useBalance({
    address: (owner as Address) ?? undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!owner, refetchInterval: 30_000 },
  });
  return { value: res.data?.value ?? null, isLoading: res.isLoading };
}

/** ERC-20 balance of `owner` for `token`, refreshed periodically. */
export function useErc20Balance(token?: Address | null, owner?: Address | null) {
  const enabled = !!token && !!owner;
  const res = useReadContract({
    address: (token as Address) ?? undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: owner ? [owner as Address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled, refetchInterval: 30_000 },
  });
  return { value: (res.data as bigint | undefined) ?? null, isLoading: res.isLoading };
}

/** USDG (treasury base currency) balance of an address. */
export function useUsdgBalance(owner?: Address | null) {
  return useErc20Balance(USDG, owner);
}

/** The quote asset a curve price is denominated in. null = a pair we cannot price. */
export type PriceQuote = "ETH" | "USDG";

export interface CurvePrice {
  /** Quote asset paid per 1 agent token, in `quoteSymbol` units. null when unknown/unsupported. */
  pricePerToken: number | null;
  /** The pair the price is denominated in ("ETH" | "USDG"); null for an unknown/unsupported pair. */
  quoteSymbol: PriceQuote | null;
  /** true when the pair is one we know how to probe (ETH or USDG). */
  supported: boolean;
  isLoading: boolean;
  /** set when the simulated buy reverted (e.g. graduated curve, or a holdings-free USDG buy). */
  error: boolean;
}

/** Classify agents.quote_asset ("ETH" | "USDG" | an address string) into a priceable pair. */
function classifyQuote(quote?: string | null): PriceQuote | null {
  const q = (quote ?? "USDG").trim();
  if (q.toUpperCase() === "ETH") return "ETH";
  if (q.toUpperCase() === "USDG" || q.toLowerCase() === USDG.toLowerCase()) return "USDG";
  return null; // some other token address — we have no probe for it
}

/**
 * Spot price from the PONS curve by simulating a tiny buy, denominated in the token's ACTUAL pair
 * (see file header). `quote` is the agent's launch quote asset ("ETH" | "USDG" | an address string).
 * A USDG pair reverts holdings-free (no state override), so it degrades gracefully to null.
 */
export function useCurvePrice(curve?: Address | null, quote?: string | null): CurvePrice {
  const quoteSymbol = classifyQuote(quote);
  const isUsdg = quoteSymbol === "USDG";
  const quoteDecimals = isUsdg ? USDG_DECIMALS : 18;
  // Tiny probe, in the pair's own base units: 1 USDG (1e6) or 0.001 ETH (1e15).
  const quoteIn = isUsdg ? 10n ** BigInt(USDG_DECIMALS) : 10n ** 15n;
  const sim = useSimulateContract({
    address: (curve as Address) ?? undefined,
    abi: CURVE_ABI,
    functionName: "buy",
    args: [quoteIn, 0n, DEAD],
    value: isUsdg ? 0n : quoteIn, // native msg.value only for an ETH pair
    account: DEAD,
    chainId: CHAIN_ID,
    query: { enabled: !!curve && quoteSymbol !== null, refetchInterval: 60_000, retry: false },
  });
  const tokensOut = sim.data?.result as bigint | undefined;
  let pricePerToken: number | null = null;
  if (tokensOut && tokensOut > 0n) {
    // quote-in / tokens-out, each formatted with its own decimals (agent tokens are 18 dp).
    const per = Number(formatUnits(quoteIn, quoteDecimals)) / Number(formatUnits(tokensOut, 18));
    pricePerToken = Number.isFinite(per) ? per : null;
  }
  return {
    pricePerToken,
    quoteSymbol,
    supported: quoteSymbol !== null,
    isLoading: sim.isLoading,
    error: quoteSymbol !== null && !!sim.error,
  };
}

/** Whether the agent token's curve has reached the graduation threshold (LP about to / has locked). */
export function useReadyToGraduate(curve?: Address | null) {
  const res = useReadContract({
    address: (curve as Address) ?? undefined,
    abi: CURVE_ABI,
    functionName: "readyToGraduate",
    chainId: CHAIN_ID,
    query: { enabled: !!curve, refetchInterval: 60_000, retry: false },
  });
  return (res.data as boolean | undefined) ?? null;
}

/** Format a curve spot price in its pair's units (ETH suffix, or a USDG $ prefix) with adaptive precision. */
export function fmtCurvePrice(pricePerToken: number | null, quote: PriceQuote | null): string {
  if (pricePerToken === null || quote === null) return "—";
  if (quote === "USDG") {
    if (pricePerToken === 0) return "$0";
    if (pricePerToken < 1e-6) return `$${pricePerToken.toExponential(3)}`;
    return `$${pricePerToken.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  }
  // ETH pair.
  if (pricePerToken === 0) return "0 ETH";
  if (pricePerToken < 1e-6) return `${pricePerToken.toExponential(3)} ETH`;
  return `${pricePerToken.toLocaleString(undefined, { maximumFractionDigits: 9 })} ETH`;
}
