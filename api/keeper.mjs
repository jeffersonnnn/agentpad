// api/keeper.mjs — the AgentPad keeper service (BUILD.md M1.2 + M2.4/M2.5, SPEC.md sections 1/3/7).
//
// On a schedule, for every LIVE (and fee-refillable SLEEPING) agent the keeper does three things:
//
//   1. FEE ROUTING — calls the per-agent FeeSplitter.claimAndRoute(): sweep the agent curve's
//      accrued creator fee into the PONS escrow, claim it, convert ETH->USDG, send 80% to the agent
//      treasury and buy-and-burn the platform token with 20% (SPEC 1, ADR 0003). The splitter does
//      all of that internally; the keeper only triggers the round (it is the allowlisted keeper).
//
//   2. TREASURY-METERED SLEEP — reads the agent treasury's USDG balance and the account's native ETH
//      (gas) balance. If the treasury cannot cover one more inference+gas cycle it marks the agent
//      `sleeping`; once refunded past a wake threshold (hysteresis) it wakes it back to `live` (BUILD
//      M2.5). Routing runs BEFORE metering so an incoming fee round can wake a dry agent.
//
//   3. DISTRIBUTION EPOCH — the proven $REBOUND off-chain-snapshot + Merkle-claim payout (SPEC 3,
//      ADR 0002). Per the creator's `distribution_config` (mode/rate/cadence), once per cadence epoch:
//        a. snapshot every holder's balance off-chain (reconstructed from Transfer logs), EXCLUDING
//           the curve/pool, the fee splitter, the agent treasury, the distributor, and dead/zero;
//        b. compute the REALIZED USDG gain ABOVE the high-water mark, take the policy `rate_bps`
//           share of it, and split that pro-rata across holders (deterministic, remainder to the
//           largest holder so the leaf amounts sum EXACTLY to the epoch total);
//        c. fund the Distributor with the epoch's USDG (funding invariant — see FUNDING below), then
//           publish the Merkle root with `setRoot(epoch, root, totalUsdg)`;
//        d. persist the snapshot + the distribution, advance the high-water mark, write the feed.
//
// ── Run ───────────────────────────────────────────────────────────────────────────────────────────
//   node --env-file=.env api/keeper.mjs            # loop forever (KEEPER_INTERVAL_MS, default 60s)
//   node --env-file=.env api/keeper.mjs --once     # one pass over all agents, then exit
//   node --env-file=.env api/keeper.mjs --once --agent=<uuid>   # one pass over a single agent
//   (also auto-loads ./.env at the repo root, so a plain `node api/keeper.mjs` works too.)
//
// ── Env ─────────────────────────────────────────────────────────────────────────────────────────────
//   DATABASE_URL            Postgres (Neon). REQUIRED.
//   ROBINHOOD_ALCHEMY_RPC   node + bundler URL. Falls back to the public RPC (reads only) if unset.
//   DEPLOYER_KEY            the platform keeper key. REQUIRED for on-chain writes (claimAndRoute /
//                           setRoot). It must be the owner OR an allowlisted keeper on each agent's
//                           FeeSplitter and Distributor (SPEC 1/3 — set at launch orchestration, M3).
//                           It ALSO derives each agent account's platform-managed owner (with the
//                           agent salt) for owner-execute treasury funding — see FUNDING.
//   KEEPER_STACK            account-stack for owner-execute funding: "zerodev" (default) | "alchemy".
//   KEEPER_INTERVAL_MS      loop period (default 60000).
//   KEEPER_REALIZED_KEY     feed.meta key holding a trade's realized USDG (base units). Default
//                           "realized_usdg" (the contract with the M2 loop — see CROSS-BUILDER below).
//   KEEPER_SLEEP_USDG / KEEPER_WAKE_USDG   treasury USDG sleep/wake floors, in whole USDG.
//                           Defaults 0.10 / 0.50. Wake needs BOTH usdg and gas above the wake floor.
//   KEEPER_SLEEP_GAS_ETH / KEEPER_WAKE_GAS_ETH   account ETH (gas) sleep/wake floors, in whole ETH.
//                           Defaults 0.0001 / 0.0005.
//   KEEPER_LOG_FROM_BLOCK   first block to scan for Transfer logs (default 0). KEEPER_LOG_CHUNK: the
//                           block page size (default 50000). KEEPER_EXCLUDE: extra addresses to drop
//                           from the holder set (comma-separated, e.g. a post-graduation v4 pool).
//
// ── FUNDING the Distributor (autonomous, via the owner-execute seam) ───────────────────────────────────
//   The Distributor enforces a full-funding invariant: it must already hold USDG covering ALL
//   outstanding claims BEFORE `setRoot`, or `setRoot` reverts `NotFunded`. The USDG belongs to the
//   AGENT TREASURY (its ERC-4337 account), and the keeper key does not — and must not — custody it
//   (ADR 0004). The keeper moves it WITHOUT custody by using the account-stack owner-execute seam
//   (agent/lib/stack.mjs `sendOwnerCall`) to send a userOp FROM the treasury account, under its
//   platform-managed OWNER validator (the per-agent owner derived from DEPLOYER_KEY+salt, SPEC 2 /
//   launch.mjs — NOT the session key, NOT any creator/holder key), that transfers exactly the
//   epoch's distributable USDG into the per-agent Distributor. That is the agent acting on its OWN
//   funds (ADR 0002), consistent with the platform-managed owner in SPEC 2. Then the keeper:
//     - asserts the Distributor holds outstanding + this epoch's total (the full-funding invariant)
//       BEFORE `setRoot`; if the treasury cannot cover it (fees not yet routed) or the transfer does
//       not land, it DEFERS the epoch: it does NOT setRoot and does NOT advance the high-water mark,
//       and retries next tick. Deferral is safe and idempotent (the transfer moves only the shortfall
//       to reach `required`, so a retry after a landed transfer is a no-op); nothing is double-counted.
//   The account pays its own gas for the funding userOp (no paymaster, ADR 0004).
//
// ── CROSS-BUILDER CONTRACTS (flagged, not silently assumed) ───────────────────────────────────────────
//   * Realized gains: the keeper reads cumulative realized USDG as SUM(feed.meta->>'realized_usdg')
//     over kind='trade' rows (base units, integer string). The M2 loop MUST write that key when it
//     banks a closed trade. Override the key name with KEEPER_REALIZED_KEY.
//   * Claim proofs: the on-chain leaf is keccak256(abi.encodePacked(epoch,index,account,amount)) with
//     OpenZeppelin sorted-pair hashing (matches Distributor._verify). The tree is DETERMINISTIC from
//     the stored holder_snapshots + the distribution total. A claim API (M4) reproduces proofs by
//     importing { computeDistribution, buildMerkleTree, leafHash } from this file — do not fork the
//     algorithm, or proofs will not verify.
//
// ── OPEN ITEMS ────────────────────────────────────────────────────────────────────────────────────────
//   1. Post-graduation the agent "pool" is a Uniswap v4 pool, not the curve; add it to KEEPER_EXCLUDE
//      (or, better, the future `agents.pool_addr`) so it is excluded from the holder set.
//   (RESOLVED) `agents.distributor_addr` — a per-agent Distributor deployed at finalizeLaunch; the
//      keeper reads it per agent and SKIPS an epoch (never falls back to a global distributor) when it
//      is missing. (RESOLVED) Treasury->Distributor funding — done via the owner-execute seam (FUNDING).
//
// ── DETERMINISTIC SNAPSHOT BLOCK (claim-side reproducibility) ─────────────────────────────────────────
//   The holder snapshot MUST be reproducible by the claim API, or recomputed Merkle leaves will not
//   match the committed root. So the snapshot block is PINNED per epoch to the last block at/before the
//   epoch-boundary timestamp (`epoch * cadenceSeconds`) — a deterministic function of the epoch id and
//   cadence, not `getBlockNumber()`. It is recorded into `distributions.to_block`. The claim API MUST
//   read `to_block` for the epoch and pass it to `snapshotHolders(token, to_block, exclude)` (exported
//   below) so it rebuilds byte-identical leaves; a backfill of an already-on-chain epoch uses the same
//   pinned block. Do not fork the snapshot/algorithm — import these helpers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  encodePacked,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  formatEther,
  getAddress,
  parseAbiItem,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pg from "pg";
// Single source of truth for the per-agent, platform-managed OWNER key (SPEC 2): the SAME
// derivation launch.mjs used to create each agent's ERC-4337 account. Imported (never re-derived)
// so the keeper's owner-execute signer can never silently diverge from the account's real owner.
import { deriveSalt, deriveAccountOwnerKey } from "./launch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny dependency-free .env loader (does not override already-set env), same shape as account.mjs ---
function autoloadEnv() {
  const candidates = [
    path.join(__dirname, "..", ".env"), // repo root (api/../.env)
    path.join(process.cwd(), ".env"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}
autoloadEnv();

// ─── Constants (FACTS.md, verified on RH Chain 4663) ──────────────────────────────────────────────
const CHAIN_ID = 4663;
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // 6 dec, base/payout currency
const USDG_DECIMALS = 6;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD";

// ─── Config from env ──────────────────────────────────────────────────────────────────────────────
const RPC = process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
const HAVE_BUNDLER = !!process.env.ROBINHOOD_ALCHEMY_RPC;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 60_000);
const REALIZED_KEY = process.env.KEEPER_REALIZED_KEY || "realized_usdg";
const LOG_FROM_BLOCK = BigInt(process.env.KEEPER_LOG_FROM_BLOCK || 0);
const LOG_CHUNK = BigInt(process.env.KEEPER_LOG_CHUNK || 50_000);
const EXTRA_EXCLUDE = (process.env.KEEPER_EXCLUDE || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(isHex40);

const SLEEP_USDG = parseUnits(String(process.env.KEEPER_SLEEP_USDG || "0.10"), USDG_DECIMALS);
const WAKE_USDG = parseUnits(String(process.env.KEEPER_WAKE_USDG || "0.50"), USDG_DECIMALS);
const SLEEP_GAS = parseUnits(String(process.env.KEEPER_SLEEP_GAS_ETH || "0.0001"), 18);
const WAKE_GAS = parseUnits(String(process.env.KEEPER_WAKE_GAS_ETH || "0.0005"), 18);

const CADENCE_SECONDS = { hourly: 3600n, daily: 86_400n, weekly: 604_800n };

function isHex40(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

// ─── viem clients ─────────────────────────────────────────────────────────────────────────────────
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ transport: http(RPC), chain });

let keeperAccount = null;
let walletClient = null;
function keeperSigner() {
  if (walletClient) return walletClient;
  const pk = process.env.DEPLOYER_KEY;
  if (!pk) return null;
  keeperAccount = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  walletClient = createWalletClient({ account: keeperAccount, chain, transport: http(RPC) });
  return walletClient;
}

// Lazily build the account-stack seam (agent/lib/stack.mjs). Only loaded when the keeper needs to
// move treasury USDG via owner-execute, so a read-only pass never imports the account SDK.
const STACK_NAME = process.env.KEEPER_STACK || "zerodev";
let _stack = null;
async function getAccountStack() {
  if (_stack) return _stack;
  const { createAccountStack } = await import("../agent/lib/stack.mjs");
  _stack = await createAccountStack(STACK_NAME, { rpcUrl: RPC, chain });
  return _stack;
}

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const SPLITTER_ABI = [
  { type: "function", name: "claimAndRoute", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "agentAmount", type: "uint256" }, { name: "platformAmount", type: "uint256" }] },
];

const DISTRIBUTOR_ABI = [
  { type: "function", name: "setRoot", stateMutability: "nonpayable", inputs: [{ name: "epoch", type: "uint256" }, { name: "root", type: "bytes32" }, { name: "totalUsdg", type: "uint256" }], outputs: [] },
  { type: "function", name: "epochs", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "merkleRoot", type: "bytes32" }, { name: "totalUsdg", type: "uint256" }, { name: "claimedUsdg", type: "uint256" }] },
  { type: "function", name: "outstandingUsdg", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isFullyFunded", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "usdg", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isKeeper", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }] },
];

// ─── Postgres ─────────────────────────────────────────────────────────────────────────────────────
const { Pool } = pg;
let pool = null;
function db() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set (Postgres/Neon connection string).");
  // Neon (and any sslmode=require URL) needs TLS. node-postgres does not read sslmode from the URL.
  const needSsl = /sslmode=require/i.test(connectionString) || /neon\.tech/i.test(connectionString);
  pool = new Pool({ connectionString, ssl: needSsl ? { rejectUnauthorized: false } : undefined, max: 4 });
  return pool;
}
async function q(text, params) {
  return db().query(text, params);
}

// Detect once whether agents has a distributor_addr column (OPEN ITEM 1).
let _hasDistributorCol = null;
async function hasDistributorColumn() {
  if (_hasDistributorCol !== null) return _hasDistributorCol;
  const r = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'distributor_addr' LIMIT 1`,
  );
  _hasDistributorCol = r.rowCount > 0;
  return _hasDistributorCol;
}

// ─── Merkle (matches Distributor._verify: keccak256(abi.encodePacked(epoch,index,account,amount)),
//     OpenZeppelin sorted-pair hashing) ──────────────────────────────────────────────────────────────
export function leafHash(epoch, index, account, amount) {
  return keccak256(
    encodePacked(
      ["uint256", "uint256", "address", "uint256"],
      [BigInt(epoch), BigInt(index), getAddress(account), BigInt(amount)],
    ),
  );
}

function hashPair(a, b) {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(encodePacked(["bytes32", "bytes32"], [lo, hi]));
}

/**
 * Build a sorted-pair Merkle tree from ordered leaves.
 * @param {`0x${string}`[]} leaves
 * @returns {{ root: `0x${string}`, proofs: `0x${string}`[][] }} proofs[i] proves leaves[i].
 */
export function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: ZERO_BYTES32, proofs: [] };
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 === prev.length) next.push(prev[i]); // odd node promoted
      else next.push(hashPair(prev[i], prev[i + 1]));
    }
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];
  const proofs = leaves.map((_, idx) => {
    const proof = [];
    let index = idx;
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l];
      const pairIndex = index ^ 1;
      if (pairIndex < layer.length) proof.push(layer[pairIndex]);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return { root, proofs };
}
const ZERO_BYTES32 = "0x" + "0".repeat(64);

/**
 * Deterministically split `totalUsdg` (base units, bigint) pro-rata across holders by balance.
 * Holders sorted ascending by address; floor shares; the remainder goes to the largest-balance
 * holder (tie-break: lowest address). Zero-payout holders are dropped from the leaf set. The leaf
 * amounts sum EXACTLY to `totalUsdg` (Distributor exact-sum requirement). A claim API MUST reuse this.
 * @param {{holder:string, balance:bigint}[]} holders  balances > 0, no exclusions.
 * @param {bigint} totalUsdg
 * @returns {{index:number, account:string, amount:bigint}[]} ordered leaf entries (amount > 0).
 */
export function computeDistribution(holders, totalUsdg) {
  const total = holders.reduce((s, h) => s + h.balance, 0n);
  if (total === 0n || totalUsdg === 0n) return [];
  const sorted = [...holders].sort((a, b) => (a.holder.toLowerCase() < b.holder.toLowerCase() ? -1 : 1));
  const shares = sorted.map((h) => (totalUsdg * h.balance) / total); // floor
  let assigned = shares.reduce((s, v) => s + v, 0n);
  const remainder = totalUsdg - assigned;
  if (remainder > 0n) {
    // largest balance, tie-break lowest address (sorted is already ascending by address)
    let best = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i].balance > sorted[best].balance) best = i;
    shares[best] += remainder;
  }
  const leaves = [];
  let index = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (shares[i] === 0n) continue; // drop zero-payout holders
    leaves.push({ index: index++, account: getAddress(sorted[i].holder), amount: shares[i] });
  }
  return leaves;
}

// ─── Deterministic epoch snapshot block ───────────────────────────────────────────────────────────
/**
 * Highest block whose timestamp is <= `timestampSec`. Binary search, so the block a snapshot pins to
 * is a pure function of the (deterministic) epoch-boundary timestamp — reproducible by the claim API.
 * Returns 0n if even the genesis block is later than the target (snapshot then yields no holders).
 * @param {bigint} timestampSec
 * @returns {Promise<bigint>}
 */
export async function blockAtOrBefore(timestampSec) {
  const target = BigInt(timestampSec);
  const latest = await withRetry(() => publicClient.getBlock({ blockTag: "latest" }));
  if (latest.timestamp <= target) return latest.number; // epoch boundary is at/after the chain head
  let lo = 0n, hi = latest.number;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n; // upper mid: converges to the highest block with ts <= target
    const b = await withRetry(() => publicClient.getBlock({ blockNumber: mid }));
    if (b.timestamp <= target) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

// ─── Holder snapshot (reconstruct balances from Transfer logs up to a pinned block) ─────────────────
// Exported so the claim API (M4) reproduces byte-identical leaves: it MUST read the epoch's
// `distributions.to_block` and pass it here as `toBlock` (never call getBlockNumber()).
/**
 * @param {string} tokenAddr
 * @param {bigint} toBlock  the PINNED snapshot block (from distributions.to_block); reproducible.
 * @param {Set<string>} exclude lowercase addresses to drop
 * @returns {Promise<{holders:{holder:string,balance:bigint}[]}>}
 */
export async function snapshotHolders(tokenAddr, toBlock, exclude) {
  const token = getAddress(tokenAddr);
  const balances = new Map(); // lowercase addr -> bigint
  const bump = (addr, delta) => {
    const key = addr.toLowerCase();
    balances.set(key, (balances.get(key) || 0n) + delta);
  };
  for (let from = LOG_FROM_BLOCK; from <= toBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > toBlock ? toBlock : from + LOG_CHUNK - 1n;
    const logs = await withRetry(() =>
      publicClient.getLogs({ address: token, event: TRANSFER_EVENT, fromBlock: from, toBlock: to }),
    );
    for (const lg of logs) {
      const { from: f, to: t, value } = lg.args;
      if (f && f !== ZERO) bump(f, -value); // mints come from the zero address
      if (t) bump(t, value);
    }
  }
  const holders = [];
  for (const [addr, bal] of balances) {
    if (bal <= 0n) continue;
    if (addr === ZERO || addr === DEAD.toLowerCase()) continue;
    if (exclude.has(addr)) continue;
    holders.push({ holder: getAddress(addr), balance: bal });
  }
  return { holders };
}

async function withRetry(fn, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Per-agent helpers ──────────────────────────────────────────────────────────────────────────────
async function fetchAgents(agentId) {
  const withCol = await hasDistributorColumn();
  const distSelect = withCol ? "distributor_addr" : "NULL::text AS distributor_addr";
  const base = `SELECT id, token_addr, curve_addr, splitter_addr, account_addr, archetype, quote_asset, status, ${distSelect} FROM agents`;
  if (agentId) {
    return (await q(`${base} WHERE id = $1`, [agentId])).rows;
  }
  // Route/meter/distribute for live + sleeping agents; skip deploying/dead.
  return (await q(`${base} WHERE status IN ('live','sleeping') ORDER BY created_at`)).rows;
}

async function readUsdgBalance(addr) {
  return publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(addr)] });
}

// 1) FEE ROUTING ────────────────────────────────────────────────────────────────────────────────────
async function routeFees(agent) {
  if (!agent.splitter_addr) return { skipped: "no splitter" };
  const wc = keeperSigner();
  if (!wc) return { skipped: "no DEPLOYER_KEY (read-only)" };
  const splitter = getAddress(agent.splitter_addr);
  try {
    const { result, request } = await publicClient.simulateContract({
      address: splitter, abi: SPLITTER_ABI, functionName: "claimAndRoute", account: keeperAccount,
    });
    const [agentAmount, platformAmount] = result;
    if (agentAmount === 0n && platformAmount === 0n) return { routed: 0n }; // nothing to do
    const hash = await wc.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    await q(
      `INSERT INTO feed (agent_id, kind, text, tx_hash, meta) VALUES ($1,'thought',$2,$3,$4)`,
      [
        agent.id,
        `Routed creator fees: ${fmtUsdg(agentAmount)} USDG to treasury, ${fmtUsdg(platformAmount)} USDG to platform buy-and-burn.`,
        hash,
        JSON.stringify({ type: "fee_route", agent_usdg: agentAmount.toString(), platform_usdg: platformAmount.toString() }),
      ],
    );
    return { routed: agentAmount + platformAmount, hash };
  } catch (e) {
    // Reverts when there is nothing to sweep/claim/route — expected and non-fatal.
    return { skipped: shortErr(e) };
  }
}

// 2) TREASURY-METERED SLEEP ───────────────────────────────────────────────────────────────────────────
async function meterTreasury(agent) {
  if (!agent.account_addr) return { skipped: "no account" };
  const acct = getAddress(agent.account_addr);
  const [usdg, ethBal] = await Promise.all([readUsdgBalance(acct), publicClient.getBalance({ address: acct })]);

  const canRunCycle = usdg >= SLEEP_USDG && ethBal >= SLEEP_GAS;
  const refunded = usdg >= WAKE_USDG && ethBal >= WAKE_GAS; // hysteresis on the way back up

  if (agent.status === "live" && !canRunCycle) {
    await setStatus(agent, "sleeping");
    await note(agent, `Sleeping: treasury cannot cover the next cycle (USDG ${fmtUsdg(usdg)}, ETH ${formatEther(ethBal)}).`,
      { type: "sleep", usdg: usdg.toString(), eth_wei: ethBal.toString() });
    return { transition: "sleeping" };
  }
  if (agent.status === "sleeping" && refunded) {
    await setStatus(agent, "live");
    await note(agent, `Waking: treasury refunded (USDG ${fmtUsdg(usdg)}, ETH ${formatEther(ethBal)}).`,
      { type: "wake", usdg: usdg.toString(), eth_wei: ethBal.toString() });
    return { transition: "live" };
  }
  return { status: agent.status };
}

async function setStatus(agent, status) {
  await q(`UPDATE agents SET status = $2 WHERE id = $1`, [agent.id, status]);
  agent.status = status; // keep the in-memory row consistent for the rest of this tick
}
async function note(agent, text, meta) {
  await q(`INSERT INTO feed (agent_id, kind, text, meta) VALUES ($1,'thought',$2,$3)`, [agent.id, text, JSON.stringify(meta)]);
}

// 3) DISTRIBUTION EPOCH ────────────────────────────────────────────────────────────────────────────────
async function runDistributionEpoch(agent) {
  const cfg = (await q(`SELECT mode, rate_bps, cadence, high_water_usdg FROM distribution_config WHERE agent_id = $1`, [agent.id])).rows[0];
  if (!cfg) return { skipped: "no distribution_config" };
  if (cfg.mode !== "distribute") return { skipped: `mode=${cfg.mode}` }; // buyback/off handled by the policy layer, not the keeper
  if (!agent.token_addr) return { skipped: "no token" };

  const period = CADENCE_SECONDS[cfg.cadence] || CADENCE_SECONDS.hourly;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const epoch = nowSec / period; // integer epoch id for this cadence

  // Idempotency: one publish per (agent, epoch). A row means we already published this epoch.
  if ((await q(`SELECT 1 FROM distributions WHERE agent_id = $1 AND epoch = $2`, [agent.id, epoch.toString()])).rowCount) {
    return { skipped: `epoch ${epoch} already published` };
  }

  // Realized-gain engine (SPEC 3): cumulative realized USDG minus the high-water mark.
  const cumRow = (await q(
    `SELECT COALESCE(SUM((meta->>$2)::numeric), 0)::text AS cum FROM feed WHERE agent_id = $1 AND kind = 'trade'`,
    [agent.id, REALIZED_KEY],
  )).rows[0];
  const cumulativeRealized = BigInt(cumRow.cum);
  const hwm = BigInt(cfg.high_water_usdg);
  const excess = cumulativeRealized - hwm;
  if (excess <= 0n) return { skipped: "no realized gain above high-water mark" };

  const distributable = (excess * BigInt(cfg.rate_bps)) / 10_000n;
  if (distributable <= 0n) return { skipped: `rate_bps=${cfg.rate_bps} yields 0` };

  // Per-agent Distributor (deployed at finalizeLaunch). If it is missing, SKIP this epoch — never
  // fall back to a single global distributor (that would pay one agent's holders from another's).
  const distributorAddr = agent.distributor_addr;
  if (!distributorAddr || !isHex40(distributorAddr)) {
    return { skipped: "no per-agent distributor_addr (skipping; will NOT fall back to a global distributor)" };
  }
  const distributor = getAddress(distributorAddr);

  const wc = keeperSigner();
  if (!wc) return { skipped: "no DEPLOYER_KEY (read-only)" };

  // Snapshot holders at a DETERMINISTIC block: the last block at/before this epoch's boundary
  // timestamp (epoch * cadenceSeconds). Reproducible by the claim API from (epoch, cadence), so the
  // recomputed Merkle leaves match the committed root. Recorded into distributions.to_block below.
  const epochBoundaryTs = epoch * period;
  const toBlock = await blockAtOrBefore(epochBoundaryTs);
  if (toBlock === 0n) return { skipped: `no block at/before epoch boundary ts ${epochBoundaryTs}` };
  const exclude = new Set([
    ...EXTRA_EXCLUDE,
    agent.curve_addr, agent.splitter_addr, agent.account_addr, distributor, agent.token_addr,
  ].filter(Boolean).map((a) => a.toLowerCase()));
  const { holders } = await snapshotHolders(agent.token_addr, toBlock, exclude);
  if (holders.length === 0) return { skipped: "no eligible holders" };

  // Deterministic pro-rata split; leaf amounts sum EXACTLY to the epoch total.
  const leaves = computeDistribution(holders, distributable);
  if (leaves.length === 0) return { skipped: "distributable too small to assign any holder" };
  const totalUsdg = leaves.reduce((s, l) => s + l.amount, 0n);

  // HARD-assert the on-chain invariant (Distributor NatSpec): the totalUsdg we commit MUST equal the
  // exact sum of the leaf amounts. computeDistribution assigns the rounding remainder to the largest
  // holder, so the leaf sum must equal `distributable`; a mismatch is a bug and aborts the commit.
  if (totalUsdg !== distributable) throw new Error(`leaf-sum ${totalUsdg} != distributable ${distributable}`);

  const leafHashes = leaves.map((l) => leafHash(epoch, l.index, l.account, l.amount));
  const { root } = buildMerkleTree(leafHashes);
  if (root === ZERO_BYTES32) return { skipped: "empty root" };

  // On-chain epoch guard: if already set on-chain (DB/chain divergence), backfill DB + advance HWM.
  // Uses the SAME deterministic `toBlock` (recorded below) so the backfilled snapshot is reproducible.
  const onchain = await publicClient.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "epochs", args: [epoch] });
  if (onchain[0] && onchain[0] !== ZERO_BYTES32) {
    await persistDistribution(agent, epoch, onchain[0], onchain[1], holders, cumulativeRealized, null, toBlock);
    return { backfilled: `epoch ${epoch} already on-chain` };
  }

  // Funding invariant (Distributor.setRoot): it must hold outstanding + this epoch's total BEFORE
  // setRoot. Move exactly the shortfall out of the AGENT TREASURY via owner-execute (the agent acting
  // on its OWN funds, ADR 0002; the keeper never custodies it, ADR 0004). On a fresh Distributor the
  // shortfall == this epoch's distributable USDG; moving only the shortfall keeps retries idempotent.
  const [distBal, outstanding] = await Promise.all([
    readUsdgBalance(distributor),
    publicClient.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "outstandingUsdg" }),
  ]);
  const required = outstanding + totalUsdg;
  if (distBal < required) {
    const funded = await fundDistributorFromTreasury(agent, distributor, required - distBal);
    if (!funded.ok) {
      return { deferred: `distributor underfunded by ${fmtUsdg(required - distBal)} USDG — ${funded.reason}` };
    }
    const after = await readUsdgBalance(distributor);
    if (after < required) {
      return { deferred: `funding did not reach the required balance (${fmtUsdg(after)} < ${fmtUsdg(required)}); will retry` };
    }
  }

  // Assert the full-funding invariant on-chain BEFORE setRoot (belt-and-suspenders with the check
  // above): the Distributor itself must report it is fully funded, or setRoot would revert NotFunded.
  const fullyFunded = await publicClient.readContract({ address: distributor, abi: DISTRIBUTOR_ABI, functionName: "isFullyFunded" });
  if (!fullyFunded) return { deferred: "distributor reports not fully funded after funding; will retry" };

  // Publish the root. DEPLOYER_KEY must be owner/keeper on the Distributor or this reverts NotAuthorized.
  const { request } = await publicClient.simulateContract({
    address: distributor, abi: DISTRIBUTOR_ABI, functionName: "setRoot",
    args: [epoch, root, totalUsdg], account: keeperAccount,
  });
  const hash = await wc.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash });

  await persistDistribution(agent, epoch, root, totalUsdg, holders, cumulativeRealized, hash, toBlock);
  return { published: `epoch ${epoch}`, totalUsdg: fmtUsdg(totalUsdg), holders: leaves.length, toBlock: toBlock.toString(), hash };
}

// Persist the snapshot + the distribution and advance the high-water mark, in one transaction.
// `toBlock` is the deterministic snapshot block; it is recorded into distributions.to_block so the
// claim API reproduces byte-identical leaves.
async function persistDistribution(agent, epoch, root, totalUsdg, holders, newHwm, txHash, toBlock) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO distributions (agent_id, epoch, merkle_root, total_usdg, to_block, ts)
       VALUES ($1,$2,$3,$4,$5, now()) ON CONFLICT (agent_id, epoch) DO NOTHING`,
      [agent.id, epoch.toString(), root, totalUsdg.toString(), toBlock.toString()],
    );
    if (holders.length) {
      await client.query(
        `INSERT INTO holder_snapshots (agent_id, epoch, holder, balance)
         SELECT $1, $2, h, b::numeric FROM unnest($3::text[], $4::text[]) AS t(h, b)
         ON CONFLICT (agent_id, epoch, holder) DO NOTHING`,
        [agent.id, epoch.toString(), holders.map((h) => h.holder), holders.map((h) => h.balance.toString())],
      );
    }
    // Advance the high-water mark to the full cumulative realized level distributed FROM (SPEC 3).
    await client.query(
      `UPDATE distribution_config SET high_water_usdg = GREATEST(high_water_usdg, $2::numeric) WHERE agent_id = $1`,
      [agent.id, newHwm.toString()],
    );
    await client.query(
      `INSERT INTO feed (agent_id, kind, text, tx_hash, meta) VALUES ($1,'distribution',$2,$3,$4)`,
      [
        agent.id,
        `Distributed ${fmtUsdg(totalUsdg)} USDG to ${holders.length} holders (epoch ${epoch}).`,
        txHash,
        JSON.stringify({ epoch: epoch.toString(), total_usdg: totalUsdg.toString(), merkle_root: root, distributor: agent.distributor_addr, to_block: toBlock.toString(), holder_count: holders.length }),
      ],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Move `amountUsdg` of the agent's OWN treasury USDG into its Distributor via OWNER-EXECUTE.
//
// The USDG sits in the agent's ERC-4337 account; the keeper key never custodies it (ADR 0004). We
// send a userOp FROM that account, signed by the account's platform-managed OWNER (SPEC 2) — the
// per-agent owner deterministically derived from DEPLOYER_KEY + deriveSalt(agentId), the SAME owner
// launch.mjs granted the account with. NOT the session key, NOT any creator/holder key. The userOp
// calls USDG.transfer(distributor, amountUsdg); the account pays its own gas (no paymaster).
// Returns { ok, reason?, txHash? }. Any failure DEFERS the epoch (safe + idempotent).
async function fundDistributorFromTreasury(agent, distributor, amountUsdg) {
  if (!agent.account_addr || !isHex40(agent.account_addr)) {
    return { ok: false, reason: "no treasury account_addr to fund from" };
  }
  const pk = process.env.DEPLOYER_KEY;
  if (!pk) return { ok: false, reason: "no DEPLOYER_KEY (read-only)" };

  const treasury = getAddress(agent.account_addr);

  // The treasury must actually hold the USDG we intend to move (else the userOp reverts). Defer with
  // a clear reason so the next tick retries once fee routing has topped the treasury up.
  const treasuryUsdg = await readUsdgBalance(treasury);
  if (treasuryUsdg < amountUsdg) {
    return { ok: false, reason: `treasury USDG ${fmtUsdg(treasuryUsdg)} < needed ${fmtUsdg(amountUsdg)} (awaiting fee routing)` };
  }

  try {
    // Derive the account's platform-managed owner — the SAME key launch.mjs used to create it.
    const salt = deriveSalt(agent.id);
    const ownerSigner = privateKeyToAccount(deriveAccountOwnerKey(pk, salt));

    const stack = await getAccountStack();
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [distributor, amountUsdg] });
    const res = await stack.sendOwnerCall({ ownerSigner, accountAddress: treasury, to: USDG, data, value: 0n });
    const txHash = res?.receipt?.receipt?.transactionHash || res?.userOpHash || null;

    await note(agent,
      `Funded Distributor ${distributor} with ${fmtUsdg(amountUsdg)} USDG from the treasury (owner-execute).`,
      { type: "distributor_fund", distributor, amount_usdg: amountUsdg.toString(), tx: txHash });
    return { ok: true, txHash };
  } catch (e) {
    console.error(`  [${agent.id}] owner-execute funding failed: ${shortErr(e)}`);
    return { ok: false, reason: `owner-execute failed: ${shortErr(e)}` };
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────────────────────────────
async function processAgent(agent) {
  const tag = `[${agent.id}]`;
  try {
    const routed = await routeFees(agent);
    logStep(tag, "route", routed);
  } catch (e) {
    console.error(`${tag} route failed: ${shortErr(e)}`);
  }
  try {
    const metered = await meterTreasury(agent);
    logStep(tag, "meter", metered);
  } catch (e) {
    console.error(`${tag} meter failed: ${shortErr(e)}`);
  }
  try {
    const dist = await runDistributionEpoch(agent);
    logStep(tag, "distribute", dist);
  } catch (e) {
    console.error(`${tag} distribute failed: ${shortErr(e)}`);
  }
}

export async function runOnce(agentId) {
  const agents = await fetchAgents(agentId);
  console.error(`keeper: ${agents.length} agent(s) this pass (chain ${CHAIN_ID}, bundler=${HAVE_BUNDLER}).`);
  for (const agent of agents) {
    await processAgent(agent);
  }
  return agents.length;
}

function logStep(tag, step, res) {
  const key = Object.keys(res || {})[0];
  console.error(`${tag} ${step}: ${key ? `${key}=${stringifyVal(res[key])}` : "ok"}`);
}
function stringifyVal(v) {
  return typeof v === "bigint" ? v.toString() : String(v);
}
function fmtUsdg(units) {
  return formatUnits(units, USDG_DECIMALS);
}
function shortErr(e) {
  return (e && (e.shortMessage || e.message) || String(e)).split("\n")[0].slice(0, 200);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v === undefined ? true : v;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  if (!process.env.DEPLOYER_KEY) {
    console.error("keeper: WARNING — DEPLOYER_KEY not set. Running READ-ONLY (no claimAndRoute / setRoot).");
  }

  if (args.once) {
    await runOnce(args.agent || null);
    await pool?.end();
    return;
  }

  console.error(`keeper: starting loop, interval ${INTERVAL_MS}ms. Ctrl-C to stop.`);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    const started = Date.now();
    try {
      await runOnce(args.agent || null);
    } catch (e) {
      console.error(`keeper: pass failed: ${shortErr(e)}`);
    }
    const elapsed = Date.now() - started;
    if (stopping) break;
    await sleep(Math.max(0, INTERVAL_MS - elapsed));
  }
  await pool?.end();
  console.error("keeper: stopped.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error("\nkeeper FAILED:", e.message);
    process.exit(1);
  });
}
