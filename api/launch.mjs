// Milestone 3 — launch orchestration (SPEC.md section 8, PLAN.md section 9, ADR 0003/0004).
//
// One flow turns a launch form + a creator-signed PONS launchToken into a live agent. The order,
// exactly per SPEC.md section 8, with the one necessary refinement noted below:
//
//   1. The platform DEPLOYER_KEY deploys the per-agent FeeSplitter (infra; the deployer pays its
//      own gas). The splitter is that agent token's `creatorFeeRecipient` (ADR 0003), so it MUST
//      exist before the launch. Its constructor needs the agent treasury address, so step 2's
//      counterfactual address is computed FIRST (a pure read that broadcasts nothing) and passed in.
//   2. The DEPLOYER_KEY counterfactually deploys the agent ERC-4337 account — i.e. it computes the
//      account's deterministic (counterfactual) address via the agent/account.mjs stack seam. No
//      on-chain deploy happens here: the account has no ETH at launch and self-deploys lazily on its
//      first funded userOp (ADR 0004, no paymaster). "Counterfactually deploys" == establish the
//      address.
//   3. The CREATOR's wallet signs PONS `launchToken` with `creatorFeeRecipient = the splitter`,
//      `buybackEnabled = false`, paying exactly the 0.0005 ETH launch fee. THE SERVER NEVER SIGNS
//      THIS. `prepareLaunch` returns the unsigned tx; the frontend has the creator sign + broadcast
//      it, then relays the resulting (token, curve) back to `finalizeLaunch`.
//   4. Store the agents row (SPEC.md section 7) and start the loop (agent/loop.mjs).
//
// NEVER CUSTODY (SPEC 2, review property 1): the only key this module signs with is the platform
// DEPLOYER_KEY, and only for INFRA it owns — the FeeSplitter deploy and the splitter's own admin
// calls (setAgentCurve / setKeeper). It NEVER signs a transaction that spends the creator's or a
// holder's funds. `launchToken` (which spends the creator's ETH) is built UNSIGNED and handed back
// for the creator to sign client-side. There is NO launch markup: the tx carries exactly launchFee.
//
// IDEMPOTENT / RETRYABLE (SPEC 8): every step's output is persisted to the agents row before the
// next step runs, keyed by a stable per-agent id. Re-running `prepareLaunch(id)` resumes from the
// last completed step (a redeployed splitter whose tx never confirmed is detected by an empty code
// check and redeployed; a predicted address is recomputed deterministically). `launchToken` is
// never called by the server, and `finalizeLaunch` refuses to re-wire once a token is recorded, so
// a token is never launched twice for one salt.
//
// ── Usage (CLI) ───────────────────────────────────────────────────────────────────────────────────
//   node --env-file=.env api/launch.mjs prepare  --creator=0x.. --name="Nova" --symbol=NOVA \
//        --archetype=tech-bull [--persona="..."] [--quote=ETH|USDG] [--id=<uuid>] [--tax-bps=0]
//        -> deploys the splitter, predicts the account, prints the UNSIGNED launchToken tx (JSON).
//   node --env-file=.env api/launch.mjs finalize --id=<id> --token=0x.. --curve=0x.. --tx=0x..
//        -> verifies the on-chain launch tx (--tx REQUIRED), wires the curve into the splitter,
//           deploys the per-agent Distributor, stores status=live, starts the loop.
//   node --env-file=.env api/launch.mjs status   --id=<id>
//
// ── Env ─────────────────────────────────────────────────────────────────────────────────────────
//   DEPLOYER_KEY          (required for prepare/finalize) platform infra key; deploys the splitter.
//   ROBINHOOD_ALCHEMY_RPC (required) node + bundler URL for chain 4663.
//   DATABASE_URL          (required) Postgres (SPEC.md section 7 schema).
//   PLATFORM_TOKEN        (optional) the platform token address (SPEC 0). Unset -> splitter holds 20%.
//   PLATFORM_CURVE        (optional) the platform token's bonding curve (needed with PLATFORM_TOKEN
//                         to actually buy-and-burn; set both at platform-token go-live).
//   KEEPER_ADDRESS        (optional) allowlist this address on the splitter as a keeper (SPEC 1). If
//                         unset, the owner (DEPLOYER_KEY) is the only caller of claimAndRoute.
//   AGENT_MODEL           (optional) default model recorded on the row / passed to the loop.
//   AGENTPAD_START_LOOP   (optional) "0" disables spawning agent/loop.mjs on finalize (default: on).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  encodeFunctionData,
  decodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  concatHex,
  stringToHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

// ── Verified on-chain constants (FACTS.md, RH Chain 4663) ─────────────────────────────────────────
export const CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"; // fallback; read live from factory
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // base/payout currency (SPEC 5)
export const LAUNCH_FEE_WEI = 500000000000000n; // 0.0005 ETH (FACTS.md)
export const LAUNCH_CONFIG_ID = 0n; // the only launch config (FACTS.md)
export const AGENT_BPS = 8000; // 80/20 split (SPEC 0)
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
// The 3-arg launchToken overload selector (FACTS.md / IPonsV2LaunchFactory.sol). finalizeLaunch
// asserts the creator's on-chain tx used exactly THIS overload before trusting its calldata.
export const LAUNCH_TOKEN_SELECTOR = "0xf35abbcf";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── Minimal ABIs (hand-written from src/interfaces/IPonsV2LaunchFactory.sol; byte-for-byte order) ──
const FACTORY_ABI = [
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeEscrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "launchToken",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "website", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" },
    ],
  },
];

// Load a compiled contract artifact (abi + creation bytecode). In dev, the Foundry build output in
// `out/` is the source of truth, so this stays in sync with src/ without a hardcoded blob. In
// production the box has no Foundry toolchain and `out/` is gitignored, so we fall back to a committed
// copy under `deploy/artifacts/<Name>.json` (trimmed to { abi, bytecode:{object} }, generated from the
// same forge build). The explicit path (tests) still wins over both. Loaded lazily so pure helpers
// need no file I/O.
function loadContractArtifact(name, explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        path.join(REPO_ROOT, "out", `${name}.sol`, `${name}.json`),
        path.join(REPO_ROOT, "deploy", "artifacts", `${name}.json`),
      ];
  let lastErr;
  for (const p of candidates) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      lastErr = e;
      continue;
    }
    const bytecode = json?.bytecode?.object;
    if (!json?.abi || !bytecode) throw new Error(`${name} artifact at ${p} is missing abi/bytecode`);
    return { abi: json.abi, bytecode };
  }
  throw new Error(
    `could not read the compiled ${name} artifact (tried: ${candidates.join(", ")}) — ` +
      `run \`forge build\`, or ship deploy/artifacts/${name}.json (${lastErr?.message || "not found"})`
  );
}

// One FeeSplitter is deployed PER launch (creatorFeeRecipient, ADR 0003).
function loadFeeSplitterArtifact(artifactPath) {
  return loadContractArtifact("FeeSplitter", artifactPath);
}

// One Distributor is deployed PER agent (ADR 0002 / SPEC 3) so holders can claim USDG.
function loadDistributorArtifact(artifactPath) {
  return loadContractArtifact("Distributor", artifactPath);
}

// ── tiny dependency-free .env loader (mirrors agent/account.mjs; does not override set env) ───────
function autoloadEnv() {
  for (const p of [path.join(REPO_ROOT, ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

const normalizePk = (pk) => (!pk ? undefined : pk.startsWith("0x") ? pk : "0x" + pk);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pure helpers (no network, no keys) — exported for tests.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A stable, unique launch id. Used as the agents PK and the seed of the deterministic salt. */
export function newLaunchId() {
  // crypto.randomUUID is available on Node 22.
  return globalThis.crypto?.randomUUID?.() ?? `agent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * The TokenParams.salt for PONS launchToken, derived deterministically from the launch id, so a
 * retry rebuilds the SAME salt (never a second, different launch for one agent). bytes32.
 */
export function deriveSalt(id) {
  return keccak256(stringToHex(`agentpad:launch:${id}`));
}

/**
 * A per-agent, platform-managed OWNER key for the ERC-4337 account, derived deterministically from
 * the DEPLOYER_KEY and the salt. The ZeroDev stack derives the counterfactual account address from
 * the owner signer, so a distinct owner per agent yields a distinct account address (the stack seam
 * does not currently thread a per-account index/salt — see open questions). The owner is
 * platform-managed, an explicitly sanctioned choice (SPEC 2: "the creator (or a platform-managed
 * owner key)"). This never touches the creator's or a holder's key.
 */
export function deriveAccountOwnerKey(deployerKey, salt) {
  const dk = normalizePk(deployerKey);
  if (!dk) throw new Error("deriveAccountOwnerKey: deployerKey required");
  return keccak256(concatHex([dk, salt]));
}

/** Resolve the pair token address from a quote-asset choice. ETH -> address(0) (SPEC 5, FACTS). */
export function pairTokenFor(quoteAsset) {
  const q = String(quoteAsset || "ETH").toUpperCase();
  if (q === "ETH") return zeroAddress;
  if (q === "USDG") return USDG;
  throw new Error(`unsupported quote asset "${quoteAsset}" (use ETH or USDG)`);
}

/**
 * Build the PONS TokenParams for launchToken. `creatorFeeRecipient` is ALWAYS the splitter (ADR
 * 0003), `buybackEnabled` is ALWAYS false (so the splitter may sweep the curve itself, SPEC 1).
 */
export function buildTokenParams({ name, symbol, logo, description, socials, splitterAddr, creatorTaxBps, salt }) {
  const tax = Number(creatorTaxBps ?? 0);
  if (!Number.isInteger(tax) || tax < 0 || tax > 1000) {
    throw new Error(`creatorTaxBps must be an integer in [0, 1000] (got ${creatorTaxBps})`);
  }
  if (!isAddress(splitterAddr)) throw new Error(`splitterAddr is not a valid address: ${splitterAddr}`);
  const s = socials || {};
  return {
    name: String(name ?? ""),
    symbol: String(symbol ?? ""),
    logo: String(logo ?? ""),
    description: String(description ?? ""),
    socials: {
      twitter: String(s.twitter ?? ""),
      telegram: String(s.telegram ?? ""),
      discord: String(s.discord ?? ""),
      website: String(s.website ?? ""),
      farcaster: String(s.farcaster ?? ""),
    },
    creatorFeeRecipient: getAddress(splitterAddr), // ALWAYS the splitter, never the agent wallet
    creatorTaxBps: tax,
    buybackEnabled: false, // ALWAYS off (SPEC 1): the splitter, as fee recipient, sweeps the curve
    expectedEconomics: ZERO32, // 0 waives the economics check (FACTS.md)
    salt,
  };
}

/**
 * Encode the UNSIGNED launchToken transaction the CREATOR signs client-side. No markup: `value` is
 * exactly the launch fee. Returned with bigints as decimal strings so it is JSON-serializable.
 */
export function buildLaunchTx({ params, pairToken, launchFeeWei, creatorAddr, factory = PONS_FACTORY }) {
  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "launchToken",
    args: [params, LAUNCH_CONFIG_ID, pairToken],
  });
  return {
    to: getAddress(factory),
    from: creatorAddr ? getAddress(creatorAddr) : undefined,
    data,
    value: (launchFeeWei ?? LAUNCH_FEE_WEI).toString(), // exactly the launch fee — no markup
    chainId: CHAIN_ID,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Chain clients + the default Postgres store. All injectable via `deps` for tests.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function robinhoodChain(rpcUrl) {
  return defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * Default Postgres store over the SPEC.md section 7 schema. Only the columns SPEC 7 defines are
 * touched. Injectable: pass your own `db` in `deps` (e.g. a shared pool or a test double).
 */
export function makePgStore(pool) {
  return {
    async getAgent(id) {
      const { rows } = await pool.query("SELECT * FROM agents WHERE id = $1", [id]);
      return rows[0] || null;
    },
    async insertAgent(row) {
      await pool.query(
        `INSERT INTO agents
           (id, token_addr, curve_addr, splitter_addr, account_addr, creator_addr,
            archetype, persona_prompt, model, quote_asset, status, logo_url, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id, row.token_addr ?? null, row.curve_addr ?? null, row.splitter_addr ?? null,
          row.account_addr ?? null, row.creator_addr, row.archetype, row.persona_prompt ?? null,
          row.model ?? DEFAULT_MODEL, row.quote_asset ?? "ETH", row.status ?? "deploying",
          row.logo_url ?? null,
        ]
      );
      return this.getAgent(row.id);
    },
    async updateAgent(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return this.getAgent(id);
      const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      await pool.query(`UPDATE agents SET ${set} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
      return this.getAgent(id);
    },
    async insertDistributionConfig(agentId, cfg) {
      await pool.query(
        `INSERT INTO distribution_config (agent_id, mode, rate_bps, cadence, high_water_usdg)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (agent_id) DO NOTHING`,
        [agentId, cfg.mode ?? "off", cfg.rate_bps ?? 0, cfg.cadence ?? "daily", cfg.high_water_usdg ?? 0]
      );
    },
  };
}

// Lazily build the real chain + store deps from env (so importers can inject their own instead).
async function resolveDeps(deps = {}) {
  const rpcUrl = deps.rpcUrl || process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
  const chain = deps.chain || robinhoodChain(rpcUrl);
  const out = { ...deps, rpcUrl, chain };

  if (!out.publicClient) out.publicClient = createPublicClient({ transport: http(rpcUrl), chain });

  if (!out.deployerAccount) {
    const pk = normalizePk(deps.deployerKey || process.env.DEPLOYER_KEY);
    if (pk) out.deployerAccount = privateKeyToAccount(pk);
  }
  if (!out.walletClient && out.deployerAccount) {
    out.walletClient = createWalletClient({ account: out.deployerAccount, transport: http(rpcUrl), chain });
  }

  if (!out.db) {
    if (deps.pool) {
      out.db = makePgStore(deps.pool);
    } else {
      const conn = process.env.DATABASE_URL;
      if (!conn) throw new Error("DATABASE_URL not set (and no `db`/`pool` injected)");
      const pg = (await import("pg")).default;
      out._ownedPool = new pg.Pool({ connectionString: conn });
      out.db = makePgStore(out._ownedPool);
    }
  }

  if (!out.predictAccountAddress) {
    out.predictAccountAddress = async ({ salt }) => {
      const dk = normalizePk(deps.deployerKey || process.env.DEPLOYER_KEY);
      if (!dk) throw new Error("DEPLOYER_KEY required to derive the agent account owner");
      const ownerSigner = privateKeyToAccount(deriveAccountOwnerKey(dk, salt));
      const { createAccountStack } = await import("../agent/lib/stack.mjs");
      const stack = await createAccountStack(deps.stack || "zerodev", { rpcUrl, chain });
      // Pass salt too: the seam documents `predictAddress({ ownerSigner, salt? })`. The current
      // ZeroDev adapter ignores salt, so the per-agent owner (above) is what makes the address
      // unique; passing salt keeps this forward-compatible if the adapter honors it later.
      return stack.predictAddress({ ownerSigner, salt });
    };
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Step 1: deploy the per-agent FeeSplitter (DEPLOYER_KEY, infra). Idempotent via the persisted addr.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function deploySplitter(deps, { agentTreasury }) {
  const { walletClient, publicClient, chain, artifactPath } = deps;
  if (!walletClient) throw new Error("no DEPLOYER_KEY: cannot deploy the FeeSplitter");
  const { abi, bytecode } = loadFeeSplitterArtifact(artifactPath);

  // Resolve the PONS escrow live (falls back to the verified constant).
  let escrow = FEE_ESCROW;
  try {
    escrow = await publicClient.readContract({ address: getAddress(PONS_FACTORY), abi: FACTORY_ABI, functionName: "feeEscrow" });
  } catch { /* keep the constant */ }

  const platformToken = normalizeAddrOrZero(process.env.PLATFORM_TOKEN);
  const platformCurve = normalizeAddrOrZero(process.env.PLATFORM_CURVE);

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    chain,
    account: walletClient.account,
    args: [
      getAddress(agentTreasury), // 80% lands here, in USDG
      platformToken,             // address(0) until PLATFORM_TOKEN is set -> splitter holds the 20%
      getAddress(USDG),          // platformQuote = base/payout currency
      getAddress(escrow),        // PONS V2 fee escrow
      zeroAddress,               // agentCurve unknown until after launch -> setAgentCurve later
      platformCurve,             // address(0) until PLATFORM_CURVE is set
      AGENT_BPS,                 // 8000 = 80/20
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`FeeSplitter deploy failed (tx ${hash}, status ${receipt.status})`);
  }
  return { splitterAddr: getAddress(receipt.contractAddress), txHash: hash };
}

function normalizeAddrOrZero(v) {
  if (!v || !isAddress(v)) return zeroAddress;
  return getAddress(v);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Keeper allowlist reconciliation (SPEC 1). Idempotent and safe to run on EVERY prepare, not just a
// fresh splitter deploy: a resume after a partial failure must not skip allowlisting the keeper. The
// owner (DEPLOYER_KEY) can always call claimAndRoute; this only matters when the keeper service runs
// under a different key. Reads isKeeper(keeper) first and writes only when not already set. Non-fatal.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function reconcileKeeperAllowlist(deps, splitterAddr) {
  const keeper = process.env.KEEPER_ADDRESS;
  if (!keeper || !isAddress(keeper)) return;
  if (!deps.walletClient) return;
  if (getAddress(keeper) === getAddress(deps.walletClient.account.address)) return; // owner == keeper
  try {
    const { abi } = loadFeeSplitterArtifact(deps.artifactPath);
    const already = await deps.publicClient.readContract({
      address: getAddress(splitterAddr), abi, functionName: "isKeeper", args: [getAddress(keeper)],
    });
    if (already) return;
    const h = await deps.walletClient.writeContract({
      address: getAddress(splitterAddr), abi, functionName: "setKeeper",
      args: [getAddress(keeper), true], chain: deps.chain, account: deps.walletClient.account,
    });
    await deps.publicClient.waitForTransactionReceipt({ hash: h });
  } catch (e) { /* non-fatal: owner can still keep */ }
}

async function hasCode(publicClient, addr) {
  if (!addr || !isAddress(addr)) return false;
  const code = await publicClient.getCode({ address: getAddress(addr) });
  return !!code && code !== "0x";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// prepareLaunch — steps 1-3. Idempotent/retryable. Returns the UNSIGNED creator launchToken tx.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} input
 *   creator (required 0x), name, symbol, archetype (required), persona, model, quote ("ETH"|"USDG"),
 *   logo, description, socials{}, creatorTaxBps, distribution{mode,rate_bps,cadence}, id (optional).
 * @param {object} deps  injectable: { db|pool, publicClient, walletClient, deployerAccount|deployerKey,
 *                        predictAccountAddress, chain, rpcUrl, stack, artifactPath }.
 * @returns {Promise<{agentId, salt, accountAddr, splitterAddr, launchTx, launchFeeWei, status, alreadyLaunched}>}
 */
export async function prepareLaunch(input, deps = {}) {
  if (!input?.creator || !isAddress(input.creator)) throw new Error("input.creator must be a valid address");
  if (!input?.archetype) throw new Error("input.archetype is required");

  const d = await resolveDeps(deps);
  try {
    const id = input.id || newLaunchId();
    const salt = deriveSalt(id);
    const quote = String(input.quote || "ETH").toUpperCase();

    // Create (or resume) the agents row. status=deploying until the launch is finalized.
    let row = await d.db.getAgent(id);
    if (!row) {
      row = await d.db.insertAgent({
        id,
        creator_addr: getAddress(input.creator),
        archetype: input.archetype,
        persona_prompt: input.persona ?? null,
        model: input.model || process.env.AGENT_MODEL || DEFAULT_MODEL,
        quote_asset: quote,
        status: "deploying",
        logo_url: input.logo ?? null,
      });
      if (input.distribution) {
        try { await d.db.insertDistributionConfig(id, input.distribution); } catch { /* optional table */ }
      }
    }

    // If the launch already completed for this id, do not rebuild anything for signing.
    if (row.token_addr) {
      return {
        agentId: id, salt, accountAddr: row.account_addr, splitterAddr: row.splitter_addr,
        launchTx: null, launchFeeWei: LAUNCH_FEE_WEI.toString(), status: row.status,
        alreadyLaunched: true,
      };
    }

    // Step 2 (computed first — the splitter constructor needs the treasury address). Deterministic.
    let accountAddr = row.account_addr;
    if (!accountAddr) {
      accountAddr = await d.predictAccountAddress({ salt });
      row = await d.db.updateAgent(id, { account_addr: getAddress(accountAddr) });
    }

    // Step 1: deploy the splitter (retry if a recorded address has no code — a deploy that never
    // confirmed). Persist the address immediately so a crash mid-flow resumes here.
    let splitterAddr = row.splitter_addr;
    if (!splitterAddr || !(await hasCode(d.publicClient, splitterAddr))) {
      const res = await deploySplitter(d, { agentTreasury: accountAddr });
      splitterAddr = res.splitterAddr;
      row = await d.db.updateAgent(id, { splitter_addr: splitterAddr });
    }

    // Allowlist a dedicated keeper (SPEC 1), on EVERY run — NOT only in the fresh-deploy branch, so a
    // resume after a partial failure cannot skip it. Idempotent: reads isKeeper first, writes only if
    // not already set. The owner (DEPLOYER_KEY) can always keep; this matters when the keeper runs
    // under a different key.
    await reconcileKeeperAllowlist(d, splitterAddr);

    // Step 3: build the UNSIGNED launchToken tx for the creator (the server never signs it).
    const params = buildTokenParams({
      name: input.name, symbol: input.symbol, logo: input.logo, description: input.description,
      socials: input.socials, splitterAddr, creatorTaxBps: input.creatorTaxBps, salt,
    });
    const launchTx = buildLaunchTx({
      params, pairToken: pairTokenFor(quote), launchFeeWei: LAUNCH_FEE_WEI,
      creatorAddr: getAddress(input.creator),
    });

    return {
      agentId: id, salt, accountAddr: getAddress(accountAddr), splitterAddr: getAddress(splitterAddr),
      launchTx, launchFeeWei: LAUNCH_FEE_WEI.toString(), status: "deploying", alreadyLaunched: false,
    };
  } finally {
    await closeOwnedPool(d);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Verify the CREATOR's on-chain launchToken tx actually established the never-custody + correct-
// recipient property (review property 1). A caller cannot be trusted to report token/curve honestly,
// so we fetch the real tx, decode its calldata against the factory ABI, and ASSERT every launch
// parameter that the property depends on. Any failed assertion aborts finalize (no curve wiring, no
// flip to live). Returns the decoded params + receipt for the caller to use.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function verifyLaunchTx(deps, { txHash, row, agentId, tokenAddr, curveAddr }) {
  if (!txHash) throw new Error("txHash is required to finalize (the on-chain launch cannot be verified without it)");

  const tx = await deps.publicClient.getTransaction({ hash: txHash });
  if (!tx) throw new Error(`launch tx ${txHash} not found on chain`);
  const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`launch tx ${txHash} did not succeed (status ${receipt.status})`);

  // Target must be the PONS factory (check both the tx and the receipt).
  if (!tx.to || getAddress(tx.to) !== getAddress(PONS_FACTORY)) {
    throw new Error(`launch tx ${txHash} target ${tx.to} is not the PONS factory`);
  }
  if (receipt.to && getAddress(receipt.to) !== getAddress(PONS_FACTORY)) {
    throw new Error(`launch tx ${txHash} receipt target ${receipt.to} is not the PONS factory`);
  }

  // It must be the exact 3-arg launchToken overload we build in prepareLaunch — not the 4-arg
  // snipe-exemption overload or any other call — so the decoded TokenParams below are authoritative.
  const selector = (tx.input || "0x").slice(0, 10).toLowerCase();
  if (selector !== LAUNCH_TOKEN_SELECTOR) {
    throw new Error(
      `launch tx ${txHash} selector ${selector} is not launchToken (${LAUNCH_TOKEN_SELECTOR})`
    );
  }

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: FACTORY_ABI, data: tx.input });
  } catch (e) {
    throw new Error(`launch tx ${txHash} calldata did not decode as launchToken: ${e.message}`);
  }
  if (decoded.functionName !== "launchToken") {
    throw new Error(`launch tx ${txHash} is ${decoded.functionName}, not launchToken`);
  }
  const params = decoded.args[0];

  // (a) NEVER-CUSTODY / CORRECT-RECIPIENT: creatorFeeRecipient MUST be this agent's splitter (ADR
  //     0003). This is the whole point of the property — the on-chain fee stream routes to infra we
  //     control, never to the creator or a holder.
  if (!row?.splitter_addr) throw new Error(`agent ${agentId} has no splitter recorded; cannot verify recipient`);
  if (getAddress(params.creatorFeeRecipient) !== getAddress(row.splitter_addr)) {
    throw new Error(
      `launch tx ${txHash} creatorFeeRecipient ${params.creatorFeeRecipient} != splitter ${row.splitter_addr}`
    );
  }
  // (b) buybackEnabled MUST be false so the splitter (as fee recipient) may sweep the curve (SPEC 1).
  if (params.buybackEnabled !== false) {
    throw new Error(`launch tx ${txHash} buybackEnabled is ${params.buybackEnabled}, must be false`);
  }
  // (c) value MUST be exactly the launch fee — no markup channel (SPEC 8).
  if (tx.value !== LAUNCH_FEE_WEI) {
    throw new Error(`launch tx ${txHash} value ${tx.value} wei != launch fee ${LAUNCH_FEE_WEI} wei`);
  }
  // (d) salt MUST be the salt we derived for THIS agent id — ties the tx to this exact launch, so a
  //     caller cannot point finalize at some unrelated PONS launch (also pins token/curve, which are
  //     deterministic in (creator, salt)).
  const expectedSalt = deriveSalt(agentId);
  if (String(params.salt).toLowerCase() !== expectedSalt.toLowerCase()) {
    throw new Error(`launch tx ${txHash} salt ${params.salt} != derived salt ${expectedSalt} for agent ${agentId}`);
  }
  // (e) sender MUST be the creator recorded at prepare (the creator signs client-side; the server
  //     never signs launchToken).
  if (row.creator_addr && getAddress(tx.from) !== getAddress(row.creator_addr)) {
    throw new Error(`launch tx ${txHash} sender ${tx.from} != creator ${row.creator_addr}`);
  }

  // (f) Consistency of the caller-supplied (token, curve) with the actual tx: the factory has no
  //     event in our ABI, so derive from the receipt logs — the token and curve are deployed/used in
  //     this tx and emit at least one log each (the token's mint Transfer, the curve's init). Require
  //     both caller-supplied addresses to appear as a log emitter in this tx.
  const logAddrs = new Set((receipt.logs || []).map((l) => getAddress(l.address)));
  if (!logAddrs.has(getAddress(tokenAddr))) {
    throw new Error(`launch tx ${txHash} logs do not reference token ${tokenAddr} (caller-supplied token is inconsistent)`);
  }
  if (!logAddrs.has(getAddress(curveAddr))) {
    throw new Error(`launch tx ${txHash} logs do not reference curve ${curveAddr} (caller-supplied curve is inconsistent)`);
  }

  return { params, receipt, tx };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Deploy the per-agent Distributor (ADR 0002 / SPEC 3): the Merkle profit-payout engine holders claim
// USDG from. Infra deploy with DEPLOYER_KEY, its own gas. Idempotent: redeploy only if the recorded
// distributor_addr has no code. Allowlists KEEPER_ADDRESS (if set) so the distribution keeper can
// call setRoot. Persists distributor_addr on the agents row.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function deployDistributor(deps, { agentId, row }) {
  const recorded = row.distributor_addr;
  if (recorded && (await hasCode(deps.publicClient, recorded))) return getAddress(recorded);

  if (!deps.walletClient) throw new Error("no DEPLOYER_KEY: cannot deploy the per-agent Distributor");
  const { abi, bytecode } = loadDistributorArtifact(deps.distributorArtifactPath);

  const hash = await deps.walletClient.deployContract({
    abi, bytecode, chain: deps.chain, account: deps.walletClient.account,
    args: [getAddress(USDG)], // Distributor(address _usdg) — payout asset is always USDG (SPEC 3/5)
  });
  const receipt = await deps.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Distributor deploy failed (tx ${hash}, status ${receipt.status})`);
  }
  const distributorAddr = getAddress(receipt.contractAddress);

  // Allowlist the distribution keeper (if configured) so it can call setRoot alongside the owner.
  const keeper = process.env.KEEPER_ADDRESS;
  if (keeper && isAddress(keeper)) {
    try {
      const h = await deps.walletClient.writeContract({
        address: distributorAddr, abi, functionName: "setKeeper",
        args: [getAddress(keeper), true], chain: deps.chain, account: deps.walletClient.account,
      });
      await deps.publicClient.waitForTransactionReceipt({ hash: h });
    } catch (e) { /* non-fatal: owner (DEPLOYER_KEY) can still call setRoot */ }
  }

  await deps.db.updateAgent(agentId, { distributor_addr: distributorAddr });
  return distributorAddr;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// finalizeLaunch — step 4. Called after the creator's launchToken is mined and the (token, curve)
// are relayed back from the frontend. Wires the curve into the splitter, records the row, starts loop.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} p  { agentId (required), tokenAddr (required), curveAddr (required), txHash (REQUIRED) }
 * @param {object} deps  same injectable shape as prepareLaunch (plus optional distributorArtifactPath).
 */
export async function finalizeLaunch({ agentId, tokenAddr, curveAddr, txHash }, deps = {}) {
  if (!agentId) throw new Error("agentId is required");
  if (!isAddress(tokenAddr)) throw new Error("tokenAddr must be a valid address");
  if (!isAddress(curveAddr)) throw new Error("curveAddr must be a valid address");
  if (!txHash) throw new Error("txHash is required (the on-chain launch is verified before wiring the curve)");

  const d = await resolveDeps(deps);
  try {
    const row = await d.db.getAgent(agentId);
    if (!row) throw new Error(`no agent row for id ${agentId} (call prepareLaunch first)`);
    if (!row.splitter_addr) throw new Error(`agent ${agentId} has no splitter yet (prepareLaunch incomplete)`);

    // Idempotent: if already finalized to this token, just ensure the loop is running and return.
    if (row.token_addr && row.status === "live") {
      return { agentId, status: "live", tokenAddr: row.token_addr, curveAddr: row.curve_addr, distributorAddr: row.distributor_addr ?? null, alreadyLive: true };
    }
    // Guard: never accept a DIFFERENT token for an id that already recorded one (no double launch).
    if (row.token_addr && getAddress(row.token_addr) !== getAddress(tokenAddr)) {
      throw new Error(
        `agent ${agentId} already launched token ${row.token_addr}; refusing to overwrite with ${tokenAddr}`
      );
    }

    // REQUIRED on-chain verification (review property 1): fetch the real launch tx, decode its
    // calldata, and assert every parameter the never-custody + correct-recipient property depends on
    // (creatorFeeRecipient == this splitter, buybackEnabled == false, value == exactly the launch fee,
    // salt == the salt we derived for this agent, sender == the creator, and the caller-supplied
    // token/curve appear in the tx logs). Any mismatch aborts BEFORE wiring the curve or going live.
    await verifyLaunchTx(d, { txHash, row, agentId, tokenAddr, curveAddr });

    // Wire the curve into the splitter (infra call, DEPLOYER_KEY, its own gas). Idempotent: the
    // splitter's setAgentCurve reverts (AlreadySet) if already wired — treat that as done.
    const wired = await hasAgentCurveSet(d, row.splitter_addr);
    if (!wired) {
      const { abi } = loadFeeSplitterArtifact(d.artifactPath);
      if (!d.walletClient) throw new Error("no DEPLOYER_KEY: cannot wire the agent curve into the splitter");
      try {
        const h = await d.walletClient.writeContract({
          address: getAddress(row.splitter_addr), abi, functionName: "setAgentCurve",
          args: [getAddress(curveAddr)], chain: d.chain, account: d.walletClient.account,
        });
        const rc = await d.publicClient.waitForTransactionReceipt({ hash: h });
        if (rc.status !== "success") throw new Error(`setAgentCurve failed (tx ${h})`);
      } catch (e) {
        // If it was set concurrently, verify and continue; otherwise surface the error.
        if (!(await hasAgentCurveSet(d, row.splitter_addr))) throw e;
      }
    }

    // Deploy the per-agent Distributor (ADR 0002 / SPEC 3) now the launch is verified, and persist
    // its address. Idempotent: skipped if a recorded distributor already has code. Non-fatal on
    // failure — the launch is done; the distributor can be (re)deployed on a later finalize retry.
    let distributorAddr = row.distributor_addr ? getAddress(row.distributor_addr) : null;
    try {
      distributorAddr = await deployDistributor(d, { agentId, row });
    } catch (e) {
      distributorAddr = row.distributor_addr ? getAddress(row.distributor_addr) : null;
    }

    // Store the completed row (SPEC 7) and flip to live.
    const updated = await d.db.updateAgent(agentId, {
      token_addr: getAddress(tokenAddr),
      curve_addr: getAddress(curveAddr),
      status: "live",
    });

    // Step 4: start the loop (agent/loop.mjs) — unless disabled or already live.
    let loop = null;
    if (process.env.AGENTPAD_START_LOOP !== "0") {
      const start = deps.startLoop || defaultStartLoop;
      try { loop = await start(updated, d); } catch (e) { loop = { started: false, error: e.message }; }
    }

    return { agentId, status: "live", tokenAddr: getAddress(tokenAddr), curveAddr: getAddress(curveAddr), distributorAddr, loop, alreadyLive: false };
  } finally {
    await closeOwnedPool(d);
  }
}

async function hasAgentCurveSet(deps, splitterAddr) {
  try {
    const { abi } = loadFeeSplitterArtifact(deps.artifactPath);
    const cur = await deps.publicClient.readContract({
      address: getAddress(splitterAddr), abi, functionName: "agentCurve",
    });
    return cur && cur !== zeroAddress;
  } catch {
    return false;
  }
}

/** Read the launch status of one agent (thin passthrough to the store). */
export async function launchStatus(agentId, deps = {}) {
  const d = await resolveDeps(deps);
  try { return await d.db.getAgent(agentId); }
  finally { await closeOwnedPool(d); }
}

// Manual fee claim (SPEC 1, ADR 0003). Owner-only on-chain: the platform DEPLOYER_KEY (the splitter's
// owner) calls FeeSplitter.claimAndRoute(), which sweeps the curve's accrued creator fee, claims it from
// the PONS escrow, converts ETH->USDG, sends 80% to the AGENT TREASURY, and buy-and-burns 20% of the
// platform token. This is the same routing the keeper runs on a timer; this is the on-demand button so a
// creator can top the treasury up from accrued fees (e.g. after the agent wallet was drained). Returns
// the routed amounts + txHash. A revert (nothing accrued to route) surfaces as a clean message.
const CLAIM_AND_ROUTE_ABI = [
  {
    type: "function",
    name: "claimAndRoute",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [
      { name: "agentAmount", type: "uint256" },
      { name: "platformAmount", type: "uint256" },
    ],
  },
];

export async function claimFees({ agentId }, deps = {}) {
  const d = await resolveDeps(deps);
  try {
    const row = await d.db.getAgent(agentId);
    if (!row) throw new Error("agent not found");
    if (!row.splitter_addr) throw new Error("this agent has no fee splitter yet");
    if (!d.walletClient) throw new Error("no DEPLOYER_KEY: the server cannot claim fees");
    const splitter = getAddress(row.splitter_addr);

    // Simulate first: this reads the routed amounts and turns a "nothing to claim" revert into a clean
    // message instead of a failed transaction the creator pays gas to discover.
    let agentAmount = null;
    let platformAmount = null;
    try {
      const sim = await d.publicClient.simulateContract({
        address: splitter,
        abi: CLAIM_AND_ROUTE_ABI,
        functionName: "claimAndRoute",
        account: d.deployerAccount,
      });
      const out = sim.result;
      if (Array.isArray(out)) {
        agentAmount = out[0]?.toString?.() ?? null;
        platformAmount = out[1]?.toString?.() ?? null;
      }
    } catch {
      throw new Error("nothing to claim right now — no accrued fees to route yet");
    }

    const txHash = await d.walletClient.writeContract({
      address: splitter,
      abi: CLAIM_AND_ROUTE_ABI,
      functionName: "claimAndRoute",
      account: d.deployerAccount,
      chain: d.chain,
    });
    const rc = await d.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (rc.status !== "success") throw new Error(`claimAndRoute reverted (${txHash})`);

    return { txHash, splitter, agentAmount, platformAmount, treasury: row.account_addr ?? null };
  } finally {
    await closeOwnedPool(d);
  }
}

// Minimum ETH the agent account must hold before we try to grant — the grant DEPLOYS the account and
// installs the session key, and the account pays that gas itself (ADR 0004, no paymaster). Below this we
// wait for the creator to top the account up (the Fund & manage box), then grant on the next pass.
const GRANT_MIN_ETH_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const GRANT_CAP_USDG_UNITS = 5000n * 1_000_000n; // 5000 USDG spend budget (base units, 6 dp)
const GRANT_MAX_TRADES = 10;
const GRANT_TTL_S = 86400; // 24h key lifetime; re-granted before expiry

// Grant (or re-grant) a scoped session key for one agent so it can trade — the enabler for autonomous
// trading. Uses the SAME per-agent owner the launch predicted the account from (deriveAccountOwnerKey),
// verifies the derived address matches the recorded account, then installs a session key scoped to the
// archetype's assets + caps and persists it to agent/.secrets/session-<id>.json (the reasoner reads it).
// The account pays its own gas, so we only attempt this once the account holds >= GRANT_MIN_ETH_WEI.
export async function grantAgentSession({ agentId }, deps = {}) {
  const d = await resolveDeps(deps);
  try {
    const row = await d.db.getAgent(agentId);
    if (!row) throw new Error("agent not found");
    if (!row.account_addr) return { granted: false, reason: "no account address yet" };
    const account = getAddress(row.account_addr);

    // Gate on gas: the deploy+install userOp pays its prefund from the account's own balance.
    const bal = await d.publicClient.getBalance({ address: account });
    if (bal < GRANT_MIN_ETH_WEI) {
      return { granted: false, reason: "needs-gas", account, balanceWei: bal.toString() };
    }

    const dk = normalizePk(deps.deployerKey || process.env.DEPLOYER_KEY);
    if (!dk) throw new Error("DEPLOYER_KEY required to derive the agent account owner");
    const salt = deriveSalt(agentId);
    const ownerSigner = privateKeyToAccount(deriveAccountOwnerKey(dk, salt));

    const { createAccountStack } = await import("../agent/lib/stack.mjs");
    const stack = await createAccountStack(deps.stack || "zerodev", { rpcUrl: d.rpcUrl, chain: d.chain });

    // SANITY: the owner we derived must reproduce the recorded account address, or we would grant on the
    // wrong account. Fail loudly instead.
    const predicted = getAddress(await stack.predictAddress({ ownerSigner, salt }));
    if (predicted !== account) {
      throw new Error(`grant aborted: derived account ${predicted} != recorded ${account} (owner-derivation mismatch)`);
    }

    const { buildSessionPolicy } = await import("../agent/lib/archetypes.mjs");
    const validUntil = Math.floor(Date.now() / 1000) + GRANT_TTL_S;
    const policy = buildSessionPolicy({
      archetype: row.archetype || "macro",
      spendBudget: GRANT_CAP_USDG_UNITS,
      dailyTradeLimit: GRANT_MAX_TRADES,
      validUntil,
      ttl: GRANT_TTL_S,
    });

    const sessionPk = generatePrivateKey();
    const sessionSigner = privateKeyToAccount(sessionPk);
    const res = await stack.grantSession({ ownerSigner, sessionSigner, policy, deploy: true });

    // Persist for the runtime (reason-all reads approval + sessionKey). 0600, gitignored .secrets dir.
    const dir = path.join(REPO_ROOT, "agent", ".secrets");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `session-${agentId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          agentId,
          accountAddress: res.accountAddress || account,
          sessionKeyAddress: sessionSigner.address,
          approval: res.approval,
          sessionKey: sessionPk,
          archetype: row.archetype || "macro",
          validUntil,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return { granted: true, account, sessionKeyAddress: sessionSigner.address, deployed: res.deployed, validUntil };
  } finally {
    await closeOwnedPool(d);
  }
}

// Default "start the loop": spawn a detached `node agent/loop.mjs` with a FULLY-WIRED env. On a
// single box this is enough; a multi-agent deployment swaps in a process manager via deps.startLoop.
//
// The env follows the powell.config.mjs `loopEnv()` pattern (AGENT_ARCHETYPE / MODEL / PERSONA /
// LOOP_INTERVAL) and ADDS everything a loop needs to actually connect + trade:
//   - AGENT_MCP_SERVERS: the standard stdio MCP server specs (chain / market / socials). Without
//     this, loop.mjs main() hits the empty-AGENT_MCP_SERVERS path and exits immediately.
//   - AGENT_ACCOUNT + FEE_SPLITTER: the agent's own treasury account + its fee splitter.
//   - the session approval/key + AGENT_STACK (flow through ...process.env, read by chain.mjs).
//   - AGENT_LOOP_INTERVAL and DATABASE_URL (so the loop persists to Postgres, not the file store).
// If a required env is missing, FAIL LOUDLY instead of spawning a loop that silently exits.
function defaultStartLoop(row) {
  const loopPath = path.join(REPO_ROOT, "agent", "loop.mjs");

  // The env the loop cannot function without (would connect no chain tool / no session key and exit).
  const accountAddr = row.account_addr || process.env.AGENT_ACCOUNT;
  const required = {
    OPENROUTER_KEY: process.env.OPENROUTER_KEY,
    ROBINHOOD_ALCHEMY_RPC: process.env.ROBINHOOD_ALCHEMY_RPC,
    AGENT_SESSION_APPROVAL: process.env.AGENT_SESSION_APPROVAL,
    AGENT_SESSION_KEY: process.env.AGENT_SESSION_KEY,
    "account_addr/AGENT_ACCOUNT": accountAddr,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    const msg =
      `defaultStartLoop: refusing to spawn agent ${row.id} loop — missing required env: ${missing.join(", ")}. ` +
      `A loop without these connects no MCP servers / has no session key and would exit immediately. ` +
      `Set them (see docs/FLAGSHIP-RUNBOOK.md) and re-run finalize, or set AGENTPAD_START_LOOP=0 to skip.`;
    console.error(msg);
    throw new Error(msg);
  }

  // Standard stdio MCP server specs the loop connects to (loop.mjs connectMcp consumes this JSON).
  const mcpDir = path.join(REPO_ROOT, "agent", "mcp");
  const mcpServers = [
    { name: "chain",   command: process.execPath, args: [path.join(mcpDir, "chain.mjs")] },
    { name: "market",  command: process.execPath, args: [path.join(mcpDir, "market.mjs")] },
    { name: "socials", command: process.execPath, args: [path.join(mcpDir, "socials.mjs")] },
  ];

  const env = {
    ...process.env,
    AGENT_ID: row.id,
    AGENT_ARCHETYPE: row.archetype || "tech-bull",
    AGENT_MODEL: row.model || DEFAULT_MODEL,
    AGENT_MCP_SERVERS: JSON.stringify(mcpServers),
    AGENT_ACCOUNT: getAddress(accountAddr),
    AGENT_LOOP_INTERVAL: process.env.AGENT_LOOP_INTERVAL || "3600",
  };
  if (row.persona_prompt) env.AGENT_PERSONA = row.persona_prompt;
  if (row.splitter_addr) env.FEE_SPLITTER = getAddress(row.splitter_addr);
  if (process.env.DATABASE_URL) env.DATABASE_URL = process.env.DATABASE_URL; // persist to Postgres
  // Per-agent X keys (opt-in, creator-connected via the web X-connect flow; ADR 0005 / SPEC 11). If the
  // creator connected X, point the socials MCP server at their gitignored config so it can post to the
  // agent's own handle. Absent = X stays off (socials falls back to feed-only). Must match
  // web/lib/server/paths.ts socialsConfigPath().
  const socialsConfig = path.join(REPO_ROOT, "agent", ".secrets", `socials-${row.id}.json`);
  if (fs.existsSync(socialsConfig)) env.SOCIALS_CONFIG = socialsConfig;
  // AGENT_SESSION_APPROVAL / AGENT_SESSION_KEY / AGENT_STACK flow through ...process.env (chain.mjs reads them).

  const child = spawn(process.execPath, [loopPath], { env, detached: true, stdio: "ignore" });
  child.unref();
  return { started: true, pid: child.pid, mcpServers: mcpServers.map((s) => s.name) };
}

async function closeOwnedPool(d) {
  if (d?._ownedPool) { try { await d._ownedPool.end(); } catch { /* ignore */ } }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
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
  autoloadEnv();
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];

  if (mode === "prepare") {
    const res = await prepareLaunch({
      id: args.id,
      creator: args.creator,
      name: args.name,
      symbol: args.symbol,
      archetype: args.archetype,
      persona: args.persona,
      model: args.model,
      quote: args.quote,
      logo: args.logo,
      description: args.description,
      creatorTaxBps: args["tax-bps"] !== undefined ? Number(args["tax-bps"]) : undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    console.log(
      "\nNext: the CREATOR signs launchTx client-side (the server does NOT). Then relay the resulting\n" +
      `token + curve + the launch tx hash back (the tx hash is REQUIRED — finalize verifies the\n` +
      `on-chain launch before wiring anything):\n  node --env-file=.env api/launch.mjs finalize --id=${res.agentId} --token=0x.. --curve=0x.. --tx=0x..`
    );
    return;
  }

  if (mode === "finalize") {
    const res = await finalizeLaunch({ agentId: args.id, tokenAddr: args.token, curveAddr: args.curve, txHash: args.tx });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (mode === "status") {
    const res = await launchStatus(args.id);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.error(
    "usage:\n" +
    "  node --env-file=.env api/launch.mjs prepare  --creator=0x.. --name=Nova --symbol=NOVA --archetype=tech-bull [--persona=..] [--quote=ETH|USDG] [--id=..] [--tax-bps=0]\n" +
    "  node --env-file=.env api/launch.mjs finalize --id=<id> --token=0x.. --curve=0x.. --tx=0x..\n" +
    "  node --env-file=.env api/launch.mjs status   --id=<id>"
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
}
