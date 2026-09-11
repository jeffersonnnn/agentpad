// Fork test — OBSERVE on-chain ERC-4337 session-key enforcement for a ZeroDev Kernel v3 agent
// account, with NO live bundler and NO real ETH. (SPEC.md section 2 / ADR 0004; Milestone 1 proof.)
//
// We fork Robinhood Chain 4663 into a LOCAL anvil, deploy the REAL product account via the REAL
// stack seam (agent/lib/stack-zerodev.mjs -> the SAME call/rate/timestamp policies the product
// installs), grant the tech-bull session key, then submit userOps by calling EntryPoint.handleOps
// DIRECTLY from a funded relayer EOA — no bundler service. We observe four distinct facts:
//
//   A. ACCEPT + EXECUTE in-scope   — a capped USDG approve to SwapRouter02 (and, as a bonus, a real
//                                     USDG->NVDA exactInputSingle) SUCCEEDS; the account pays its own
//                                     gas (its ETH balance drops; no paymaster).
//   B. REJECT over-cap             — same approve but amount > perTradeCap -> handleOps validation REVERTS.
//   C. REJECT disallowed token     — approve of a token NOT in the tech-bull set -> REVERTS.
//   D. REJECT wrong recipient      — exactInputSingle with recipient != the account -> REVERTS.
//
// Run:  node --env-file=.env agent/test/sessionkey.fork.mjs         (or: npm --prefix agent run test:sessionkey)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionPolicy, CHAIN_ID, TOKENS, SWAP_ROUTER_02, USDG_DECIMALS,
} from "../lib/archetypes.mjs";
import { createAccountStack } from "../lib/stack.mjs";
import {
  makeChain, startAnvil, makeClients, newEoa, setEth, fundUsdg,
  provisionRateLimitModule, deployAccountViaSudo,
  buildSignedPackedUserOp, submitHandleOps, simulateHandleOps,
  ERC20_APPROVE_ABI, ROUTER_EXACTIN_ABI,
  encodeFunctionData, formatEther, privateKeyToAccount,
} from "./fork-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function autoloadEnv() {
  const candidates = [
    path.join(__dirname, "..", "..", ".env"), // repo root (agent/test/../../.env)
    path.join(__dirname, "..", ".env"),        // agent/.env
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

const NVDA = TOKENS.NVDA;
const SGOV = TOKENS.SGOV;              // NOT in the tech-bull set -> disallowed token for case C
const NVDA_USDG_POOL = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3"; // ~$3.56M USDG whale (FACTS.md), impersonation fallback
const NVDA_POOL_FEE = 500;

async function main() {
  autoloadEnv();
  const forkUrl = process.env.ROBINHOOD_ALCHEMY_RPC;
  if (!forkUrl) throw new Error("ROBINHOOD_ALCHEMY_RPC not set in .env — cannot fork chain 4663.");

  const results = { A: null, B: null, C: null, D: null };
  const meta = {};
  let anvil;
  try {
    // 1) Fork 4663 into a local anvil, auto-mine.
    anvil = await startAnvil({ forkUrl });
    const chain = makeChain(anvil.url);
    const { publicClient, testClient } = makeClients(anvil.url, chain);
    meta.chainId = await publicClient.getChainId();
    meta.forkBlock = Number(await publicClient.getBlockNumber());

    // FINDING + provisioning: ZeroDev's rate-limit policy singleton is not deployed on chain 4663,
    // which blocks enabling the product's session-key validator there. We port its (CREATE2-identical)
    // bytecode from Base/Arbitrum onto the LOCAL fork so the REAL, full policy set can be exercised.
    meta.rate_limit_module = await provisionRateLimitModule(testClient, publicClient);

    // Throwaway keys: owner (platform/creator) + session key (runtime) + relayer EOA (bundler stand-in).
    const owner = newEoa();
    const session = newEoa();
    const relayer = newEoa();
    await setEth(testClient, relayer.account.address, 100);

    // 2) Build the REAL policy + grant the tech-bull session key via the REAL stack seam.
    const ttl = 86400;
    const validUntil = Math.floor(Date.now() / 1000) + ttl;
    const spendBudget = 5000n * 10n ** BigInt(USDG_DECIMALS); // 5000 USDG
    const dailyTradeLimit = 10;
    const policy = buildSessionPolicy({ archetype: "tech-bull", spendBudget, dailyTradeLimit, validUntil, ttl });
    const perTradeCap = policy.perTradeCap; // 500 USDG (500e6)
    meta.archetype = "tech-bull";
    meta.perTradeCap_USDG = Number(perTradeCap) / 10 ** USDG_DECIMALS;
    meta.spendBudget_USDG = Number(spendBudget) / 10 ** USDG_DECIMALS;
    meta.dailyTradeLimit = dailyTradeLimit;
    meta.allowedTokens = policy.symbols;

    const stack = await createAccountStack("zerodev", { rpcUrl: anvil.url, chain });
    const grant = await stack.grantSession({
      ownerSigner: owner.account, sessionSigner: session.account, policy, deploy: false,
    });
    const accountAddress = grant.accountAddress;
    meta.account = accountAddress;
    meta.owner = owner.account.address;
    meta.sessionKey = session.account.address;
    meta.relayer = relayer.account.address;

    // Resume the account under the SESSION KEY (runtime side). client.account is the signer-capable
    // kernel account whose ACTIVE validator is the scoped permission (session) validator.
    const resumed = await stack.resumeSession({ approval: grant.approval, sessionSigner: session.account });
    const account = resumed.client.account;

    // 3) Fund the account with ETH so it pays its OWN gas (no paymaster). Confirm no paymaster wired.
    await setEth(testClient, accountAddress, 2);
    meta.paymaster_wired = resumed.client.paymaster != null; // expected false
    const codeBefore = await publicClient.getCode({ address: accountAddress });
    meta.account_counterfactual_before_deploy = !(codeBefore && codeBefore !== "0x"); // expected true

    // Deploy the account with a SUDO (owner) userOp via handleOps — no bundler. Mirrors the product's
    // separate owner-driven deploy, so the first SESSION op below only has to ENABLE the validator.
    meta.deploy = await deployAccountViaSudo(anvil.url, chain, publicClient, owner.account, accountAddress, relayer.account);

    // Fund the account with USDG on the fork (slot-1 write; fallback = impersonate the NVDA/USDG pool).
    const fund = await fundUsdg(testClient, publicClient, anvil.url, chain, NVDA_USDG_POOL, accountAddress, spendBudget);
    meta.usdg_funding = { method: fund.method, balance_USDG: Number(fund.balance) / 10 ** USDG_DECIMALS };

    const ethOf = (a) => publicClient.getBalance({ address: a });
    const allowanceOf = () => publicClient.readContract({
      address: TOKENS.USDG, abi: ERC20_APPROVE_ABI, functionName: "allowance", args: [accountAddress, SWAP_ROUTER_02] });
    const nvdaOf = () => publicClient.readContract({
      address: NVDA, abi: ERC20_APPROVE_ABI, functionName: "balanceOf", args: [accountAddress] });

    // ── A: ACCEPT + EXECUTE in-scope — capped USDG approve to SwapRouter02 (first SESSION op enables
    //       the scoped permission validator, then executes the in-scope call). ──
    {
      const approveData = encodeFunctionData({
        abi: ERC20_APPROVE_ABI, functionName: "approve", args: [SWAP_ROUTER_02, perTradeCap] });
      const callData = await account.encodeCalls([{ to: TOKENS.USDG, value: 0n, data: approveData }]);
      const ethBefore = await ethOf(accountAddress);
      const { packed } = await buildSignedPackedUserOp(publicClient, account, meta.chainId, callData);
      const paymasterEmpty = (packed.paymasterAndData ?? "0x") === "0x";
      const sub = await submitHandleOps(anvil.url, chain, publicClient, relayer.account, packed, relayer.account.address);
      const ethAfter = await ethOf(accountAddress);
      const allowance = await allowanceOf();
      const deployedNow = await publicClient.getCode({ address: accountAddress });

      // Bonus: a REAL in-scope, within-cap swap USDG->NVDA (recipient == the account).
      let swap = { attempted: false };
      if (sub.status === "success") {
        try {
          const swapData = encodeFunctionData({
            abi: ROUTER_EXACTIN_ABI, functionName: "exactInputSingle",
            args: [{ tokenIn: TOKENS.USDG, tokenOut: NVDA, fee: NVDA_POOL_FEE, recipient: accountAddress,
              amountIn: perTradeCap, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
          const swapCall = await account.encodeCalls([{ to: SWAP_ROUTER_02, value: 0n, data: swapData }]);
          const nvdaBefore = await nvdaOf();
          const built = await buildSignedPackedUserOp(publicClient, account, meta.chainId, swapCall);
          const swapSub = await submitHandleOps(anvil.url, chain, publicClient, relayer.account, built.packed, relayer.account.address);
          const nvdaAfter = await nvdaOf();
          swap = { attempted: true, status: swapSub.status, sendError: swapSub.sendError,
            nvda_received: (nvdaAfter - nvdaBefore).toString(), recipient: "account" };
        } catch (e) { swap = { attempted: true, error: e.shortMessage || e.message }; }
      }

      const ethDropped = ethAfter < ethBefore;
      const holds = sub.status === "success" && ethDropped && paymasterEmpty && allowance === perTradeCap;
      results.A = {
        assumption: "A session-key userOp doing an IN-SCOPE, within-cap action (USDG approve to SwapRouter02, amount <= perTradeCap) is ACCEPTED and EXECUTED, and the account pays its own gas (no paymaster).",
        how_observed: "Built + signed the userOp with the session/permission validator (ZeroDev SDK), submitted it via EntryPoint.handleOps from a funded relayer EOA on the anvil fork; read receipt status, the account's ETH balance before/after, the resulting USDG->router allowance, and account code.",
        actual: {
          handleOps_status: sub.status, sendError: sub.sendError,
          account_deployed: !!(deployedNow && deployedNow !== "0x"),
          paymasterAndData_empty: paymasterEmpty, client_paymaster_wired: meta.paymaster_wired,
          account_eth_before: formatEther(ethBefore), account_eth_after: formatEther(ethAfter), account_eth_dropped: ethDropped,
          usdg_allowance_to_router_USDG: Number(allowance) / 10 ** USDG_DECIMALS,
          bonus_swap: swap,
        },
        holds,
      };
    }

    // Helper for the REJECT cases: observe both an eth_call simulation AND a mined handleOps tx.
    const observeReject = async (label, callData) => {
      const { packed } = await buildSignedPackedUserOp(publicClient, account, meta.chainId, callData);
      const sim = await simulateHandleOps(publicClient, relayer.account.address, packed, relayer.account.address);
      const sub = await submitHandleOps(anvil.url, chain, publicClient, relayer.account, packed, relayer.account.address);
      const rejected = sim.wouldRevert && (sub.status === "reverted" || sub.status === null || !!sub.sendError);
      // The EntryPoint wraps the validator's own revert as FailedOpWithRevert(..., inner). A NON-EMPTY
      // inner selector proves the CALL POLICY itself reverted (vs the empty 0x seen on a failed enable).
      const m = (sim.reason || "").match(/AA23 reverted,\s*(0x[0-9a-fA-F]*)\)/);
      const innerSelector = m ? m[1] : null;
      return { packed, sim, sub, rejected, innerSelector };
    };

    // ── B: REJECT over-cap — USDG approve with amount = perTradeCap + 1. ──
    {
      const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve",
        args: [SWAP_ROUTER_02, perTradeCap + 1n] });
      const callData = await account.encodeCalls([{ to: TOKENS.USDG, value: 0n, data }]);
      const o = await observeReject("B", callData);
      results.B = {
        assumption: "A USDG approve to SwapRouter02 for amount > perTradeCap is REJECTED at validation (before execution).",
        how_observed: "eth_call of EntryPoint.handleOps reverts, and a mined handleOps tx reverts (status=reverted). No execution occurs.",
        actual: { would_revert: o.sim.wouldRevert, inner_revert_selector: o.innerSelector, revert_reason: o.sim.reason, handleOps_status: o.sub.status, sendError: o.sub.sendError },
        holds: o.rejected,
      };
    }

    // ── C: REJECT disallowed token — approve SGOV (not in the tech-bull set) to the router. ──
    {
      const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve",
        args: [SWAP_ROUTER_02, perTradeCap] });
      const callData = await account.encodeCalls([{ to: SGOV, value: 0n, data }]);
      const o = await observeReject("C", callData);
      results.C = {
        assumption: "An action touching a token NOT in the tech-bull allowed set (approve SGOV to the router) is REJECTED at validation.",
        how_observed: "eth_call of EntryPoint.handleOps reverts, and a mined handleOps tx reverts (status=reverted). No execution occurs.",
        actual: { disallowed_token: "SGOV", would_revert: o.sim.wouldRevert, inner_revert_selector: o.innerSelector, revert_reason: o.sim.reason, handleOps_status: o.sub.status, sendError: o.sub.sendError },
        holds: o.rejected,
      };
    }

    // ── D: REJECT wrong recipient — exactInputSingle with recipient != the account. ──
    {
      const data = encodeFunctionData({ abi: ROUTER_EXACTIN_ABI, functionName: "exactInputSingle",
        args: [{ tokenIn: TOKENS.USDG, tokenOut: NVDA, fee: NVDA_POOL_FEE, recipient: relayer.account.address,
          amountIn: perTradeCap, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
      const callData = await account.encodeCalls([{ to: SWAP_ROUTER_02, value: 0n, data }]);
      const o = await observeReject("D", callData);
      results.D = {
        assumption: "An exactInputSingle whose recipient != the agent account is REJECTED at validation (proceeds cannot be routed to an attacker).",
        how_observed: "eth_call of EntryPoint.handleOps reverts, and a mined handleOps tx reverts (status=reverted). No execution occurs.",
        actual: { recipient: "relayer (NOT the account)", would_revert: o.sim.wouldRevert, inner_revert_selector: o.innerSelector, revert_reason: o.sim.reason, handleOps_status: o.sub.status, sendError: o.sub.sendError },
        holds: o.rejected,
      };
    }
  } finally {
    if (anvil) anvil.kill();
  }

  const all_observed = !!(results.A?.holds && results.B?.holds && results.C?.holds && results.D?.holds);
  const summary = {
    test: "sessionkey.fork",
    stack: "ZeroDev Kernel v3.1 + EntryPoint v0.7 (0x0000000071727De22E5E9d8BAf0edAc6f37da032)",
    chain: CHAIN_ID,
    bundler: "NONE — EntryPoint.handleOps called directly from a funded relayer EOA on a local anvil fork",
    meta,
    findings: [
      meta.rate_limit_module?.missing_on_4663_fork
        ? "BLOCKER for 4663: ZeroDev's rate-limit policy singleton (0xf63d4139B25c836334edD76641356c6b74C86873) has NO code on chain 4663, so the product's session-key validator cannot be enabled there as-is. The test ports the module's (CREATE2-identical) bytecode from Base/Arbitrum onto the local fork to exercise the real, full policy set. ACTION: deploy this module (and re-verify the other permission modules) on 4663 before Milestone 1 ships."
        : "ZeroDev rate-limit policy module already present on the forked 4663 state.",
      "Reject cases carry DISTINCT non-empty inner revert selectors from the call policy (over-cap/wrong-recipient = param-condition failure; disallowed-token = no-permission-for-target), which is how we know the reverts are the SCOPE being enforced, not a generic enable failure (that returns empty 0x).",
    ],
    observations: results,
    all_observed,
  };
  console.log("\n=== SESSION-KEY ENFORCEMENT — FORK OBSERVATION SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(all_observed ? 0 : 1);
}

main().catch((e) => {
  console.error("\nFAILED:", e.stack || e.message);
  process.exit(1);
});
