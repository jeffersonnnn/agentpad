// Flagship agent config - "Powell" (Macro / safe-haven). Milestone 5.
//
// This is the ONE hand-built flagship agent AgentPad launches to prove the whole loop end to end
// (BUILD.md M5). It is a plain, importable ES module the launch orchestration and the agent runtime
// consume directly - no new loader, no new format:
//
//   • api/launch.mjs  prepareLaunch(input)   <- `launchInput(creatorAddr)` (exact input shape, SPEC 8)
//   • agent/account.mjs grant                <- `session`   (archetype + USDG cap + max-trades + ttl)
//   • agent/loop.mjs   (env)                 <- `loopEnv()`  (AGENT_ARCHETYPE / MODEL / PERSONA / GOAL)
//   • api/keeper.mjs   distribution epoch     <- `distribution` (mode / rate_bps / cadence, ADR 0002)
//
// SOURCE OF TRUTH for the numbers: SPEC.md section 4 (archetype = macro), section 3/ADR 0002
// (distribution), section 2/ADR 0004 (session key). The persona text lives in ONE place,
// agents/powell.persona.md, and is read in here so it never drifts.
//
// This module VALIDATES itself on import: it resolves the archetype and builds the session policy
// through agent/lib/archetypes.mjs, so an invalid archetype key or an inconsistent cap/ttl throws
// the moment the config is imported, not at launch time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveArchetype,
  buildSessionPolicy,
  USDG_DECIMALS,
} from "../agent/lib/archetypes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Persona (single source: agents/powell.persona.md) ─────────────────────────────────────────────
export const PERSONA_FILE = path.join(__dirname, "powell.persona.md");
export const persona = fs.readFileSync(PERSONA_FILE, "utf8").trim();

// ── Identity + PONS launch metadata (SPEC 9, PLAN 9) ──────────────────────────────────────────────
// `creator` is intentionally NOT hardcoded: the CREATOR's own wallet signs launchToken client-side
// (never the server, ADR 0004). Pass it to launchInput(creatorAddr) at launch time.
export const archetype = "macro"; // SPEC.md section 4 - Macro (safe-haven): SGOV, GLD, SLV, +USDG
export const name = "Powell";
export const symbol = "POWELL";
export const description =
  "A macro safe-haven strategist. Rotates a small book across short treasuries (SGOV), " +
  "gold (GLD), silver (SLV), and USDG cash by the macro regime, and narrates every move. " +
  "Capital protection first. Trades its own fee-funded treasury on Robinhood Chain.";
export const logo = ""; // TokenParams.logo is a URL string (SPEC 9). Set a hosted image URL at launch.

// Quote/pair asset: native ETH by default (SPEC 5; the splitter converts the ETH fee cut to USDG on
// the way in). "USDG" is the reversible alternative. Keep ETH unless you deliberately pair in USDG.
export const quote = "ETH";

// PONS advanced: extra creator tax on top of the pool fee. 0 = none (SPEC 9 / FACTS TokenParams).
export const creatorTaxBps = 0;

// Socials are optional and creator-owned (PLAN 6b). Empty is a proven launch (test/Phase0.fork.t.sol);
// a NON-empty socials launch must be re-verified against live PONS source before mainnet (SPEC 9).
export const socials = {
  twitter: "",
  telegram: "",
  discord: "",
  website: "",
  farcaster: "",
};

// ── Distribution policy (ADR 0002 / SPEC 3) ───────────────────────────────────────────────────────
// Pays holders a share of REALIZED USDG gains above the high-water mark, per epoch. Legal owns the
// characterization (ADR 0001/0002); `buyback` (buy+burn the agent token, no cash to holders) is the
// ready lower-risk fallback if legal requires it - flip `mode` to switch, no code change.
export const distribution = {
  mode: "distribute",   // "distribute" | "buyback" | "off"
  rate_bps: 5000,       // 50% of realized gain above the high-water mark goes to holders
  cadence: "weekly",    // "hourly" | "daily" | "weekly" - weekly suits a slow macro book
};

// ── Session key / spend scope (ADR 0004 / SPEC 2; consumed by agent/account.mjs grant) ────────────
// The chain-enforced bound is perTradeCap x maxTrades over one ttl window (NOT a rolling cumulative
// cap - see archetypes.buildSessionPolicy). Size `capUsdg` to the treasury seed. Rotate the key daily.
export const session = {
  archetype,
  capUsdg: 2000,        // USDG spend budget (whole USDG). perTradeCap = capUsdg / maxTrades = 250 USDG
  maxTrades: 8,         // max userOps per rate-limit interval (pinned to ttl)
  ttl: 86400,           // 24h key lifetime; rotate daily so one budget maps to one day
  stack: "zerodev",     // ZeroDev Kernel v3 + EntryPoint v0.7 (SPEC 2). "alchemy" is the fallback.
};

// ── Brain / loop (consumed by agent/loop.mjs via env) ─────────────────────────────────────────────
export const model = "anthropic/claude-sonnet-5"; // OpenRouter default (BUILD.md stack)
export const goal =
  "Read your portfolio and the fresh price of each allowed asset. State the macro regime you see, " +
  "then decide whether to rotate between SGOV cash, GLD, and SLV within your limits, or to hold. " +
  "Never trade a stale or off-hours price. Explain your reasoning for your holders, then act or hold.";
export const loopIntervalSeconds = 3600; // one decision per hour

// The allowed-asset set, resolved through the SAME code the runtime enforces (archetypes.mjs). USDG
// is always added as the base currency; SPY would add WETH (not in this archetype).
export const allowed = resolveArchetype(archetype); // { key, label, symbols[], allowedTokens[] }

// ── VALIDATE ON IMPORT ────────────────────────────────────────────────────────────────────────────
// Fail fast if the archetype key is unknown or the cap/ttl are inconsistent. `validUntil` is derived
// as now+ttl so buildSessionPolicy's own consistency assertion (interval == ttl) passes.
{
  const capUnits = BigInt(session.capUsdg) * 10n ** BigInt(USDG_DECIMALS);
  const now = Math.floor(Date.now() / 1000);
  buildSessionPolicy({
    archetype: session.archetype,
    spendBudget: capUnits,
    dailyTradeLimit: session.maxTrades,
    validUntil: now + session.ttl,
    ttl: session.ttl,
  });
}

/**
 * The EXACT object api/launch.mjs prepareLaunch(input) consumes (PrepareLaunchInput, web/lib/types.ts).
 * The creator address is supplied at call time - the server never signs the launch (ADR 0004).
 * @param {string} creator 0x address of the creator wallet that will sign launchToken.
 * @param {object} [overrides] optional per-launch overrides (e.g. logo URL, socials, id to resume).
 */
export function launchInput(creator, overrides = {}) {
  if (!creator || !/^0x[0-9a-fA-F]{40}$/.test(creator)) {
    throw new Error(`launchInput: a valid creator 0x address is required (got ${creator})`);
  }
  return {
    creator,
    archetype,
    name,
    symbol,
    persona,
    model,
    quote,
    logo,
    description,
    socials,
    creatorTaxBps,
    distribution,
    ...overrides,
  };
}

/**
 * The env block agent/loop.mjs reads. Merge over process.env when spawning the loop. AGENT_ID is set
 * by the launch orchestration (the agents-row UUID), so it is NOT included here.
 * AGENT_MCP_SERVERS (the on-chain / market / socials MCP server specs) is deployment-specific and is
 * also left to the launch env - see docs/FLAGSHIP-RUNBOOK.md.
 */
export function loopEnv() {
  return {
    AGENT_ARCHETYPE: archetype,
    AGENT_MODEL: model,
    AGENT_PERSONA_FILE: PERSONA_FILE, // single-source persona; loop.mjs reads it (falls back to AGENT_PERSONA)
    AGENT_GOAL: goal,
    AGENT_LOOP_INTERVAL: String(loopIntervalSeconds),
  };
}

/** The account.mjs `grant` CLI flags for this flagship (for the runbook / scripts). */
export function grantFlags() {
  return [
    `--archetype=${session.archetype}`,
    `--cap=${session.capUsdg}`,
    `--max-trades=${session.maxTrades}`,
    `--ttl=${session.ttl}`,
    `--stack=${session.stack}`,
  ];
}

export default {
  archetype, name, symbol, description, logo, quote, creatorTaxBps, socials,
  persona, PERSONA_FILE, distribution, session, model, goal, loopIntervalSeconds,
  allowed, launchInput, loopEnv, grantFlags,
};
