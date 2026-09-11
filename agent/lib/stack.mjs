// The account-stack seam.
//
// SPEC.md section 10.1 flags the account stack as OPEN: ZeroDev Kernel v3 is the recommended
// default, Alchemy Modular Account the fallback. This file is the small interface that isolates
// that choice, so swapping stacks is a one-line change (`--stack=alchemy`) and nothing else in the
// launchpad touches an SDK type directly.
//
// Every adapter (stack-zerodev.mjs, stack-alchemy.mjs) is loaded LAZILY (dynamic import) so that
// account.mjs `--plan` mode runs with no SDK installed. An adapter that needs an SDK throws a clear
// "run npm install" error rather than a cryptic module-not-found.
//
// ── The interface every adapter implements ──────────────────────────────────────────────────────
//
//   const stack = await createAccountStack("zerodev", { rpcUrl, chain });
//
//   stack.name                 -> "zerodev" | "alchemy"
//   stack.entryPointVersion    -> "0.7"
//
//   await stack.predictAddress({ ownerAddress | ownerSigner, salt? })
//        -> `0x...`  counterfactual smart-account address. Pure read; broadcasts nothing.
//
//   await stack.grantSession({ ownerSigner, sessionSigner, policy, deploy })
//        -> { accountAddress, sessionKeyAddress, approval, deployed }
//        OWNER SIDE. Builds the smart account controlled by ownerSigner, scopes the session key to
//        `policy` (allowed tokens + USDG spend budget = perTradeCap x dailyTradeLimit + expiry),
//        optionally deploys the account
//        on-chain (the account pays its own gas — no paymaster), and returns `approval`: the
//        serialized grant the runtime persists. Requires a funded owner when deploy=true.
//
//   await stack.resumeSession({ approval, sessionSigner })
//        -> { accountAddress, client, sendCall }
//        RUNTIME SIDE. Rebuilds a signer-capable account client from `approval` + the session key.
//        `sendCall({ to, data, value })` sends one userOp under the scoped policy. The account pays
//        its own gas.
//
//   await stack.sendOwnerCall({ ownerSigner, accountAddress?, to, data, value })
//        -> { userOpHash, receipt }
//        OWNER SIDE. Sends ONE arbitrary call FROM the agent account under its sudo/ECDSA OWNER
//        validator (full control) — NOT the scoped session key. Used by the keeper to move the
//        agent's OWN treasury USDG into its per-agent Distributor before setRoot (SPEC 3, ADR 0002):
//        the agent acting on its own funds via the platform-managed owner (SPEC 2), never any
//        creator/holder key. `ownerSigner` MUST be the same per-agent owner the account was granted
//        with (launch.mjs deriveAccountOwnerKey(DEPLOYER_KEY, salt)), or the userOp fails validation.
//        No paymaster: the account pays its own gas. If `accountAddress` is passed it is asserted to
//        equal the owner-derived account address (a guard against funding the wrong account).
//
// `ownerSigner` / `sessionSigner` are viem LocalAccounts (from privateKeyToAccount). `policy` is the
// stack-neutral object from archetypes.buildSessionPolicy().

const ADAPTERS = {
  zerodev: () => import("./stack-zerodev.mjs"),
  alchemy: () => import("./stack-alchemy.mjs"),
};

/**
 * @param {"zerodev"|"alchemy"} name
 * @param {{ rpcUrl: string, chain?: object }} deps  rpcUrl is the Alchemy node+bundler URL.
 */
export async function createAccountStack(name, deps) {
  const load = ADAPTERS[name];
  if (!load) {
    throw new Error(`unknown stack "${name}". Valid: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  let mod;
  try {
    mod = await load();
  } catch (e) {
    throw new Error(
      `failed to load the "${name}" stack adapter — the SDK is probably not installed.\n` +
      `  Run:  cd agent && npm install\n` +
      `  Underlying error: ${e.message}`
    );
  }
  return mod.createStack(deps);
}

export const AVAILABLE_STACKS = Object.keys(ADAPTERS);
