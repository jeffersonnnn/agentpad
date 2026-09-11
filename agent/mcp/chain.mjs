// agent/mcp/chain.mjs — the on-chain MCP server (Milestone 2, BUILD.md / PLAN.md M2.1).
//
// A REAL Model Context Protocol server (@modelcontextprotocol/sdk, stdio transport) that exposes
// the agent's on-chain surface to the brain loop as tools:
//
//   1. get_treasury_balances — read the agent treasury's native ETH + ERC-20 balances on 4663.
//   2. execute_swap          — swap one token for another through the Milestone 1 session-key
//                              ERC-4337 account (SPEC 2 / ADR 0004). The account pays its own gas;
//                              the on-chain session policy caps spend, pins the swap recipient to
//                              the account, and restricts the allowed tokens. No paymaster.
//   3. get_fee_status        — read the per-agent FeeSplitter's config + the PONS escrow credits +
//                              the agent curve's accrued (un-swept) fees (SPEC 1 / ADR 0003).
//
// The swap reuses the approach proven in test/Phase0Stock.fork.t.sol: Uniswap SwapRouter02
// exactInputSingle (selector 0x04e45aaf, params tuple has NO deadline), approve-then-swap, recipient
// = the account. Execution goes through the account-stack seam (agent/lib/stack.mjs) exactly as the
// Milestone 1 runtime does: resumeSession({ approval, sessionSigner }) -> sendCall (one userOp each).
//
// ── Config (env; MCP clients pass these at launch, or ./.env is auto-loaded) ──────────────────────
//   ROBINHOOD_ALCHEMY_RPC   node + bundler URL for 4663 (falls back to the public RPC for READS only;
//                           the public RPC is NOT a bundler, so execute_swap needs the Alchemy URL).
//   AGENT_ACCOUNT           default treasury/account address for get_treasury_balances.
//   AGENT_SESSION_APPROVAL  the serialized grant blob printed by `account.mjs grant` (execute_swap).
//   AGENT_SESSION_KEY       the session PRIVATE key printed by `account.mjs grant` (execute_swap).
//   AGENT_STACK             zerodev (default) | alchemy — the account stack behind lib/stack.mjs.
//   FEE_SPLITTER            default FeeSplitter address for get_fee_status.
//
// ── Run ───────────────────────────────────────────────────────────────────────────────────────
//   node --env-file=.env agent/mcp/chain.mjs      (or register it as an MCP stdio server in a client)
//
// NOTE: this is a stdio server. stdout is the JSON-RPC channel and MUST stay clean — every log here
// goes to stderr (console.error) only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  formatEther,
  isAddress,
  getAddress,
} from "viem";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOKENS, SWAP_ROUTER_02, CHAIN_ID, PUBLIC_RPC } from "../lib/archetypes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny dependency-free .env loader (does not override already-set env), same as account.mjs ---
function autoloadEnv() {
  const candidates = [
    path.join(__dirname, "..", "..", ".env"), // repo root (agent/mcp/../../.env)
    path.join(__dirname, "..", ".env"), // agent/.env
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

const RPC = process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
const HAVE_BUNDLER = !!process.env.ROBINHOOD_ALCHEMY_RPC; // public RPC is node-only, not a bundler

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const publicClient = createPublicClient({ transport: http(RPC), chain });

// --- Minimal ABIs (function shape only) ---
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

// SwapRouter02.exactInputSingle — params tuple has NO deadline field on this router (FACTS.md).
const ROUTER_ABI = [
  {
    type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

const SPLITTER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "agentTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "agentBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "platformToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "platformCurve", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "agentCurve", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "platformQuote", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ponsEscrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "heldPlatformUsdg", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxDeviationBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
];

const ESCROW_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "r", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOfToken", stateMutability: "view", inputs: [{ name: "r", type: "address" }, { name: "t", type: "address" }], outputs: [{ type: "uint256" }] },
];

const CURVE_ABI = [
  { type: "function", name: "quoteFeeBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creatorTaxBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buybackQuoteBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "readyToGraduate", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
];

// Chainlink AggregatorV3 (8-dec equity/RWA feeds) — used to VALUE portfolio positions in USDG for
// get_portfolio. USDG is a ~1:1 USD stable, so a feed's USD answer is treated as the USDG value.
const AGGREGATOR_ABI = [
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

// Verified Chainlink feed addresses (FACTS.md / market.mjs, cross-checked 2026-09-10). GLD and NFLX
// are feedless on 4663 (NFLX honors a NFLX_FEED override). A position in a feedless asset is marked
// unpriceable by get_portfolio rather than silently valued at 0.
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
  NFLX:  process.env.NFLX_FEED || null,
  GLD:   null,
};

/** USD (~USDG) price of one whole token from its Chainlink feed, or null if feedless/unreadable. */
async function feedPriceUsd(sym) {
  const feed = FEEDS[sym];
  if (!feed) return null;
  try {
    const [dec, round] = await Promise.all([
      publicClient.readContract({ address: getAddress(feed), abi: AGGREGATOR_ABI, functionName: "decimals" }).catch(() => 8),
      publicClient.readContract({ address: getAddress(feed), abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
    ]);
    const answer = round[1];
    if (answer <= 0n) return null;
    return Number(answer) / 10 ** Number(dec);
  } catch {
    return null;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
const isZero = (a) => !a || a.toLowerCase() === ZERO;

// Floor a whole-unit numeric (possibly a JS float or scientific-notation string) to `decimals`
// places, returning a fixed-decimal string parseUnits can consume WITHOUT throwing. Defensive: the
// brain loop already floors its enforced slippage floor, but a raw caller could still pass e.g.
// "1e-7" or "0.1234567" for a 6-dec token, which parseUnits rejects. Flooring is conservative for a
// minimum-out (never raises the floor above what was requested).
function toFixedFloorStr(x, decimals) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const expanded = n.toFixed(Math.min(100, decimals + 4)); // expand any sci-notation
  const dot = expanded.indexOf(".");
  if (dot === -1) return expanded;
  if (decimals === 0) return expanded.slice(0, dot);
  return expanded.slice(0, dot) + "." + expanded.slice(dot + 1, dot + 1 + decimals);
}

// Symbol -> address reverse lookup from the verified FACTS.md set.
const SYMBOL_BY_ADDR = Object.fromEntries(
  Object.entries(TOKENS).map(([sym, addr]) => [addr.toLowerCase(), sym]),
);

/** Resolve a token given as a verified symbol (e.g. "NVDA") OR a 0x address. */
function resolveToken(x) {
  if (typeof x !== "string" || !x.length) throw new Error("token is required (a symbol like NVDA or a 0x address)");
  if (x.startsWith("0x")) {
    if (!isAddress(x)) throw new Error(`not a valid address: ${x}`);
    return getAddress(x);
  }
  const addr = TOKENS[x.toUpperCase()];
  if (!addr) throw new Error(`unknown token symbol "${x}". Known: ${Object.keys(TOKENS).join(", ")}`);
  return getAddress(addr);
}

/** Best-effort on-chain read of an ERC-20's decimals + symbol (fed by verified fallback). */
async function tokenMeta(addr) {
  const knownSym = SYMBOL_BY_ADDR[addr.toLowerCase()];
  let decimals, symbol;
  try {
    decimals = Number(await publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }));
  } catch {
    decimals = knownSym === "USDG" ? 6 : 18; // sensible default; stocks are 18-dec
  }
  try {
    symbol = await publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" });
  } catch {
    symbol = knownSym || "?";
  }
  return { decimals, symbol };
}

// JSON.stringify replacer: BigInt -> decimal string.
const bigintReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const json = (o) => JSON.stringify(o, bigintReplacer, 2);

// ---------------------------------------------------------------------------------------------
// Tool: get_treasury_balances
// ---------------------------------------------------------------------------------------------
async function getTreasuryBalances(args) {
  const address = args.address || process.env.AGENT_ACCOUNT;
  if (!address) throw new Error("no address: pass `address` or set AGENT_ACCOUNT in env");
  if (!isAddress(address)) throw new Error(`not a valid address: ${address}`);
  const acct = getAddress(address);

  // Default to USDG (the base currency); accept a list of symbols/addresses.
  const tokenInputs = Array.isArray(args.tokens) && args.tokens.length ? args.tokens : ["USDG"];

  const ethWei = await publicClient.getBalance({ address: acct });
  const tokens = [];
  for (const t of tokenInputs) {
    const addr = resolveToken(t);
    const { decimals, symbol } = await tokenMeta(addr);
    const raw = await publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "balanceOf", args: [acct] });
    tokens.push({ symbol, address: addr, decimals, balance: formatUnits(raw, decimals), raw });
  }

  return { chainId: CHAIN_ID, address: acct, eth: formatEther(ethWei), ethWei, tokens };
}

// ---------------------------------------------------------------------------------------------
// Tool: get_portfolio — the GROUND-TRUTH snapshot the brain loop enforces its risk caps against.
// Matches the loop's PORTFOLIO role contract EXACTLY:
//   { usdg, positions: [{ symbol, amount, value_usdg }], total_value_usdg }
// USDG (base currency) is valued 1:1. Each non-USDG holding is valued via its Chainlink feed
// (USD ~ USDG). A holding whose asset is feedless/unreadable is INCLUDED but marked unpriceable
// (value_usdg: null, priced: false) and is NOT counted into total_value_usdg — the loop then sees a
// conservative (understated) total, which only makes the caps tighter, never looser. Never 0-values.
// ---------------------------------------------------------------------------------------------
async function getPortfolio(args) {
  const address = args.address || process.env.AGENT_ACCOUNT;
  if (!address) throw new Error("no address: pass `address` or set AGENT_ACCOUNT in env");
  if (!isAddress(address)) throw new Error(`not a valid address: ${address}`);
  const acct = getAddress(address);

  // The position universe: an explicit `tokens` list, else every verified token except the base
  // currency (USDG). Only holdings with a non-zero balance become positions.
  const universe = (Array.isArray(args.tokens) && args.tokens.length ? args.tokens : Object.keys(TOKENS))
    .map((t) => String(t).toUpperCase())
    .filter((s) => s !== "USDG");

  // USDG balance (base currency), valued 1:1.
  const usdgAddr = getAddress(TOKENS.USDG);
  const usdgMeta = await tokenMeta(usdgAddr);
  const usdgRaw = await publicClient.readContract({ address: usdgAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [acct] });
  const usdg = Number(formatUnits(usdgRaw, usdgMeta.decimals));

  const positions = [];
  let total = usdg;
  for (const sym of universe) {
    const addr = TOKENS[sym];
    if (!addr) continue; // unknown symbol; skip
    const a = getAddress(addr);
    const meta = await tokenMeta(a);
    const raw = await publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "balanceOf", args: [acct] });
    if (raw === 0n) continue; // not held
    const amount = Number(formatUnits(raw, meta.decimals));
    const price = await feedPriceUsd(sym);
    if (price && price > 0) {
      const value_usdg = amount * price;
      positions.push({ symbol: sym, amount, value_usdg, price_usdg: price, priced: true, raw });
      total += value_usdg;
    } else {
      positions.push({
        symbol: sym, amount, value_usdg: null, price_usdg: null, priced: false, raw,
        note: `no fresh Chainlink feed for ${sym} — value NOT counted in total_value_usdg (conservative).`,
      });
    }
  }

  return { chainId: CHAIN_ID, address: acct, usdg, positions, total_value_usdg: total };
}

// ---------------------------------------------------------------------------------------------
// Tool: execute_swap (through the Milestone 1 session-key account)
// ---------------------------------------------------------------------------------------------
async function executeSwap(args) {
  const approval = args.approval || process.env.AGENT_SESSION_APPROVAL;
  const sessionKey = args.session_key || process.env.AGENT_SESSION_KEY;
  if (!approval || !sessionKey) {
    throw new Error(
      "execute_swap needs a granted session key. Set AGENT_SESSION_APPROVAL and AGENT_SESSION_KEY " +
      "in env (or pass `approval` / `session_key`). Produce them with:\n" +
      "  node --env-file=.env agent/account.mjs grant --archetype=<tech-bull|...> --cap=<usdg> --ttl=<secs>",
    );
  }
  if (!HAVE_BUNDLER) {
    throw new Error(
      "execute_swap needs a bundler: set ROBINHOOD_ALCHEMY_RPC in env (the public RPC is a node only, " +
      "not a bundler, so it cannot submit userOps).",
    );
  }

  const tokenIn = resolveToken(args.token_in);
  const tokenOut = resolveToken(args.token_out);
  const fee = Number(args.fee);
  if (!Number.isInteger(fee) || fee <= 0) throw new Error(`fee must be a positive uint24 pool tier (e.g. 500, 3000, 10000); got ${args.fee}`);
  if (args.amount_in === undefined || args.amount_in === null || `${args.amount_in}` === "") {
    throw new Error("amount_in is required (whole units of token_in, e.g. \"100\" USDG)");
  }

  const metaIn = await tokenMeta(tokenIn);
  const metaOut = await tokenMeta(tokenOut);
  const amountIn = parseUnits(`${args.amount_in}`, metaIn.decimals);
  if (amountIn <= 0n) throw new Error("amount_in must be > 0");

  // amount_out_minimum is the slippage/sandwich floor and is MANDATORY. A zero (or absent) floor is
  // REJECTED — it would let the swap return arbitrarily little token_out (total loss to slippage or a
  // sandwich). The session policy caps spend and pins the recipient, but it does NOT bound
  // amountOutMinimum, so this is the only line of defense for the received amount. The brain loop
  // injects an enforced floor (quote * (1 - 1%)) under this exact key; callers must supply a real one.
  const minOutWhole = args.amount_out_minimum;
  if (minOutWhole === undefined || minOutWhole === null || `${minOutWhole}` === "") {
    throw new Error(
      "amount_out_minimum is required — a swap with no slippage floor is refused. Pass the minimum " +
      "token_out to accept, in whole units (the brain loop injects a 1%-slippage floor automatically).",
    );
  }
  // Defensively floor to metaOut.decimals as a fixed-decimal string before parseUnits, so a float /
  // scientific-notation / excess-precision value can never throw here (guardrail #4).
  const amountOutMinimum = parseUnits(toFixedFloorStr(minOutWhole, metaOut.decimals), metaOut.decimals);
  if (amountOutMinimum <= 0n) {
    throw new Error(
      `amount_out_minimum must be > 0 (got "${minOutWhole}" -> ${amountOutMinimum} smallest units). A zero ` +
      "slippage floor permits total loss to slippage/sandwich and is refused.",
    );
  }
  const warnings = [];

  const stackName = args.stack || process.env.AGENT_STACK || "zerodev";

  // Lazy imports so the READ tools work even if the account SDK is not installed.
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createAccountStack } = await import("../lib/stack.mjs");

  const pk = sessionKey.startsWith("0x") ? sessionKey : "0x" + sessionKey;
  const sessionSigner = privateKeyToAccount(pk);
  const stack = await createAccountStack(stackName, { rpcUrl: RPC, chain });
  const s = await stack.resumeSession({ approval, sessionSigner });
  const account = s.accountAddress;

  // The session policy pins the swap recipient to EQUAL the account (stack-zerodev.mjs). Enforce it
  // here too so a caller can never accidentally build an op the chain will reject at validation.
  const recipient = getAddress(account);

  // token_out balance BEFORE the swap, so we can report the exact amount received (amountOut) as the
  // delta — the brain loop's canonical trade meta needs a real numeric amount_out.
  const outBefore = await publicClient.readContract({ address: tokenOut, abi: ERC20_ABI, functionName: "balanceOf", args: [recipient] });

  // Step 1: approve the router to pull token_in (capped for USDG by the session policy on-chain).
  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [getAddress(SWAP_ROUTER_02), amountIn] });
  const approveReceipt = await s.sendCall({ to: tokenIn, data: approveData }); // approve is a call ON token_in

  // Step 2: exactInputSingle. recipient = the account (policy-enforced).
  const swapData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
  });
  const swapReceipt = await s.sendCall({ to: getAddress(SWAP_ROUTER_02), data: swapData });

  // Resulting token_out balance, and the amount actually received in THIS swap (the delta).
  const outRaw = await publicClient.readContract({ address: tokenOut, abi: ERC20_ABI, functionName: "balanceOf", args: [recipient] });
  const amountOutRaw = outRaw > outBefore ? outRaw - outBefore : 0n;

  const pick = (r) => ({
    userOpHash: r?.userOpHash ?? r?.hash ?? null,
    txHash: r?.receipt?.transactionHash ?? null,
    success: r?.success ?? r?.receipt?.status ?? null,
  });
  const execute = pick(swapReceipt);

  return {
    chainId: CHAIN_ID,
    stack: stackName,
    account,
    // Canonical top-level fields the brain loop reads to record a trade (a REAL on-chain tx hash and
    // a numeric amount_out in whole token_out units). If the swap did not land these are null/0.
    tx_hash: execute.txHash ?? execute.userOpHash ?? null,
    amount_out: formatUnits(amountOutRaw, metaOut.decimals),
    swap: {
      tokenIn: { symbol: metaIn.symbol, address: tokenIn, decimals: metaIn.decimals },
      tokenOut: { symbol: metaOut.symbol, address: tokenOut, decimals: metaOut.decimals },
      fee,
      amountIn: formatUnits(amountIn, metaIn.decimals),
      amountInRaw: amountIn,
      amountOut: formatUnits(amountOutRaw, metaOut.decimals),
      amountOutRaw,
      amountOutMinimum: formatUnits(amountOutMinimum, metaOut.decimals),
      recipient,
    },
    approve: pick(approveReceipt),
    execute,
    tokenOutBalanceAfter: { balance: formatUnits(outRaw, metaOut.decimals), raw: outRaw },
    paidOwnGas: true, // no paymaster (ADR 0004)
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Tool: get_fee_status
// ---------------------------------------------------------------------------------------------
async function getFeeStatus(args) {
  const splitterAddr = args.splitter || process.env.FEE_SPLITTER;
  if (!splitterAddr) throw new Error("no splitter: pass `splitter` or set FEE_SPLITTER in env");
  if (!isAddress(splitterAddr)) throw new Error(`not a valid address: ${splitterAddr}`);
  const splitter = getAddress(splitterAddr);

  const read = (functionName, callArgs = []) =>
    publicClient.readContract({ address: splitter, abi: SPLITTER_ABI, functionName, args: callArgs });

  const [
    owner, agentTreasury, agentBps, platformToken, platformCurve, agentCurveAddr,
    platformQuote, ponsEscrowAddr, heldPlatformUsdg, maxDeviationBps,
  ] = await Promise.all([
    read("owner"), read("agentTreasury"), read("agentBps"), read("platformToken"),
    read("platformCurve"), read("agentCurve"), read("platformQuote"), read("ponsEscrow"),
    read("heldPlatformUsdg"), read("maxDeviationBps"),
  ]);

  // USDG (platformQuote) decimals for formatting the held amount + escrow credits.
  const quoteMeta = await tokenMeta(platformQuote);

  // PONS escrow credits owed to THIS splitter (native ETH leg + the USDG-token leg).
  const [ethCredit, usdgCredit] = await Promise.all([
    publicClient.readContract({ address: ponsEscrowAddr, abi: ESCROW_ABI, functionName: "balanceOf", args: [splitter] }),
    publicClient.readContract({ address: ponsEscrowAddr, abi: ESCROW_ABI, functionName: "balanceOfToken", args: [splitter, platformQuote] }),
  ]);

  // Agent-curve accruals not yet swept (only if the curve is wired).
  let curve = null;
  if (!isZero(agentCurveAddr)) {
    try {
      const [quoteFee, creatorTax, buybackQuote, ready] = await Promise.all([
        publicClient.readContract({ address: agentCurveAddr, abi: CURVE_ABI, functionName: "quoteFeeBalance" }),
        publicClient.readContract({ address: agentCurveAddr, abi: CURVE_ABI, functionName: "creatorTaxBalance" }),
        publicClient.readContract({ address: agentCurveAddr, abi: CURVE_ABI, functionName: "buybackQuoteBalance" }),
        publicClient.readContract({ address: agentCurveAddr, abi: CURVE_ABI, functionName: "readyToGraduate" }),
      ]);
      curve = {
        address: agentCurveAddr,
        pendingQuoteFee: quoteFee,
        pendingCreatorTax: creatorTax,
        pendingBuybackQuote: buybackQuote,
        readyToGraduate: ready,
      };
    } catch (e) {
      curve = { address: agentCurveAddr, error: `curve view read failed: ${e.shortMessage || e.message}` };
    }
  }

  return {
    chainId: CHAIN_ID,
    splitter,
    owner,
    agentTreasury,
    split: { agentBps: Number(agentBps), platformBps: 10_000 - Number(agentBps), agentShare: `${Number(agentBps) / 100}%` },
    platformToken: isZero(platformToken) ? null : platformToken,
    platformCurve: isZero(platformCurve) ? null : platformCurve,
    platformConfigured: !isZero(platformToken) && !isZero(platformCurve),
    platformQuote: { symbol: quoteMeta.symbol, address: platformQuote, decimals: quoteMeta.decimals },
    heldPlatformUsdg: { amount: formatUnits(heldPlatformUsdg, quoteMeta.decimals), raw: heldPlatformUsdg },
    maxDeviationBps: Number(maxDeviationBps),
    ponsEscrow: ponsEscrowAddr,
    escrowCredits: {
      eth: { amount: formatEther(ethCredit), raw: ethCredit },
      usdg: { amount: formatUnits(usdgCredit, quoteMeta.decimals), raw: usdgCredit },
    },
    agentCurve: curve,
    routable: ethCredit > 0n || usdgCredit > 0n || (curve && (curve.pendingQuoteFee > 0n || curve.pendingCreatorTax > 0n)),
  };
}

// ---------------------------------------------------------------------------------------------
// MCP tool registry + dispatch
// ---------------------------------------------------------------------------------------------
const TOOLS = [
  {
    name: "get_treasury_balances",
    description:
      "Read an agent treasury's native ETH and ERC-20 balances on Robinhood Chain 4663. " +
      "Defaults to the USDG balance of AGENT_ACCOUNT; pass `tokens` (symbols like NVDA/USDG or 0x addresses) for more.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "treasury/account address (0x...). Defaults to env AGENT_ACCOUNT." },
        tokens: { type: "array", items: { type: "string" }, description: "token symbols or addresses to read (default [\"USDG\"])." },
      },
    },
  },
  {
    name: "get_portfolio",
    description:
      "Read the agent treasury's ground-truth portfolio on Robinhood Chain 4663 for risk-guardrail " +
      "enforcement: the USDG balance, every non-zero token position with its whole-token amount and " +
      "USDG value (priced off the Chainlink feed; feedless holdings are returned marked unpriceable, " +
      "not zero-valued), and total_value_usdg (sum of USDG + priceable positions). Defaults to " +
      "AGENT_ACCOUNT; pass `tokens` to restrict the position universe.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "treasury/account address (0x...). Defaults to env AGENT_ACCOUNT." },
        tokens: { type: "array", items: { type: "string" }, description: "token symbols/addresses to value as positions (default: all verified tokens minus USDG)." },
      },
    },
  },
  {
    name: "execute_swap",
    description:
      "Swap one token for another through the agent's ERC-4337 session-key account (Uniswap v3 " +
      "SwapRouter02 exactInputSingle). The account pays its own gas; the on-chain session policy caps " +
      "spend, pins the swap recipient to the account, and restricts tokens. Does approve + swap as two " +
      "userOps. Needs a granted session (AGENT_SESSION_APPROVAL + AGENT_SESSION_KEY) and a bundler " +
      "(ROBINHOOD_ALCHEMY_RPC).",
    inputSchema: {
      type: "object",
      properties: {
        token_in: { type: "string", description: "token to spend: a symbol (USDG, NVDA, ...) or a 0x address." },
        token_out: { type: "string", description: "token to receive: a symbol or a 0x address." },
        fee: { type: "number", description: "Uniswap v3 pool fee tier for the pair (e.g. 500, 3000, 10000). See FACTS.md." },
        amount_in: { type: "string", description: "amount of token_in to swap, in whole units (e.g. \"100\" USDG)." },
        amount_out_minimum: { type: "string", description: "REQUIRED minimum token_out to accept, in whole units (the slippage floor). Must be > 0; a zero/absent floor is rejected. The brain loop injects an enforced 1%-slippage floor here." },
        stack: { type: "string", enum: ["zerodev", "alchemy"], description: "account stack (default zerodev / env AGENT_STACK)." },
        approval: { type: "string", description: "session grant blob (defaults to env AGENT_SESSION_APPROVAL)." },
        session_key: { type: "string", description: "session private key (defaults to env AGENT_SESSION_KEY)." },
      },
      required: ["token_in", "token_out", "fee", "amount_in", "amount_out_minimum"],
    },
  },
  {
    name: "get_fee_status",
    description:
      "Read a per-agent FeeSplitter's status on 4663: the 80/20 split config, the platform-token wiring, " +
      "USDG held for buy-and-burn, the PONS escrow fee credits owed to the splitter (ETH + USDG legs), and " +
      "the agent curve's un-swept accrued fees. Use it to decide whether a keeper claim-and-route round is due.",
    inputSchema: {
      type: "object",
      properties: {
        splitter: { type: "string", description: "FeeSplitter address (0x...). Defaults to env FEE_SPLITTER." },
      },
    },
  },
];

const HANDLERS = {
  get_treasury_balances: getTreasuryBalances,
  get_portfolio: getPortfolio,
  execute_swap: executeSwap,
  get_fee_status: getFeeStatus,
};

const server = new Server(
  { name: "agentpad-chain", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args);
    return { content: [{ type: "text", text: json(result) }] };
  } catch (e) {
    console.error(`[agentpad-chain] ${name} failed:`, e.stack || e.message);
    return { content: [{ type: "text", text: `error: ${e.shortMessage || e.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[agentpad-chain] MCP server up on stdio — chain ${CHAIN_ID}, rpc ${HAVE_BUNDLER ? "alchemy (node+bundler)" : "public (reads only)"}. ` +
    `tools: ${TOOLS.map((t) => t.name).join(", ")}`,
  );
}

main().catch((e) => {
  console.error("[agentpad-chain] FAILED to start:", e.stack || e.message);
  process.exit(1);
});
