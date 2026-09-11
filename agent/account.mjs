// Milestone 1 — the ERC-4337 agent account + session key (SPEC.md section 2, ADR 0004).
//
// Deploys an ERC-4337 smart account for one agent on Robinhood Chain 4663 and scopes a runtime
// SESSION KEY to: the archetype's allowed tokens + USDG, a USDG spend budget (perTradeCap x
// dailyTradeLimit — NOT a rolling cumulative cap; see archetypes.buildSessionPolicy), and an
// expiry. Owner = the creator/platform key (DEPLOYER_KEY). The runtime holds the session key. No
// paymaster: the account pays its own gas. Bundler = ROBINHOOD_ALCHEMY_RPC (node + bundler in one).
//
// The account stack is OPEN (SPEC.md 10.1): ZeroDev Kernel v3 is the default here, Alchemy Modular
// Account is a drop-in (`--stack=alchemy`). Both sit behind lib/stack.mjs, so nothing here touches
// an SDK type — only the neutral policy and the stack interface.
//
// ── Usage ───────────────────────────────────────────────────────────────────────────────────────
//   Load env first. Node 22:   node --env-file=.env agent/account.mjs <mode> [flags]
//   (account.mjs also auto-loads ./.env if present, so plain `node agent/account.mjs` works too.)
//
//   Modes:
//     plan     (default) Resolve + print the scope. Pure: no SDK, no network, no keys, no gas.
//     predict            Compute the counterfactual account address. Needs the SDK + RPC + owner key.
//     grant              Deploy the account and install the session key. Needs a FUNDED owner key.
//                        Prints the account address, the session key, and the grant blob the runtime
//                        stores. Add --no-deploy to only compute the grant without broadcasting.
//
//   Flags:
//     --archetype=tech-bull      one of: macro | tech-bull | hard-money | index | meme-stock | yield
//     --cap=5000                 USDG spend budget (whole USDG) = perTradeCap x max-trades. Default 5000.
//                                NOT a rolling cumulative cap; assumes daily key rotation. See SPEC 2.
//     --max-trades=10            max userOps per rate-limit interval. Default 10. perTradeCap=cap/max-trades.
//     --ttl=86400                session-key lifetime in seconds (the expiry). Default 86400 (24h).
//     --stack=zerodev            zerodev (default) | alchemy
//     --owner=0x<pk>             owner private key. Default: DEPLOYER_KEY from env.
//     --session=0x<pk>           session private key. Default: a fresh key is generated and printed.
//     --no-deploy                (grant mode) build the grant but do not broadcast the deploy.
//
// Example:
//   node --env-file=.env agent/account.mjs grant --archetype=tech-bull --cap=5000 --ttl=86400

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionPolicy, resolveArchetype, USDG_DECIMALS, CHAIN_ID, PUBLIC_RPC } from "./lib/archetypes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny dependency-free .env loader (does not override already-set env) ---
function autoloadEnv() {
  for (const p of [path.join(__dirname, "..", ".env"), path.join(process.cwd(), ".env")]) {
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

// USDG (6 dec) whole-number -> smallest units, no float error.
function usdgToUnits(whole) {
  return BigInt(Math.trunc(Number(whole))) * 10n ** BigInt(USDG_DECIMALS);
}

function normalizePk(pk) {
  if (!pk) return undefined;
  return pk.startsWith("0x") ? pk : "0x" + pk;
}

async function main() {
  autoloadEnv();
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0] || "plan";

  const archetype = args.archetype || "tech-bull";
  const capWhole = args.cap ?? 5000;
  const cap = usdgToUnits(capWhole);
  const maxTrades = Number(args["max-trades"] ?? 10);
  const ttl = Number(args.ttl ?? 86400);
  const stackName = args.stack || "zerodev";
  const validUntil = Math.floor(Date.now() / 1000) + ttl;

  // Build the stack-neutral policy (pure — no SDK).
  const policy = buildSessionPolicy({ archetype, spendBudget: cap, dailyTradeLimit: maxTrades, validUntil, ttl });
  const resolved = resolveArchetype(archetype);
  const perTradeWhole = Number(policy.perTradeCap) / 10 ** USDG_DECIMALS;

  // --- print the resolved scope (every mode shows this) ---
  console.log(`\n=== ERC-4337 agent account — ${mode.toUpperCase()} ===`);
  console.log(`  chain           : ${CHAIN_ID} (Robinhood Chain)`);
  console.log(`  stack           : ${stackName} (EntryPoint v0.7)`);
  console.log(`  archetype       : ${archetype} — ${resolved.label}`);
  console.log(`  allowed tokens  : ${resolved.symbols.join(", ")}`);
  console.log(`  swap target     : SwapRouter02 ${policy.router} (only approve spender, only swap target)`);
  console.log(`  spend budget    : ${capWhole} USDG  =  ${perTradeWhole} USDG/trade (perTradeCap) x ${maxTrades} trades (dailyTradeLimit)`);
  console.log(`                    (NOT a rolling cumulative cap: enforced as capped USDG approve + ${maxTrades}-op rate limit`);
  console.log(`                     over one ${ttl}s window pinned to the key TTL; assumes daily key rotation — SPEC 2)`);
  console.log(`  expiry          : ${new Date(validUntil * 1000).toISOString()} (ttl ${ttl}s)`);
  console.log(`  paymaster       : NONE — the account pays its own gas (ADR 0004)`);

  if (mode === "plan") {
    console.log(`\n  plan mode is pure (no SDK, no network, no keys). Next:`);
    console.log(`    node --env-file=.env agent/account.mjs predict --archetype=${archetype} --stack=${stackName}`);
    console.log(`    node --env-file=.env agent/account.mjs grant   --archetype=${archetype} --cap=${args.cap ?? 5000} --ttl=${ttl}\n`);
    return;
  }

  // --- modes that need the SDK + network + keys ---
  const rpcUrl = process.env.ROBINHOOD_ALCHEMY_RPC || PUBLIC_RPC;
  if (!process.env.ROBINHOOD_ALCHEMY_RPC) {
    console.log(`  (warning) ROBINHOOD_ALCHEMY_RPC not set; falling back to the public RPC (not a bundler).`);
  }

  // Lazy imports so `plan` never needs viem installed.
  let privateKeyToAccount, generatePrivateKey, defineChain;
  try {
    ({ privateKeyToAccount, generatePrivateKey } = await import("viem/accounts"));
    ({ defineChain } = await import("viem"));
  } catch (e) {
    console.error(`\n  viem is not installed. Run:  cd agent && npm install\n  (${e.message})`);
    process.exit(1);
  }

  const chain = defineChain({
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const ownerPk = normalizePk(args.owner) || normalizePk(process.env.DEPLOYER_KEY);
  if (!ownerPk) {
    console.error(`\n  no owner key. Set DEPLOYER_KEY in .env or pass --owner=0x...\n`);
    process.exit(1);
  }
  const ownerSigner = privateKeyToAccount(ownerPk);

  const { createAccountStack } = await import("./lib/stack.mjs");
  const stack = await createAccountStack(stackName, { rpcUrl, chain });

  if (mode === "predict") {
    const addr = await stack.predictAddress({ ownerSigner });
    console.log(`\n  owner           : ${ownerSigner.address}`);
    console.log(`  account (predicted, counterfactual): ${addr}\n`);
    return;
  }

  if (mode === "grant") {
    const sessionPk = normalizePk(args.session) || generatePrivateKey();
    const sessionSigner = privateKeyToAccount(sessionPk);
    const deploy = !args["no-deploy"];

    console.log(`\n  owner           : ${ownerSigner.address}`);
    console.log(`  session key     : ${sessionSigner.address}`);
    if (!args.session) {
      console.log(`  session PRIVATE : ${sessionPk}`);
      console.log(`                    ^ the RUNTIME holds this. Store it in the agent's secret store, never on-chain.`);
    }
    console.log(`  deploy on-chain : ${deploy ? "yes (account pays its own gas)" : "no (--no-deploy: grant only)"}`);

    const res = await stack.grantSession({ ownerSigner, sessionSigner, policy, deploy });

    console.log(`\n  account         : ${res.accountAddress}`);
    console.log(`  deployed now    : ${res.deployed}`);
    console.log(`\n  --- GRANT (persist this for the runtime; resumeSession() rebuilds the account from it) ---`);
    console.log(res.approval);
    console.log(`\n  Runtime usage:`);
    console.log(`    const stack = await createAccountStack("${stackName}", { rpcUrl, chain });`);
    console.log(`    const s = await stack.resumeSession({ approval, sessionSigner });`);
    console.log(`    await s.sendCall({ to: router, data: exactInputSingleCalldata });  // scoped, self-paying\n`);
    return;
  }

  console.error(`unknown mode "${mode}". Use: plan | predict | grant`);
  process.exit(1);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
