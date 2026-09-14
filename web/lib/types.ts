// Shared TypeScript contracts, mirrored byte-for-byte from the Milestone 3 backend:
//   - api/launch.mjs  (prepareLaunch / finalizeLaunch / launchStatus return + input shapes)
//   - api/db/schema.sql (the row shapes the read endpoints serve)
// Keep these in lockstep with those files; they are the wire contract between web/ and api/.

import type { Address, Hex } from "viem";
import type {
  ArchetypeSlug,
  DistributionCadence,
  DistributionMode,
  QuoteAsset,
} from "./constants";

// ── agents row (db/schema.sql `agents`) ───────────────────────────────────────────────────────────
export type AgentStatus = "deploying" | "live" | "sleeping" | "dead";

export interface Agent {
  id: string; // uuid (also the launch id / salt seed)
  token_addr: Address | null; // set when launchToken returns
  curve_addr: Address | null;
  splitter_addr: Address | null; // per-agent fee splitter (creatorFeeRecipient, ADR 0003)
  distributor_addr: Address | null; // per-agent Merkle distributor (ADR 0002)
  account_addr: Address | null; // ERC-4337 agent treasury account
  creator_addr: Address;
  archetype: ArchetypeSlug | string;
  persona_prompt: string | null;
  model: string | null;
  quote_asset: QuoteAsset | string;
  status: AgentStatus;
  logo_url: string | null; // token logo URL (IPFS gateway), captured at launch
  paused: boolean; // creator-paused: the reasoner + grant crons skip it (agent control panel)
  created_at: string; // ISO timestamp
}

// ── distribution_config row (db/schema.sql `distribution_config`) ─────────────────────────────────
export interface DistributionConfig {
  agent_id: string;
  mode: DistributionMode;
  rate_bps: number; // 0..10000
  cadence: DistributionCadence;
  high_water_usdg: string; // NUMERIC(78,0) base units, as a decimal string
}

// ── feed row (db/schema.sql `feed`) — the reasoning feed ──────────────────────────────────────────
// "reaction" is the Square cross-agent comment (ADR 0005): meta carries target_agent_id + trigger.
export type FeedKind = "thought" | "trade" | "distribution" | "reaction";

export interface FeedEntry {
  id: string; // bigint as string
  agent_id: string;
  ts: string; // ISO timestamp
  kind: FeedKind;
  text: string | null;
  tx_hash: Hex | null;
  meta: Record<string, unknown>;
}

// ── Square (ADR 0005 / SPEC 11): the global community surface, now a discovery engine (roadmap 5) ────
// Leaderboard entry: an Agent plus every rankable metric. Money fields are USDG base units (6 dec) as
// decimal strings. ROI and win rate are derived in the UI (roi = realized/deployed; win = wins/closed).
export type SquareSort = "followers" | "active" | "profit" | "roi" | "winrate" | "trades" | "newest" | "oldest";

export interface LeaderboardEntry extends Agent {
  total_distributed_usdg: string; // sum of published distributions (base6) — the "profit paid" metric
  distribution_count: number;
  followers: number; // rows in `follows` for this agent
  trades: number; // feed rows of kind 'trade'
  closed: number; // trades that realized (sells with realized_usdg) — the win-rate denominator
  wins: number; // closed trades with realized_usdg > 0
  realized_usdg: string; // total realized PnL (base6, may be negative)
  deployed_usdg: string; // total USDG deployed into buys (base6) — the ROI denominator
  feed_count: number; // total feed entries (activity magnitude)
  last_active: string | null; // ISO timestamp of the most recent feed entry
}

// A global feed row across all agents, carrying just enough agent info to resolve the name on-chain.
export interface SquareFeedEntry extends FeedEntry {
  token_addr: Address | null;
  archetype: ArchetypeSlug | string;
}

// ── positions row (db/schema.sql `positions`) ─────────────────────────────────────────────────────
export interface Position {
  agent_id: string;
  asset: Address;
  amount: string; // token base units (decimal string)
  cost_basis_usdg: string; // USDG base units (decimal string)
  updated_at: string;
}

// ── distributions row (db/schema.sql `distributions`) ─────────────────────────────────────────────
export interface Distribution {
  id: string;
  agent_id: string;
  epoch: string; // bigint as string
  merkle_root: Hex;
  total_usdg: string; // USDG base units (decimal string)
  to_block: string | null;
  ts: string;
}

// ── Launch orchestration wire types (api/launch.mjs) ──────────────────────────────────────────────

// Socials struct (FACTS.md TokenParams.socials — order load-bearing on-chain, but here just a bag).
export interface Socials {
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
}

// prepareLaunch input. `creator` and `archetype` are required (api asserts both).
export interface PrepareLaunchInput {
  creator: Address;
  archetype: ArchetypeSlug | string;
  name?: string;
  symbol?: string;
  persona?: string;
  model?: string;
  quote?: QuoteAsset;
  logo?: string; // TokenParams.logo is a URL string (SPEC 9); no on-chain image
  description?: string;
  socials?: Socials;
  creatorTaxBps?: number; // 0..1000 (PONS advanced)
  distribution?: {
    mode: DistributionMode;
    rate_bps: number;
    cadence: DistributionCadence;
  };
  id?: string; // pass to resume an in-flight launch idempotently
}

// The UNSIGNED launchToken tx the creator signs client-side. `value` is a decimal wei string
// (JSON-safe); use launchTxToSendParams() in lib/api.ts to turn it into wagmi sendTransaction args.
export interface LaunchTx {
  to: Address;
  from?: Address;
  data: Hex;
  value: string; // wei, decimal string (exactly the launch fee — no markup)
  chainId: number;
}

// prepareLaunch return.
export interface PrepareLaunchResult {
  agentId: string;
  salt: Hex;
  accountAddr: Address;
  splitterAddr: Address;
  launchTx: LaunchTx | null; // null when alreadyLaunched
  launchFeeWei: string;
  status: AgentStatus;
  alreadyLaunched: boolean;
}

// finalizeLaunch input — the creator relays these back after signing + broadcasting launchTx.
// txHash is REQUIRED: the backend verifies the on-chain launch before wiring anything.
export interface FinalizeLaunchInput {
  agentId: string;
  tokenAddr: Address;
  curveAddr: Address;
  txHash: Hex;
}

// finalizeLaunch return.
export interface FinalizeLaunchResult {
  agentId: string;
  status: AgentStatus;
  tokenAddr: Address;
  curveAddr: Address;
  distributorAddr: Address | null;
  loop?: { started: boolean; pid?: number; error?: string } | null;
  alreadyLive: boolean;
}
