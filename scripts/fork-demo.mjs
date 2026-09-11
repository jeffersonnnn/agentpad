// scripts/fork-demo.mjs — end-to-end flagship launch on a LOCAL anvil FORK of RH Chain 4663.
//
// Drives ONE agent ("Powell", Macro archetype) through the REAL product code against the fork at
// http://localhost:8545, persisting to the same Neon DB the running Next.js app reads:
//
//   1. Fork setup   — inject the ZeroDev rate-limit module (anvil_setCode), fund DEPLOYER + a fresh
//                     CREATOR EOA + a relayer (anvil_setBalance), seed the treasury with USDG.
//   2. Launch       — api/launch.mjs prepareLaunch (DEPLOYER deploys the FeeSplitter) -> the CREATOR
//                     signs + broadcasts launchToken on the fork -> finalizeLaunch (verify recipient
//                     == splitter, deploy the per-agent Distributor, write agents row status=live).
//   3. Session key  — agent/lib/stack grantSession (Macro) + owner-deploy the account (handleOps).
//   4. Fees + route — buyer EOAs buy the agent token's curve to accrue a creator fee, then the keeper
//                     claimAndRoute splits 80% USDG to the treasury / 20% held.
//   5. Trade        — the REAL agent loop (agent/loop.mjs) runs one iteration: a REAL OpenRouter
//                     decision + a REAL session-key USDG->SGOV swap via the handleOps submit mode,
//                     writing a thought + a canonical trade feed row + a position to Neon.
//   6. Distribution — a genuine realized gain (whale pumps SGOV, the agent sells it back), then one
//                     keeper distribution epoch (owner-execute funds the Distributor -> setRoot) and a
//                     holder claims USDG by Merkle proof.
//
// THE BUNDLER PROBLEM: the production submit path routes userOps through the Alchemy bundler, which
// does not exist on a fork. We solve it faithfully with the FORK-EXECUTION seam added to
// agent/lib/stack-zerodev.mjs (env AGENT_SUBMIT=handleops + AGENT_RELAYER_KEY): sendCall AND
// sendOwnerCall submit the SAME signed userOp via EntryPoint.handleOps directly (the technique proven
// in agent/test/fork-helpers.mjs). Only the final submit differs; the real loop -> chain.execute_swap
// -> stack.sendCall path is intact. Mainnet (bundler) behavior is the default and untouched.
//
// Run:  node scripts/fork-demo.mjs        (reads ./.env; DO NOT reset the fork or clean up after)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const FORK_RPC = process.env.FORK_RPC || "http://localhost:8545";

// scripts/ has no node_modules of its own; resolve viem from the api workspace (self-contained, no
// symlink). Node honors package "exports", so subpath specifiers resolve too.
const _req = createRequire(path.join(REPO_ROOT, "api", "package.json"));
const _imp = (spec) => import(pathToFileURL(_req.resolve(spec)).href);
const {
  createPublicClient, createWalletClient, createTestClient, http, defineChain,
  getAddress, parseEther, parseUnits, formatUnits, formatEther, encodeFunctionData,
  decodeFunctionResult, keccak256, encodeAbiParameters, toHex, zeroAddress,
} = await _imp("viem");
const { privateKeyToAccount, generatePrivateKey } = await _imp("viem/accounts");

// ── env (load ./.env, then FORCE every chain client onto the fork BEFORE any env-sensitive import) ─
function autoloadEnv() {
  const p = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
autoloadEnv();

// Point EVERYTHING at the fork + enable the fork-execution submit mode. keeper.mjs reads several of
// these at module load, so they MUST be set before it is dynamically imported (below).
process.env.ROBINHOOD_ALCHEMY_RPC = FORK_RPC; // node + "bundler" URL -> the fork
process.env.AGENT_SUBMIT = "handleops";       // fork-execution: submit userOps via EntryPoint.handleOps
process.env.AGENTPAD_START_LOOP = "0";        // do not auto-spawn the loop on finalize (we run it by hand)
process.env.AGENT_STACK = "zerodev";
process.env.KEEPER_STACK = "zerodev";

const norm = (pk) => (pk.startsWith("0x") ? pk : "0x" + pk);
const bigintReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const jlog = (label, o) => console.log(`\n${label}:\n` + JSON.stringify(o, bigintReplacer, 2));

// ── constants (FACTS.md) ──────────────────────────────────────────────────────────────────────────
const CHAIN_ID = 4663;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DEC = 6;
const SGOV = "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5";
const SWAP_ROUTER_02 = "0xCaf681a66D020601342297493863E78C959E5cb2";
const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
const RATE_LIMIT_ADDR = "0xf63d4139B25c836334edD76641356c6b74C86873";
// ZeroDev rate-limit policy singleton runtime (Base/Arbitrum CREATE2-identical) — from fork-helpers.
const RATE_LIMIT_BYTECODE = "0x60806040908082526004908136101561001757600080fd5b600090813560e01c908163244d6cb2146104a857508063309bfb76146104235780636d61fe70146102ae5780637129edce1461026c5780638712147a1461020c5780638a91b0e314610149578063d60b347f14610110578063d8ed2b3c146100aa5763ecd059611461008857600080fd5b346100a75760203660031901126100a757506005602092519135148152f35b80fd5b50823461010c578060031936011261010c576100c46104f6565b8335835260016020528183209060018060a01b0316835260205260ff818320541690519160038210156100f957602083838152f35b634e487b7160e01b815260218452602490fd5b5080fd5b50823461010c57602036600319011261010c5760209181906001600160a01b036101386104db565b168152808452205415159051908152f35b509160208060031936011261020857823567ffffffffffffffff811161020457610176903690850161050c565b8211610204573580855260018252828520338652825260ff838620541660038110156101f157906001869392036101ed578252600181528282203383528152828220805460ff191660021790555282208054909181156101da575060001901905580f35b634e487b7160e01b845260119052602483fd5b8280fd5b634e487b7160e01b865260218552602486fd5b8480fd5b8380fd5b509190346101ed57816003193601126101ed57606092829161022c6104f6565b9035825260026020528282209060018060a01b0316825260205220549065ffffffffffff8151928181168452818160301c166020850152841c1690820152f35b508290600319828136011261010c5760243567ffffffffffffffff81116101ed579061012091360301126100a757506102a760209235610570565b9051908152f35b509160208060031936011261020857823567ffffffffffffffff8111610204576102db903690850161050c565b9081831161041f57803591601f190182875260018452848720338852845260ff8588205416600381101561040c5790879493929161020457806006116102045780600c1161020457601211610208576103d79061033661053a565b908481013560d01c825284820190602681013560d01c8252602c88840191013560d01c81528487526002865287872033885286526103b38888209365ffffffffffff93848092511665ffffffffffff198754161786555116849065ffffffffffff60301b82549160301b169065ffffffffffff60301b1916179055565b51825465ffffffffffff60601b1916911660601b65ffffffffffff60601b16179055565b8252600181528282203383528152828220600160ff198254161790555282209081549060001982146101da5750600101905580f35b634e487b7160e01b885260218752602488fd5b8580fd5b509190346101ed5760803660031901126101ed5761043f6104f6565b5060643567ffffffffffffffff81116102085761045f903690830161050c565b505080358352600160205281832033845260205260ff8284205416906003821015610495575060010361010c5751908152602090f35b634e487b7160e01b845260219052602483fd5b905083346101ed5760203660031901126101ed576020926001600160a01b036104cf6104db565b16815280845220548152f35b600435906001600160a01b03821682036104f157565b600080fd5b602435906001600160a01b03821682036104f157565b9181601f840112156104f15782359167ffffffffffffffff83116104f157602083818601950101116104f157565b604051906060820182811067ffffffffffffffff82111761055a57604052565b634e487b7160e01b600052604160045260246000fd5b906000828152602090600182526040808220338352835260ff818320541660038110156106b75760010361010c578482526002835280822033835283528082206105b861053a565b90549365ffffffffffff918286168152828660301c168083830152838583019760601c16875280156106aa576000190183811161069657610629908987526002845285872033885284528587209065ffffffffffff60301b82549160301b169065ffffffffffff60301b1916179055565b8280875116915116019082821161068257968452600287528284203385529096529120805465ffffffffffff60601b19169190941660601b65ffffffffffff60601b1617909255905160d01b6001600160d01b03191690565b634e487b7160e01b85526011600452602485fd5b634e487b7160e01b86526011600452602486fd5b5060019750505050505050565b634e487b7160e01b83526021600452602483fd";

// ── minimal ABIs ────────────────────────────────────────────────────────────────────────────────
const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const CURVE_BUY = [
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ name: "quoteIn", type: "uint256" }, { name: "minTokensOut", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [{ name: "tokensOut", type: "uint256" }] },
  { type: "function", name: "quoteFeeBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const ROUTER_EXACTIN = [
  { type: "function", name: "exactInputSingle", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
    { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ name: "amountOut", type: "uint256" }] },
];
const QUOTER_ABI = [
  { type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
    { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" }, { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }] },
];
// The 3-arg launchToken overload (from api/launch.mjs FACTORY_ABI) — used ONLY to decode the (token,
// curve) return via a staticcall simulate before the CREATOR broadcasts the real tx.
const LAUNCH_ABI = [{
  type: "function", name: "launchToken", stateMutability: "payable",
  inputs: [
    { name: "params", type: "tuple", components: [
      { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "logo", type: "string" },
      { name: "description", type: "string" },
      { name: "socials", type: "tuple", components: [
        { name: "twitter", type: "string" }, { name: "telegram", type: "string" }, { name: "discord", type: "string" },
        { name: "website", type: "string" }, { name: "farcaster", type: "string" }] },
      { name: "creatorFeeRecipient", type: "address" }, { name: "creatorTaxBps", type: "uint16" },
      { name: "buybackEnabled", type: "bool" }, { name: "expectedEconomics", type: "bytes32" }, { name: "salt", type: "bytes32" }] },
    { name: "launchConfigId", type: "uint256" }, { name: "pairToken", type: "address" }],
  outputs: [{ name: "token", type: "address" }, { name: "curve", type: "address" }],
}];
const DISTRIBUTOR_CLAIM = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [
    { name: "epoch", type: "uint256" }, { name: "index", type: "uint256" }, { name: "account", type: "address" },
    { name: "amount", type: "uint256" }, { name: "merkleProof", type: "bytes32[]" }], outputs: [] },
];

// A generous HTTP timeout + retries: a cold fork proxies un-cached mainnet state to Alchemy, so a
// first-touch of a big contract (the PONS factory, a v3 pool) can exceed viem's 10s default.
const httpFork = () => http(FORK_RPC, { timeout: 120_000, retryCount: 6, retryDelay: 600 });
const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain (fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [FORK_RPC] } } });
const publicClient = createPublicClient({ transport: httpFork(), chain });
const testClient = createTestClient({ mode: "anvil", transport: httpFork(), chain });

// Retry a chain call across transient timeouts / network blips.
async function withRetry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; console.log(`   (retry ${i + 1}/${tries} after: ${errStr(e)})`); await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}

const usdgBal = (a) => publicClient.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [getAddress(a)] });
const tokBal = (t, a) => publicClient.readContract({ address: getAddress(t), abi: ERC20, functionName: "balanceOf", args: [getAddress(a)] });
const fmtUsdg = (u) => formatUnits(u, USDG_DEC);

// Fund an address with USDG by writing balanceOf storage slot 1 (FACTS.md), like fork-helpers.
async function fundUsdg(address, units) {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(address), 1n]));
  await testClient.setStorageAt({ address: USDG, index: slot, value: toHex(units, { size: 32 }) });
  return usdgBal(address);
}
async function setEth(address, ether) { await testClient.setBalance({ address: getAddress(address), value: parseEther(String(ether)) }); }

// SGOV is an OpenZeppelin v5 upgradeable token (ERC-7201 namespaced storage), so its _balances
// mapping lives under the "openzeppelin.storage.ERC20" namespace base slot, NOT slot 0/1.
const SGOV_SLOT_BASE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
async function fundSgov(address, units) {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(address), SGOV_SLOT_BASE]));
  await testClient.setStorageAt({ address: SGOV, index: slot, value: toHex(units, { size: 32 }) });
  return tokBal(SGOV, address);
}

// Quote selling `amountIn` SGOV -> USDG (fee 3000) via QuoterV2 (used to size pool moves).
async function quoteSgovToUsdg(amountIn) {
  const { result } = await publicClient.simulateContract({
    address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: SGOV, tokenOut: USDG, amountIn, fee: 3000, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}
const sgovQuoteWhole = async () => Number(await quoteSgovToUsdg(10n ** 18n)) / 1e6;

// Move the SGOV/USDG pool toward `target` (whole USDG/SGOV) in SMALL chunks from `moverWallet`.
// direction "down" SELLS SGOV (adds SGOV depth — the smooth direction); "up" BUYS SGOV back. We only
// ever move within a band we ourselves refilled by selling down first, so a move UP never approaches
// the concentrated-liquidity cliff (which is what blew the pool out when a single large buy was used).
async function movePool({ moverWallet, mover, direction, target, sgovChunk, usdgChunk, floor = 99, ceil = 101.6, maxSteps = 400 }) {
  let q = await sgovQuoteWhole();
  for (let i = 0; i < maxSteps; i++) {
    q = await sgovQuoteWhole();
    if (direction === "down" ? (q <= target || q <= floor) : (q >= target || q >= ceil)) break;
    // Shrink the chunk as we near the target so a step can't overshoot past it into the thin band edge
    // (a big chunk near the concentrated-liquidity edge blows the price out — the run7 failure mode).
    const near = Math.abs(q - target) < 0.6;
    const args = direction === "down"
      ? { tokenIn: SGOV, tokenOut: USDG, fee: 3000, recipient: mover, amountIn: near ? sgovChunk / 8n : sgovChunk, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }
      : { tokenIn: USDG, tokenOut: SGOV, fee: 3000, recipient: mover, amountIn: near ? usdgChunk / 8n : usdgChunk, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
    const h = await moverWallet.writeContract({ address: SWAP_ROUTER_02, abi: ROUTER_EXACTIN, functionName: "exactInputSingle", args: [args] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  return q;
}

const results = {};
const errStr = (e) => (e && (e.shortMessage || e.message) || String(e)).split("\n").slice(0, 3).join(" | ");

async function main() {
  console.log(`=== AgentPad fork demo — chain ${CHAIN_ID} @ ${FORK_RPC} ===`);
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`fork chainId ${chainId} != ${CHAIN_ID}`);
  const startBlock = await publicClient.getBlockNumber();
  // Restrict holder-log scanning to post-launch blocks so the snapshot is fast on a deep fork.
  process.env.KEEPER_LOG_FROM_BLOCK = startBlock.toString();
  console.log(`fork head block: ${startBlock}`);

  // Dynamic imports AFTER env is pinned to the fork (keeper.mjs reads RPC/log-range at module load).
  const launch = await import(path.join(REPO_ROOT, "api", "launch.mjs"));
  const cfg = (await import(path.join(REPO_ROOT, "agents", "powell.config.mjs"))).default;
  const { buildSessionPolicy, USDG_DECIMALS, TOKENS } = await import(path.join(REPO_ROOT, "agent", "lib", "archetypes.mjs"));
  const { createAccountStack } = await import(path.join(REPO_ROOT, "agent", "lib", "stack.mjs"));
  const keeper = await import(path.join(REPO_ROOT, "api", "keeper.mjs"));
  const loop = await import(path.join(REPO_ROOT, "agent", "loop.mjs"));

  const require = (await import("node:module")).createRequire(path.join(REPO_ROOT, "api", "package.json"));
  const pg = require("pg");
  const conn = process.env.DATABASE_URL;
  const needSsl = /sslmode=require/i.test(conn) || /neon\.tech/i.test(conn);
  const pool = new pg.Pool({ connectionString: conn, ssl: needSsl ? { rejectUnauthorized: false } : undefined, max: 4 });

  // ── STEP 1: fork setup ──────────────────────────────────────────────────────────────────────────
  const deployer = privateKeyToAccount(norm(process.env.DEPLOYER_KEY));
  const creator = privateKeyToAccount(generatePrivateKey());
  const relayerPk = generatePrivateKey();
  const relayer = privateKeyToAccount(relayerPk);
  const buyer = privateKeyToAccount(generatePrivateKey());   // buys the agent token -> a holder
  const whale = privateKeyToAccount(generatePrivateKey());   // pumps SGOV to create a realized gain
  // The relayer PRIVATE KEY drives EntryPoint.handleOps for every userOp on the fork (fork-execution).
  process.env.AGENT_RELAYER_KEY = relayerPk;
  try {
    const codeBefore = await publicClient.getCode({ address: RATE_LIMIT_ADDR });
    const missing = !codeBefore || codeBefore === "0x";
    if (missing) await testClient.setCode({ address: RATE_LIMIT_ADDR, bytecode: RATE_LIMIT_BYTECODE });
    const codeAfter = await publicClient.getCode({ address: RATE_LIMIT_ADDR });

    await setEth(deployer.address, 5);
    await setEth(creator.address, 2);
    await setEth(relayer.address, 100);
    await setEth(buyer.address, 3);
    await setEth(whale.address, 5);
    results.step1 = {
      rate_limit_module: { address: RATE_LIMIT_ADDR, missing_on_fork: missing, code_present_now: !!(codeAfter && codeAfter !== "0x") },
      funded: { deployer: deployer.address, creator: creator.address, relayer: relayer.address, buyer: buyer.address, whale: whale.address },
    };
    jlog("STEP 1 — fork setup", results.step1);
  } catch (e) { results.step1 = { error: errStr(e) }; jlog("STEP 1 FAILED", results.step1); throw e; }

  // Pre-warm the contracts the loop's MCP children read (default-timeout clients), so a cold fork's
  // first-touch Alchemy proxy fetch never times out inside a child. getCode caches contract bytecode.
  try {
    const warm = [...Object.values(TOKENS), SWAP_ROUTER_02, QUOTER,
      "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", "0xa0DF4ee0fFf975306345875E3548Fcc519577A11"]; // NVDA + SGOV feeds
    await Promise.all(warm.map((a) => withRetry(() => publicClient.getCode({ address: getAddress(a) }), 3).catch(() => {})));
    console.log(`prewarmed ${warm.length} contracts`);
  } catch { /* best-effort */ }

  // ── STEP 2: launch via the REAL orchestration ────────────────────────────────────────────────────
  let agentId, accountAddr, splitterAddr, tokenAddr, curveAddr, distributorAddr, salt;
  try {
    const input = cfg.launchInput(creator.address, {
      logo: "https://robohash.org/powell.png?set=set1&size=512x512",
      distribution: { mode: "distribute", rate_bps: 5000, cadence: "hourly" }, // hourly so an epoch can fire on the fork
    });
    input.id = launch.newLaunchId(); // pin the id so a retry RESUMES this launch (never a 2nd row)
    // Route the launch's on-chain reads/writes through our long-timeout clients + shared pool.
    const deployerWallet = createWalletClient({ account: deployer, chain, transport: httpFork() });
    const launchDeps = { publicClient, walletClient: deployerWallet, deployerAccount: deployer, chain, rpcUrl: FORK_RPC, pool };
    const prep = await withRetry(() => launch.prepareLaunch(input, launchDeps));
    agentId = prep.agentId; accountAddr = getAddress(prep.accountAddr); splitterAddr = getAddress(prep.splitterAddr);
    salt = prep.salt;
    console.log(`prepared: agentId=${agentId} splitter=${splitterAddr} account=${accountAddr}`);

    // Seed the treasury BEFORE the loop trades: USDG to trade + ETH to pay its own userOp gas.
    const treasuryUsdg = 2000n * 10n ** BigInt(USDG_DECIMALS);
    await fundUsdg(accountAddr, treasuryUsdg);
    await setEth(accountAddr, 5);

    // The CREATOR signs + broadcasts launchToken (the server NEVER signs it). Simulate first to learn
    // the (token, curve) the factory will deploy, then broadcast the exact unsigned tx.
    const lt = prep.launchTx;
    const sim = await withRetry(() => publicClient.call({ account: creator.address, to: getAddress(lt.to), data: lt.data, value: BigInt(lt.value) }));
    const [tok, cur] = decodeFunctionResult({ abi: LAUNCH_ABI, functionName: "launchToken", data: sim.data });
    tokenAddr = getAddress(tok); curveAddr = getAddress(cur);
    const creatorWallet = createWalletClient({ account: creator, chain, transport: httpFork() });
    const launchHash = await withRetry(() => creatorWallet.sendTransaction({ to: getAddress(lt.to), data: lt.data, value: BigInt(lt.value) }));
    const launchRc = await publicClient.waitForTransactionReceipt({ hash: launchHash });
    if (launchRc.status !== "success") throw new Error(`launchToken tx ${launchHash} reverted`);

    const fin = await withRetry(() => launch.finalizeLaunch({ agentId, tokenAddr, curveAddr, txHash: launchHash }, launchDeps));
    distributorAddr = fin.distributorAddr ? getAddress(fin.distributorAddr) : null;

    results.step2 = {
      agentId, splitter: splitterAddr, account: accountAddr, token: tokenAddr, curve: curveAddr,
      distributor: distributorAddr, launch_tx: launchHash, launch_fee_wei: lt.value, status: fin.status,
      treasury_usdg_seeded: fmtUsdg(await usdgBal(accountAddr)),
    };
    jlog("STEP 2 — launch (live in DB)", results.step2);
  } catch (e) { results.step2 = { error: errStr(e) }; jlog("STEP 2 FAILED", results.step2); throw e; }

  // ── STEP 3: grant the session key + owner-deploy the account (handleOps) ───────────────────────────
  let approval, sessionPk;
  try {
    const ownerKey = launch.deriveAccountOwnerKey(process.env.DEPLOYER_KEY, launch.deriveSalt(agentId));
    const ownerSigner = privateKeyToAccount(ownerKey);
    sessionPk = generatePrivateKey();
    const sessionSigner = privateKeyToAccount(sessionPk);
    const now = Math.floor(Date.now() / 1000);
    const policy = buildSessionPolicy({
      archetype: "macro", spendBudget: BigInt(cfg.session.capUsdg) * 10n ** BigInt(USDG_DECIMALS),
      dailyTradeLimit: cfg.session.maxTrades, validUntil: now + cfg.session.ttl, ttl: cfg.session.ttl,
    });
    const stack = await createAccountStack("zerodev", { rpcUrl: FORK_RPC, chain });
    const grant = await withRetry(() => stack.grantSession({ ownerSigner, sessionSigner, policy, deploy: false }));
    if (getAddress(grant.accountAddress) !== accountAddr) {
      throw new Error(`granted account ${grant.accountAddress} != prepared account ${accountAddr}`);
    }
    approval = grant.approval;
    // Deploy the account on the fork via a sudo (owner) no-op userOp through EntryPoint.handleOps, so
    // the first SESSION op only has to enable the scoped validator (mirrors grantSession deploy=true).
    const dep = await withRetry(() => stack.sendOwnerCall({ ownerSigner, accountAddress: accountAddr, to: accountAddr, data: "0x" }));
    const code = await publicClient.getCode({ address: accountAddr });
    // Persist the grant + session key for the loop's chain MCP server (execute_swap reads these).
    process.env.AGENT_SESSION_APPROVAL = approval;
    process.env.AGENT_SESSION_KEY = sessionPk;
    results.step3 = {
      account: accountAddr, session_key: sessionSigner.address, owner: ownerSigner.address,
      per_trade_cap_usdg: Number(policy.perTradeCap) / 10 ** USDG_DECIMALS, max_trades: policy.dailyTradeLimit,
      ttl_seconds: policy.ttl, deploy_tx: dep?.receipt?.receipt?.transactionHash || dep?.userOpHash,
      account_deployed: !!(code && code !== "0x"),
    };
    jlog("STEP 3 — session key granted + account deployed", results.step3);
  } catch (e) { results.step3 = { error: errStr(e) }; jlog("STEP 3 FAILED", results.step3); throw e; }

  // ── STEP 4: generate fees on the curve + keeper claimAndRoute (80/20) ──────────────────────────────
  try {
    const buyerWallet = createWalletClient({ account: buyer, chain, transport: httpFork() });
    const buys = [];
    for (const eth of ["0.25", "0.25", "0.2"]) {
      const v = parseEther(eth);
      const hash = await buyerWallet.writeContract({ address: curveAddr, abi: CURVE_BUY, functionName: "buy", args: [v, 0n, buyer.address], value: v });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      buys.push({ eth, tx: hash, status: rc.status });
    }
    const buyerTokens = await tokBal(tokenAddr, buyer.address);
    const pendingFee = await publicClient.readContract({ address: curveAddr, abi: CURVE_BUY, functionName: "quoteFeeBalance" });

    const treasuryBefore = await usdgBal(accountAddr);
    await keeper.runOnce(agentId); // FEE ROUTING (+ meter + a distribution attempt that skips: no gain yet)
    const treasuryAfter = await usdgBal(accountAddr);
    const splitterHeld = await usdgBal(splitterAddr);
    // Read the fee_route feed row the keeper wrote.
    const feeRow = (await pool.query(
      `SELECT text, tx_hash, meta FROM feed WHERE agent_id=$1 AND meta->>'type'='fee_route' ORDER BY id DESC LIMIT 1`, [agentId])).rows[0];

    results.step4 = {
      buys, buyer_agent_tokens: formatUnits(buyerTokens, 18), curve_pending_quote_fee_wei: pendingFee.toString(),
      treasury_usdg_before: fmtUsdg(treasuryBefore), treasury_usdg_after: fmtUsdg(treasuryAfter),
      routed_80pct_to_treasury_usdg: fmtUsdg(treasuryAfter - treasuryBefore),
      splitter_held_20pct_usdg: fmtUsdg(splitterHeld),
      fee_route_feed: feeRow ? { text: feeRow.text, tx: feeRow.tx_hash, meta: feeRow.meta } : null,
    };
    jlog("STEP 4 — fees generated + routed 80/20", results.step4);
  } catch (e) { results.step4 = { error: errStr(e) }; jlog("STEP 4 FAILED", results.step4); }

  // ── loop runner (in-process; the chain MCP child inherits AGENT_SUBMIT/RELAYER/SESSION via env) ────
  const mcpDir = path.join(REPO_ROOT, "agent", "mcp");
  const mcpSpecs = [
    { name: "chain", command: process.execPath, args: [path.join(mcpDir, "chain.mjs")] },
    { name: "market", command: process.execPath, args: [path.join(mcpDir, "market.mjs")] },
  ];
  const store = loop.createPgStore(pool);
  const callModel = loop.makeOpenRouterCaller({ apiKey: process.env.OPENROUTER_KEY, model: cfg.model });
  async function runLoopOnce(goal) {
    process.env.AGENT_ID = agentId; process.env.AGENT_ACCOUNT = accountAddr;
    process.env.FEE_SPLITTER = splitterAddr; process.env.AGENT_ARCHETYPE = "macro";
    const mcp = await loop.connectMcp(mcpSpecs);
    try {
      const config = { agentId, archetype: "macro", persona: cfg.persona, memoryN: 20, maxSteps: 12, goal };
      return await loop.runAgentOnce({ config, store, mcp, callModel, log: (m) => console.log(`   [loop] ${m}`) });
    } finally { await mcp.close(); }
  }

  // ── Whale setup: fund SGOV + USDG and pre-approve the router (used to move the pool in 5/6). ──────
  const U = 10n ** BigInt(USDG_DEC);
  const whaleWallet = createWalletClient({ account: whale, chain, transport: httpFork() });
  let poolPrep = {};
  try {
    await fundSgov(whale.address, 200_000n * 10n ** 18n); // SGOV to sell (push price down + add depth)
    await fundUsdg(whale.address, 50_000_000n * U);       // USDG to buy it back (push price up)
    await whaleWallet.writeContract({ address: SGOV, abi: ERC20, functionName: "approve", args: [SWAP_ROUTER_02, 200_000n * 10n ** 18n] });
    await whaleWallet.writeContract({ address: USDG, abi: ERC20, functionName: "approve", args: [SWAP_ROUTER_02, 50_000_000n * U] });
    // Push the pool sell-price DOWN to ~99.5 (below the ~101.05 Chainlink) BEFORE the agent buys, so
    // (i) the agent's Chainlink-referenced 1% slippage floor has ample headroom and the buy fills, and
    // (ii) the agent buys genuinely cheap — the basis for a real realized gain after we push back up.
    const before = await sgovQuoteWhole();
    // Modest push to ~100.0 (below the ~101.05 Chainlink, well ABOVE the ~98 lower cliff): enough
    // headroom for the buy's 1% slippage floor without approaching the concentrated-liquidity edge.
    const after = await movePool({ moverWallet: whaleWallet, mover: whale.address, direction: "down", target: 99.8, sgovChunk: 120n * 10n ** 18n, floor: 99.0 });
    poolPrep = { sgov_quote_before_pushdown: before.toFixed(4), sgov_quote_after_pushdown: after.toFixed(4) };
    jlog("POOL PREP — pushed SGOV/USDG down before the buy", poolPrep);
  } catch (e) { poolPrep = { error: errStr(e) }; jlog("POOL PREP FAILED", poolPrep); }

  // ── STEP 5: the REAL agent loop — one iteration, a real session-key USDG->SGOV buy ─────────────────
  try {
    const goal =
      "You are Powell. You hold only USDG cash and US equities are closed, but SGOV (short treasuries) " +
      "trades on its 24h feed. Rotate idle USDG into SGOV for yield while equities are closed: execute " +
      "exactly ONE buy of 200 USDG into SGOV using the SGOV/USDG Uniswap v3 pool fee tier 3000. First " +
      "read your portfolio and the SGOV price to confirm it is fresh, then place the single buy, then stop.";
    const tokBefore = await tokBal(SGOV, accountAddr);
    const res = await runLoopOnce(goal);
    const tokAfter = await tokBal(SGOV, accountAddr);
    const tradeRow = (await pool.query(`SELECT text, tx_hash, meta FROM feed WHERE agent_id=$1 AND kind='trade' ORDER BY id DESC LIMIT 1`, [agentId])).rows[0];
    results.step5 = {
      loop_finished: res.finished, steps: res.steps,
      sgov_before: formatUnits(tokBefore, 18), sgov_after: formatUnits(tokAfter, 18),
      sgov_acquired: formatUnits(tokAfter - tokBefore, 18),
      trade_feed: tradeRow ? { text: tradeRow.text, tx: tradeRow.tx_hash, meta: tradeRow.meta } : null,
    };
    jlog("STEP 5 — autonomous session-key trade", results.step5);
  } catch (e) { results.step5 = { error: errStr(e) }; jlog("STEP 5 FAILED", results.step5); }

  // ── STEP 6: realized gain (pump SGOV + agent sells) -> keeper distribution epoch -> holder claim ───
  try {
    // (a) Push the pool sell-price back UP to ~101.25 (buying back the SGOV the whale sold in POOL PREP).
    //     The agent bought near ~99.5, so selling near ~101.25 realizes a genuine gain after the 0.6%
    //     round-trip fee. This move only traverses the region the push-DOWN refilled, so it stays well
    //     below the original level and never approaches the concentrated-liquidity cliff.
    const quoteBefore = await sgovQuoteWhole();
    const quoteAfter = await movePool({ moverWallet: whaleWallet, mover: whale.address, direction: "up", target: 101.4, usdgChunk: 15_000n * U, ceil: 101.55 });
    const pump = { sgov_quote_before_pushup: quoteBefore.toFixed(4), sgov_quote_after_pushup: quoteAfter.toFixed(4), pool_prep: poolPrep };

    // (b) The REAL loop sells the appreciated SGOV back to USDG — a realizing leg (realized_usdg > 0).
    const sellGoal =
      "You are Powell. SGOV has appreciated. Realize the gain now: sell your ENTIRE SGOV balance back " +
      "to USDG using the SGOV/USDG Uniswap v3 pool fee tier 3000. Read your portfolio to see your exact " +
      "SGOV balance and confirm the SGOV price is fresh, then execute exactly ONE sell of your full SGOV " +
      "balance to USDG, then stop.";
    const sellRes = await runLoopOnce(sellGoal);
    const sellRow = (await pool.query(`SELECT text, tx_hash, meta FROM feed WHERE agent_id=$1 AND kind='trade' ORDER BY id DESC LIMIT 1`, [agentId])).rows[0];
    const cumRealized = (await pool.query(`SELECT COALESCE(SUM((meta->>'realized_usdg')::numeric),0)::text AS c FROM feed WHERE agent_id=$1 AND kind='trade'`, [agentId])).rows[0].c;

    // (c) Run one keeper distribution epoch. The keeper derives the epoch id from Date.now() (wall
    //     clock) but PINS the holder snapshot to the fork block at/before that epoch's boundary
    //     timestamp. On a freshly-forked chain the launch/buy blocks sit at ~real-now, so the CURRENT
    //     wall-hour boundary falls just BEFORE them and the snapshot would find no holders. So we make
    //     the keeper read the next hourly boundary AFTER the latest fork block as "now" (monkeypatch
    //     Date.now for the call only): blockAtOrBefore(boundary) then returns the latest fork block —
    //     after the buys — so the curve buyer is captured as an eligible holder. This only steers the
    //     keeper's epoch clock on the fork; the product code path is unchanged.
    const latestTs = Number((await publicClient.getBlock()).timestamp);
    const boundary = (Math.floor(latestTs / 3600) + 1) * 3600; // clean hourly boundary strictly > latestTs
    const realDateNow = Date.now;
    Date.now = () => (boundary + 1) * 1000;
    try { await keeper.runOnce(agentId); } finally { Date.now = realDateNow; }
    results.step6_epoch_now = new Date((boundary + 1) * 1000).toISOString();

    const distRow = (await pool.query(`SELECT epoch, merkle_root, total_usdg::text AS total_usdg, to_block FROM distributions WHERE agent_id=$1 ORDER BY epoch DESC LIMIT 1`, [agentId])).rows[0];
    const distFeed = (await pool.query(`SELECT text, tx_hash, meta FROM feed WHERE agent_id=$1 AND kind='distribution' ORDER BY id DESC LIMIT 1`, [agentId])).rows[0];

    let claim = { attempted: false };
    if (distRow) {
      // (d) A holder claims USDG by Merkle proof — rebuild the tree with the keeper's own exported
      //     helpers + the pinned to_block so leaves are byte-identical to the committed root.
      const epoch = BigInt(distRow.epoch);
      const toBlock = BigInt(distRow.to_block);
      const exclude = new Set([curveAddr, splitterAddr, accountAddr, distributorAddr, tokenAddr].filter(Boolean).map((a) => a.toLowerCase()));
      const { holders } = await keeper.snapshotHolders(tokenAddr, toBlock, exclude);
      const leaves = keeper.computeDistribution(holders, BigInt(distRow.total_usdg));
      const leafHashes = leaves.map((l) => keeper.leafHash(epoch, l.index, l.account, l.amount));
      const { root, proofs } = keeper.buildMerkleTree(leafHashes);
      const mine = leaves.find((l) => l.account.toLowerCase() === buyer.address.toLowerCase());
      if (mine && root.toLowerCase() === distRow.merkle_root.toLowerCase()) {
        const usdgBefore = await usdgBal(buyer.address);
        const buyerWallet = createWalletClient({ account: buyer, chain, transport: httpFork() });
        const claimHash = await buyerWallet.writeContract({ address: distributorAddr, abi: DISTRIBUTOR_CLAIM, functionName: "claim",
          args: [epoch, BigInt(mine.index), getAddress(mine.account), mine.amount, proofs[mine.index]] });
        const crc = await publicClient.waitForTransactionReceipt({ hash: claimHash });
        const usdgAfter = await usdgBal(buyer.address);
        claim = { attempted: true, holder: buyer.address, epoch: epoch.toString(), amount_usdg: fmtUsdg(mine.amount),
          claim_tx: claimHash, status: crc.status, holder_usdg_before: fmtUsdg(usdgBefore), holder_usdg_after: fmtUsdg(usdgAfter) };
      } else {
        claim = { attempted: false, reason: mine ? `root mismatch ${root} != ${distRow.merkle_root}` : "controlled holder not in the leaf set", root, holders: holders.length };
      }
    }

    results.step6 = {
      pump, sell_loop_finished: sellRes.finished, sell_trade_feed: sellRow ? { text: sellRow.text, tx: sellRow.tx_hash, meta: sellRow.meta } : null,
      cumulative_realized_usdg: fmtUsdg(BigInt(cumRealized)),
      distribution: distRow ? { epoch: distRow.epoch, merkle_root: distRow.merkle_root, total_usdg: fmtUsdg(BigInt(distRow.total_usdg)), to_block: distRow.to_block } : null,
      distribution_feed: distFeed ? { text: distFeed.text, tx: distFeed.tx_hash, meta: distFeed.meta } : null,
      claim,
    };
    jlog("STEP 6 — distribution + claim", results.step6);
  } catch (e) { results.step6 = { error: errStr(e), stack: (e.stack || "").split("\n").slice(0, 4).join(" | ") }; jlog("STEP 6 FAILED", results.step6); }

  // ── summary ──────────────────────────────────────────────────────────────────────────────────────
  const summary = {
    agentId, view: `http://localhost:3000/agent/${agentId}`,
    token: tokenAddr, curve: curveAddr, splitter: splitterAddr, account: accountAddr, distributor: distributorAddr,
    steps: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.error ? `FAILED: ${v.error}` : "ok"])),
  };
  jlog("=== SUMMARY ===", summary);
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error("\nFATAL:", e.stack || e.message); process.exit(1); });
