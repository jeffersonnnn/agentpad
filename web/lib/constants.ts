// Verified on-chain constants and product enums, mirrored from FACTS.md and SPEC.md so the frontend
// speaks the exact same language as the Milestone 3 backend (api/launch.mjs). Re-verify addresses
// against FACTS.md before any mainnet write; these are the single frontend source of truth.

import type { Address } from "viem";

// ── Chain (FACTS.md) ────────────────────────────────────────────────────────────────────────────
export const CHAIN_ID = 4663 as const; // Robinhood Chain (viem/chains `robinhood`)
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

// PONS launchpad web app. Our tokens are launched via the PONS factory, so each token has a PONS
// launchpad page with the live trading chart + buy/sell. We link out to it for the full market view.
export const PONS_LAUNCHPAD_URL = "https://www.ponsfamily.com/launchpad";
export function ponsLaunchpadUrl(tokenAddr: string): string {
  return `${PONS_LAUNCHPAD_URL}/${tokenAddr}`;
}

// ── PONS V2 + core tokens (FACTS.md; also encoded in api/launch.mjs) ──────────────────────────────
export const PONS_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const FEE_ESCROW: Address = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // 6 dec, base/payout currency
export const USDG_DECIMALS = 6 as const;
export const LAUNCH_FEE_WEI = 500000000000000n; // 0.0005 ETH — the launch tx carries exactly this, no markup

// ── Quote / paired asset (SPEC.md section 5) ──────────────────────────────────────────────────────
// Launch pairs in native ETH by default; USDG optional. The treasury's base currency is always USDG.
export type QuoteAsset = "ETH" | "USDG";
export const QUOTE_ASSETS: { value: QuoteAsset; label: string }[] = [
  { value: "ETH", label: "ETH (native, default)" },
  { value: "USDG", label: "USDG" },
];

// ── Strategy archetype templates (SPEC.md section 4) ──────────────────────────────────────────────
// The slug is what api/launch.mjs stores in agents.archetype (e.g. --archetype=tech-bull).
export type ArchetypeSlug = "macro" | "tech-bull" | "hard-money" | "index" | "meme-stock" | "yield";

export interface Archetype {
  slug: ArchetypeSlug;
  label: string;
  assets: string[]; // allowed-asset tickers (subset of the ~17 tradeable in FACTS.md) + USDG
  notes: string;
}

export const ARCHETYPES: Archetype[] = [
  { slug: "macro", label: "Macro (safe-haven)", assets: ["SGOV", "GLD", "SLV", "USDG"], notes: "rotates by rates; off-hours-safe leaning" },
  { slug: "tech-bull", label: "Tech Bull", assets: ["NVDA", "TSLA", "AMD", "MSFT", "AMZN", "META", "GOOGL"], notes: "high beta" },
  { slug: "hard-money", label: "Hard Money", assets: ["GLD", "SLV", "USDG"], notes: "metals only" },
  { slug: "index", label: "Index", assets: ["SPY", "QQQ", "SGOV"], notes: "broad ETFs" },
  { slug: "meme-stock", label: "Meme-stock", assets: ["GME", "MSTR", "USO"], notes: "high volatility" },
  { slug: "yield", label: "Yield / Cash", assets: ["SGOV", "USDG"], notes: "parks for yield, minimal trading" },
];

export const ARCHETYPE_SLUGS = ARCHETYPES.map((a) => a.slug);

// ── Distribution policy (ADR 0002 / SPEC.md section 3; distribution_config in db/schema.sql) ──────
export type DistributionMode = "distribute" | "buyback" | "off";
export type DistributionCadence = "hourly" | "daily" | "weekly";

export const DISTRIBUTION_MODES: { value: DistributionMode; label: string }[] = [
  { value: "distribute", label: "Distribute profits to holders" },
  { value: "buyback", label: "Buy back the agent token" },
  { value: "off", label: "Off (no distribution)" },
];

export const DISTRIBUTION_CADENCES: { value: DistributionCadence; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

// PONS advanced option bound (FACTS.md: creatorTaxBps uint16 <= 1000).
export const MAX_CREATOR_TAX_BPS = 1000 as const;

// Preset creator-tax choices shown in the create form. Values are basis points (stored as strings for
// the <Select>); labels are the plain-English percent. Default is 0% (most creators leave it there).
export const CREATOR_TAX_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "0% (recommended)" },
  { value: "50", label: "0.5%" },
  { value: "100", label: "1%" },
  { value: "200", label: "2%" },
  { value: "500", label: "5%" },
];

// Default model recorded on the agent row when the creator does not pick one (matches api DEFAULT_MODEL).
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
